"""Copy an agent's own conversation state, truncated at a chosen event.

WHY THIS EXISTS, AND WHY `copy_events_until` IS NOT ENOUGH
---------------------------------------------------------
A conversation has TWO event stores, and only one of them is the agent's
memory.

  * The **app-server store** (`EventService`) is a downstream DISPLAY MIRROR.
    Events reach it exactly one way: the agent server POSTs them to
    `/api/v1/webhooks`, which calls `save_event`. Nothing writes back. It is
    what the transcript renders from.

  * The **agent's own EventLog**, on disk inside the sandbox at
    ``<conversations_path>/<conversation_id.hex>/``, is what
    ``ConversationState.create`` reads on its resume path. It is what the agent
    can actually reason about.

`EventService.copy_events_until` populates the first. On its own it produces a
fork whose transcript is complete and whose agent remembers nothing — which is
worse than no fork at all, because the entire purpose of forking is recovering
trust after the agent went wrong. This module populates the second.

Neither half is sufficient alone. A fork endpoint MUST do both or neither.

WHY A FILE COPY RATHER THAN AN API CALL
---------------------------------------
There is no API path for this. The agent server exposes no event-injection
endpoint, and ``StartConversationRequest`` carries no prior events — only an
``initial_message``. Checked, not assumed: its fields are workspace, worktree,
conversation_id, confirmation_policy, security_analyzer, initial_message.

WHY THE ID MUST BE REWRITTEN
----------------------------
The resume path refuses a mismatch outright::

    if state.id != id:
        raise ValueError(f"Conversation ID mismatch: ...")

So the fork cannot point at the source's directory, and cannot copy it
verbatim. `base_state.json` must carry the NEW id or the agent will not start.
"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from uuid import UUID

from openhands.sdk.conversation.persistence_const import (
    BASE_STATE,
    EVENT_NAME_RE,
    EVENTS_DIR,
)

_logger = logging.getLogger(__name__)


class ForkStateError(Exception):
    """The source state could not be forked. Never raised for a benign miss."""


def conversation_state_dir(conversations_path: Path, conversation_id: UUID) -> Path:
    """``<conversations_path>/<hex>`` — the SDK's own layout.

    Mirrors ``Conversation.get_persistence_dir``, which is
    ``Path(base) / conversation_id.hex``. Kept as a named function so the one
    place this layout is assumed is greppable.
    """
    return conversations_path / conversation_id.hex


def _ordered_event_files(events_dir: Path) -> list[tuple[int, str, Path]]:
    """Event files as ``(index, event_id, path)``, in log order.

    Sorted by the INDEX parsed out of the filename rather than by name, because
    the writer pads to a five-digit minimum and does not cap the width — so at
    100_000 events a lexicographic sort silently reorders history.
    """
    found: list[tuple[int, str, Path]] = []
    for path in events_dir.iterdir():
        if not path.is_file():
            continue
        match = EVENT_NAME_RE.match(path.name)
        # A non-matching file is not an error. The directory belongs to the SDK
        # and may grow sidecars; ignoring them is safer than refusing to fork.
        if match is None:
            continue
        found.append((int(match.group('idx')), match.group('event_id'), path))

    found.sort(key=lambda item: item[0])
    return found


def fork_conversation_state(
    conversations_path: Path,
    source_conversation_id: UUID,
    target_conversation_id: UUID,
    up_to_event_id: str | None = None,
    target_conversations_path: Path | None = None,
) -> int:
    """Copy the agent's state for a conversation, truncated at an event.

    Returns the number of event files copied.

    Args:
        conversations_path: a LOCALLY VISIBLE directory holding the source
            conversation. See the transport note below — this is not the remote
            sandbox's path.
        target_conversations_path: a LOCALLY VISIBLE directory to write into.
            Defaults to the source's.

    TRANSPORT IS NOT THIS FUNCTION'S JOB, and the parameter names above are a
    trap if read as sandbox paths. This is a LOCAL filesystem primitive: it
    takes `Path`s and copies with `shutil`. A forked conversation gets its OWN
    sandbox — `SandboxGroupingStrategy.NO_GROUPING` is the default and its
    comment says so outright — and two sandboxes are two containers whose
    filesystems are not both mounted anywhere. So the app server can NEVER call
    this with a source in sandbox A and a target in sandbox B.

    The caller does the moving, and this function then runs against two local
    temp trees, which is the shape it already supports:

        GET  /file/archive on the SOURCE  -> pull the persistence dir
        extract                           -> temp_src
        fork_conversation_state(temp_src, src_id, new_id, cutoff, temp_tgt)
        archive temp_tgt, POST /file/upload on the TARGET

    Note `validate_session_key` refuses a non-RUNNING sandbox, so the parent's
    sandbox must be started purely to be read from.

    The cutoff is INCLUSIVE and an unknown id copies everything, matching
    ``EventService.copy_events_until`` exactly. The two halves of a fork
    disagreeing about where the cut falls would be a subtle, awful bug, so the
    rule is stated identically in both places: a user forks *from* a message
    they can see, and excluding it would drop the event they were reasoning
    about.

    Raises:
        ForkStateError: if the source has no persisted state. That is a real
            failure rather than an empty fork — a fork whose agent silently
            starts blank is the exact outcome this module exists to prevent.
    """
    source_dir = conversation_state_dir(conversations_path, source_conversation_id)
    target_dir = conversation_state_dir(
        target_conversations_path or conversations_path, target_conversation_id
    )

    source_base_state = source_dir / BASE_STATE
    if not source_base_state.is_file():
        raise ForkStateError(
            f'No agent state at {source_dir}: the source conversation has no '
            f'{BASE_STATE}. Forking would produce a conversation whose '
            'transcript is complete and whose agent remembers nothing.'
        )

    target_dir.mkdir(parents=True, exist_ok=True)

    # --- base_state.json, with the id rewritten -------------------------------
    try:
        state = json.loads(source_base_state.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as e:
        raise ForkStateError(f'Could not read {source_base_state}: {e}') from e

    if not isinstance(state, dict):
        raise ForkStateError(f'{source_base_state} is not a JSON object.')

    # The resume path compares `state.id` to the id it was asked for and raises
    # on a mismatch, so this rewrite is what makes the fork startable at all.
    state['id'] = str(target_conversation_id)

    (target_dir / BASE_STATE).write_text(
        json.dumps(state, indent=2), encoding='utf-8'
    )

    # --- events, up to and including the cutoff -------------------------------
    source_events = source_dir / EVENTS_DIR
    if not source_events.is_dir():
        # State without events is a conversation that never ran. Copyable, and
        # not worth failing over.
        _logger.info(
            'fork: %s has no %s directory; copied base state only',
            source_dir,
            EVENTS_DIR,
        )
        return 0

    target_events = target_dir / EVENTS_DIR
    target_events.mkdir(parents=True, exist_ok=True)

    ordered = _ordered_event_files(source_events)

    copied = 0
    for _idx, event_id, path in ordered:
        # copy2 rather than copy: the SDK reads these back by name, and
        # preserving mtime keeps anything that sorts or ages by timestamp
        # behaving the same in the fork as in the source.
        shutil.copy2(path, target_events / path.name)
        copied += 1
        if up_to_event_id is not None and event_id == up_to_event_id:
            break

    if up_to_event_id is not None and copied == len(ordered):
        # Either the cutoff was the last event, or it was not found. Both copy
        # everything, deliberately: an empty or truncated-to-nothing fork looks
        # exactly like a broken feature, whereas a complete copy is at worst
        # more than was asked for. Logged because "not found" is worth seeing.
        matched = any(event_id == up_to_event_id for _i, event_id, _p in ordered)
        if not matched:
            _logger.warning(
                'fork: cutoff event %s not found in %s; copied all %d events',
                up_to_event_id,
                source_events,
                copied,
            )

    return copied
