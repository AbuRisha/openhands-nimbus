"""The workspace listing endpoint the @-mention picker needs.

The load-bearing property is not "does it list files" but **the caller's query
never reaches a shell**. This endpoint exists because ``/api/bash/*`` is
deliberately not proxied to the browser; an implementation that interpolated
``q`` into the command would hand back exactly the arbitrary execution that
decision refused, through a door labelled "file picker".
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from openhands.app_server.app_conversation import workspace_search_router as mod
from openhands.app_server.app_conversation.fork_state_transport import (
    ForkTransportError,
)
from openhands.app_server.sandbox.sandbox_models import SandboxStatus


class TestTheCommandIsNotCallerControlled:
    """The whole security posture of the module, in three tests."""

    def test_the_query_appears_nowhere_in_the_command(self):
        # If this ever fails, the module has become an execution endpoint.
        assert 'q' not in mod._LIST_COMMAND.split()
        assert '{' not in mod._LIST_COMMAND
        assert '%s' not in mod._LIST_COMMAND

    @pytest.mark.parametrize(
        'hostile',
        [
            '; rm -rf /',
            '$(cat /etc/passwd)',
            '`id`',
            "' ; curl evil.test ; '",
            '&& echo pwned',
        ],
    )
    def test_a_hostile_query_is_only_ever_a_substring(self, hostile):
        """Shell metacharacters are matched literally, never evaluated.

        `_rank` is plain Python, so the only thing a query can do is fail to
        match. Pinned per-payload rather than in prose.
        """
        matches, _ = mod._rank(['src/app.ts', 'README.md'], hostile, 50)

        assert matches == []

    def test_the_listing_is_capped_inside_the_sandbox(self):
        """A monorepo's full path list must not be pulled across to be discarded."""
        assert f'head -n {mod._LISTING_CEILING}' in mod._LIST_COMMAND


class TestRanking:
    PATHS = [
        'src/router/index.ts',
        'src/router.ts',
        'docs/router-design.md',
        'src/app.ts',
    ]

    def test_basename_matches_outrank_path_matches(self):
        """Typing "router" means the file called router, far more often than
        every file that happens to live under src/router/."""
        matches, _ = mod._rank(self.PATHS, 'router', 50)

        assert matches[0] == 'src/router.ts'
        assert matches[1] == 'docs/router-design.md'
        assert 'src/router/index.ts' in matches

    def test_matching_is_case_insensitive(self):
        matches, _ = mod._rank(['src/App.tsx'], 'app', 50)

        assert matches == ['src/App.tsx']

    def test_an_empty_query_lists_rather_than_matching_nothing(self):
        """A picker opens before anything is typed; an empty state there reads
        as an empty workspace."""
        matches, _ = mod._rank(self.PATHS, '', 50)

        assert len(matches) == len(self.PATHS)

    def test_a_whitespace_query_is_treated_as_empty(self):
        matches, _ = mod._rank(self.PATHS, '   ', 50)

        assert len(matches) == len(self.PATHS)

    def test_truncation_is_reported_rather_than_silent(self):
        """A silent cut reads as "no such file" — the user retypes a query that
        was already correct."""
        matches, truncated = mod._rank(self.PATHS, '', 2)

        assert len(matches) == 2
        assert truncated is True

    def test_not_truncated_when_everything_fits(self):
        _, truncated = mod._rank(self.PATHS, '', 50)

        assert truncated is False


class _Info:
    def __init__(self, sandbox_id):
        self.sandbox_id = sandbox_id


class _InfoService:
    def __init__(self, info):
        self._info = info

    async def get_app_conversation_info(self, _id):
        return self._info


class _Sandbox:
    def __init__(self, status=SandboxStatus.RUNNING, key='sk-1'):
        self.id = 'sb-1'
        self.status = status
        self.session_api_key = key
        self.exposed_urls = []


class _SandboxService:
    def __init__(self, sandbox):
        self._sandbox = sandbox

    async def get_sandbox(self, _id):
        return self._sandbox


