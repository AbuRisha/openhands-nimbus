from __future__ import annotations

from http.cookies import SimpleCookie

import jwt
import pytest
from fastapi import HTTPException, Request

from openhands.app_server.app_conversation.app_conversation_router import (
    _require_customer_metering_ready,
)
from openhands.app_server.nimbus_sso.nimbus_sso_router import nimbus_sso
from openhands.app_server.nimbus_sso.nimbus_user_auth import (
    SESSION_COOKIE,
    NimbusUserAuth,
    create_session_token,
)


def _request_with_cookie(value: str | None) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if value is not None:
        headers.append((b'cookie', f'{SESSION_COOKIE}={value}'.encode()))
    return Request({'type': 'http', 'method': 'GET', 'path': '/', 'headers': headers})


@pytest.mark.asyncio
async def test_signed_session_binds_customer(monkeypatch):
    monkeypatch.setenv(
        'NIMBUS_SSO_SHARED_SECRET', 'test-shared-secret-at-least-32-bytes'
    )
    token = create_session_token(
        sub='customer-123', email='customer@example.com', name='Customer'
    )

    auth = await NimbusUserAuth.get_instance(_request_with_cookie(token))

    assert await auth.get_user_id() == 'customer-123'
    assert await auth.get_user_email() == 'customer@example.com'


@pytest.mark.asyncio
@pytest.mark.parametrize('cookie', [None, 'forged.browser.value'])
async def test_missing_or_forged_session_fails_closed(monkeypatch, cookie):
    monkeypatch.setenv(
        'NIMBUS_SSO_SHARED_SECRET', 'test-shared-secret-at-least-32-bytes'
    )

    with pytest.raises(HTTPException) as exc_info:
        await NimbusUserAuth.get_instance(_request_with_cookie(cookie))

    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_sso_exchanges_handoff_for_httponly_session(monkeypatch):
    secret = 'test-shared-secret-at-least-32-bytes'
    monkeypatch.setenv('NIMBUS_SSO_SHARED_SECRET', secret)
    handoff = jwt.encode(
        {
            'sub': 'customer-123',
            'email': 'customer@example.com',
            'name': 'Customer',
            'aud': 'chat',
        },
        secret,
        algorithm='HS256',
    )

    response = await nimbus_sso(handoff)
    cookies = SimpleCookie()
    for header in response.headers.getlist('set-cookie'):
        cookies.load(header)

    session = cookies[SESSION_COOKIE]
    assert session['httponly']
    assert session['secure']
    auth = await NimbusUserAuth.get_instance(_request_with_cookie(session.value))
    assert await auth.get_user_id() == 'customer-123'


def test_execution_fails_closed_until_customer_metering_is_ready(monkeypatch):
    monkeypatch.setenv('NIMBUS_AUTH_REQUIRED', 'true')
    monkeypatch.delenv('NIMBUS_CUSTOMER_METERING_READY', raising=False)

    with pytest.raises(HTTPException) as exc_info:
        _require_customer_metering_ready()

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == 'nimbus_customer_metering_not_configured'


@pytest.mark.parametrize('ready_value', ['true', '1'])
def test_execution_accepts_supported_customer_metering_flags(monkeypatch, ready_value):
    monkeypatch.setenv('NIMBUS_AUTH_REQUIRED', 'true')
    monkeypatch.setenv('NIMBUS_CUSTOMER_METERING_READY', ready_value)

    _require_customer_metering_ready()
