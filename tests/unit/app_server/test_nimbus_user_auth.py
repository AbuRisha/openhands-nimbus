from __future__ import annotations

from datetime import UTC, datetime
from http.cookies import SimpleCookie

import jwt
import pytest
from fastapi import HTTPException, Request

from openhands.app_server.config import get_global_config
from openhands.app_server.config_api.config_models import AppMode
from openhands.app_server.nimbus_sso.nimbus_execution_gate import (
    require_customer_metering_ready,
)
from openhands.app_server.nimbus_sso.nimbus_sso_router import (
    nimbus_authenticate,
    nimbus_sso,
)
from openhands.app_server.nimbus_sso.nimbus_user_auth import (
    SESSION_COOKIE,
    NimbusUserAuth,
    create_session_token,
    should_redirect_nimbus_guest,
)
from openhands.app_server.server_config.server_config import ServerConfig


def _request_with_cookie(
    value: str | None,
    *,
    path: str = '/',
    method: str = 'GET',
    accept: str | None = None,
) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if value is not None:
        headers.append((b'cookie', f'{SESSION_COOKIE}={value}'.encode()))
    if accept is not None:
        headers.append((b'accept', accept.encode()))
    return Request({'type': 'http', 'method': method, 'path': path, 'headers': headers})


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
    now = int(datetime.now(UTC).timestamp())
    handoff = jwt.encode(
        {
            'sub': 'customer-123',
            'email': 'customer@example.com',
            'name': 'Customer',
            'aud': 'chat',
            'iat': now,
            'exp': now + 60,
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


@pytest.mark.asyncio
@pytest.mark.parametrize('missing_claim', ['iat', 'exp'])
async def test_sso_rejects_handoff_without_time_boundary(monkeypatch, missing_claim):
    secret = 'test-shared-secret-at-least-32-bytes'
    monkeypatch.setenv('NIMBUS_SSO_SHARED_SECRET', secret)
    now = int(datetime.now(UTC).timestamp())
    payload = {
        'sub': 'customer-123',
        'email': 'customer@example.com',
        'aud': 'chat',
        'iat': now,
        'exp': now + 60,
    }
    payload.pop(missing_claim)

    response = await nimbus_sso(jwt.encode(payload, secret, algorithm='HS256'))

    assert response.status_code == 302
    assert response.headers['location'] == '/?error=sso_expired'
    assert SESSION_COOKIE not in response.headers.get('set-cookie', '')


@pytest.mark.asyncio
async def test_sso_rejects_handoff_lifetime_beyond_replay_window(monkeypatch):
    secret = 'test-shared-secret-at-least-32-bytes'
    monkeypatch.setenv('NIMBUS_SSO_SHARED_SECRET', secret)
    now = int(datetime.now(UTC).timestamp())
    handoff = jwt.encode(
        {
            'sub': 'customer-123',
            'email': 'customer@example.com',
            'aud': 'chat',
            'iat': now,
            'exp': now + 61,
        },
        secret,
        algorithm='HS256',
    )

    response = await nimbus_sso(handoff)

    assert response.status_code == 302
    assert response.headers['location'] == '/?error=sso_expired'
    assert SESSION_COOKIE not in response.headers.get('set-cookie', '')


@pytest.mark.asyncio
async def test_spa_authenticate_requires_signed_customer_session(monkeypatch):
    monkeypatch.setenv(
        'NIMBUS_SSO_SHARED_SECRET', 'test-shared-secret-at-least-32-bytes'
    )
    with pytest.raises(HTTPException) as exc_info:
        await nimbus_authenticate(_request_with_cookie(None))
    assert exc_info.value.status_code == 401


def test_direct_host_html_guest_redirects_but_valid_customer_does_not(monkeypatch):
    monkeypatch.setenv('NIMBUS_AUTH_REQUIRED', 'true')
    monkeypatch.setenv(
        'NIMBUS_SSO_SHARED_SECRET', 'test-shared-secret-at-least-32-bytes'
    )
    guest = _request_with_cookie(None, accept='text/html')
    token = create_session_token(
        sub='customer-123', email='customer@example.com', name='Customer'
    )
    customer = _request_with_cookie(token, accept='text/html')

    assert should_redirect_nimbus_guest(guest) is True
    assert should_redirect_nimbus_guest(customer) is False


def test_guest_redirect_does_not_intercept_api_or_assets(monkeypatch):
    monkeypatch.setenv('NIMBUS_AUTH_REQUIRED', 'true')
    api_request = _request_with_cookie(
        None, path='/api/auth/nimbus-sso', accept='text/html'
    )
    asset_request = _request_with_cookie(
        None, path='/assets/app.js', accept='application/javascript'
    )

    assert should_redirect_nimbus_guest(api_request) is False
    assert should_redirect_nimbus_guest(asset_request) is False


def test_hosted_server_uses_saas_auth_mode():
    assert ServerConfig.app_mode == AppMode.SAAS
    assert get_global_config().app_mode == AppMode.SAAS
    assert ServerConfig.user_auth_class.endswith('.NimbusUserAuth')


def test_execution_fails_closed_until_customer_metering_is_ready(monkeypatch):
    monkeypatch.setenv('NIMBUS_AUTH_REQUIRED', 'true')
    monkeypatch.delenv('NIMBUS_CUSTOMER_METERING_READY', raising=False)

    with pytest.raises(HTTPException) as exc_info:
        require_customer_metering_ready()

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == 'nimbus_customer_metering_not_configured'


@pytest.mark.parametrize('ready_value', ['true', '1'])
def test_execution_accepts_supported_customer_metering_flags(monkeypatch, ready_value):
    monkeypatch.setenv('NIMBUS_AUTH_REQUIRED', 'true')
    monkeypatch.setenv('NIMBUS_CUSTOMER_METERING_READY', ready_value)

    require_customer_metering_ready()
