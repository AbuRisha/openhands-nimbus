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
    transfer_forked_state,
)

SOURCE = SandboxEndpoint(base_url='http://src.invalid', session_api_key='key-src')
TARGET = SandboxEndpoint(base_url='http://tgt.invalid', session_api_key='key-tgt')
CONVERSATIONS = '/workspace/conversations'


def _recorder(
    *,
    bash_stdout: str = '{"copied": 4}',
    bash_exit: int | None = 0,
    archive_body: bytes = b'\x1f\x8b_fake_tarball',
    fail: dict[str, int] | None = None,
):
    """A MockTransport that records requests and can fail a chosen path."""
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
            return httpx.Response(
                200,
                json={
                    'command_id': str(uuid4()),
                    'order': 0,
                    'exit_code': bash_exit,
                    'stdout': bash_stdout,
                    'stderr': None,
                },
            )
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
        target_bash = [b for b in bashes if str(b.url).startswith(TARGET.base_url)]
        assert len(target_bash) == 1
        cmd = json.loads(target_bash[0].content)['command']
        assert 'tar xzf' in cmd and CONVERSATIONS in cmd


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
                return httpx.Response(
                    200,
                    json={
                        'command_id': str(uuid4()),
                        'order': 0,
                        'exit_code': 0,
                        'stdout': '{"copied": 1}',
                        'stderr': None,
                    },
                )
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
