"""Record what the gateway actually billed, when it tells us.

THE BUG
-------
A real qwen turn was recorded at $0.00. Measured, not theorised:

    metrics.accumulated_cost : 0.0
    usage.cost (from gateway): 0.000384

``Telemetry._compute_cost`` prices a response with litellm's
``completion_cost``, which reads litellm's bundled price map. That map has never
heard of ``qwen3.8-max``, so it raises, the caller swallows the exception with a
UserWarning, and the turn books as free. Every Qwen model in the catalog does
this — qwen3.8-max, qwen3.7-max and qwen3-coder.

The customer is still charged correctly, so this is not the claude-opus-5 leak
repeating: chat holds each customer's own ``sk-nim-live-`` key and the gateway's
ledger.mjs settles against the gateway's own figure. What was wrong is the
number we then SHOW them, and the per-conversation totals in
conversation_cost_events, which is fed from accumulated_cost. A model that
silently displays as free is exactly the shape of the opus-5 incident even when
the money is right, and it is the display a customer would reconcile against.

THE FIX, AND ITS LIMIT
----------------------
The gateway already returns the amount it billed on ``usage.cost``, and litellm
preserves the field. Prefer it. It is the authoritative number — the same one
that moved the customer's balance — so it cannot drift from billing the way a
second price table maintained on this side would. That matters here specifically:
the last time we kept our own prices, a missing row billed 373 requests at $0.00.

The field is NOT always present, and that is the limit of this fix. Measured
across providers on 2026-08-04:

    alibaba/qwen3.8-max       usage.cost = 0.00027   (SDK said 0.0)
    anthropic/claude-sonnet-5 usage.cost = None      (SDK priced it 7e-05)
    openai/gpt-5.6-sol        usage.cost = None      (SDK priced it 0.000225)

Anthropic and OpenAI come back through a different upstream shape entirely —
their usage carries ``inference_geo`` and ``speed`` and no cost at all. So this
repairs the $0 case and leaves everything already working untouched; it does not
make every displayed cost exact. Whether litellm's vendor list price matches what
we charge for those models is a separate question this does not answer.

WHY PATCH THE METHOD RATHER THAN REGISTER PRICES
------------------------------------------------
The obvious alternative is to teach litellm our prices via ``register_model``.
That is the one thing that must not happen: registering a model makes litellm
RECOGNISE it and infer a native provider from the prefix, which broke routing
twice before (see nimbus_model_caps and nimbus_provider_fallback). Every model
we sell is OpenAI-compatible traffic to one gateway, and litellm's registry is
effectively our routing table.

So this follows the same shape as the vision fix: patch the single method that
asks the question, answer from data we trust, and leave the registry alone. The
original runs whenever we have no answer, so BYOR models a customer configures
are priced exactly as they are today.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def _gateway_cost(resp: object) -> float | None:
    """The cost the gateway reported for this response, or None.

    None means "no opinion" and the caller falls back. Zero is a real answer and
    is kept: when the gateway bills nothing it also debited nothing, so showing
    0.00 matches the customer's balance. Substituting litellm's estimate there
    would display a charge that never happened.
    """
    usage = getattr(resp, 'usage', None)
    if usage is None:
        return None

    cost = getattr(usage, 'cost', None)
    if cost is None and hasattr(usage, 'model_dump'):
        # Non-standard fields can survive as extras rather than attributes
        # depending on how the response model was constructed.
        try:
            cost = usage.model_dump().get('cost')
        except Exception:  # noqa: BLE001
            cost = None
    if cost is None:
        return None

    try:
        value = float(cost)
    except (TypeError, ValueError):
        return None
    # A negative cost is a malformed payload, not a refund. Defer to litellm.
    return value if value >= 0 else None


def install_gateway_cost() -> bool:
    """Make Telemetry._compute_cost prefer the gateway's own figure.

    Never raises: this runs from sitecustomize, where an exception would break
    every interpreter start in the image.
    """
    try:
        from openhands.sdk.llm.utils.telemetry import Telemetry
    except Exception:  # noqa: BLE001 - SDK moved or absent
        return False

    if getattr(Telemetry, '_nimbus_gateway_cost_installed', False):
        return True

    original = getattr(Telemetry, '_compute_cost', None)
    if original is None:
        return False

    def _compute_cost(self, resp):  # type: ignore[no-untyped-def]
        try:
            reported = _gateway_cost(resp)
        except Exception:  # noqa: BLE001 - never fail a turn over telemetry
            reported = None
        if reported is not None:
            return reported
        return original(self, resp)

    Telemetry._compute_cost = _compute_cost  # type: ignore[assignment]
    Telemetry._nimbus_gateway_cost_installed = True  # type: ignore[attr-defined]
    return True
