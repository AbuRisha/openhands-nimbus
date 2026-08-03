"""Nimbus-native LLM catalog service.

Nimbus is the product, `api.nimbusapi.net/v1` is the supply chain. The
customer UI must NEVER expose the raw LiteLLM catalogue (hundreds of
models across every provider) — only the curated set of SS-native
models that the Nimbus proxy is guaranteed to route.

This service replaces :class:`DefaultLLMModelService` when
``NIMBUS_CATALOG_MODE`` is unset or set to ``true`` (the default in this
fork). Upstream discovery via LiteLLM/Bedrock/Ollama is short-circuited;
the only models the model picker will see are the ones enumerated in
:data:`NIMBUS_CHAT_MODELS`.

Runtime routing note: the model strings are stored and returned exactly
as they appear on the Nimbus proxy (``anthropic/claude-sonnet-5``,
``openai/gpt-5.1``, ...). The proxy speaks the OpenAI Chat Completions
schema at ``https://api.nimbusapi.net/v1``; LiteLLM sends the model
string verbatim in the JSON payload when ``LLM_BASE_URL`` is pinned to
that host. If a customer opens the ``Advanced: bring your own key``
panel and points somewhere else, they get whatever routing LiteLLM
defaults would give.
"""

from __future__ import annotations

from typing import AsyncGenerator

from fastapi import Request

from openhands.app_server.config_api.config_models import (
    LLMModel,
    LLMModelPage,
    Provider,
    ProviderPage,
)
from openhands.app_server.config_api.llm_model_service import (
    LLMModelService,
    LLMModelServiceInjector,
)
from openhands.app_server.services.injector import InjectorState
from openhands.app_server.utils.paging_utils import paginate_results

# ---------------------------------------------------------------------------
# Nimbus catalog — SS-native chat models only.
#
# Ordering here is the ordering the UI renders: grouped by vendor, newest
# first inside each group, matching the Builder's picker so the two surfaces
# agree.
#
# Rebuilt 2026-08-03 from the gateway's live /v1/models. The previous list was
# wrong in both directions at once. Five of its fifteen entries could not
# route at all — anthropic/claude-fable-5, openai/gpt-5.1, openai/gpt-5-codex,
# openai/o4-mini and moonshotai/kimi-k2.7-code are not on the gateway, so a
# third of the picker returned model_not_found. And eighteen models that DO
# route were missing, including the flagship anthropic/claude-opus-5, the
# entire GPT-5.6 line, and every Qwen and Z.ai model — a chat customer could
# not select the best model Nimbus sells.
#
# The list is hardcoded rather than fetched so the picker cannot inherit
# LiteLLM's hundreds of upstream ids. That is the right call, but it means
# this file goes stale silently: nothing fails until a customer picks a dead
# model. Re-check it against /v1/models whenever the roster changes.
#
# Release dates behind the ordering were sourced from vendor changelogs; see
# CHAT_CATALOG in bolt-diy-nimbus (app/lib/modules/llm/providers/nimbus.ts),
# which carries the dates and the two cases where version order and release
# order genuinely disagree.
# ---------------------------------------------------------------------------
NIMBUS_CHAT_MODELS: list[str] = [
    # Anthropic
    'anthropic/claude-opus-5',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-opus-4.7',
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-opus-4.6',
    'anthropic/claude-haiku-4.5',
    # OpenAI
    'openai/gpt-5.6-sol',
    'openai/gpt-5.6-terra',
    'openai/gpt-5.6-luna',
    'openai/gpt-5.5',
    'openai/gpt-5.4-mini',
    'openai/gpt-5.4',
    'openai/gpt-5.3-codex',
    'openai/gpt-5.1-codex-max',
    # gpt-5.1-codex-mini removed 2026-08-03: advertised by /v1/models but a
    # real completion returns 404 upstream_error "upstream-H unavailable".
    # Presence in the catalog is NOT proof of routability - only a
    # completion is.
    # Google
    'google/gemini-3.5-flash',
    'google/gemini-3.1-pro-preview',
    'google/gemini-3-flash-preview',
    # DeepSeek
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    # Moonshot
    'moonshotai/kimi-k3',
    'moonshotai/kimi-k2.6',
    # Qwen
    'qwen/qwen3.7-max',
    'qwen/qwen3-coder',
    # Z.ai
    'z-ai/glm-5.2',
    'z-ai/glm-5.1',
    'z-ai/glm-5',
]

