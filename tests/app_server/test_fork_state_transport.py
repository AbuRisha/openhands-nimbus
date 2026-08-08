"""The fork transport, driven through real httpx.

These use ``httpx.MockTransport`` rather than hand-rolled fakes, so every request
is genuinely built by httpx: query params are really encoded, multipart bodies are
really assembled, headers really applied. That means the tests assert the WIRE
SHAPE, which is the part a live agent server will judge us on.

What they still cannot prove is that a running agent server answers those
requests as its source says. That gap is stated in the module docstring and is
why a first live run is part of the change rather than a follow-up.

The cases that matter most here are the failure ones. A fork that silently
half-succeeds presents as an agent that has forgotten things, which is
indistinguishable from the bug the whole feature exists to fix — so "could not
tell" must never collapse into "copied nothing".
"""

from __future__ import annotations

import json
import re
from uuid import uuid4

import httpx
import pytest

from openhands.app_server.app_conversation.fork_state_transport import (
    REMOTE_ARCHIVE_PATH,
    REMOTE_STAGE_DIR,
    REMOTE_TOOL_DIR,
    ForkTransportError,
    SandboxEndpoint,
    _parse_copied,
    _parse_landed,
    transfer_forked_state,
)

SOURCE = SandboxEndpoint(base_url='http://src.invalid', session_api_key='key-src')
TARGET = SandboxEndpoint(base_url='http://tgt.invalid', session_api_key='key-tgt')
CONVERSATIONS = '/workspace/conversations'


def _bash_response(exit_code, stdout) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            'command_id': str(uuid4()),
            'order': 0,
            'exit_code': exit_code,
            'stdout': stdout,
            'stderr': None,
        },
    )


