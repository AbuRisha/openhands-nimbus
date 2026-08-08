"""Compose the two halves of a fork, in the order that fails safely.

A fork has two halves and they live in different stores:

  - the agent's memory   -> the sandbox's persistence dir (fork_state_transport)
  - the transcript       -> the app-server event mirror (copy_events_until)

Both are needed. The transcript alone is the amnesiac fork this whole feature
exists to prevent; the agent state alone is a conversation the user cannot see.

WHY THE STATE GOES FIRST
------------------------
The ordering is the only real decision in this module, and it is a safety
property rather than a preference.

Transfer the agent state FIRST, then mirror the transcript. If the state transfer
fails, no transcript has been written either, so the fork presents as EMPTY —
obviously broken, and the user retries. If the mirror went first and the state
transfer then failed, the fork would present as COMPLETE: a full transcript, and
an agent that remembers none of it. That is precisely the failure the feature is
meant to fix, reintroduced by the wiring, and it is silent.

So: fail toward the outcome someone will notice. An empty fork gets reported; an
amnesiac one gets trusted.

The caller still owns cleanup. This function does not delete the target
conversation on failure, because deleting a conversation is not this module's
business and a half-built fork with no transcript is inspectable — which is worth
more than tidiness when diagnosing why a fork failed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from uuid import UUID

import httpx

from openhands.app_server.app_conversation.fork_state_transport import (
    ForkTransportError,
    SandboxEndpoint,
    transfer_forked_state,
)

_logger = logging.getLogger(__name__)


class ForkError(RuntimeError):
    """A fork did not complete. The target is not usable."""


@dataclass(frozen=True)
class ForkResult:
    """What landed, in both stores, so a caller can check them against each other."""

    events_in_agent_state: int
    events_in_transcript: int

    @property
    def halves_agree(self) -> bool:
        """Both halves cut at the same point.

        Not enforced — an inequality is worth logging and surfacing, not worth
        destroying a fork over, because the cutoff rules are identical by
        construction and a mismatch means an assumption broke somewhere that
        wants investigating rather than papering over.
        """
        return self.events_in_agent_state == self.events_in_transcript


async def fork_conversation(
    *,
    event_service,
    httpx_client: httpx.AsyncClient,
    source_sandbox: SandboxEndpoint,
    target_sandbox: SandboxEndpoint,
    conversations_path: str,
    source_conversation_id: UUID,
    target_conversation_id: UUID,
    up_to_event_id: str | None = None,
) -> ForkResult:
    """Fork ``source`` into an already-started ``target``. See module docstring.

    ``target_conversation_id`` must already exist and its sandbox must be RUNNING
    — ``validate_session_key`` refuses non-RUNNING sandboxes, and so does the
    source's, which is why forking a stopped conversation has to start the parent
    first.
    """
    try:
        in_state = await transfer_forked_state(
            client=httpx_client,
            source=source_sandbox,
            target=target_sandbox,
            conversations_path=conversations_path,
            source_conversation_id=source_conversation_id,
            target_conversation_id=target_conversation_id,
            up_to_event_id=up_to_event_id,
        )
    except ForkTransportError as e:
        # Nothing has been mirrored, so the fork is visibly empty rather than
        # convincingly wrong.
        raise ForkError(
            f'agent state transfer failed, fork {target_conversation_id} is not '
            f'usable and has no transcript: {e}'
        ) from e

    in_transcript = await event_service.copy_events_until(
        source_conversation_id=source_conversation_id,
        target_conversation_id=target_conversation_id,
        up_to_event_id=up_to_event_id,
    )

    result = ForkResult(
        events_in_agent_state=in_state, events_in_transcript=in_transcript
    )
    if not result.halves_agree:
        # Both halves use the same inclusive rule and the same unknown-id
        # behaviour, so this should be impossible. Log loudly rather than
        # silently: it means one of those two rules changed under the other.
        _logger.error(
            'fork: halves disagree for %s -> %s: agent state %d events, '
            'transcript %d. Cutoff rules have diverged.',
            source_conversation_id,
            target_conversation_id,
            in_state,
            in_transcript,
        )
    else:
        _logger.info(
            'fork: %s -> %s complete, %d events in both halves',
            source_conversation_id,
            target_conversation_id,
            in_state,
        )
    return result
