import os
from unittest.mock import patch

import jwt
import pytest
from starlette.requests import Request

from openhands.app_server.errors import AuthError
from openhands.app_server.nimbus_sso.nimbus_session import (
    NIMBUS_SESSION_COOKIE,
    decode_nimbus_session,
    mint_nimbus_session,
)
from openhands.app_server.nimbus_sso.nimbus_sso_router import nimbus_sso
from openhands.app_server.user_auth.nimbus_user_auth import NimbusUserAuth

SECRET = 'test-only-nimbus-session-secret-0000000000000000'


def _request(token: str | None = None) -> Request:
    headers = []
    if token:
        headers.append((b'cookie', f'{NIMBUS_SESSION_COOKIE}={token}'.encode()))
    return Request({'type': 'http', 'headers': headers})


def test_session_round_trip_is_audience_bound() -> None:
    token = mint_nimbus_session(
        {'sub': 'customer_123', 'email': 'test@example.invalid', 'name': 'Test'},
        SECRET,
    )
    payload = decode_nimbus_session(token, SECRET)
    assert payload['sub'] == 'customer_123'
    assert payload['email'] == 'test@example.invalid'


def test_rejects_wrong_audience() -> None:
    token = jwt.encode(
        {
            'sub': 'customer_123',
            'email': 'test@example.invalid',
            'aud': 'builder',
            'iss': 'chat.nimbusapi.net',
            'exp': 4_000_000_000,
        },
        SECRET,
        algorithm='HS256',
    )
    with pytest.raises(jwt.InvalidAudienceError):
        decode_nimbus_session(token, SECRET)


@pytest.mark.asyncio
async def test_user_auth_requires_a_signed_session() -> None:
    with patch.dict(os.environ, {'NIMBUS_SSO_SHARED_SECRET': SECRET}):
        with pytest.raises(AuthError):
            await NimbusUserAuth.get_instance(_request())


@pytest.mark.asyncio
async def test_user_auth_returns_customer_identity() -> None:
    token = mint_nimbus_session(
        {'sub': 'customer_123', 'email': 'test@example.invalid'}, SECRET
    )
    with patch.dict(os.environ, {'NIMBUS_SSO_SHARED_SECRET': SECRET}):
        auth = await NimbusUserAuth.get_instance(_request(token))
    assert await auth.get_user_id() == 'customer_123'
    assert await auth.get_user_email() == 'test@example.invalid'
    settings = await auth.get_user_settings_store()
    secrets = await auth.get_secrets_store()
    assert settings.path == 'users/customer_123/settings.json'
    assert secrets.path == 'users/customer_123/secrets.json'


@pytest.mark.asyncio
async def test_user_id_cannot_escape_its_storage_namespace() -> None:
    token = mint_nimbus_session(
        {'sub': '../root', 'email': 'test@example.invalid'}, SECRET
    )
    with patch.dict(os.environ, {'NIMBUS_SSO_SHARED_SECRET': SECRET}):
        with pytest.raises(AuthError):
            await NimbusUserAuth.get_instance(_request(token))


@pytest.mark.asyncio
async def test_handoff_sets_one_httponly_no_store_session_cookie() -> None:
    handoff = jwt.encode(
        {
            'sub': 'customer_123',
            'email': 'test@example.invalid',
            'aud': 'chat',
            'exp': 4_000_000_000,
        },
        SECRET,
        algorithm='HS256',
    )
    with patch.dict(os.environ, {'NIMBUS_SSO_SHARED_SECRET': SECRET}):
        response = await nimbus_sso(token=handoff)
    cookie = response.headers['set-cookie']
    assert cookie.startswith(f'{NIMBUS_SESSION_COOKIE}=')
    assert 'HttpOnly' in cookie
    assert 'Secure' in cookie
    assert 'nimbus_sso_email' not in cookie
    assert response.headers['cache-control'] == 'private, no-store'
    assert response.headers['referrer-policy'] == 'no-referrer'
