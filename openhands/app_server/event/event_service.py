import asyncio
import logging
from abc import ABC, abstractmethod
from datetime import datetime
from typing import AsyncGenerator
from uuid import UUID

from openhands.agent_server.models import EventPage, EventSortOrder
from openhands.app_server.event_callback.event_callback_models import EventKind
from openhands.app_server.services.injector import Injector
from openhands.sdk import Event
from openhands.sdk.utils.models import DiscriminatedUnionMixin
from openhands.sdk.utils.paging import page_iterator

_logger = logging.getLogger(__name__)


class EventService(ABC):
    """Event Service for getting events."""

    @abstractmethod
    async def get_event(self, conversation_id: UUID, event_id: UUID) -> Event | None:
        """Given an id, retrieve an event."""

    @abstractmethod
    async def search_events(
        self,
        conversation_id: UUID,
        kind__eq: EventKind | None = None,
        timestamp__gte: datetime | None = None,
        timestamp__lt: datetime | None = None,
        sort_order: EventSortOrder = EventSortOrder.TIMESTAMP,
        page_id: str | None = None,
        limit: int = 100,
    ) -> EventPage:
        """Search events matching the given filters."""

    @abstractmethod
    async def count_events(
        self,
        conversation_id: UUID,
        kind__eq: EventKind | None = None,
        timestamp__gte: datetime | None = None,
        timestamp__lt: datetime | None = None,
    ) -> int:
        """Count events matching the given filters."""

    async def iter_events_for_export(
        self, conversation_id: UUID
    ) -> AsyncGenerator[Event, None]:
        """Iterate all events for a conversation in export order.

        Implementations can override this to avoid paginated searches that reload the
        full event history for each page.
        """
        events = page_iterator(self.search_events, conversation_id=conversation_id)
        async for event in events:
            yield event

    @abstractmethod
    async def save_event(self, conversation_id: UUID, event: Event):
        """Save an event. Internal method intended not be part of the REST api."""

    async def copy_events_until(
        self,
        source_conversation_id: UUID,
        target_conversation_id: UUID,
        up_to_event_id: str | None = None,
    ) -> int:
        """Copy a conversation's history into another, up to a chosen point.

        This is the load-bearing half of forking a conversation. Agentic coding
        is speculative: the agent goes down a wrong path and what the user needs
        is to get BACK to a good state and try differently, which today means
        starting over and re-explaining everything.

        WHY COPY RATHER THAN TRUNCATE
        -----------------------------
        The obvious alternative — delete everything after a point in place — is
        destructive, and there is no delete on this interface for good reason:
        it would have to exist in every implementation, including the ones
        backed by object storage where a "delete" is not obviously reversible.
        Copying leaves the original conversation exactly as it was, so a fork
        that turns out to be the wrong idea costs nothing. It also means this
        can never destroy history through a bug in the cutoff logic, which is
        the failure that would matter most.

        THE CUTOFF IS INCLUSIVE
        -----------------------
        `up_to_event_id` is the last event KEPT, not the first dropped. A user
        forks *from* a message they can see, and "from here" naturally includes
        the thing they pointed at. Excluding it would silently drop the event
        they were reasoning about.

        An id that does not appear copies the whole history rather than nothing.
        The alternative — an empty fork — looks identical to a broken feature,
        while a complete copy is at worst more than was asked for and is
        obviously recoverable. Callers that need to know should check the
        returned count against their expectation.
        """
        copied = 0
        async for event in self.iter_events_for_export(source_conversation_id):
            await self.save_event(target_conversation_id, event)
            copied += 1
            if up_to_event_id is not None and str(event.id) == up_to_event_id:
                break
        return copied

    async def batch_get_events(
        self, conversation_id: UUID, event_ids: list[UUID]
    ) -> list[Event | None]:
        """Given a list of ids, get events (Or none for any which were not found)."""
        return await asyncio.gather(
            *[self.get_event(conversation_id, event_id) for event_id in event_ids]
        )


class EventServiceInjector(DiscriminatedUnionMixin, Injector[EventService], ABC):
    pass
