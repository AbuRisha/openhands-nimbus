"""Move a forked conversation's agent state between two sandboxes.

WHERE THIS SITS
---------------
``fork_conversation_state`` copies the agent's persistence directory and rewrites
the id; ``fork_state_cli`` lets it run as two loose files. This module is the
transport that puts those files in the source sandbox, runs them there, and
relays the result into the target's.

A forked conversation gets its own sandbox (``SandboxGroupingStrategy`` defaults
to ``NO_GROUPING``), so source and target are different filesystems. The copier
runs in the SOURCE — where the state already is — and only an opaque archive
crosses the app server. Customer conversation state is never expanded here. See
docs/fork-conversation-design.md.

VERIFIED VS ASSUMED
-------------------
The endpoint signatures below were read out of ``openhands/agent_server/``:
``GET /file/archive`` (``format`` must be ``tar.gz``; the default ``git-delta``
is a git patch and needs a repo), ``POST /file/upload?path=`` (a single FILE,
multipart field ``file``), ``POST /bash/execute_bash_command``
(``ExecuteBashRequest`` -> ``BashOutput``).

What is NOT verified is the composition against a live agent server. The tests
drive real httpx through ``MockTransport``, so the wire shape — methods, paths,
query params, multipart encoding, headers — is asserted for real; what they
cannot prove is that a running agent server answers those requests the way its
source says it will. Treat a first live run as part of the change.

TWO SHARP EDGES, both handled below
-----------------------------------
``execute_bash_command`` returns ``page.items[-1]`` and ``BashOutput``'s own
docstring says "a single command may have multiple pieces of output depending on
how large the output is". So ``stdout`` can be a LATER FRAGMENT rather than the
whole thing. That is why the CLI prints one short line and why ``_parse_copied``
scans for the last JSON object instead of parsing the whole stream.

``exit_code`` is ``None`` while a command is still running. None is therefore not
success and must never be treated as zero.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

import httpx

from openhands.app_server.app_conversation import (
    fork_conversation_state as _copier_module,
)
from openhands.app_server.app_conversation import fork_state_cli as _cli_module

_logger = logging.getLogger(__name__)

# Where the copier is dropped inside the source sandbox. Under /tmp so it dies
# with the container and never lands in a customer's workspace.
REMOTE_TOOL_DIR = '/tmp/oh-fork'
REMOTE_STAGE_DIR = f'{REMOTE_TOOL_DIR}/out'
REMOTE_ARCHIVE_PATH = '/tmp/oh-fork-in.tar.gz'

_JSON_OBJECT_RE = re.compile(r'\{[^{}]*\}')


class ForkTransportError(RuntimeError):
    """A step failed. Carries enough context to tell WHICH step."""


@dataclass(frozen=True)
class SandboxEndpoint:
    """A sandbox's agent server and the key that reaches it.

    Build with ``_agent_base_url(sandbox)`` and ``sandbox.session_api_key`` from
    ``validate_session_key`` — the same pair every other sandbox-scoped call uses.
    """

    base_url: str
    session_api_key: str

    @property
    def headers(self) -> dict[str, str]:
        return {'X-Session-API-Key': self.session_api_key}


def _parse_copied(stdout: str | None) -> int:
    """The ``{"copied": N}`` the CLI printed, from possibly-fragmented stdout.

    Scans for the LAST JSON object rather than parsing the whole string, because
    stdout may be a fragment and may carry unrelated shell noise. A missing or
    unparseable count is an error, not a zero: "forked nothing" and "could not
    tell" must not collapse into the same value.
    """
    if not stdout:
        raise ForkTransportError(
            'fork CLI produced no stdout, so nothing can be verified'
        )
    candidates = _JSON_OBJECT_RE.findall(stdout)
    for blob in reversed(candidates):
        try:
            payload = json.loads(blob)
        except ValueError:
            continue
        if isinstance(payload, dict) and 'copied' in payload:
            return int(payload['copied'])
        if isinstance(payload, dict) and 'error' in payload:
            raise ForkTransportError(f'fork CLI reported: {payload["error"]}')
    raise ForkTransportError(f'no {{"copied": N}} in fork CLI stdout: {stdout[:400]!r}')


async def _upload(
    client: httpx.AsyncClient,
    sandbox: SandboxEndpoint,
    remote_path: str,
    content: bytes,
    filename: str,
) -> None:
    response = await client.post(
        f'{sandbox.base_url}/file/upload',
        params={'path': remote_path},
        files={'file': (filename, content, 'application/octet-stream')},
        headers=sandbox.headers,
    )
    if response.status_code >= 400:
        raise ForkTransportError(
            f'upload of {remote_path} failed: {response.status_code} '
            f'{response.text[:200]}'
        )


async def _bash(
    client: httpx.AsyncClient,
    sandbox: SandboxEndpoint,
    command: str,
    *,
    timeout: int = 300,
) -> str | None:
    response = await client.post(
        f'{sandbox.base_url}/bash/execute_bash_command',
        json={'command': command, 'timeout': timeout},
        headers=sandbox.headers,
    )
    if response.status_code >= 400:
        raise ForkTransportError(
            f'bash failed: {response.status_code} {response.text[:200]}'
        )
    body = response.json()
    exit_code = body.get('exit_code')
    if exit_code is None:
        # Still running, or the agent server never reported one. Either way we
        # cannot claim the command succeeded.
        raise ForkTransportError(
            f'bash returned no exit code (still running?): {command[:120]!r}'
        )
    if exit_code != 0:
        raise ForkTransportError(
            f'bash exited {exit_code}: {command[:120]!r} '
            f'stderr={(body.get("stderr") or "")[:300]!r}'
        )
    return body.get('stdout')


async def _archive(
    client: httpx.AsyncClient, sandbox: SandboxEndpoint, remote_dir: str
) -> bytes:
    response = await client.get(
        f'{sandbox.base_url}/file/archive',
        params={
            'path': remote_dir,
            # MUST be explicit. The default is git-delta, a git patch of
            # working-tree changes, which needs a repository a conversations
            # directory is not.
            'format': 'tar.gz',
            # The built-in excludes should not match event JSON, but a
            # persistence directory is the wrong place to accept a filter
            # nobody chose.
            'use_default_excludes': 'false',
        },
        headers=sandbox.headers,
    )
    if response.status_code >= 400:
        raise ForkTransportError(
            f'archive of {remote_dir} failed: {response.status_code} '
            f'{response.text[:200]}'
        )
    if not response.content:
        raise ForkTransportError(f'archive of {remote_dir} was empty')
    return response.content


async def transfer_forked_state(
    client: httpx.AsyncClient,
    source: SandboxEndpoint,
    target: SandboxEndpoint,
    conversations_path: str,
    source_conversation_id: UUID,
    target_conversation_id: UUID,
    up_to_event_id: str | None = None,
) -> int:
    """Fork the agent's state from one sandbox into another. Returns event count.

    Raises ForkTransportError with the failing step named. Nothing here is
    idempotent by itself, but every write goes to a path keyed by the TARGET
    conversation id, so a retry overwrites its own previous attempt rather than
    anything else's.
    """
    copier_src = Path(_copier_module.__file__).read_bytes()
    cli_src = Path(_cli_module.__file__).read_bytes()

    # 1-2. Put the tested copier in the source sandbox.
    await _upload(
        client,
        source,
        f'{REMOTE_TOOL_DIR}/fork_conversation_state.py',
        copier_src,
        'fork_conversation_state.py',
    )
    await _upload(
        client,
        source,
        f'{REMOTE_TOOL_DIR}/fork_state_cli.py',
        cli_src,
        'fork_state_cli.py',
    )

    # 3. Run it there, staging the fork under /tmp so the source's own
    #    conversations directory is never written to.
    argv = [
        'python',
        f'{REMOTE_TOOL_DIR}/fork_state_cli.py',
        '--conversations-path',
        _sh(conversations_path),
        '--source-id',
        str(source_conversation_id),
        '--target-id',
        str(target_conversation_id),
        '--target-conversations-path',
        REMOTE_STAGE_DIR,
    ]
    if up_to_event_id:
        argv += ['--up-to-event-id', _sh(up_to_event_id)]
    stdout = await _bash(client, source, ' '.join(argv))
    copied = _parse_copied(stdout)

    # 4-6. Relay the staged tree as an opaque archive.
    archive = await _archive(
        client, source, f'{REMOTE_STAGE_DIR}/{target_conversation_id.hex}'
    )
    await _upload(client, target, REMOTE_ARCHIVE_PATH, archive, 'fork.tar.gz')
    await _bash(
        client,
        target,
        f'mkdir -p {_sh(conversations_path)} '
        f'&& tar xzf {REMOTE_ARCHIVE_PATH} -C {_sh(conversations_path)} '
        f'&& rm -f {REMOTE_ARCHIVE_PATH}',
    )

    # 7. Best effort cleanup. A leftover /tmp directory is not worth failing a
    #    fork that has already landed.
    try:
        await _bash(client, source, f'rm -rf {REMOTE_TOOL_DIR}')
    except ForkTransportError as e:
        _logger.warning('fork: source cleanup failed, continuing: %s', e)

    _logger.info(
        'fork: transferred %d event(s) for conversation %s -> %s',
        copied,
        source_conversation_id,
        target_conversation_id,
    )
    return copied


def _sh(value: str) -> str:
    """Single-quote a value for the remote shell.

    The conversations path and the cutoff id both reach a shell. They are
    server-derived rather than user-typed today, but "derived from a request"
    is one refactor away from "taken from a request", and a quoting bug in a
    command that runs in a customer's sandbox is not a bug worth discovering
    later.
    """
    return "'" + value.replace("'", "'\\''") + "'"
