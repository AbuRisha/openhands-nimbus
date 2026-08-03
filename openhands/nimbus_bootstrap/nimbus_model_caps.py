"""Tell litellm what our models can actually do.

THE BUG
-------
No model in Nimbus chat could read an image. Uploading one produced:

    I received your image, but the currently selected model
    (anthropic/claude-opus-4.8) does not support image understanding.
    Please switch to a multimodal model to analyze the image.

which is false for every Claude, GPT and Gemini model we sell.

The refusal comes from the SDK, not from us. ``LLM._supports_vision`` asks
litellm, and litellm does not know our models::

    supports_vision(model_for_caps)                    # "anthropic/claude-opus-4.8"
    or supports_vision(model_for_caps.split("/")[-1])  # "claude-opus-4.8"
    or (self._model_info is not None
        and self._model_info.get("supports_vision", False))

The SDK's own comment concedes the first call returns False for any prefixed
name. The second strips the prefix, but ``claude-opus-4.8`` is newer than the
model map bundled with litellm, so that misses too. ``_model_info`` comes from
the same registry, so it misses as well — and the whole expression falls through
to False for every model we offer.

THE FIX
-------
Register our catalog with litellm at interpreter start, which populates exactly
the registry those three lookups read. Nothing in the SDK needs patching.

WHY THIS RUNS FROM sitecustomize
--------------------------------
The check executes in the AGENT SERVER, a separate process that
process_sandbox_service spawns as ``python -m ...``. It imports the SDK, not our
application, so registering from the app server would have no effect on it —
the same per-process trap that caused the ``apply_patch`` tool-registration
incident. Putting the call in ``sitecustomize`` means the interpreter applies it
before any agent code runs, in whichever process it is.

THE DATA
--------
Modalities and context windows below are the gateway's own published values
(``architecture.input_modalities`` and ``context_length`` from
``GET /v1/models``), read on 2026-08-03 — not inferred from model names. Seven
models are genuinely text-only and are marked so deliberately; claiming vision
for them would swap a false refusal for a failed request.

Regenerate rather than hand-edit when the roster changes:

    curl -sH "Authorization: Bearer $SPIDERSENSE_MASTER_KEY" \\
         https://spiderssense.com/v1/models
"""

from __future__ import annotations

# model id -> (supports_vision, max_input_tokens or None)
#
# max_input_tokens rides along because the SDK reads it from the same registry
# and raises LLMContextWindowTooSmallError below 16,384. Several models publish
# no context_length upstream; those stay None so the SDK keeps its own default
# rather than inheriting a number we invented.
NIMBUS_MODEL_CAPS: dict[str, tuple[bool, int | None]] = {
    # Anthropic — every model takes text+image+file
    'anthropic/claude-opus-5': (True, 1_000_000),
    'anthropic/claude-sonnet-5': (True, 1_000_000),
    'anthropic/claude-opus-4.8': (True, 1_000_000),
    'anthropic/claude-opus-4.7': (True, 1_000_000),
    'anthropic/claude-sonnet-4.6': (True, 1_000_000),
    'anthropic/claude-opus-4.6': (True, 1_000_000),
    'anthropic/claude-haiku-4.5': (True, 200_000),
    # OpenAI — all vision-capable
    'openai/gpt-5.6-sol': (True, 1_050_000),
    'openai/gpt-5.6-terra': (True, 1_050_000),
    'openai/gpt-5.6-luna': (True, 1_050_000),
    'openai/gpt-5.5': (True, 1_050_000),
    'openai/gpt-5.4-mini': (True, 400_000),
    'openai/gpt-5.4': (True, 1_050_000),
    'openai/gpt-5.3-codex': (True, 400_000),
    'openai/gpt-5.1-codex-max': (True, 400_000),
    # Google — text+image+file+audio+video
    'google/gemini-3.5-flash': (True, 1_048_576),
    'google/gemini-3.1-pro-preview': (True, 1_048_576),
    'google/gemini-3-flash-preview': (True, 1_048_576),
    # Moonshot — both take images
    'moonshotai/kimi-k3': (True, 1_000_000),
    'moonshotai/kimi-k2.6': (True, 262_144),
    # Text-only. Upstream lists input_modalities as ["text"] for each of these,
    # so marking them vision-capable would turn a clear refusal into a failed
    # request, which is worse.
    'deepseek/deepseek-v4-pro': (False, 1_048_576),
    'deepseek/deepseek-v4-flash': (False, 1_048_576),
    'qwen/qwen3.7-max': (False, None),
    'qwen/qwen3-coder': (False, 1_048_576),
    'z-ai/glm-5.2': (False, None),
    'z-ai/glm-5.1': (False, None),
    'z-ai/glm-5': (False, 202_752),
}


def register_nimbus_model_caps() -> int:
    """Register the catalog with litellm. Returns how many entries were added.

    Registers BOTH the full id and the bare name, because ``_supports_vision``
    tries the prefixed form first and the stripped form second — covering both
    means the lookup succeeds whichever path the SDK takes.

    Never raises. This runs from sitecustomize, so an exception here would take
    down every Python process in the image, turning a missing capability flag
    into a total outage. A failure to register costs image support; a failure to
    start costs everything.
    """
    try:
        import litellm
    except Exception:  # noqa: BLE001
        return 0

    registered = 0
    for model_id, (vision, max_input) in NIMBUS_MODEL_CAPS.items():
        info: dict[str, object] = {
            'supports_vision': vision,
            # Declared so tool-using models are not silently downgraded; every
            # model in this catalog is called with tools by the agent.
            'supports_function_calling': True,
            'litellm_provider': 'openai',
            'mode': 'chat',
        }
        if max_input is not None:
            info['max_input_tokens'] = max_input

        for name in {model_id, model_id.split('/')[-1]}:
            try:
                litellm.register_model({name: dict(info)})
                registered += 1
            except Exception:  # noqa: BLE001 - one bad entry must not stop the rest
                continue

    return registered
