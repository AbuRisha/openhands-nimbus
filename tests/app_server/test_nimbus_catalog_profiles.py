"""The model picker hides itself when a user has no LLM profiles, so these
cover the seeding that makes it appear at all — and the two properties that are
easy to break later without noticing.

The security one is the reason this file exists as much as the feature is:
a seeded profile that forgets its base_url does not merely fail, it sends the
customer's Nimbus key to the model vendor's real endpoint.
"""

from __future__ import annotations

import pytest

from openhands.app_server.config_api.nimbus_llm_model_service import (
    NIMBUS_CHAT_MODELS,
    NIMBUS_DEFAULT_MODEL,
)
from openhands.app_server.settings.llm_profiles import (
    MAX_PROFILES_PER_USER,
    LLMProfiles,
)
from openhands.app_server.settings.nimbus_catalog_profiles import (
    display_name,
    repair_catalog_profile_base_urls,
    seed_catalog_profiles,
)
from openhands.sdk.llm import LLM

GATEWAY = 'https://api.nimbusapi.net'


class _Settings:
    """Stand-in for Settings — seeding only touches ``llm_profiles``."""

    def __init__(self, profiles: LLMProfiles | None = None) -> None:
        self.llm_profiles = profiles or LLMProfiles()


@pytest.fixture(autouse=True)
def _gateway(monkeypatch):
    monkeypatch.setenv('LLM_BASE_URL', GATEWAY)


def test_seeds_one_profile_per_catalog_model():
    settings = _Settings()

    assert seed_catalog_profiles(settings) is True

    assert len(settings.llm_profiles.profiles) == len(NIMBUS_CHAT_MODELS)
    seeded_models = {llm.model for llm in settings.llm_profiles.profiles.values()}
    assert seeded_models == set(NIMBUS_CHAT_MODELS)


def test_every_seeded_profile_pins_the_gateway():
    """The security property.

    resolve_llm_base_url returns the PROVIDER's endpoint for a profile that
    stores no base_url, and resolve_profile_llm then attaches the customer's
    key to it. A seeded profile missing base_url would ship an sk-nim-live-
    credential to api.anthropic.com.
    """
    settings = _Settings()
    seed_catalog_profiles(settings)

    for name, llm in settings.llm_profiles.profiles.items():
        assert llm.base_url == GATEWAY, f'{name} would leave the gateway'


def test_seeded_profiles_carry_no_api_key():
    """Keys are inherited at activation, never copied.

    A copied key would survive _upgrade_shared_key moving the customer onto
    their own key, so their usage would keep billing the deployment.
    """
    settings = _Settings()
    seed_catalog_profiles(settings)

    for name, llm in settings.llm_profiles.profiles.items():
        key = getattr(llm, 'api_key', None)
        plain = key.get_secret_value() if hasattr(key, 'get_secret_value') else key
        assert not plain, f'{name} should inherit the customer key, not hold one'


def test_seeding_is_idempotent():
    settings = _Settings()
    assert seed_catalog_profiles(settings) is True
    count = len(settings.llm_profiles.profiles)

    # Second load must report "nothing changed" — otherwise every settings
    # load would trigger a store() write.
    assert seed_catalog_profiles(settings) is False
    assert len(settings.llm_profiles.profiles) == count


def test_never_overwrites_a_user_profile():
    """A user's own configuration outranks the catalog."""
    name = display_name(NIMBUS_DEFAULT_MODEL)
    mine = LLM(model='anthropic/claude-sonnet-5', base_url='https://my-own-proxy')
    settings = _Settings(LLMProfiles(profiles={name: mine}))

    seed_catalog_profiles(settings)

    assert settings.llm_profiles.profiles[name].base_url == 'https://my-own-proxy'


def test_no_gateway_url_means_no_seeding():
    """Better an empty picker than profiles that route to the vendor."""
    settings = _Settings()

    import os

    os.environ.pop('LLM_BASE_URL', None)
    assert seed_catalog_profiles(settings) is False
    assert settings.llm_profiles.profiles == {}


def test_active_defaults_to_the_catalog_default():
    settings = _Settings()
    seed_catalog_profiles(settings)
    assert settings.llm_profiles.active == display_name(NIMBUS_DEFAULT_MODEL)


def test_seeding_does_not_steal_an_existing_active():
    chosen = display_name('anthropic/claude-opus-5')
    settings = _Settings(
        LLMProfiles(
            profiles={chosen: LLM(model='anthropic/claude-opus-5', base_url=GATEWAY)},
            active=chosen,
        )
    )

    seed_catalog_profiles(settings)

    assert settings.llm_profiles.active == chosen


