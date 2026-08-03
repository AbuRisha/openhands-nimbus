"""UserAuth backed by the signed Nimbus SSO session.

DefaultUserAuth returns None for user_id — its own docstring says it "does not
support multi tenancy" — so every request is the same anonymous root user and
every customer shares one workspace. This implementation returns the real Nimbus
customer id instead, taken from the HMAC-signed ``nimbus_session`` cookie that
the SSO handoff issues.

WHAT THIS DOES AND DOES NOT GIVE YOU
------------------------------------
It gives a VERIFIED per-request identity, and it is what the storage layer keys
off. It is the necessary half of isolation, not the whole of it: a store that
ignores the user_id it is handed will still leak across customers no matter how
trustworthy the id is. See sql_app_conversation_info_service (query filter) and
the user-scoped settings/secrets stores for the other half.

The identity comes ONLY from the signed cookie. The nimbus_sso_sub /
nimbus_sso_email / nimbus_sso_name cookies set alongside it are HttpOnly=False
by design so the SPA can render a name, which means any script on the page can
rewrite them. They are never read here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Request
from pydantic import SecretStr

from openhands.app_server import shared
from openhands.app_server.integrations.provider import PROVIDER_TOKEN_TYPE
from openhands.app_server.nimbus_sso.nimbus_session import COOKIE_SESSION, read_session
from openhands.app_server.secrets.secrets_models import Secrets
from openhands.app_server.secrets.secrets_store import SecretsStore
from openhands.app_server.settings.settings_models import Settings
from openhands.app_server.settings.settings_store import SettingsStore
from openhands.app_server.user_auth.user_auth import UserAuth


@dataclass
class NimbusUserAuth(UserAuth):
    """Per-customer identity resolved from the signed Nimbus session cookie."""

    _user_id: str | None = None
    _user_email: str | None = None
    _settings: Settings | None = field(default=None)
    _settings_store: SettingsStore | None = field(default=None)
    _secrets_store: SecretsStore | None = field(default=None)
    _secrets: Secrets | None = field(default=None)

    async def get_user_id(self) -> str | None:
        return self._user_id

    async def get_user_email(self) -> str | None:
        return self._user_email

    async def get_access_token(self) -> SecretStr | None:
        # Nimbus does not hand chat an upstream access token; the customer's
        # own API key is configured through settings.
        return None

    async def get_user_settings_store(self) -> SettingsStore:
        settings_store = self._settings_store
        if settings_store:
            return settings_store
        # The user_id is what makes this store per-customer. With
        # FileSettingsStore it was accepted and ignored; the Nimbus stores use
        # it as the key.
        settings_store = await shared.SettingsStoreImpl.get_instance(
            await self.get_user_id()
        )
        if settings_store is None:
            raise ValueError('Failed to get settings store instance')
        self._settings_store = settings_store
        return settings_store

    async def get_secrets_store(self) -> SecretsStore:
        secrets_store = self._secrets_store
        if secrets_store:
            return secrets_store
        secrets_store = await shared.SecretsStoreImpl.get_instance(
            await self.get_user_id()
        )
        if secrets_store is None:
            raise ValueError('Failed to get secrets store instance')
        self._secrets_store = secrets_store
        return secrets_store

    async def get_secrets(self) -> Secrets | None:
        if self._secrets:
            return self._secrets
        store = await self.get_secrets_store()
        self._secrets = await store.load()
        return self._secrets

    async def get_provider_tokens(self) -> PROVIDER_TOKEN_TYPE | None:
        secrets = await self.get_secrets()
        return None if secrets is None else secrets.provider_tokens

    async def get_mcp_api_key(self) -> str | None:
        return None

    @classmethod
    async def get_instance(cls, request: Request) -> UserAuth:
        payload = read_session(request.cookies.get(COOKIE_SESSION))
        if payload is None:
            # Unauthenticated. user_id stays None, which the auth dependency
            # turns into a 401 — it does NOT silently fall back to a shared
            # workspace, which is what DefaultUserAuth did.
            return NimbusUserAuth()
        return NimbusUserAuth(
            _user_id=payload.get('sub'),
            _user_email=payload.get('email') or None,
        )

    @classmethod
    async def get_for_user(cls, user_id: str) -> UserAuth:
        # Used by background work that already knows whose behalf it acts on
        # (callbacks, schedulers). No request, so no cookie to verify.
        return NimbusUserAuth(_user_id=user_id)
