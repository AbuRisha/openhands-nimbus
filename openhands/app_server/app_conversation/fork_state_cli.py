"""Run ``fork_conversation_state`` inside a sandbox, over stdin/stdout.

WHY THIS EXISTS
---------------
The fork state copy has to happen where the state is. A forked conversation gets
its own sandbox (``SandboxGroupingStrategy`` defaults to ``NO_GROUPING``), so the
source's persistence directory is on a filesystem the app server cannot see.

The obvious wiring — pull the archive to the app server, expand it, run the
copier locally, re-archive, push — works, and it puts a customer's conversation
state (including whatever the agent wrote into its own event log) on shared
app-server disk on every fork. Nothing does that today. See
docs/fork-conversation-design.md.

The alternative that was considered was expressing the mutation as a shell
one-liner in the sandbox, which keeps customer state where it already is but
trades away the copier's tests — including the 100,000-event ordering case that
is the whole reason it sorts by parsed index.

This module is why neither trade is necessary. ``fork_conversation_state``
depends on nothing outside the standard library except
``openhands.sdk.conversation.persistence_const``, and that module is core SDK:
``openhands/sdk/conversation/event_store.py`` imports it, so it is present in any
sandbox running the agent server. So the copier can be uploaded and executed IN
the sandbox, unmodified. The code that runs is the code that is tested, and the
app server never expands customer state — it only relays an opaque archive.

DEPLOYMENT
----------
Upload this file and ``fork_conversation_state.py`` side by side into the source
sandbox (``POST /file/upload``), then run it (``POST
/bash/execute_bash_command``). The import below resolves both ways: as part of the
installed package, and as two loose files in a directory.

    python fork_state_cli.py \
        --conversations-path /path/to/conversations \
        --source-id <uuid> --target-id <uuid> \
        [--up-to-event-id <event id>] \
        [--target-conversations-path /path/to/other]

Prints one line of JSON to stdout: ``{"copied": N}``. Any failure exits non-zero
with ``{"error": "..."}``, so a caller reading BashOutput can tell the difference
between "forked nothing" and "did not run".
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from uuid import UUID

try:  # installed as part of the package
    from openhands.app_server.app_conversation.fork_conversation_state import (
        ForkStateError,
        fork_conversation_state,
    )
except ImportError:  # uploaded as two loose files next to each other
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    # import-not-found is expected and is the POINT: this module does not exist
    # on the import path at type-check time, only at runtime in a sandbox where
    # the two files sit side by side. no-redef covers the second binding of the
    # same two names.
    from fork_conversation_state import (  # type: ignore[import-not-found,no-redef]
        ForkStateError,
        fork_conversation_state,
    )


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Copy a conversation's agent state, truncated at an event."
    )
    parser.add_argument('--conversations-path', required=True)
    parser.add_argument('--source-id', required=True)
    parser.add_argument('--target-id', required=True)
    # Deliberately optional and deliberately NOT defaulted to a sentinel: an
    # absent cutoff means "copy everything", which is copy_events_until's rule
    # for an unknown id too.
    parser.add_argument('--up-to-event-id', default=None)
    parser.add_argument('--target-conversations-path', default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        copied = fork_conversation_state(
            conversations_path=Path(args.conversations_path),
            source_conversation_id=UUID(args.source_id),
            target_conversation_id=UUID(args.target_id),
            up_to_event_id=args.up_to_event_id,
            target_conversations_path=(
                Path(args.target_conversations_path)
                if args.target_conversations_path
                else None
            ),
        )
    except (ForkStateError, ValueError, OSError) as e:
        # ValueError covers a malformed UUID, which is a caller bug rather than a
        # fork failure, but both need to be distinguishable from success by exit
        # code because the transport only sees stdout and an exit status.
        print(json.dumps({'error': f'{type(e).__name__}: {e}'}), file=sys.stdout)
        return 1
    print(json.dumps({'copied': copied}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
