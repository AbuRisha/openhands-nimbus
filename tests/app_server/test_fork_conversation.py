"""The fork composer, and the ordering property that is its whole point.

The load-bearing test is ``test_transcript_is_not_written_when_state_fails``. If
the mirror were written first and the state transfer then failed, the fork would
present as COMPLETE — full transcript, agent that remembers none of it — which is
exactly the failure the feature exists to fix, reintroduced silently by the
wiring. State first means a failure presents as an EMPTY fork, which someone
reports.
"""

from __future__ import annotations

import logging
from uuid import uuid4

import pytest

from openhands.app_server.app_conversation import fork_conversation as module
from openhands.app_server.app_conversation.fork_conversation import (
    ForkError,
    ForkResult,
    fork_conversation,
)
from openhands.app_server.app_conversation.fork_state_transport import (
    ForkTransportError,
    SandboxEndpoint,
)

SOURCE = SandboxEndpoint(base_url='http://src.invalid', session_api_key='k1')
TARGET = SandboxEndpoint(base_url='http://tgt.invalid', session_api_key='k2')


class _FakeEventService:
    def __init__(self, copied: int = 3):
        self._copied = copied
        self.calls: list[dict] = []

    async def copy_events_until(self, **kwargs):
        self.calls.append(kwargs)
        return self._copied


async def _call(monkeypatch, *, state_result=3, transcript_result=3, state_error=None):
    async def fake_transfer(**kwargs):
        if state_error:
            raise state_error
        return state_result

    monkeypatch.setattr(module, 'transfer_forked_state', fake_transfer)
    events = _FakeEventService(transcript_result)
    src, tgt = uuid4(), uuid4()
    result = await fork_conversation(
        event_service=events,
        httpx_client=None,  # unused: transfer is stubbed
        source_sandbox=SOURCE,
        target_sandbox=TARGET,
        conversations_path='/workspace/conversations',
        source_conversation_id=src,
        target_conversation_id=tgt,
        up_to_event_id='evt-1',
    )
    return result, events, src, tgt


class TestOrderingFailsSafely:
    @pytest.mark.asyncio
    async def test_transcript_is_not_written_when_state_fails(self, monkeypatch):
        """The whole reason state goes first.

        A fork with a transcript and no agent memory looks finished and is
        silently broken. A fork with neither looks broken and gets reported.
        """

        async def fake_transfer(**kwargs):
            raise ForkTransportError('archive of /tmp/... was empty')

        monkeypatch.setattr(module, 'transfer_forked_state', fake_transfer)
        events = _FakeEventService()

        with pytest.raises(ForkError, match='not usable'):
            await fork_conversation(
                event_service=events,
                httpx_client=None,
                source_sandbox=SOURCE,
                target_sandbox=TARGET,
                conversations_path='/c',
                source_conversation_id=uuid4(),
                target_conversation_id=uuid4(),
            )

        assert events.calls == [], (
            'the transcript must NOT be mirrored when the agent state failed, '
            'or the fork presents as complete while the agent remembers nothing'
        )

    @pytest.mark.asyncio
    async def test_the_error_names_the_unusable_fork(self, monkeypatch):
        async def fake_transfer(**kwargs):
            raise ForkTransportError('boom')

        monkeypatch.setattr(module, 'transfer_forked_state', fake_transfer)
        tgt = uuid4()
        with pytest.raises(ForkError) as excinfo:
            await fork_conversation(
                event_service=_FakeEventService(),
                httpx_client=None,
                source_sandbox=SOURCE,
                target_sandbox=TARGET,
                conversations_path='/c',
                source_conversation_id=uuid4(),
                target_conversation_id=tgt,
            )
        assert str(tgt) in str(excinfo.value)


class TestHappyPath:
    @pytest.mark.asyncio
    async def test_both_halves_run_and_counts_are_returned(self, monkeypatch):
        result, events, src, tgt = await _call(monkeypatch)
        assert result == ForkResult(events_in_agent_state=3, events_in_transcript=3)
        assert result.halves_agree
        assert len(events.calls) == 1

    @pytest.mark.asyncio
    async def test_cutoff_is_passed_to_the_mirror_unchanged(self, monkeypatch):
        _, events, src, tgt = await _call(monkeypatch)
        assert events.calls[0] == {
            'source_conversation_id': src,
            'target_conversation_id': tgt,
            'up_to_event_id': 'evt-1',
        }


class TestHalvesDisagreeing:
    @pytest.mark.asyncio
    async def test_mismatch_is_reported_but_does_not_destroy_the_fork(
        self, monkeypatch
    ):
        """Should be impossible: both halves share the cutoff rule.

        If it happens, one of those rules changed under the other. That wants
        investigating, not a raised exception that discards a fork which may be
        perfectly usable.
        """
        # Capture on the module's own logger with our own handler, NOT via
        # caplog. caplog attaches at root, and the `openhands` ancestor logger is
        # configured with propagate=False plus its own handler -- so records never
        # reach root. That configuration is applied on import, which is why a
        # caplog assertion here passes when this file runs ALONE (config not yet
        # imported) and fails in-suite (it is). An assertion whose result depends
        # on import order is worse than no assertion.
        records: list[logging.LogRecord] = []

        class _Capture(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                records.append(record)

        handler = _Capture(level=logging.ERROR)
        logger = logging.getLogger(module.__name__)
        logger.addHandler(handler)
        try:
            result, _, _, _ = await _call(
                monkeypatch, state_result=5, transcript_result=3
            )
        finally:
            logger.removeHandler(handler)

        # The behavioural property first: a mismatch is REPORTED, not raised, and
        # the fork survives.
        assert not result.halves_agree
        assert result.events_in_agent_state == 5
        assert result.events_in_transcript == 3
        assert any('halves disagree' in r.getMessage() for r in records)
