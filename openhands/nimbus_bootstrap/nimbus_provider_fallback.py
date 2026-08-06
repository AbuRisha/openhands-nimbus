"""Let litellm resolve a provider for the model prefixes only WE use.

THE FAILURE
-----------
A multi-model audit found that most of the catalog could not complete a single
turn in chat:

    litellm.BadRequestError: LLM Provider NOT provided. Pass in the LLM
    provider you are trying to call. You passed model=moonshotai/kimi-k2.6

anthropic/* and deepseek/* worked; google/*, moonshotai/*, z-ai/*, qwen/* and
alibaba/* did not. The pattern is not about the vendors — it is about whether
litellm RECOGNISES the prefix. It knows ``anthropic`` and ``deepseek``; it knows
``gemini`` and ``vertex_ai`` but never ``google``; it has never heard of
``moonshotai``, ``z-ai``, ``qwen`` or ``alibaba``. For those,
``litellm.get_llm_provider`` raises, the SDK's ``infer_litellm_provider``
swallows the exception and returns None, and the completion is refused before a
request is ever sent.

So these models had never worked in chat. Nothing regressed them; they were
offered in the picker and could not answer, which is the same class of defect as
shipping a model the gateway cannot route.

THE FIX
-------
Every model we sell is served by ONE endpoint — our gateway — and it accepts the
OpenAI Chat Completions shape with the full id as the model name. So when
litellm cannot place one of OUR prefixes, we answer ``openai`` and hand the id
through unchanged. litellm's OpenAI handler then POSTs
``{"model": "google/gemini-3.5-flash", ...}`` to ``{base}/chat/completions``,
which is exactly what the gateway expects.

WHY THIS IS SCOPED SO TIGHTLY
-----------------------------
Two earlier attempts at "just tell litellm about our models" broke routing:
setting ``litellm_provider: 'openai'`` sent every Anthropic call through the
OpenAI client (dying on the ``system`` kwarg), and calling ``register_model``
made litellm treat models as native provider traffic. The lesson is that for us
the model registry IS the routing table.

This therefore does the minimum: the original function runs FIRST and its answer
always wins, so anything litellm can already place — including anthropic/* and
deepseek/*, which must keep their native wire formats — is untouched. Only the
prefixes litellm rejects reach the fallback, and only for prefixes we actually
sell.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Prefixes that belong to our gateway and that litellm does not natively place.
# Deliberately NOT a catch-all: a customer's own BYOR model with an unknown
# prefix should still fail loudly rather than be silently pointed at us.
NIMBUS_OPENAI_COMPATIBLE_PREFIXES: frozenset[str] = frozenset(
    {
        'google',
        'moonshotai',
        # Our own namespace (Weekly Free). litellm has never heard of it, so
        # without this the completion is refused before a request is sent.
        'nimbus',
        'z-ai',
        'qwen',
        'alibaba',
    }
)


def _is_ours(model: str | None) -> bool:
    if not model or '/' not in model:
        return False
    return model.split('/', 1)[0] in NIMBUS_OPENAI_COMPATIBLE_PREFIXES


def install_provider_fallback() -> bool:
    """Inject custom_llm_provider into the kwargs litellm actually receives.

    Three earlier attempts missed because I guessed where provider inference
    happens instead of reading it:

      1. litellm_provider:'openai' via register_model — broke Anthropic routing.
      2. Patching litellm.get_llm_provider (module attribute) — llm.py binds its
         helper at import, so the patch was never consulted.
      3. Patching LLM._infer_litellm_provider — that feeds TELEMETRY, not the
         request. The bootstrap marker file proved the patch installed
         (provider:True) while the error stayed byte-identical, which is what
         finally ruled the method out.

    The request is built by LLM._prepare_transport_kwargs and handed straight to
    litellm_completion(**kwargs). Setting custom_llm_provider there makes
    litellm skip inference entirely, so the full model id reaches the gateway —
    which is what it keys on. A method on the class, so import bindings cannot
    route around it.

    Never raises: this runs from sitecustomize, where an exception would break
    every interpreter start in the image.
    """
    try:
        from openhands.sdk.llm.llm import LLM
    except Exception:  # noqa: BLE001
        return False

    if getattr(LLM, '_nimbus_provider_fallback_installed', False):
        return True

    original = getattr(LLM, '_prepare_transport_kwargs', None)
    if original is None:
        return False

    def _prepare_transport_kwargs(self, **kwargs):  # type: ignore[no-untyped-def]
        prepared = original(self, **kwargs)
        try:
            # Only for OUR prefixes, and never overriding an explicit value.
            # anthropic/* and deepseek/* must keep their native wire formats.
            if _is_ours(prepared.get('model')) and not prepared.get(
                'custom_llm_provider'
            ):
                prepared['custom_llm_provider'] = 'openai'
        except Exception:  # noqa: BLE001 - a failed hint must not fail the call
            pass
        return prepared

    LLM._prepare_transport_kwargs = _prepare_transport_kwargs  # type: ignore[assignment]
    LLM._nimbus_provider_fallback_installed = True  # type: ignore[attr-defined]
    return True
