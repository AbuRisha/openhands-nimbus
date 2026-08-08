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

The sharpest of those unknowns is the archive's member framing: whether the
tarball's paths are relative to the archived directory or include it. Guess wrong
and ``tar`` still exits 0 while the state lands one level off, which reads as a
successful fork whose agent remembers nothing. Rather than leave that as a
caveat, ``_verify_landed`` checks the TARGET for the state the agent will
actually open, so the wrong framing fails loudly on the first real fork instead
of shipping an amnesiac one.

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
from openhands.sdk.conversation.persistence_const import BASE_STATE, EVENTS_DIR

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


def _parse_landed(stdout: str | None) -> tuple[bool, int]:
    """The ``{"base": 0|1, "events": N}`` the target-side probe printed.

    Same fragmentation caveat as ``_parse_copied``, same rule: an unreadable
    answer is an error, never an optimistic default.
    """
    if not stdout:
        raise ForkTransportError(
            'target did not report what landed, so the fork cannot be confirmed'
        )
    for blob in reversed(_JSON_OBJECT_RE.findall(stdout)):
        try:
            payload = json.loads(blob)
        except ValueError:
            continue
        if isinstance(payload, dict) and 'base' in payload and 'events' in payload:
            return bool(int(payload['base'])), int(payload['events'])
    raise ForkTransportError(
        f'target verification produced no readable result: {stdout[:400]!r}'
    )


async def _verify_landed(
    client: httpx.AsyncClient,
    target: SandboxEndpoint,
    conversations_path: str,
    target_conversation_id: UUID,
    expected_events: int,
) -> None:
    """Confirm on the TARGET that the state is where the agent will look for it.

    WHY THIS EXISTS. Everything before this point is evidence from the SOURCE:
    the copied count comes from the copier's own stdout, and ``tar`` exiting 0
    only says extraction ran, not that it landed at the depth we assumed. The
    archive's member framing is read from the agent server's source, not
    observed -- and if it unpacks one level off, ``tar`` still exits 0, this
    function's caller still returns N, and the fork is a complete-looking
    conversation whose agent remembers nothing. That is the exact failure the
    whole feature exists to prevent, so it is checked rather than assumed.

    The probe always exits 0 and reports facts, so a missing directory is a
    parsed answer rather than a cryptic non-zero exit.
    """
    state_dir = f'{conversations_path.rstrip("/")}/{target_conversation_id.hex}'
    base_path = f'{state_dir}/{BASE_STATE}'
    events_path = f'{state_dir}/{EVENTS_DIR}'
    stdout = await _bash(
        client,
        target,
        'printf \'{"base": %s, "events": %s}\\n\' '
        f'"$(test -f {_sh(base_path)} && echo 1 || echo 0)" '
        f'"$(ls -1 {_sh(events_path)} 2>/dev/null | wc -l | tr -d \' \')"',
    )
    has_base, landed = _parse_landed(stdout)
    if not has_base:
        raise ForkTransportError(
            f'fork state did not land in the target: {base_path} is missing after '
            'extraction, so the agent would start with no memory. The archive '
            'most likely unpacked at a different depth than expected.'
        )
    if landed != expected_events:
        raise ForkTransportError(
            f'fork state landed incompletely: {expected_events} event(s) were '
            f'staged in the source but {landed} arrived in {events_path}'
        )


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

    The returned count is only reached if the state was confirmed present in the
    TARGET (step 7). A count sourced purely from the copier's own stdout would
    assert a fork that extraction may have put somewhere else.

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

    # 7. Confirm it landed, on the TARGET. Everything above is source-side
    #    evidence; without this the return value asserts a fork that may not
    #    exist. Raising here is what keeps the transcript from being written.
    await _verify_landed(
        client, target, conversations_path, target_conversation_id, copied
    )

    # 8. Best effort cleanup. A leftover /tmp directory is not worth failing a
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


async def resolve_conversations_path(
    client: httpx.AsyncClient, sandbox: SandboxEndpoint
) -> str:
    """Ask the sandbox where its conversations directory is, as an ABSOLUTE path.

    Not hardcoded, for two reasons that would each produce a silently empty fork.

    ``AgentServerConfig.conversations_path`` defaults to
    ``Path("workspace/conversations")`` — RELATIVE, so its meaning depends on the
    agent server's working directory, which the app server does not know. And
    ``GET /file/archive`` documents ``path`` as "Absolute path of the directory to
    archive". Resolving it anywhere but inside the sandbox is guesswork.

    A deployment may also override it, in which case a constant here would be
    wrong in exactly the way that copies zero events and reports success.
    """
    stdout = await _bash(
        client,
        sandbox,
        'python -c "from openhands.agent_server.config import get_default_config'
        ' as c; print(c().conversations_path.resolve())"',
    )
    lines = [line.strip() for line in (stdout or '').splitlines() if line.strip()]
    if not lines:
        raise ForkTransportError(
            'sandbox did not report its conversations_path; cannot fork blind'
        )
    path = lines[-1]
    if not path.startswith('/'):
        # Sandboxes are Linux containers, so an absolute path starts with '/'.
        # Anything else means we captured shell noise rather than the answer, and
        # forking against it would archive nothing.
        raise ForkTransportError(
            f'sandbox reported a non-absolute conversations_path: {path!r}'
        )
    return path
