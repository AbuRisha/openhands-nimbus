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
    """Wrap litellm.get_llm_provider with an OpenAI-compatible fallback.

    Never raises: this runs from sitecustomize, where an exception would break
    every interpreter start in the image.
    """
    try:
        import litellm
    except Exception:  # noqa: BLE001
        return False

    if getattr(litellm, '_nimbus_provider_fallback_installed', False):
        return True

    original = getattr(litellm, 'get_llm_provider', None)
    if original is None:
        return False

    def get_llm_provider(*args, **kwargs):  # type: ignore[no-untyped-def]
        model = kwargs.get('model')
        if model is None and args:
            model = args[0]

        try:
            # litellm's own answer always wins. anthropic/* and deepseek/* must
            # keep their native wire formats, and this must never intercept a
            # model litellm can already place.
            return original(*args, **kwargs)
        except Exception:
            if not _is_ours(model):
                raise
            # (model, provider, dynamic_api_key, api_base) — the id is passed
            # through UNCHANGED because the gateway keys on the full name.
            api_base = kwargs.get('api_base')
            api_key = kwargs.get('api_key')
            logger.debug(
                'nimbus: resolving %s as openai-compatible gateway traffic', model
            )
            return model, 'openai', api_key, api_base

    litellm.get_llm_provider = get_llm_provider
    litellm._nimbus_provider_fallback_installed = True
    logger.info(
        'nimbus: provider fallback installed for prefixes %s',
        ', '.join(sorted(NIMBUS_OPENAI_COMPATIBLE_PREFIXES)),
    )
    return True
