"""Customer-scoped authentication for the hosted Nimbus Chat surface."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final

import jwt
from fastapi import HTTPException, Request, status

from openhands.app_server.user_auth.default_user_auth import DefaultUserAuth
from openhands.app_server.user_auth.user_auth import AuthType, UserAuth

SESSION_COOKIE: Final[str] = 'nimbus_chat_session'
SESSION_AUDIENCE: Final[str] = 'chat-session'
SESSION_ISSUER: Final[str] = 'nimbus-chat'
SESSION_MAX_AGE_SECONDS: Final[int] = 60 * 60 * 24 * 30


def _shared_secret() -> str:
    secret = os.getenv('NIMBUS_SSO_SHARED_SECRET')
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='nimbus_sso_not_configured',
        )
    return secret


def create_session_token(*, sub: str, email: str, name: str) -> str:
    """Create an HttpOnly chat session after the one-time SSO handoff."""
    now = datetime.now(UTC)
    return jwt.encode(
        {
            'sub': sub,
            'email': email,
            'name': name,
            'aud': SESSION_AUDIENCE,
            'iss': SESSION_ISSUER,
            'iat': now,
            'exp': now + timedelta(seconds=SESSION_MAX_AGE_SECONDS),
        },
        _shared_secret(),
        algorithm='HS256',
    )


def decode_session_token(token: str) -> dict[str, Any]:
    """Verify and decode a Nimbus Chat session cookie."""
    return jwt.decode(
        token,
        _shared_secret(),
        algorithms=['HS256'],
        audience=SESSION_AUDIENCE,
        issuer=SESSION_ISSUER,
        options={'require': ['sub', 'email', 'iat', 'exp']},
    )


@dataclass
class NimbusUserAuth(DefaultUserAuth):
    """Bind every app-server request to the signed Nimbus customer identity."""

    _user_id: str = ''
    _email: str | None = None

    async def get_user_id(self) -> str:
        return self._user_id

    async def get_user_email(self) -> str | None:
        return self._email

    def get_auth_type(self) -> AuthType:
        return AuthType.COOKIE

    @classmethod
    async def get_instance(cls, request: Request) -> UserAuth:
        token = request.cookies.get(SESSION_COOKIE)
        if not token:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail='nimbus_auth_required',
            )
        try:
            payload = decode_session_token(token)
        except jwt.PyJWTError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail='nimbus_session_invalid',
            ) from exc

        sub = payload.get('sub')
        email = payload.get('email')
        if (
            not isinstance(sub, str)
            or not sub
            or not isinstance(email, str)
            or not email
        ):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail='nimbus_session_invalid',
            )
        return cls(_user_id=sub, _email=email)

    @classmethod
    async def get_for_user(cls, user_id: str) -> UserAuth:
        if not user_id:
            raise ValueError('Nimbus user_id is required')
        return cls(_user_id=user_id)
