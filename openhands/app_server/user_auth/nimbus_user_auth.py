"""Nimbus customer authentication for the hosted OpenHands surface."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

import jwt
from fastapi import Request

from openhands.app_server.errors import AuthError
from openhands.app_server.nimbus_sso.nimbus_session import (
    NIMBUS_SESSION_COOKIE,
    decode_nimbus_session,
)
from openhands.app_server.secrets.file_secrets_store import FileSecretsStore
from openhands.app_server.secrets.secrets_store import SecretsStore
from openhands.app_server.settings.file_settings_store import FileSettingsStore
from openhands.app_server.settings.settings_store import SettingsStore
from openhands.app_server.user_auth.default_user_auth import DefaultUserAuth
from openhands.app_server.user_auth.user_auth import UserAuth


@dataclass
class NimbusUserAuth(DefaultUserAuth):
    user_id: str = ''
    email: str | None = None

    async def get_user_id(self) -> str:
        return self.user_id

    async def get_user_email(self) -> str | None:
        return self.email

    async def get_user_settings_store(self) -> SettingsStore:
        if self._settings_store:
            return self._settings_store
        from openhands.app_server.config import get_global_config

        self._settings_store = FileSettingsStore(
            get_global_config().file_store,
            path=f'users/{self.user_id}/settings.json',
        )
        return self._settings_store

    async def get_secrets_store(self) -> SecretsStore:
        if self._secrets_store:
            return self._secrets_store
        from openhands.app_server.config import get_global_config

        self._secrets_store = FileSecretsStore(
            get_global_config().file_store,
            path=f'users/{self.user_id}/secrets.json',
        )
        return self._secrets_store

    @classmethod
    async def get_instance(cls, request: Request) -> UserAuth:
        secret = os.getenv('NIMBUS_SSO_SHARED_SECRET')
        token = request.cookies.get(NIMBUS_SESSION_COOKIE)
        if not secret or not token:
            raise AuthError(detail='Nimbus sign-in required')
        try:
            payload = decode_nimbus_session(token, secret)
        except jwt.InvalidTokenError as exc:
            raise AuthError(detail='Nimbus session expired or invalid') from exc
        return cls(
            user_id=cls._validate_user_id(payload['sub']), email=payload['email']
        )

    @classmethod
    async def get_for_user(cls, user_id: str) -> UserAuth:
        return cls(user_id=cls._validate_user_id(user_id))

    @staticmethod
    def _validate_user_id(user_id: str) -> str:
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', user_id):
            raise AuthError(detail='Invalid Nimbus user id')
        return user_id
