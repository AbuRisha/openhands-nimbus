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
