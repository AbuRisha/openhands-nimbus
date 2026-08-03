"""Stop the corrective-nudge loop from billing forever.

THE LOOP
--------
When a model returns neither a tool call nor content, the SDK injects a
synthetic user message::

    "Your last response did not include a function call or a message.
     Please use a tool to proceed with the task."

There is no counter on it. A model that keeps returning empty gets nudged
forever, and every nudge is a paid completion. Observed in production as the
same line repeating until the conversation was abandoned.

The docstring on ``_send_corrective_nudge`` explains why it does not
self-terminate:

    "Prevents the monologue stuck-detector from firing when the model simply
     forgot to emit a function call."

That is the whole problem. The nudge is a *user* message, so it breaks the
agent-only pattern StuckDetector watches for — the one safety net that would
have ended the run is deliberately defeated on every iteration. Forgetting once
is worth a nudge; forgetting indefinitely is a stuck agent wearing a disguise.

THE FIX
-------
Cap CONSECUTIVE nudges. Below the cap, behaviour is byte-for-byte unchanged, so
the legitimate case this feature exists for still works. At the cap we simply
stop nudging — which lets StuckDetector see the repetition it was always meant
to catch and end the run through the SDK's own path. Nothing is force-raised
here; making the loop visible to the existing detector is safer than inventing a
new termination route through code we do not own.

The counter resets on real progress — a tool call or a content response — so a
long healthy conversation never accumulates toward the cap.

WHY A MONKEYPATCH
-----------------
This lives in the SDK, inside the agent-server process, and is reached long
before any of our code. sitecustomize is the only hook that runs first. The
patch is deliberately additive: it wraps three methods, keeps their signatures,
and delegates to the originals, so an SDK upgrade that renames or removes them
disables the cap rather than breaking the agent.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_COUNTER_ATTR = '_nimbus_consecutive_nudges'


def max_nudges() -> int:
    """Consecutive empty responses tolerated before we stop nudging.

    Three is deliberately generous: a model that forgets a tool call twice and
    recovers on the third attempt is a real pattern this must not break. Set
    NIMBUS_MAX_NUDGES=0 to restore the previous unbounded behaviour.
    """
    raw = os.getenv('NIMBUS_MAX_NUDGES')
    if raw is None:
        return 3
    try:
        value = int(raw)
    except ValueError:
        return 3
    return max(0, value)


def install_nudge_cap() -> bool:
    """Wrap the dispatcher so nudges cannot repeat forever. True if installed.

    Never raises: this runs from sitecustomize, where an exception would break
    every interpreter start in the image.
    """
    try:
        from openhands.sdk.agent.response_dispatch import ResponseDispatchMixin
    except Exception:  # noqa: BLE001 - SDK moved or absent; leave behaviour as-is
        return False

    if getattr(ResponseDispatchMixin, '_nimbus_nudge_cap_installed', False):
        return True

    limit = max_nudges()
    if limit == 0:
        return False

    original_nudge = getattr(ResponseDispatchMixin, '_send_corrective_nudge', None)
    if original_nudge is None:
        return False

    def _capped_nudge(self, on_event):  # type: ignore[no-untyped-def]
        count = getattr(self, _COUNTER_ATTR, 0)
        if count >= limit:
            # Stop nudging rather than raising. The injected user message is
            # what hides this from StuckDetector; withholding it lets the
            # detector see an agent repeating itself and terminate the run
            # through the SDK's own machinery.
            logger.warning(
                'nimbus: suppressing corrective nudge after %d consecutive '
                'empty responses - letting the stuck detector end the run '
                'instead of billing another completion',
                count,
            )
            return None
        setattr(self, _COUNTER_ATTR, count + 1)
        return original_nudge(self, on_event)

    def _reset_wrapper(name):
        original = getattr(ResponseDispatchMixin, name, None)
        if original is None:
            return None

        def _wrapped(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            # Real output means the model is not stuck; forget the streak.
            setattr(self, _COUNTER_ATTR, 0)
            return original(self, *args, **kwargs)

        return _wrapped

    ResponseDispatchMixin._send_corrective_nudge = _capped_nudge  # type: ignore[assignment]

    for name in ('_handle_tool_calls', '_handle_content_response'):
        wrapped = _reset_wrapper(name)
        if wrapped is not None:
            setattr(ResponseDispatchMixin, name, wrapped)

    ResponseDispatchMixin._nimbus_nudge_cap_installed = True  # type: ignore[attr-defined]
    return True
