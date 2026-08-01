"""Tests for the dynamic, customer-safe Nimbus model catalog."""

import httpx
import pytest

from openhands.app_server.config_api.config_models import LLMModelPage, ProviderPage
from openhands.app_server.config_api.nimbus_llm_model_service import (
    NIMBUS_DEFAULT_MODEL,
    NimbusLLMModelService,
    NimbusLLMModelServiceInjector,
)


def _service(models: list[dict]) -> NimbusLLMModelService:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={'models': models})

    return NimbusLLMModelService(
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        catalog_url='https://nimbus.example/api/models',
    )


CHAT_MODELS = [
    {'id': 'anthropic/claude-sonnet-5', 'provider': 'anthropic'},
    {'id': 'openai/gpt-5.6-sol', 'provider': 'openai'},
    # Public Nimbus groups several maker brands under "china". The picker must
    # derive the actual maker from the model id instead of displaying "china".
    {'id': 'deepseek/deepseek-v4-pro', 'provider': 'china'},
    {'id': 'qwen/qwen3-coder', 'provider': 'china'},
]


class TestNimbusLLMModelServiceCatalog:
    @pytest.mark.asyncio
    async def test_search_mirrors_dynamic_nimbus_chat_roster(self):
        service = _service(CHAT_MODELS)
        result = await service.search_llm_models(limit=100)

        assert isinstance(result, LLMModelPage)
        returned = {f'{model.provider}/{model.name}' for model in result.items}
        assert returned == {model['id'] for model in CHAT_MODELS}
        assert all(model.verified and not model.hidden for model in result.items)
        await service.http_client.aclose()

    @pytest.mark.asyncio
    async def test_media_uses_separate_endpoint_and_never_enters_chat_picker(self):
        service = _service(
            CHAT_MODELS
            + [
                {
                    'id': 'google/gemini-3.1-flash-image',
                    'provider': 'image',
                    'isImage': True,
                    'mediaUnit': 'per-image',
                },
                {
                    'id': 'openai/whisper',
                    'provider': 'audio',
                    'isMedia': True,
                    'mediaUnit': 'per-minute-audio',
                },
            ]
        )

        result = await service.search_llm_models(limit=100)

        assert {model.name for model in result.items} == {
            model['id'].split('/', 1)[1] for model in CHAT_MODELS
        }
        await service.http_client.aclose()

    @pytest.mark.asyncio
    async def test_supplier_labels_never_leak(self):
        service = _service(
            CHAT_MODELS
            + [
                {'id': 'spiderssense/best', 'provider': 'spiderssense'},
                {'id': 'nimbus/spider-sense-pro', 'provider': 'nimbus'},
            ]
        )

        models = await service.search_llm_models(limit=100)
        providers = await service.search_providers(limit=100)
        customer_visible = repr(models.model_dump()) + repr(providers.model_dump())

        assert 'spiderssense' not in customer_visible.lower()
        assert 'spider-sense' not in customer_visible.lower()
        assert 'spider sense' not in customer_visible.lower()
        await service.http_client.aclose()

    @pytest.mark.asyncio
    async def test_default_model_is_in_live_roster(self):
        service = _service(CHAT_MODELS)
        result = await service.search_llm_models(limit=100)
        returned = {f'{model.provider}/{model.name}' for model in result.items}
        assert NIMBUS_DEFAULT_MODEL in returned
        await service.http_client.aclose()

    @pytest.mark.asyncio
    async def test_query_and_provider_filters(self):
        service = _service(CHAT_MODELS)
        query_result = await service.search_llm_models(query='sonnet', limit=100)
        provider_result = await service.search_llm_models(
            provider_eq='openai', limit=100
        )
        assert [model.name for model in query_result.items] == ['claude-sonnet-5']
        assert all(model.provider == 'openai' for model in provider_result.items)
        await service.http_client.aclose()


class TestNimbusLLMModelServiceProviders:
    @pytest.mark.asyncio
    async def test_returns_model_maker_brands(self):
        service = _service(CHAT_MODELS)
        result = await service.search_providers(limit=100)

        assert isinstance(result, ProviderPage)
        assert [provider.name for provider in result.items] == [
            'anthropic',
            'openai',
            'deepseek',
            'qwen',
        ]
        assert all(provider.verified for provider in result.items)
        await service.http_client.aclose()


class TestNimbusLLMModelServiceInjector:
    @pytest.mark.asyncio
    async def test_injector_yields_nimbus_service(self):
        injector = NimbusLLMModelServiceInjector()
        async for service in injector.inject(state=None, request=None):
            assert isinstance(service, NimbusLLMModelService)
            break
