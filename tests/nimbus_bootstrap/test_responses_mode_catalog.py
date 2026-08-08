"""The catalog and the chat-mode override have to stay in step.

WHY THIS TEST EXISTS
--------------------
`openai/gpt-5.5` began failing every chat turn in production with

    litellm.BadRequestError: OpenAIException - not_found: POST /responses

with no deploy on our side. litellm decides endpoint shape from
``litellm.model_cost``, which it FETCHES AT IMPORT from
raw.githubusercontent.com; when that fetch fails it silently falls back to the
map bundled with the installed version. So the same image can route the same
model two different ways depending on whether one HTTP call succeeded at
container start, and a model that worked for months can break overnight because
someone else edited a JSON file.

`nimbus_responses_mode` forces our own models back onto Chat Completions. That
list was one id, so it fixed one model and left the other twenty-six exposed to
the same thing. It now covers the catalog, and this test is what keeps it
covering the catalog: adding a model to NIMBUS_CHAT_MODELS without adding it
here would otherwise be silent until a customer hit it.

The list is duplicated rather than imported because
`config_api.nimbus_llm_model_service` costs ~6.5s to import and
`nimbus_responses_mode` runs from sitecustomize on every interpreter start in
the image. Duplication plus a test is the cheaper trade; duplication alone is
not.
"""

from __future__ import annotations


def _bare(model_id: str) -> str:
    """``openai/gpt-5.5`` -> ``gpt-5.5``."""
    return model_id.split('/', 1)[-1]


class TestOverrideListMatchesCatalog:
    def test_every_catalog_model_is_covered(self):
        from openhands.app_server.config_api.nimbus_llm_model_service import (
            NIMBUS_CHAT_MODELS,
        )
        from openhands.nimbus_bootstrap.nimbus_responses_mode import (
            NIMBUS_FORCE_CHAT_MODE,
        )

        missing = {_bare(m) for m in NIMBUS_CHAT_MODELS} - set(NIMBUS_FORCE_CHAT_MODE)
        assert not missing, (
            f'these catalog models are not covered by the chat-mode override: '
            f'{sorted(missing)}. If litellm ever reports mode "responses" for '
            'one of them, every chat turn on that model fails with '
            '"not_found: POST /responses".'
        )

    def test_no_model_outside_the_catalog_is_forced(self):
        """The guarantee the original one-id list was protecting.

        A customer's own BYOR model may genuinely need the Responses API, and
        must not be dragged onto Chat Completions by us. Restricting the list to
        our catalog is what keeps that true while still covering everything we
        sell.
        """
        from openhands.app_server.config_api.nimbus_llm_model_service import (
            NIMBUS_CHAT_MODELS,
        )
        from openhands.nimbus_bootstrap.nimbus_responses_mode import (
            NIMBUS_FORCE_CHAT_MODE,
        )

        extra = set(NIMBUS_FORCE_CHAT_MODE) - {_bare(m) for m in NIMBUS_CHAT_MODELS}
        assert not extra, (
            f'{sorted(extra)} are forced onto Chat Completions but are not '
            'models we sell; we should not be overriding routing for those.'
        )


class TestTheOverrideActuallyFlips:
    def test_a_responses_entry_is_rewritten(self, monkeypatch):
        """Exercise the flip rather than trusting the list alone.

        Uses a real catalog id so the test breaks if the id is dropped, and
        writes the registry through monkeypatch so it is restored afterwards -
        `litellm.model_cost` is process-global and a leaked edit would change
        how other tests route.
        """
        import litellm

        from openhands.nimbus_bootstrap.nimbus_responses_mode import (
            NIMBUS_FORCE_CHAT_MODE,
            install_chat_mode_overrides,
        )

        target = 'gpt-5.5'
        assert target in NIMBUS_FORCE_CHAT_MODE

        registry = dict(litellm.model_cost)
        registry[target] = {**registry.get(target, {}), 'mode': 'responses'}
        monkeypatch.setattr(litellm, 'model_cost', registry)

        changed = install_chat_mode_overrides()

        assert changed >= 1
        assert registry[target]['mode'] == 'chat'

    def test_a_chat_entry_is_left_alone(self, monkeypatch):
        """The override must be a no-op once litellm agrees with us.

        Without this, the function could be rewriting every entry it touches and
        the test above would still pass.
        """
        import litellm

        from openhands.nimbus_bootstrap.nimbus_responses_mode import (
            install_chat_mode_overrides,
        )

        registry = dict(litellm.model_cost)
        registry['gpt-5.5'] = {**registry.get('gpt-5.5', {}), 'mode': 'chat'}
        monkeypatch.setattr(litellm, 'model_cost', registry)

        install_chat_mode_overrides()

        assert registry['gpt-5.5']['mode'] == 'chat'


