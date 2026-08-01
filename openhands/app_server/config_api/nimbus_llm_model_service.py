"""Dynamic, Nimbus-owned chat model catalog.

The customer picker mirrors Nimbus' public sellable roster instead of baking a
second list into Chat. Only text/chat models are exposed here; media models use
their dedicated Nimbus endpoints and billing units.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Final

import httpx
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

NIMBUS_DEFAULT_MODEL: Final[str] = 'anthropic/claude-sonnet-5'
NIMBUS_CATALOG_URL: Final[str] = 'https://nimbusapi.net/api/models'

_MEDIA_PROVIDERS: Final[frozenset[str]] = frozenset(
    {'image', 'media', 'audio', 'embed', 'rerank', 'ocr', 'video'}
)
_SUPPLIER_LABELS: Final[tuple[str, ...]] = (
    'spiderssense',
    'spider-sense',
    'spider sense',
)


def _contains_supplier_label(value: str) -> bool:
    lowered = value.lower()
    return any(label in lowered for label in _SUPPLIER_LABELS)


def _parse_catalog(payload: Any) -> list[LLMModel]:
    """Convert the public Nimbus roster into the OpenHands picker shape."""
    if not isinstance(payload, dict) or not isinstance(payload.get('models'), list):
        raise ValueError('Nimbus catalog response is missing models')

    results: list[LLMModel] = []
    seen: set[str] = set()
    for raw in payload['models']:
        if not isinstance(raw, dict):
            continue
        model_id = raw.get('id')
        public_provider = raw.get('provider')
        if not isinstance(model_id, str) or not model_id.strip():
            continue
        model_id = model_id.strip()
        if model_id in seen or _contains_supplier_label(model_id):
            continue
        if (
            raw.get('isImage') is True
            or raw.get('isMedia') is True
            or public_provider in _MEDIA_PROVIDERS
            or raw.get('mediaUnit') is not None
        ):
            continue

        if '/' in model_id:
            provider, name = model_id.split('/', 1)
        else:
            provider = public_provider if isinstance(public_provider, str) else None
            name = model_id
        if not provider or _contains_supplier_label(provider):
            continue

        results.append(
            LLMModel(
                provider=provider,
                name=name,
                verified=True,
                hidden=False,
                canonical=None,
            )
        )
        seen.add(model_id)
    return results


@dataclass
class NimbusLLMModelService(LLMModelService):
    """Fetch the current Nimbus roster and expose only chat-capable models."""

    http_client: httpx.AsyncClient | None = None
    catalog_url: str = NIMBUS_CATALOG_URL

    async def _models(self) -> list[LLMModel]:
        client = self.http_client
        if client is not None:
            response = await client.get(self.catalog_url)
        else:
            async with httpx.AsyncClient(timeout=10) as owned_client:
                response = await owned_client.get(self.catalog_url)
        response.raise_for_status()
        models = _parse_catalog(response.json())
        if not models:
            raise ValueError('Nimbus catalog contains no chat models')
        return models

    async def search_llm_models(
        self,
        *,
        query: str | None = None,
        verified_eq: bool | None = None,
        provider_eq: str | None = None,
        page_id: str | None = None,
        limit: int = 50,
    ) -> LLMModelPage:
        models = await self._models()
        if query is not None:
            query_lower = query.lower()
            models = [model for model in models if query_lower in model.name.lower()]
        if verified_eq is not None:
            models = [model for model in models if model.verified == verified_eq]
        if provider_eq is not None:
            models = [model for model in models if model.provider == provider_eq]
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
        models = await self._models()
        names = list(
            dict.fromkeys(model.provider for model in models if model.provider)
        )
        providers = [Provider(name=name, verified=True) for name in names]
        if query is not None:
            query_lower = query.lower()
            providers = [p for p in providers if query_lower in p.name.lower()]
        if verified_eq is not None:
            providers = [p for p in providers if p.verified == verified_eq]
        items, next_page_id = paginate_results(providers, page_id, limit)
        return ProviderPage(items=items, next_page_id=next_page_id)


class NimbusLLMModelServiceInjector(LLMModelServiceInjector):
    async def inject(
        self, state: InjectorState, request: Request | None = None
    ) -> AsyncGenerator[LLMModelService, None]:
        yield NimbusLLMModelService(
            catalog_url=os.getenv('NIMBUS_CATALOG_URL', NIMBUS_CATALOG_URL)
        )
