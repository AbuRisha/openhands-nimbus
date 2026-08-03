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
# Ordering here is the ordering the UI will render. Founder-preferred
# defaults land at the top. Keep this list in sync with the proxy's
# ``anthropic/*``, ``openai/*``, ``google/*``, ``deepseek/*``,
# ``moonshotai/*`` deployment aliases (see api.nimbusapi.net roster).
# ---------------------------------------------------------------------------
NIMBUS_CHAT_MODELS: list[str] = [
    'anthropic/claude-opus-5',
    'anthropic/claude-opus-4.8',
    'anthropic/claude-opus-4.6',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-sonnet-4.6',
    'anthropic/claude-haiku-4.5',
    'openai/gpt-5.6-sol',
    'openai/gpt-5.6-terra',
    'openai/gpt-5.6-luna',
    'openai/gpt-5.5',
    'openai/gpt-5.4',
    'openai/gpt-5.4-mini',
    'openai/gpt-5.3-codex',
    'google/gemini-3.1-pro-preview',
    'google/gemini-3.5-flash',
    'google/gemini-3-flash-preview',
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'qwen/qwen3.7-max',
    'qwen/qwen3-coder',
    'moonshotai/kimi-k3',
    'moonshotai/kimi-k2.6',
    'z-ai/glm-5.2',
    'z-ai/glm-5.1',
    'z-ai/glm-5',
]

# ``anthropic/claude-sonnet-5`` is the default per the Nimbus platform brief.
NIMBUS_DEFAULT_MODEL: str = 'anthropic/claude-sonnet-5'

# Providers shown as "verified" in the model selector, in preferred order.
NIMBUS_VERIFIED_PROVIDERS: list[str] = [
    'anthropic',
    'openai',
    'google',
    'deepseek',
    'qwen',
    'moonshotai',
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
