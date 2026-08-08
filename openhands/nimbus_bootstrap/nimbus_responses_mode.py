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

# Every model in the Nimbus catalog, by bare id.
#
# This was one id — `gpt-5.3-codex` — and the scoping was right in principle and
# too narrow in practice. `openai/gpt-5.5` started failing every chat turn in
# production with the identical `not_found: POST /responses`, with no deploy on
# our side, because litellm decides endpoint shape from a registry it FETCHES AT
# IMPORT from raw.githubusercontent.com. That file is not ours, it changes, and
# when the fetch fails litellm silently falls back to the map bundled with the
# installed version. So two containers on the same image can route the same
# model differently, and a model that worked for months can stop overnight.
#
# Listing the whole catalog is safe because the flip below only rewrites entries
# whose mode is exactly "responses": for everything already on "chat" it is a
# no-op. It also keeps the original guarantee that mattered — a customer's own
# BYOR model that genuinely needs the Responses API is untouched, because it is
# not in this list.
#
# Kept as a literal rather than imported from
# config_api.nimbus_llm_model_service, which costs ~6.5s to import: this module
# runs from sitecustomize on EVERY interpreter start in the image. The test in
# tests/nimbus_bootstrap asserts the two stay in step, so drift is a failing
# test rather than a model that quietly starts 400ing in production.
NIMBUS_FORCE_CHAT_MODE: tuple[str, ...] = (
    'claude-haiku-4.5',
    'claude-opus-4.6',
    'claude-opus-4.7',
    'claude-opus-4.8',
    'claude-opus-5',
    'claude-sonnet-4.6',
    'claude-sonnet-5',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'gemini-3-flash-preview',
    'gemini-3.1-pro-preview',
    'gemini-3.5-flash',
    'glm-5',
    'glm-5.1',
    'glm-5.2',
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.5',
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'kimi-k2.6',
    'kimi-k3',
    'qwen3-coder',
    'qwen3.7-max',
    'qwen3.8-max',
)


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

    # Say WHERE the registry came from. Routing is decided by this map, litellm
    # fetches it over the network at import, and falls back to the bundled copy
    # without raising - so two containers on the same image can route the same
    # model differently and nothing in the logs says why. That is how gpt-5.5
    # started 400ing in production with no deploy. One line here turns the next
    # occurrence from a mystery into a lookup.
    try:
        # Not re-exported on the litellm package, so import from the module.
        from litellm.litellm_core_utils.get_model_cost_map import (
            get_model_cost_map_source_info,
        )

        source = get_model_cost_map_source_info()
        logger.info(
            'nimbus: litellm model registry source=%s forced_local=%s%s',
            source.get('source'),
            source.get('is_env_forced'),
            (
                f' fallback_reason={source["fallback_reason"]}'
                if source.get('fallback_reason')
                else ''
            ),
        )
    except Exception:  # noqa: BLE001
        # Older litellm has no such helper. Not knowing the source is not a
        # reason to skip the override that fixes the routing.
        logger.debug('nimbus: litellm model registry source unavailable')

    for bare in NIMBUS_FORCE_CHAT_MODE:
        # The registry is keyed on the bare id, but check the prefixed form too
        # so this keeps working if that ever changes.
        for key in (bare, f'openai/{bare}'):
            entry = registry.get(key)
            if isinstance(entry, dict) and entry.get('mode') == 'responses':
                entry['mode'] = 'chat'
                changed += 1
                logger.info('nimbus: forced chat mode for %s (was "responses")', key)
    return changed