async def _call(monkeypatch, *, info, sandbox, stdout='', boom=None, q='', limit=50):
    async def _fake_bash(_client, _endpoint, _command, timeout=300):  # noqa: ARG001
        if boom:
            raise boom
        return stdout

    monkeypatch.setattr(mod, '_bash', _fake_bash)
    monkeypatch.setattr(mod, '_endpoint_for', lambda _s: object())

    return await mod.search_workspace_files(
        'conv-1',
        q,
        limit,
        app_conversation_info_service=_InfoService(info),
        sandbox_service=_SandboxService(sandbox),
        httpx_client=None,
    )


class TestEndpointBehaviour:
    @pytest.mark.asyncio
    async def test_lists_what_the_sandbox_reported(self, monkeypatch):
        page = await _call(
            monkeypatch,
            info=_Info('sb-1'),
            sandbox=_Sandbox(),
            stdout='src/app.ts\nREADME.md\n',
        )

        assert [i.path for i in page.items] == ['src/app.ts', 'README.md']
        assert [i.name for i in page.items] == ['app.ts', 'README.md']

    @pytest.mark.asyncio
    async def test_blank_lines_do_not_become_entries(self, monkeypatch):
        """`head` and shell noise leave trailing newlines; an empty path in a
        picker is a row that cannot be clicked."""
        page = await _call(
            monkeypatch,
            info=_Info('sb-1'),
            sandbox=_Sandbox(),
            stdout='src/app.ts\n\n   \nREADME.md\n',
        )

        assert len(page.items) == 2

    @pytest.mark.asyncio
    async def test_an_unknown_conversation_is_404(self, monkeypatch):
        with pytest.raises(HTTPException) as excinfo:
            await _call(monkeypatch, info=None, sandbox=_Sandbox())

        assert excinfo.value.status_code == 404

    @pytest.mark.asyncio
    async def test_a_stopped_sandbox_is_409_not_an_empty_list(self, monkeypatch):
        """An empty list would say "this workspace has no files", which is a
        different and wrong statement."""
        with pytest.raises(HTTPException) as excinfo:
            await _call(
                monkeypatch,
                info=_Info('sb-1'),
                sandbox=_Sandbox(status=SandboxStatus.PAUSED),
            )

        assert excinfo.value.status_code == 409

    @pytest.mark.asyncio
    async def test_a_sandbox_failure_is_502_not_500(self, monkeypatch):
        """The failure is the sandbox's. The distinction is what tells an
        operator which side to look at."""
        with pytest.raises(HTTPException) as excinfo:
            await _call(
                monkeypatch,
                info=_Info('sb-1'),
                sandbox=_Sandbox(),
                boom=ForkTransportError('agent server said no'),
            )

        assert excinfo.value.status_code == 502

    @pytest.mark.asyncio
    async def test_the_sandbox_error_text_is_not_returned_to_the_caller(
        self, monkeypatch
    ):
        """It can carry internal hosts and paths, same as the 1011 close reason."""
        with pytest.raises(HTTPException) as excinfo:
            await _call(
                monkeypatch,
                info=_Info('sb-1'),
                sandbox=_Sandbox(),
                boom=ForkTransportError('dial tcp 10.0.0.7:8001 refused'),
            )

        assert '10.0.0.7' not in str(excinfo.value.detail)

    @pytest.mark.asyncio
    async def test_a_conversation_with_no_sandbox_is_409(self, monkeypatch):
        with pytest.raises(HTTPException) as excinfo:
            await _call(monkeypatch, info=_Info(None), sandbox=_Sandbox())

        assert excinfo.value.status_code == 409

    @pytest.mark.asyncio
    async def test_a_sandbox_the_service_will_not_return_is_404(self, monkeypatch):
        """Pins the interaction with sandbox-listing ownership scoping.

        Once `get_sandbox` filters on `process_info.user_id == self.user_id`, a
        sandbox this caller does not own resolves to None here. 404 is the right
        answer — the same one a nonexistent id gets, so the response does not
        confirm that someone else's sandbox exists.

        The combination worth watching is MIXED: a sandbox started without a
        user id, later read by an authenticated caller, would take this branch
        for a conversation the user legitimately owns. Not believed reachable —
        `start_sandbox` stamps `self.user_id` and the gate requires auth — but
        the failure would present as "sandbox not found" on your own
        conversation, which is a confusing enough symptom to name here rather
        than rediscover.
        """
        with pytest.raises(HTTPException) as excinfo:
            await _call(monkeypatch, info=_Info('sb-1'), sandbox=None)

        assert excinfo.value.status_code == 404
