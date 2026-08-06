"""What a brand new customer gets on their very first load.

The seed is the only place these defaults are decided, and every one of them is
here because its absence was a bug a customer could see: no LLM meant the
conversation hung at "Connecting...", no catalog profiles meant the model picker
rendered nothing, and sub-agents off meant "spawn an agent to do X" silently did
not exist.

Defaults are exactly the kind of thing that regresses without anyone noticing,
because nothing fails — the product just quietly does less.
"""

from __future__ import annotations

import pytest

from openhands.app_server.settings.nimbus_settings_store import NimbusSettingsStore


class _MemoryFileStore:
    """Enough of the file store for a first-run load: nothing is there yet."""

    def __init__(self) -> None:
        self.written: dict[str, str] = {}

    def read(self, path: str) -> str:
        if path not in self.written:
            raise FileNotFoundError(path)
        return self.written[path]

    def write(self, path: str, contents: str) -> None:
        self.written[path] = contents

    def list(self, path: str) -> list[str]:  # noqa: A003 - store protocol
        return list(self.written)

    def delete(self, path: str) -> None:
        self.written.pop(path, None)


@pytest.fixture
def seeded_settings(monkeypatch):
    """Run the real first-run seed and hand back what it produced."""
    monkeypatch.setenv('LLM_MODEL', 'anthropic/claude-sonnet-5')
    monkeypatch.setenv('LLM_BASE_URL', 'https://api.nimbusapi.net/v1')

    # The customer's own key: the seed asks nimbus-v2 for it rather than
    # falling back to the shared deployment key, so it has to be stubbed.
    async def _fake_key(_user_id, current_key=None):
        return 'sk-nim-live-testkey'

    monkeypatch.setattr(
        'openhands.app_server.settings.nimbus_settings_store.fetch_customer_api_key',
        _fake_key,
    )

    store = NimbusSettingsStore(
        file_store=_MemoryFileStore(),
        path='users/cust-1/settings.json',
        nimbus_user_id='cust-1',
    )

    import asyncio

    return (
        asyncio.get_event_loop_policy()
        .new_event_loop()
        .run_until_complete(store.load())
    )


def test_first_run_enables_sub_agents(seeded_settings):
    """Delegation is on out of the box.

    The SDK ships enable_sub_agents=False, which gates TaskToolSet out of the
    agent's tools entirely — so delegation did not exist until a customer found
    a toggle buried in Agent settings. A capability nobody can discover is one
    the product does not have.
    """
    assert seeded_settings is not None
    assert seeded_settings.agent_settings.enable_sub_agents is True


def test_first_run_fills_the_model_picker(seeded_settings):
    """A new customer's first view of chat already lists the catalog."""
    assert seeded_settings is not None
    profiles = seeded_settings.llm_profiles
    assert profiles is not None
    assert len(profiles.profiles) > 1


def test_first_run_uses_the_customers_own_key(seeded_settings):
    """Usage must draw down THEIR balance, never the deployment's."""
    assert seeded_settings is not None
    key = seeded_settings.agent_settings.llm.api_key
    plain = key.get_secret_value() if hasattr(key, 'get_secret_value') else key
    assert plain == 'sk-nim-live-testkey'