def test_repair_repoints_a_stale_gateway():
    """The gateway URL moved once already (dropping /v1); frozen profiles 404."""
    name = display_name(NIMBUS_DEFAULT_MODEL)
    settings = _Settings(
        LLMProfiles(
            profiles={
                name: LLM(
                    model=NIMBUS_DEFAULT_MODEL,
                    base_url='https://api.nimbusapi.net/v1',
                )
            }
        )
    )

    assert repair_catalog_profile_base_urls(settings) is True
    assert settings.llm_profiles.profiles[name].base_url == GATEWAY


def test_repair_leaves_non_catalog_profiles_alone():
    """A BYOR profile may legitimately point at a third party with the user's
    own key; rewriting it would break it and misroute their traffic."""
    # gpt-4o is deliberately NOT in NIMBUS_CHAT_MODELS, and unlike a small
    # local model it clears the SDK's 16,384-token context-window floor, so the
    # profile constructs and the test exercises the branch it means to.
    settings = _Settings(
        LLMProfiles(
            profiles={
                'My Own Proxy': LLM(
                    model='openai/gpt-4o', base_url='https://byo.example.com'
                )
            }
        )
    )

    assert repair_catalog_profile_base_urls(settings) is False
    assert (
        settings.llm_profiles.profiles['My Own Proxy'].base_url
        == 'https://byo.example.com'
    )


def test_profile_cap_leaves_room_for_user_profiles():
    """The catalog must not consume the whole per-user allowance.

    At the old cap of 10 the 27 seeded profiles would put every user over the
    limit, and save() would reject their first hand-made profile.
    """
    assert MAX_PROFILES_PER_USER > len(NIMBUS_CHAT_MODELS)

    settings = _Settings()
    seed_catalog_profiles(settings)
    # The path a user takes when adding their own on top of the catalog.
    settings.llm_profiles.save('Mine', LLM(model='anthropic/claude-opus-5'))
    assert settings.llm_profiles.has('Mine')


@pytest.mark.parametrize(
    ('model', 'expected'),
    [
        ('anthropic/claude-sonnet-5', 'Claude Sonnet 5'),
        ('anthropic/claude-haiku-4.5', 'Claude Haiku 4.5'),
        ('openai/gpt-5.6-sol', 'GPT 5.6 Sol'),
        ('openai/gpt-5.1-codex-max', 'GPT 5.1 Codex Max'),
        ('google/gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview'),
        ('z-ai/glm-5.2', 'GLM 5.2'),
        ('moonshotai/kimi-k3', 'Kimi K3'),
        ('deepseek/deepseek-v4-flash', 'Deepseek V4 Flash'),
    ],
)
def test_display_names_read_like_product_names(model, expected):
    assert display_name(model) == expected


def test_display_names_are_unique_across_the_catalog():
    """Profiles are keyed by name — a collision would silently drop a model."""
    names = [display_name(m) for m in NIMBUS_CHAT_MODELS]
    assert len(set(names)) == len(names), 'duplicate display name in catalog'


def test_prunes_a_seeded_profile_whose_model_left_the_catalog():
    """Withdrawing a model must withdraw its picker entry.

    alibaba/qwen3.8-max was pulled because it 404s through our own gateway;
    accounts seeded beforehand kept offering it, which is the exact failure the
    withdrawal was meant to prevent.
    """
    from openhands.app_server.settings.nimbus_catalog_profiles import (
        prune_retired_catalog_profiles,
    )

    retired = LLM(model='alibaba/qwen3.8-max', base_url=GATEWAY)
    settings = _Settings(LLMProfiles(profiles={'Qwen3.8 Max': retired}))

    assert prune_retired_catalog_profiles(settings) is True
    assert 'Qwen3.8 Max' not in settings.llm_profiles.profiles


def test_pruning_spares_a_user_configured_profile():
    """A BYOR profile is the user's, even when its model is not in the catalog."""
    from openhands.app_server.settings.nimbus_catalog_profiles import (
        prune_retired_catalog_profiles,
    )

    mine = LLM(model='openai/gpt-4o', base_url='https://byo.example.com')
    settings = _Settings(LLMProfiles(profiles={'My Own': mine}))

    assert prune_retired_catalog_profiles(settings) is False
    assert 'My Own' in settings.llm_profiles.profiles


def test_pruning_leaves_the_live_catalog_intact():
    from openhands.app_server.settings.nimbus_catalog_profiles import (
        prune_retired_catalog_profiles,
    )

    settings = _Settings()
    seed_catalog_profiles(settings)
    count = len(settings.llm_profiles.profiles)

    assert prune_retired_catalog_profiles(settings) is False
    assert len(settings.llm_profiles.profiles) == count
