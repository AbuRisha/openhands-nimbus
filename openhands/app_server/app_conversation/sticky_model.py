"""The sticky-model rule, with no imports, so it can be unit-tested.

── The bug this exists to fix ──────────────────────────────────────────────
``llm_model`` was already persisted per conversation and nothing ever read it
back, so a customer who deliberately picked a model was silently reset to the
platform default (``anthropic/claude-sonnet-5``) every time they opened chat.

Owner report, 2026-08-03: "it's always auto on sonnet 5 ... it should stick to
that same model when the person comes to the chat."

── Why this is its own module ──────────────────────────────────────────────
The service that consumes it imports FastAPI and the agent-server SDK, so
importing it in a unit test drags in the entire runtime. The RULE is a pure
scan over rows and deserves a test that runs anywhere; the wiring around it
does not. This mirrors lib/motionCapability.ts on the marketing site, extracted
for exactly the same reason.
"""

from __future__ import annotations

from typing import Any, Iterable

# How many recent conversations to scan for a recorded model.
#
# NOT 1. ``llm_model`` is nullable and rows created before the column existed
# have none, so looking only at the newest conversation would miss the
# preference whenever the last session happened not to record one. Small enough
# to stay a single indexed page read.
STICKY_MODEL_LOOKBACK = 25


def pick_last_used_model(conversations: Iterable[Any]) -> str | None:
    """Return the newest recorded ``llm_model``, or ``None``.

    ``conversations`` is expected newest-first (the caller queries with
    ``CREATED_AT_DESC``). Rows without a model are skipped rather than treated
    as a stopping point — that skip is the whole reason a window is scanned
    instead of a single row.

    Returns ``None`` when nothing in the window recorded a model, which the
    caller must treat as "leave the default alone".
    """
    for info in conversations:
        model = getattr(info, 'llm_model', None)
        if isinstance(model, str) and model.strip():
            return model
    return None
