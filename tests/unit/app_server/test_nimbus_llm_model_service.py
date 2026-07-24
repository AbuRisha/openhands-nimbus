"""Unit tests for the Nimbus SS-native LLM catalog service.

Pins the guarantee that the customer-facing model picker only offers the
15 curated Nimbus chat models — never the raw LiteLLM/Bedrock/Ollama
catalogue.
"""

import pytest

from openhands.app_server.config_api.config_models import (
    LLMModelPage,
    ProviderPage,
)
from openhands.app_server.config_api.nimbus_llm_model_service import (
    NIMBUS_CHAT_MODELS,
    NIMBUS_DEFAULT_MODEL,
    NIMBUS_VERIFIED_PROVIDERS,
    NimbusLLMModelService,
    NimbusLLMModelServiceInjector,
)


class TestNimbusLLMModelServiceCatalog:
    """The catalog is closed: only the 15 SS-native models are exposed."""

    @pytest.mark.asyncio
    async def test_search_returns_only_nimbus_models(self):
        service = NimbusLLMModelService()
        result = await service.search_llm_models(limit=100)

        assert isinstance(result, LLMModelPage)
        returned = {f'{m.provider}/{m.name}' for m in result.items}
        assert returned == set(NIMBUS_CHAT_MODELS)

    @pytest.mark.asyncio
    async def test_every_returned_model_is_verified(self):
        """Nimbus curates every model — none are 'unverified' from the
        customer's point of view."""
        service = NimbusLLMModelService()
        result = await service.search_llm_models(limit=100)

        assert all(m.verified for m in result.items)
        assert not any(m.hidden for m in result.items)

    @pytest.mark.asyncio
    async def test_default_model_is_claude_sonnet_5(self):
        """The Nimbus default is anthropic/claude-sonnet-5 per the platform
        brief. This test fails loudly if that ever drifts."""
        assert NIMBUS_DEFAULT_MODEL == 'anthropic/claude-sonnet-5'
        assert NIMBUS_DEFAULT_MODEL in NIMBUS_CHAT_MODELS

    @pytest.mark.asyncio
    async def test_no_upstream_provider_leaks(self):
        """A regression test: if anyone adds 'bedrock/', 'ollama/', 'clarifai/',
        or any raw LiteLLM catalogue entry to NIMBUS_CHAT_MODELS, this fails."""
        forbidden_prefixes = ('bedrock/', 'ollama/', 'clarifai/', 'openhands/')
        for model in NIMBUS_CHAT_MODELS:
            assert not model.startswith(forbidden_prefixes), (
                f'{model!r} would leak an upstream/internal provider into '
                f'the customer UI'
            )

    @pytest.mark.asyncio
    async def test_query_filter(self):
        service = NimbusLLMModelService()
        result = await service.search_llm_models(query='sonnet', limit=100)
        names = {m.name for m in result.items}
        assert 'claude-sonnet-5' in names
        # No non-matching model should slip through the filter.
        assert all('sonnet' in m.name.lower() for m in result.items)

    @pytest.mark.asyncio
    async def test_provider_filter(self):
        service = NimbusLLMModelService()
        result = await service.search_llm_models(provider_eq='anthropic', limit=100)
        assert result.items
        assert all(m.provider == 'anthropic' for m in result.items)


class TestNimbusLLMModelServiceProviders:
    @pytest.mark.asyncio
    async def test_returns_curated_providers_only(self):
        service = NimbusLLMModelService()
        result = await service.search_providers(limit=100)

        assert isinstance(result, ProviderPage)
        names = [p.name for p in result.items]
        assert names == NIMBUS_VERIFIED_PROVIDERS
        assert all(p.verified for p in result.items)


class TestNimbusLLMModelServiceInjector:
    @pytest.mark.asyncio
    async def test_injector_yields_nimbus_service(self):
        injector = NimbusLLMModelServiceInjector()
        async for service in injector.inject(state=None, request=None):
            assert isinstance(service, NimbusLLMModelService)
            break