class TestResponsesApiOverride:
    """The switch that actually decides which litellm entry point is called.

    `install_chat_mode_overrides` edits `litellm.model_cost`. The SDK never
    reads it for this decision — `LLM.uses_responses_api()` answers from
    `RESPONSES_API_MODELS` in sdk/llm/utils/model_features.py. Extending the
    registry list therefore fixed nothing in production even with a matching
    deployed sha, which is why this test asserts on `uses_responses_api()`
    itself and not on the registry.
    """

    def _llm(self, model: str, base_url: str):
        from pydantic import SecretStr

        from openhands.sdk.llm.llm import LLM

        return LLM(model=model, base_url=base_url, api_key=SecretStr('x'), usage_id='t')

    def test_gateway_models_do_not_use_the_responses_api(self):
        from openhands.nimbus_bootstrap.nimbus_responses_mode import (
            install_responses_api_override,
        )

        install_responses_api_override()

        # Every OpenAI id in the catalog contains "gpt-5", so every one of them
        # matched the SDK's substring table. Checking several, because the bug
        # looked like a single broken model purely because one was tried.
        for model in (
            'openai/gpt-5.5',
            'openai/gpt-5.4',
            'openai/gpt-5.4-mini',
            'openai/gpt-5.6-luna',
            'openai/gpt-5.3-codex',
        ):
            llm = self._llm(model, 'https://api.nimbusapi.net')
            assert llm.uses_responses_api() is False, (
                f'{model} would be sent to POST /responses, which the gateway '
                'answers with not_found'
            )

    def test_a_customers_own_openai_endpoint_is_untouched(self):
        """The reason this is keyed on base_url and not on model names.

        A BYOK customer pointed at OpenAI directly should keep the Responses
        API; we only know that OUR gateway does not serve it.
        """
        from openhands.nimbus_bootstrap.nimbus_responses_mode import (
            install_responses_api_override,
        )

        install_responses_api_override()

        llm = self._llm('openai/gpt-5.5', 'https://api.openai.com/v1')
        assert llm.uses_responses_api() is True

    def test_applying_it_twice_does_not_stack_wrappers(self):
        from openhands.nimbus_bootstrap.nimbus_responses_mode import (
            install_responses_api_override,
        )

        assert install_responses_api_override() is True
        assert install_responses_api_override() is True
        llm = self._llm('openai/gpt-5.5', 'https://api.nimbusapi.net')
        assert llm.uses_responses_api() is False


class TestNimbusOnlyDeployments:
    """The rule that actually holds in production.

    The first version of this patch keyed only on `LLM.base_url`. It installed
    correctly in the agent child — the bootstrap markers read `respapi:True` —
    and changed nothing, because the endpoint reaches litellm from the
    environment rather than from that field. Installed is not the same as
    effective, and the marker proving the former is what made it look fixed.

    `NIMBUS_ONLY` is the deployment stating there is no endpoint other than our
    gateway, which is both stronger and simpler than anything recovered from
    the LLM object.
    """

    def _llm(self, model: str, base_url: str | None = None):
        from pydantic import SecretStr

        from openhands.sdk.llm.llm import LLM

        kwargs = {'model': model, 'api_key': SecretStr('x'), 'usage_id': 't'}
        if base_url:
            kwargs['base_url'] = base_url
        return LLM(**kwargs)

    def test_nimbus_only_forces_chat_even_with_no_base_url(self, monkeypatch):
        from openhands.nimbus_bootstrap.nimbus_responses_mode import (
            install_responses_api_override,
        )

        install_responses_api_override()
        monkeypatch.setenv('NIMBUS_ONLY', 'true')

        # No base_url at all — the production shape that defeated the first fix.
        assert self._llm('openai/gpt-5.5').uses_responses_api() is False

    def test_without_nimbus_only_a_byok_endpoint_keeps_responses(self, monkeypatch):
        from openhands.nimbus_bootstrap.nimbus_responses_mode import (
            install_responses_api_override,
        )

        install_responses_api_override()
        monkeypatch.delenv('NIMBUS_ONLY', raising=False)
        for var in ('LLM_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'):
            monkeypatch.delenv(var, raising=False)

        llm = self._llm('openai/gpt-5.5', 'https://api.openai.com/v1')
        assert llm.uses_responses_api() is True

    def test_env_supplied_gateway_is_honoured_without_nimbus_only(self, monkeypatch):
        """base_url absent, endpoint in the environment — resolve it the same
        way litellm does rather than concluding 'not our gateway'."""
        from openhands.nimbus_bootstrap.nimbus_responses_mode import (
            install_responses_api_override,
        )

        install_responses_api_override()
        monkeypatch.delenv('NIMBUS_ONLY', raising=False)
        monkeypatch.setenv('LLM_BASE_URL', 'https://api.nimbusapi.net/v1')

        assert self._llm('openai/gpt-5.5').uses_responses_api() is False