# ``anthropic/claude-sonnet-5`` is the default per the Nimbus platform brief.
#
# Left alone deliberately while the rest of this file was rebuilt. Opus 5 is
# now available and is the stronger model, but the default is what every new
# conversation bills against — promoting it would raise the running cost for
# every chat customer without anyone asking for it. It still routes, so this
# is a pricing decision, not a correctness one.
NIMBUS_DEFAULT_MODEL: str = 'anthropic/claude-sonnet-5'

# Providers shown as "verified" in the model selector, in preferred order.
#
# qwen and z-ai were missing, so their models — five between them — would have
# rendered outside the verified group even once the catalog above listed them.
NIMBUS_VERIFIED_PROVIDERS: list[str] = [
    'anthropic',
    'openai',
    'google',
    'deepseek',
    'moonshotai',
    'qwen',
    'z-ai',
]

# Providers rendered when computing :meth:`search_providers`. Extracted from
# :data:`NIMBUS_CHAT_MODELS` so the two never drift.
_NIMBUS_PROVIDERS: list[str] = list(NIMBUS_VERIFIED_PROVIDERS)


def _split_provider(model: str) -> tuple[str | None, str]:
    parts = model.split('/', 1)
    if len(parts) == 2:
        return parts[0], parts[1]
    return None, parts[0]


def build_nimbus_llm_models() -> list[LLMModel]:
    """Return the curated Nimbus catalog as :class:`LLMModel` entries."""
    results: list[LLMModel] = []
    for full in NIMBUS_CHAT_MODELS:
        provider, name = _split_provider(full)
        results.append(
            LLMModel(
                provider=provider,
                name=name,
                verified=True,
                hidden=False,
                canonical=None,
            )
        )
    return results


def build_nimbus_providers() -> list[Provider]:
    """Return the curated provider list; every provider is 'verified'."""
    return [Provider(name=name, verified=True) for name in _NIMBUS_PROVIDERS]


class NimbusLLMModelService(LLMModelService):
    """LLM model discovery pinned to the Nimbus SS-native catalog.

    In-memory only; no litellm, no Bedrock, no Ollama, no upstream
    catalogue leaks. Filtering and pagination match the semantics of
    :class:`DefaultLLMModelService` so the router stays interchangeable.
    """

    async def search_llm_models(
        self,
        *,
        query: str | None = None,
        verified_eq: bool | None = None,
        provider_eq: str | None = None,
        page_id: str | None = None,
        limit: int = 50,
    ) -> LLMModelPage:
        models = build_nimbus_llm_models()

        if query is not None:
            query_lower = query.lower()
            models = [m for m in models if query_lower in m.name.lower()]
        if verified_eq is not None:
            models = [m for m in models if m.verified == verified_eq]
        if provider_eq is not None:
            models = [m for m in models if m.provider == provider_eq]

        items, next_page_id = paginate_results(models, page_id, limit)
        return LLMModelPage(items=items, next_page_id=next_page_id)

    async def search_providers(
        self,
        *,
        query: str | None = None,
        verified_eq: bool | None = None,
        page_id: str | None = None,
        limit: int = 50,
    ) -> ProviderPage:
        providers = build_nimbus_providers()

        if query is not None:
            query_lower = query.lower()
            providers = [p for p in providers if query_lower in p.name.lower()]
        if verified_eq is not None:
            providers = [p for p in providers if p.verified == verified_eq]

        items, next_page_id = paginate_results(providers, page_id, limit)
        return ProviderPage(items=items, next_page_id=next_page_id)


class NimbusLLMModelServiceInjector(LLMModelServiceInjector):
    """Injector that always yields a stateless :class:`NimbusLLMModelService`.

    No fields — the catalog is baked in.  Enable/disable is handled one
    level up in ``openhands.app_server.config`` via the
    ``NIMBUS_CATALOG_MODE`` env var.
    """

    async def inject(
        self, state: InjectorState, request: Request | None = None
    ) -> AsyncGenerator[LLMModelService, None]:
        yield NimbusLLMModelService()