def _recorder(
    *,
    bash_stdout: str = '{"copied": 4}',
    bash_exit: int | None = 0,
    archive_body: bytes = b'\x1f\x8b_fake_tarball',
    fail: dict[str, int] | None = None,
    landed_base: int = 1,
    landed_events: int | None = None,
):
    """A MockTransport that records requests and can fail a chosen path.

    The target-side verification probe is answered separately from the copier,
    and by default answers CONSISTENTLY with it: the landed event count is read
    back out of ``bash_stdout`` so the mock cannot accidentally describe a
    sandbox where the fork half-arrived. Pass ``landed_base``/``landed_events``
    to describe one deliberately.
    """
    seen: list[httpx.Request] = []
    fail = fail or {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path = request.url.path
        for needle, code in fail.items():
            if needle in path:
                return httpx.Response(code, text='boom')
        if path.endswith('/file/upload'):
            return httpx.Response(200, json={'success': True})
        if path.endswith('/bash/execute_bash_command'):
            command = json.loads(request.content).get('command', '')
            if command.startswith('printf'):
                # The probe is built to always exit 0 and report facts, so it is
                # answered that way here rather than through bash_exit.
                events = landed_events
                if events is None:
                    match = re.search(r'"copied":\s*(\d+)', bash_stdout)
                    events = int(match.group(1)) if match else 0
                return _bash_response(
                    0, f'{{"base": {landed_base}, "events": {events}}}'
                )
            return _bash_response(bash_exit, bash_stdout)
        if path.endswith('/file/archive'):
            return httpx.Response(200, content=archive_body)
        return httpx.Response(404, text=f'unexpected {path}')

    return seen, httpx.MockTransport(handler)


async def _run(seen_transport, **kwargs):
    seen, transport = seen_transport
    async with httpx.AsyncClient(transport=transport) as client:
        result = await transfer_forked_state(
            client=client,
            source=SOURCE,
            target=TARGET,
            conversations_path=CONVERSATIONS,
            source_conversation_id=kwargs.pop('src', uuid4()),
            target_conversation_id=kwargs.pop('tgt', uuid4()),
            **kwargs,
        )
    return result, seen


class TestTheHappyPathMakesExactlyTheRightCalls:
    @pytest.mark.asyncio
    async def test_returns_the_copied_count(self):
        copied, _ = await _run(_recorder(bash_stdout='{"copied": 4}'))
        assert copied == 4

    @pytest.mark.asyncio
    async def test_uploads_both_modules_to_the_source_then_runs_them(self):
        src, tgt = uuid4(), uuid4()
        _, seen = await _run(_recorder(), src=src, tgt=tgt)

        uploads = [r for r in seen if r.url.path.endswith('/file/upload')]
        # Two into the source, one archive into the target.
        assert len(uploads) == 3
        assert str(uploads[0].url).startswith(SOURCE.base_url)
        assert uploads[0].url.params['path'] == (
            f'{REMOTE_TOOL_DIR}/fork_conversation_state.py'
        )
        assert uploads[1].url.params['path'] == f'{REMOTE_TOOL_DIR}/fork_state_cli.py'
        # The copier is uploaded as real bytes, not a stub.
        assert b'def fork_conversation_state' in uploads[0].content

        assert str(uploads[2].url).startswith(TARGET.base_url)
        assert uploads[2].url.params['path'] == REMOTE_ARCHIVE_PATH

    @pytest.mark.asyncio
    async def test_each_sandbox_gets_its_own_session_key(self):
        _, seen = await _run(_recorder())
        for request in seen:
            expected = (
                SOURCE.session_api_key
                if str(request.url).startswith(SOURCE.base_url)
                else TARGET.session_api_key
            )
            assert request.headers['X-Session-API-Key'] == expected

    @pytest.mark.asyncio
    async def test_archive_is_requested_as_targz_not_the_git_delta_default(self):
        """The default format is a git patch and would fail on a non-repo."""
        _, seen = await _run(_recorder())
        archive = next(r for r in seen if r.url.path.endswith('/file/archive'))
        assert archive.url.params['format'] == 'tar.gz'
        assert archive.url.params['use_default_excludes'] == 'false'

    @pytest.mark.asyncio
    async def test_archives_the_staged_tree_not_the_sources_own_directory(self):
        """The source's conversations dir must never be archived or written."""
        src, tgt = uuid4(), uuid4()
        _, seen = await _run(_recorder(), src=src, tgt=tgt)
        archive = next(r for r in seen if r.url.path.endswith('/file/archive'))
        assert archive.url.params['path'] == f'{REMOTE_STAGE_DIR}/{tgt.hex}'

    @pytest.mark.asyncio
    async def test_cutoff_is_forwarded_only_when_given(self):
        _, seen = await _run(_recorder(), up_to_event_id='abc-123')
        cmd = json.loads(
            next(
                r for r in seen if r.url.path.endswith('/bash/execute_bash_command')
            ).content
        )['command']
        assert "--up-to-event-id 'abc-123'" in cmd

        _, seen2 = await _run(_recorder())
        cmd2 = json.loads(
            next(
                r for r in seen2 if r.url.path.endswith('/bash/execute_bash_command')
            ).content
        )['command']
        assert '--up-to-event-id' not in cmd2

    @pytest.mark.asyncio
    async def test_target_extraction_runs_on_the_target_sandbox(self):
        _, seen = await _run(_recorder())
        bashes = [r for r in seen if r.url.path.endswith('/bash/execute_bash_command')]
        target_cmds = [
            json.loads(b.content)['command']
            for b in bashes
            if str(b.url).startswith(TARGET.base_url)
        ]
        # Extraction, then the verification probe.
        assert len(target_cmds) == 2
        assert 'tar xzf' in target_cmds[0] and CONVERSATIONS in target_cmds[0]

    @pytest.mark.asyncio
    async def test_it_verifies_on_the_target_that_the_state_actually_landed(self):
        """The count from the source proves nothing about where tar put things."""
        tgt = uuid4()
        _, seen = await _run(_recorder(), tgt=tgt)
        probes = [
            json.loads(r.content)['command']
            for r in seen
            if r.url.path.endswith('/bash/execute_bash_command')
            and str(r.url).startswith(TARGET.base_url)
            and json.loads(r.content)['command'].startswith('printf')
        ]
        assert len(probes) == 1
        # It must look where the AGENT will look, not where we staged.
        assert f'{CONVERSATIONS}/{tgt.hex}/base_state.json' in probes[0]
        assert f'{CONVERSATIONS}/{tgt.hex}/events' in probes[0]


class TestFailuresAreLoudAndNamed:
    @pytest.mark.asyncio
    async def test_upload_failure_raises(self):
        with pytest.raises(ForkTransportError, match='upload'):
            await _run(_recorder(fail={'/file/upload': 500}))

    @pytest.mark.asyncio
    async def test_archive_failure_raises(self):
        with pytest.raises(ForkTransportError, match='archive'):
            await _run(_recorder(fail={'/file/archive': 500}))

    @pytest.mark.asyncio
    async def test_nonzero_exit_raises_rather_than_reporting_zero_events(self):
        with pytest.raises(ForkTransportError, match='exited 2'):
            await _run(_recorder(bash_exit=2, bash_stdout=''))

    @pytest.mark.asyncio
    async def test_missing_exit_code_is_not_treated_as_success(self):
        """exit_code None means still running. None is not zero."""
        with pytest.raises(ForkTransportError, match='no exit code'):
            await _run(_recorder(bash_exit=None))

    @pytest.mark.asyncio
    async def test_empty_archive_raises(self):
        with pytest.raises(ForkTransportError, match='empty'):
            await _run(_recorder(archive_body=b''))

    @pytest.mark.asyncio
    async def test_cli_error_payload_is_surfaced(self):
        with pytest.raises(ForkTransportError, match='ForkStateError'):
            await _run(_recorder(bash_stdout='{"error": "ForkStateError: no state"}'))

    @pytest.mark.asyncio
    async def test_a_target_missing_base_state_is_a_failure_not_a_reported_success(
        self,
    ):
        """tar can exit 0 having unpacked at the wrong depth.

        Without the target-side check this returned a healthy count for a fork
        whose agent would start with no memory at all.
        """
        with pytest.raises(ForkTransportError, match='did not land'):
            await _run(_recorder(landed_base=0))

    @pytest.mark.asyncio
    async def test_a_partially_landed_fork_is_a_failure(self):
        """4 staged, 1 arrived: an agent that has silently forgotten things."""
        with pytest.raises(ForkTransportError, match='landed incompletely'):
            await _run(_recorder(bash_stdout='{"copied": 4}', landed_events=1))

    @pytest.mark.asyncio
    async def test_cleanup_failure_does_not_fail_a_landed_fork(self):
        """The fork is already in the target; a stale /tmp dir is not worth losing it."""
        calls = {'n': 0}

        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            if path.endswith('/file/upload'):
                return httpx.Response(200, json={'ok': True})
            if path.endswith('/file/archive'):
                return httpx.Response(200, content=b'tar')
            if path.endswith('/bash/execute_bash_command'):
                calls['n'] += 1
                body = json.loads(request.content)['command']
                if body.startswith('rm -rf'):
                    return httpx.Response(500, text='cleanup denied')
                if body.startswith('printf'):
                    return _bash_response(0, '{"base": 1, "events": 1}')
                return _bash_response(0, '{"copied": 1}')
            return httpx.Response(404)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            copied = await transfer_forked_state(
                client=client,
                source=SOURCE,
                target=TARGET,
                conversations_path=CONVERSATIONS,
                source_conversation_id=uuid4(),
                target_conversation_id=uuid4(),
            )
        assert copied == 1


class TestParseCopied:
    """stdout may be a FRAGMENT: execute_bash_command returns items[-1] and a
    command may emit several outputs. So the count is scanned for, not assumed
    to be the whole stream."""

    def test_plain(self):
        assert _parse_copied('{"copied": 7}') == 7

    def test_surrounded_by_shell_noise(self):
        assert _parse_copied('warning: whatever\n{"copied": 2}\n') == 2

    def test_last_object_wins(self):
        assert _parse_copied('{"copied": 1}\n{"copied": 9}') == 9

    def test_no_stdout_is_an_error_not_zero(self):
        with pytest.raises(ForkTransportError, match='no stdout'):
            _parse_copied(None)

    def test_unparseable_is_an_error_not_zero(self):
        with pytest.raises(ForkTransportError, match='no .*copied'):
            _parse_copied('Traceback (most recent call last): ...')

    def test_zero_is_a_legitimate_count_and_is_returned(self):
        assert _parse_copied('{"copied": 0}') == 0


class TestParseLanded:
    def test_plain(self):
        assert _parse_landed('{"base": 1, "events": 12}') == (True, 12)

    def test_absent_base_state_is_reported_as_such(self):
        assert _parse_landed('{"base": 0, "events": 0}') == (False, 0)

    def test_surrounded_by_shell_noise(self):
        assert _parse_landed('ls: no such dir\n{"base": 1, "events": 3}\n') == (True, 3)

    def test_no_stdout_is_an_error(self):
        with pytest.raises(ForkTransportError, match='did not report'):
            _parse_landed(None)

    def test_unreadable_is_an_error_not_an_assumed_success(self):
        with pytest.raises(ForkTransportError, match='no readable result'):
            _parse_landed('Traceback (most recent call last): ...')

    def test_the_copied_payload_is_not_mistaken_for_a_landing_report(self):
        """Both probes emit JSON; only one answers this question."""
        with pytest.raises(ForkTransportError, match='no readable result'):
            _parse_landed('{"copied": 4}')


class TestShellQuoting:
    @pytest.mark.asyncio
    async def test_a_path_with_a_quote_cannot_break_out_of_the_command(self):
        seen, transport = _recorder()
        async with httpx.AsyncClient(transport=transport) as client:
            await transfer_forked_state(
                client=client,
                source=SOURCE,
                target=TARGET,
                conversations_path="/tmp/it's here; rm -rf /",
                source_conversation_id=uuid4(),
                target_conversation_id=uuid4(),
            )
        cmd = json.loads(
            next(
                r for r in seen if r.url.path.endswith('/bash/execute_bash_command')
            ).content
        )['command']
        # The semicolon survives only INSIDE quotes, so the shell cannot see it
        # as a command separator.
        assert "'/tmp/it'\\''s here; rm -rf /'" in cmd
