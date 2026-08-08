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
        """DO NOT TRUST THIS. It compares two numbers that do not measure the
        same thing, and it is false on forks that are completely fine.

        The original docstring here claimed the two cutoff rules were "identical
        by construction" so a mismatch meant an assumption had broken. The first
        real fork disproved it: a healthy full fork reported 11 events in agent
        state against 5 in the transcript, and a fork truncated to 3 reported
        11 against 3. The two stores hold different event KINDS, so their counts
        were never comparable and this equality never tested what it claimed.

        The cost was not theoretical. `shouldWarnAboutHalves` is `!halves_agree`,
        so EVERY successful fork showed the user "do not rely on this
        conversation" — a warning that fires on 100% of successes, which is
        strictly worse than no warning because it teaches people to ignore the
        one that matters.

        **The property worth testing is whether each half was cut at the
        requested point, measured against its OWN store** — not whether two
        stores ended up the same size. That fix belongs with the truncation
        defect it would expose: `up_to_event_id` never truncates agent memory at
        all, because the copier matches the cutoff against SDK event-file ids
        while a client can only supply transcript ids, so the "unknown id ->
        copy everything" fallback fires every time. Repairing this comparison
        without repairing that would just report the real failure in a field
        nobody trusts any more.

        Left returning the old value deliberately, rather than hardcoded True:
        flipping it would silence the log below, which is currently the only
        place the truncation defect announces itself.
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
        # THIS FIRES ON EVERY FORK, INCLUDING HEALTHY ONES. The comparison is
        # invalid (see ForkResult.halves_agree) -- but the numbers it prints are
        # real, and they are currently the only visible signal that
        # `up_to_event_id` is not truncating agent memory. Kept for that reason,
        # and NOT because a disagreement here means what it says.
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
