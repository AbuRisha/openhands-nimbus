"""The fork endpoint's guards.

``fork_app_conversation`` takes plain arguments precisely so this can be tested
without standing up FastAPI. The cases here are the branches where a fork must
REFUSE rather than produce something half-built — a conversation that exists but
whose agent remembers nothing is the failure the whole feature exists to prevent,
so every path that cannot complete has to fail loudly instead.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi import HTTPException

from openhands.app_server.app_conversation import fork_conversation_router as router
from openhands.app_server.app_conversation.fork_conversation import ForkResult
from openhands.app_server.app_conversation.fork_conversation_router import (
    ForkConversationRequest,
    fork_app_conversation,
)
from openhands.app_server.app_conversation.fork_state_transport import (
    ForkTransportError,
)
from openhands.app_server.sandbox.sandbox_models import AGENT_SERVER, SandboxStatus

_MISSING = object()


class _ExposedUrl:
    def __init__(self, name, url):
        self.name = name
        self.url = url


class _Sandbox:
    """_agent_base_url requires an AGENT_SERVER entry; without one it raises 503
    before any guard under test runs, which is how the first draft of this file
    failed seven tests for a reason that had nothing to do with the code."""

    def __init__(self, sandbox_id='sb-1', status=SandboxStatus.RUNNING, key='k'):
        self.id = sandbox_id
        self.status = status
        self.session_api_key = key
        self.exposed_urls = [
            _ExposedUrl(AGENT_SERVER, f'http://{sandbox_id}.invalid:8001')
        ]


class _Info:
    def __init__(self, sandbox_id='sb-1'):
        self.sandbox_id = sandbox_id


class _InfoService:
    def __init__(self, info=None):
        self._info = info

    async def get_app_conversation_info(self, conversation_id):
        return self._info


class _SandboxService:
    def __init__(self, sandboxes: dict):
        self._sandboxes = sandboxes

    async def get_sandbox(self, sandbox_id):
        return self._sandboxes.get(sandbox_id)


class _Task:
    def __init__(self, status, conv_id=None, sandbox_id=None, detail=None):
        self.status = status
        self.app_conversation_id = conv_id
        self.sandbox_id = sandbox_id
        self.detail = detail


class _ConvService:
    def __init__(self, tasks):
        self._tasks = tasks

    async def start_app_conversation(self, request):
        self.request = request
        for t in self._tasks:
            yield t


def _patch_happy(monkeypatch, result=None):
    async def fake_resolve(client, sandbox):
        return '/workspace/conversations'

    async def fake_fork(**kwargs):
        return result or ForkResult(events_in_agent_state=3, events_in_transcript=3)

    monkeypatch.setattr(router, 'resolve_conversations_path', fake_resolve)
    monkeypatch.setattr(router, 'fork_conversation', fake_fork)


async def _call(monkeypatch, *, info=_MISSING, sandboxes=None, tasks=None):
    from openhands.app_server.app_conversation.app_conversation_models import (
        AppConversationStartTaskStatus as S,
    )

    if tasks is None:
        tasks = [_Task(S.READY, conv_id=uuid4(), sandbox_id='sb-2')]
    return await fork_app_conversation(
        uuid4(),
        ForkConversationRequest(up_to_event_id='evt-9'),
        app_conversation_service=_ConvService(tasks),
        app_conversation_info_service=_InfoService(
            _Info() if info is _MISSING else info
        ),
        sandbox_service=_SandboxService(
            sandboxes
            if sandboxes is not None
            else {'sb-1': _Sandbox('sb-1'), 'sb-2': _Sandbox('sb-2')}
        ),
        event_service=object(),
        httpx_client=object(),
    )


class TestItRefusesRatherThanHalfBuilding:
    @pytest.mark.asyncio
    async def test_unknown_source_conversation_is_404(self, monkeypatch):
        _patch_happy(monkeypatch)
        with pytest.raises(HTTPException) as e:
            await _call(monkeypatch, info=None)
        assert e.value.status_code == 404

    @pytest.mark.asyncio
    async def test_source_sandbox_not_running_is_409_and_says_to_start_it(
        self, monkeypatch
    ):
        """A stopped parent cannot be forked: its state cannot be read cold."""
        _patch_happy(monkeypatch)
        with pytest.raises(HTTPException) as e:
            await _call(
                monkeypatch,
                sandboxes={'sb-1': _Sandbox('sb-1', status=SandboxStatus.PAUSED)},
            )
        assert e.value.status_code == 409
        assert 'Start the conversation before forking' in e.value.detail

    @pytest.mark.asyncio
    async def test_missing_source_sandbox_is_404(self, monkeypatch):
        _patch_happy(monkeypatch)
        with pytest.raises(HTTPException) as e:
            await _call(monkeypatch, sandboxes={})
        assert e.value.status_code == 404

    @pytest.mark.asyncio
    async def test_sandbox_without_a_session_key_is_409_not_a_crash(self, monkeypatch):
        """session_api_key is None for STARTING/PAUSED or partial access."""
        _patch_happy(monkeypatch)
        with pytest.raises(HTTPException) as e:
            await _call(monkeypatch, sandboxes={'sb-1': _Sandbox('sb-1', key=None)})
        assert e.value.status_code == 409

    @pytest.mark.asyncio
    async def test_target_that_fails_to_start_is_502(self, monkeypatch):
        from openhands.app_server.app_conversation.app_conversation_models import (
            AppConversationStartTaskStatus as S,
        )

        _patch_happy(monkeypatch)
        with pytest.raises(HTTPException) as e:
            await _call(monkeypatch, tasks=[_Task(S.ERROR, detail='no capacity')])
        assert e.value.status_code == 502
        assert 'no capacity' in e.value.detail

    @pytest.mark.asyncio
    async def test_ready_without_a_conversation_id_is_502(self, monkeypatch):
        from openhands.app_server.app_conversation.app_conversation_models import (
            AppConversationStartTaskStatus as S,
        )

        _patch_happy(monkeypatch)
        with pytest.raises(HTTPException) as e:
            await _call(
                monkeypatch, tasks=[_Task(S.READY, conv_id=None, sandbox_id='sb-2')]
            )
        assert e.value.status_code == 502

    @pytest.mark.asyncio
    async def test_transport_failure_is_502_and_names_the_conversation(
        self, monkeypatch
    ):
        async def fake_resolve(client, sandbox):
            return '/workspace/conversations'

        async def boom(**kwargs):
            raise ForkTransportError('archive was empty')

        monkeypatch.setattr(router, 'resolve_conversations_path', fake_resolve)
        monkeypatch.setattr(router, 'fork_conversation', boom)

        with pytest.raises(HTTPException) as e:
            await _call(monkeypatch)
        assert e.value.status_code == 502
        assert 'archive was empty' in e.value.detail


class TestHappyPath:
    @pytest.mark.asyncio
    async def test_returns_both_counts_and_the_new_conversation(self, monkeypatch):
        _patch_happy(monkeypatch)
        result = await _call(monkeypatch)
        assert result.events_in_agent_state == 3
        assert result.events_in_transcript == 3
        assert result.halves_agree is True
        assert result.sandbox_id == 'sb-2'

    @pytest.mark.asyncio
    async def test_a_half_mismatch_is_surfaced_not_hidden(self, monkeypatch):
        """The fork is still returned; the disagreement is reported to the caller."""
        _patch_happy(
            monkeypatch,
            result=ForkResult(events_in_agent_state=5, events_in_transcript=3),
        )
        result = await _call(monkeypatch)
        assert result.halves_agree is False
        assert (result.events_in_agent_state, result.events_in_transcript) == (5, 3)

    @pytest.mark.asyncio
    async def test_the_fork_records_its_parent(self, monkeypatch):
        """parent_conversation_id is why the field exists on the start request."""
        from openhands.app_server.app_conversation.app_conversation_models import (
            AppConversationStartTaskStatus as S,
        )

        _patch_happy(monkeypatch)
        source_id = uuid4()
        conv_service = _ConvService(
            [_Task(S.READY, conv_id=uuid4(), sandbox_id='sb-2')]
        )
        await fork_app_conversation(
            source_id,
            ForkConversationRequest(),
            app_conversation_service=conv_service,
            app_conversation_info_service=_InfoService(_Info()),
            sandbox_service=_SandboxService(
                {'sb-1': _Sandbox('sb-1'), 'sb-2': _Sandbox('sb-2')}
            ),
            event_service=object(),
            httpx_client=object(),
        )
        assert conv_service.request.parent_conversation_id == source_id
