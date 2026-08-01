"""GET /api/auth/nimbus-sso — HS256 JWT handoff from nimbusapi.net dashboard.

The nimbusapi.net dashboard mints a 60-second HS256 JWT via its own
/api/auth/chat-token route, then navigates the browser here with
?token=<jwt>. We verify the JWT with the shared secret
(NIMBUS_SSO_SHARED_SECRET, identical on both sides), stamp a signed session
cookie that binds requests to the Nimbus customer, and
302 the user to the chat root. On ANY failure we redirect to
/?error=<code> so the frontend can surface a message rather than dumping
a stack trace.

The one-time handoff token is never used as the long-lived session itself.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Final

import jwt
from fastapi import APIRouter, Query, Request
from fastapi.responses import RedirectResponse

from openhands.app_server.nimbus_sso.nimbus_user_auth import (
    SESSION_COOKIE,
    SESSION_MAX_AGE_SECONDS,
    NimbusUserAuth,
    create_session_token,
)
from openhands.app_server.utils.logger import openhands_logger as logger

router = APIRouter(tags=['NimbusSSO'])

_JWT_LEEWAY_SECONDS: Final[int] = 5
_HANDOFF_MAX_AGE_SECONDS: Final[int] = 60


def _redirect_error(code: str) -> RedirectResponse:
    """302 to the SPA root with an error query param the frontend can read."""
    return RedirectResponse(url=f'/?error={code}', status_code=302)


@router.get('/api/auth/nimbus-sso', include_in_schema=False)
async def nimbus_sso(token: str | None = Query(default=None)) -> RedirectResponse:
    """Verify HS256 JWT from nimbusapi.net and sign the user into chat."""
    if not token:
        logger.info('nimbus_sso:missing_token')
        return _redirect_error('sso_missing')

    secret = os.getenv('NIMBUS_SSO_SHARED_SECRET')
    if not secret:
        logger.error('nimbus_sso:NIMBUS_SSO_SHARED_SECRET not set on container')
        return _redirect_error('sso_not_configured')

    try:
        payload = jwt.decode(
            token,
            secret,
            algorithms=['HS256'],
            audience='chat',
            leeway=_JWT_LEEWAY_SECONDS,
            options={'require': ['sub', 'email', 'aud', 'iat', 'exp']},
        )
        issued_at = payload['iat']
        expires_at = payload['exp']
        if (
            isinstance(issued_at, bool)
            or not isinstance(issued_at, (int, float))
            or isinstance(expires_at, bool)
            or not isinstance(expires_at, (int, float))
            or expires_at <= issued_at
            or expires_at - issued_at > _HANDOFF_MAX_AGE_SECONDS
            or datetime.now(UTC).timestamp() - issued_at
            > _HANDOFF_MAX_AGE_SECONDS + _JWT_LEEWAY_SECONDS
        ):
            raise jwt.InvalidTokenError('handoff lifetime is invalid')
    except jwt.ExpiredSignatureError:
        logger.info('nimbus_sso:expired')
        return _redirect_error('sso_expired')
    except jwt.InvalidSignatureError:
        logger.warning('nimbus_sso:invalid_signature')
        return _redirect_error('sso_expired')
    except jwt.InvalidTokenError as exc:
        logger.warning('nimbus_sso:invalid_token %s', type(exc).__name__)
        return _redirect_error('sso_expired')

    email = payload.get('email')
    if not isinstance(email, str) or not email:
        logger.warning('nimbus_sso:payload missing email')
        return _redirect_error('sso_payload')

    sub = payload.get('sub')
    name = payload.get('name') or email.split('@')[0]

    logger.info('nimbus_sso:ok sub=%s email=%s', sub, email)

    if not isinstance(sub, str) or not sub:
        logger.warning('nimbus_sso:payload missing sub')
        return _redirect_error('sso_payload')
    if not isinstance(name, str) or not name:
        name = email.split('@')[0]

    # Exchange the one-minute handoff JWT for a signed, HttpOnly chat session.
    # Identity is never accepted from the old browser-writable display cookies.
    response = RedirectResponse(url='/', status_code=302)
    response.set_cookie(
        SESSION_COOKIE,
        create_session_token(sub=sub, email=email, name=name),
        max_age=SESSION_MAX_AGE_SECONDS,
        path='/',
        secure=True,
        httponly=True,
        samesite='lax',
    )
    # Remove the legacy unsigned identity cookies on the first successful handoff.
    for legacy_cookie in ('nimbus_sso_email', 'nimbus_sso_sub', 'nimbus_sso_name'):
        response.delete_cookie(legacy_cookie, path='/', secure=True, samesite='lax')
    return response


@router.post('/api/authenticate', include_in_schema=False)
async def nimbus_authenticate(request: Request) -> dict[str, bool]:
    """Authenticate the SPA against the signed Nimbus customer session."""
    await NimbusUserAuth.get_instance(request)
    return {'authenticated': True}
