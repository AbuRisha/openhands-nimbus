"""Tell the SDK which of our models can see images — without touching routing.

THE BUG THIS FIXES
------------------
No model in Nimbus chat could read an image. ``LLM._supports_vision`` is an
or-chain over litellm:

    supports_vision("anthropic/claude-opus-4.8")   -> False
    supports_vision("claude-opus-4.8")             -> False
    _model_info.get("supports_vision", False)      -> False (same registry)

litellm's bundled model map predates our ids, so all three miss and every model
reports no vision.

THE BUG THE FIRST FIX CAUSED, AND WHY THIS NO LONGER USES register_model
------------------------------------------------------------------------
The obvious repair — ``litellm.register_model`` — worked for capabilities and
broke ROUTING, twice:

  1. The first version also set ``litellm_provider: 'openai'``, which made
     litellm send anthropic/claude-* through the OpenAI client. Every Anthropic
     call died on `AsyncCompletions.create() got an unexpected keyword argument
     'system'`.

  2. Removing that field was not enough. Registering a model at all makes
     litellm RECOGNISE it and infer a native provider from the prefix — so
     google/* started being routed to the Gemini API and openai/* to the OpenAI
     SDK, instead of being treated as generic OpenAI-compatible traffic to our
     own gateway. Measured: Anthropic and DeepSeek completed, OpenAI and Google
     conversations ended in execution_status "error" while the identical models
     returned 200 when called directly upstream.

Every model here is served by ONE endpoint — our gateway — and it speaks the
OpenAI Chat Completions shape for all of them. Anything that teaches litellm to
treat a model as native provider traffic is therefore wrong by construction.

So this no longer registers anything. It patches the single method that asks the
question, and answers from our own table. litellm's registry is left exactly as
it was, which means routing is exactly as it was.

THE DATA
--------
Modalities and context windows are the gateway's own published values
(``architecture.input_modalities`` and ``context_length`` from GET /v1/models),
read on 2026-08-03 — not inferred from model names. Seven models are genuinely
text-only and are marked so deliberately; claiming vision for them would swap a
false refusal for a failed request.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# model id -> (supports_vision, max_input_tokens or None)
NIMBUS_MODEL_CAPS: dict[str, tuple[bool, int | None]] = {
    # Anthropic - every model takes text+image+file
    'anthropic/claude-opus-5': (True, 1_000_000),
    'anthropic/claude-sonnet-5': (True, 1_000_000),
    'anthropic/claude-opus-4.8': (True, 1_000_000),
    'anthropic/claude-opus-4.7': (True, 1_000_000),
    'anthropic/claude-sonnet-4.6': (True, 1_000_000),
    'anthropic/claude-opus-4.6': (True, 1_000_000),
    'anthropic/claude-haiku-4.5': (True, 200_000),
    # OpenAI - all vision-capable
    'openai/gpt-5.6-sol': (True, 1_050_000),
    'openai/gpt-5.6-terra': (True, 1_050_000),
    'openai/gpt-5.6-luna': (True, 1_050_000),
    'openai/gpt-5.5': (True, 1_050_000),
    'openai/gpt-5.4-mini': (True, 400_000),
    'openai/gpt-5.4': (True, 1_050_000),
    'openai/gpt-5.3-codex': (True, 400_000),
    'openai/gpt-5.1-codex-max': (True, 400_000),
    # Google - text+image+file+audio+video
    'google/gemini-3.5-flash': (True, 1_048_576),
    'google/gemini-3.1-pro-preview': (True, 1_048_576),
    'google/gemini-3-flash-preview': (True, 1_048_576),
    # Moonshot - both take images
    'moonshotai/kimi-k3': (True, 1_000_000),
    'moonshotai/kimi-k2.6': (True, 262_144),
    # Text-only upstream. Marking these vision-capable would turn a clear
    # refusal into a failed request, which is worse.
    'deepseek/deepseek-v4-pro': (False, 1_048_576),
    'deepseek/deepseek-v4-flash': (False, 1_048_576),
    'qwen/qwen3.7-max': (False, None),
    'qwen/qwen3-coder': (False, 1_048_576),
    'z-ai/glm-5.2': (False, None),
    'z-ai/glm-5.1': (False, None),
    'z-ai/glm-5': (False, 202_752),
}


def _vision_for(model: str | None) -> bool | None:
    """Our answer for this model, or None when we have no opinion.

    Matches the full id first, then the bare name, so it works whichever form
    the caller holds.
    """
    if not model:
        return None
    entry = NIMBUS_MODEL_CAPS.get(model)
    if entry is not None:
        return entry[0]

    bare = model.split('/')[-1]
    for known, (vision, _) in NIMBUS_MODEL_CAPS.items():
        if known.split('/')[-1] == bare:
            return vision
    return None


def install_vision_capabilities() -> bool:
    """Patch LLM._supports_vision to consult our table. True if installed.

    Deliberately additive: when we have no opinion about a model, the original
    implementation runs unchanged, so a BYOR model the customer configures still
    gets litellm's answer. Nothing is written to litellm's registry, so routing
    is untouched.
    """
    try:
        from openhands.sdk.llm.llm import LLM
    except Exception:  # noqa: BLE001 - SDK moved or absent
        return False

    if getattr(LLM, '_nimbus_vision_installed', False):
        return True

    original = getattr(LLM, '_supports_vision', None)
    if original is None:
        return False

    def _supports_vision(self) -> bool:  # type: ignore[no-untyped-def]
        try:
            answer = _vision_for(getattr(self, 'model', None))
        except Exception:  # noqa: BLE001
            answer = None
        if answer is not None:
            return answer
        return original(self)

    LLM._supports_vision = _supports_vision  # type: ignore[assignment]
    LLM._nimbus_vision_installed = True  # type: ignore[attr-defined]
    logger.info('nimbus: vision capabilities installed for %d models', len(NIMBUS_MODEL_CAPS))
    return True


# Back-compat name for sitecustomize; the old one registered models with
# litellm, which is exactly what must not happen any more.
def register_nimbus_model_caps() -> int:
    return len(NIMBUS_MODEL_CAPS) if install_vision_capabilities() else 0
