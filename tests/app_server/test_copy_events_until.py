"""Forking a conversation's history up to a chosen point.

Agentic coding is speculative: the agent goes down a wrong path and the user
needs to get BACK to a good state and try differently. The property that matters
most here is that the SOURCE is never modified — a bug in the cutoff logic
should cost a wrong-sized fork, never someone's history.
"""

from __future__ import annotations

from typing import AsyncGenerator
from uuid import UUID

import pytest

from openhands.app_server.event.event_service import EventService


class _FakeEvent:
    """Enough of an Event for the copy loop: it reads only `.id`."""

    def __init__(self, event_id: str):
        self.id = event_id

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f'<event {self.id}>'


class _RecordingEventService(EventService):
    """Records what was saved where, and proves the source is untouched."""

    def __init__(self, source: list[_FakeEvent]):
        self._source = source
        self.saved: dict[UUID, list[str]] = {}

    async def iter_events_for_export(  # type: ignore[override]
        self, conversation_id: UUID
    ) -> AsyncGenerator[_FakeEvent, None]:
        for event in self._source:
            yield event

    async def save_event(self, conversation_id: UUID, event) -> None:  # type: ignore[override]
        self.saved.setdefault(conversation_id, []).append(str(event.id))

    # Unused by copy_events_until, but the ABC requires them.
    async def get_event(self, conversation_id, event_id):  # type: ignore[override]
        raise NotImplementedError

    async def search_events(self, *args, **kwargs):  # type: ignore[override]
        raise NotImplementedError

    async def count_events(self, *args, **kwargs):  # type: ignore[override]
        raise NotImplementedError


@pytest.fixture
def source_events() -> list[_FakeEvent]:
    return [_FakeEvent(f'e{i}') for i in range(1, 6)]


@pytest.fixture
def service(source_events) -> _RecordingEventService:
    return _RecordingEventService(source_events)


SOURCE = UUID('11111111-1111-1111-1111-111111111111')
TARGET = UUID('22222222-2222-2222-2222-222222222222')


class TestCutoff:
    @pytest.mark.asyncio
    async def test_cutoff_is_inclusive(self, service):
        """`up_to_event_id` is the last event KEPT, not the first dropped.

        A user forks *from* a message they can see, and "from here" includes the
        thing they pointed at. Excluding it silently drops the event they were
        reasoning about.
        """
        copied = await service.copy_events_until(SOURCE, TARGET, up_to_event_id='e3')

        assert service.saved[TARGET] == ['e1', 'e2', 'e3']
        assert copied == 3

    @pytest.mark.asyncio
    async def test_no_cutoff_copies_everything(self, service):
        copied = await service.copy_events_until(SOURCE, TARGET)

        assert service.saved[TARGET] == ['e1', 'e2', 'e3', 'e4', 'e5']
        assert copied == 5

    @pytest.mark.asyncio
    async def test_an_unknown_id_copies_everything_rather_than_nothing(self, service):
        """An empty fork is indistinguishable from a broken feature.

        A complete copy is at worst more than was asked for, and is obviously
        recoverable by forking again.
        """
        copied = await service.copy_events_until(
            SOURCE, TARGET, up_to_event_id='does-not-exist'
        )

        assert copied == 5

    @pytest.mark.asyncio
    async def test_cutoff_on_the_first_event_keeps_exactly_one(self, service):
        copied = await service.copy_events_until(SOURCE, TARGET, up_to_event_id='e1')

        assert service.saved[TARGET] == ['e1']
        assert copied == 1

    @pytest.mark.asyncio
    async def test_cutoff_on_the_last_event_keeps_all(self, service):
        copied = await service.copy_events_until(SOURCE, TARGET, up_to_event_id='e5')

        assert copied == 5

    @pytest.mark.asyncio
    async def test_stops_reading_at_the_cutoff(self, source_events):
        """Not merely filtering: a long history should not be walked in full to
        produce a short fork."""
        consumed: list[str] = []

        class _Counting(_RecordingEventService):
            async def iter_events_for_export(self, conversation_id):  # type: ignore[override]
                for event in source_events:
                    consumed.append(event.id)
                    yield event

        service = _Counting(source_events)
        await service.copy_events_until(SOURCE, TARGET, up_to_event_id='e2')

        assert consumed == ['e1', 'e2']


class TestNonDestructive:
    @pytest.mark.asyncio
    async def test_never_writes_to_the_source(self, service):
        """The property worth protecting. A cutoff bug should cost a
        wrong-sized fork, never someone's history."""
        await service.copy_events_until(SOURCE, TARGET, up_to_event_id='e2')

        assert SOURCE not in service.saved

    @pytest.mark.asyncio
    async def test_source_history_is_unchanged(self, service, source_events):
        before = [e.id for e in source_events]

        await service.copy_events_until(SOURCE, TARGET, up_to_event_id='e2')

        assert [e.id for e in source_events] == before

    @pytest.mark.asyncio
    async def test_an_empty_source_forks_to_an_empty_target(self):
        service = _RecordingEventService([])

        copied = await service.copy_events_until(SOURCE, TARGET)

        assert copied == 0
        assert service.saved == {}
