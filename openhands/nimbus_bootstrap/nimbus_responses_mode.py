"""Keep litellm on Chat Completions for models our gateway serves that way.

THE FAILURE
-----------
``openai/gpt-5.3-codex`` failed every chat turn with:

    litellm.BadRequestError: OpenAIException - not_found: POST /responses

It is not a missing model. The gateway answers 200 for it over
``/chat/completions`` — verified with a customer key. litellm simply refuses to
use that path: ``get_model_info`` reports ``mode: "responses"`` for that id and
``mode: "chat"`` for every other OpenAI model we sell, so litellm bridges the
call to the Responses API, which our gateway does not implement.

WHY THIS IS A REGISTRY EDIT WHEN THE OTHER FIXES WERE NOT
---------------------------------------------------------
Three earlier attempts to solve routing by touching litellm's registry made
things worse, and they are worth distinguishing from this one:

  1. ``litellm_provider: 'openai'`` via register_model — sent Anthropic traffic
     through the OpenAI client.
  2. ``register_model`` at all — made litellm RECOGNISE ids it previously did
     not, and infer a native provider from the prefix.
  3. Patching ``LLM._infer_litellm_provider`` — feeds telemetry, not the request.

All three changed WHICH PROVIDER a model resolves to. This changes none of that.
The id is already in litellm's registry, already resolves to the OpenAI-
compatible path, and already points at our gateway. The only field touched is
``mode``, which selects the ENDPOINT SHAPE, and only where the current value is
``"responses"`` — the one shape our gateway does not serve.

MEASURED, NOT ASSUMED
---------------------
Tested in a running container before shipping. With the flip applied,
``openai/gpt-5.3-codex`` returns a real completion ('PONG').

``openai/gpt-5.1-codex-max`` does NOT come back, and is deliberately left out of
the catalog: with the same flip it stops erroring but returns an empty body —
0 prompt tokens, 0 completion tokens, no content. A model that silently returns
nothing is worse than one that fails loudly, so it stays out until the gateway
returns something for it.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Ids whose endpoint shape litellm gets wrong FOR US. Deliberately explicit
# rather than "anything with mode == responses": a customer's own BYOR model
# that genuinely needs the Responses API must keep using it.
NIMBUS_FORCE_CHAT_MODE: tuple[str, ...] = ('gpt-5.3-codex',)


def install_chat_mode_overrides() -> int:
    """Flip `mode` to "chat" for the ids above. Returns how many were changed.

    Only rewrites entries whose current mode is exactly "responses", so this is
    a no-op the moment litellm ships the same conclusion, and it can never
    change a model that was already on the path we want.

    Never raises: called from sitecustomize, where an exception would break
    every interpreter start in the image.
    """
    try:
        import litellm
    except Exception:  # noqa: BLE001
        return 0

    changed = 0
    registry = getattr(litellm, 'model_cost', None)
    if not isinstance(registry, dict):
        return 0

    for bare in NIMBUS_FORCE_CHAT_MODE:
        # The registry is keyed on the bare id, but check the prefixed form too
        # so this keeps working if that ever changes.
        for key in (bare, f'openai/{bare}'):
            entry = registry.get(key)
            if isinstance(entry, dict) and entry.get('mode') == 'responses':
                entry['mode'] = 'chat'
                changed += 1
                logger.info(
                    'nimbus: forced chat mode for %s (was "responses")', key
                )
    return changed
