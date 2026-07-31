"""GET /api/auth/nimbus-sso — HS256 JWT handoff from nimbusapi.net dashboard.

The nimbusapi.net dashboard mints a 60-second HS256 JWT via its own
/api/auth/chat-token route, then navigates the browser here with
?token=<jwt>. We verify the JWT with the shared secret
(NIMBUS_SSO_SHARED_SECRET, identical on both sides), stamp cookies that
identify the Nimbus customer for downstream code that wants them, and
302 the user to the chat root. On ANY failure we redirect to
/?error=<code> so the frontend can surface a message rather than dumping
a stack trace.

Successful handoff exchanges the short-lived query token for one signed,
HttpOnly, audience-bound session cookie consumed by NimbusUserAuth.
"""

from __future__ import annotations

import os
from typing import Final

import jwt
from fastapi import APIRouter, Query
from fastapi.responses import RedirectResponse

from openhands.app_server.nimbus_sso.nimbus_session import (
    NIMBUS_SESSION_COOKIE,
    NIMBUS_SESSION_MAX_AGE_SECONDS,
    mint_nimbus_session,
)
from openhands.app_server.utils.logger import openhands_logger as logger

router = APIRouter(tags=['NimbusSSO'])

_JWT_LEEWAY_SECONDS: Final[int] = 5


def _redirect_error(code: str) -> RedirectResponse:
    """302 to the SPA root with an error query param the frontend can read."""
    response = RedirectResponse(url=f'/?error={code}', status_code=302)
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response


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
        )
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
    if not isinstance(sub, str) or not sub:
        logger.warning('nimbus_sso:payload missing sub')
        return _redirect_error('sso_payload')

    logger.info('nimbus_sso:ok')

    session_token = mint_nimbus_session(payload, secret)
    response = RedirectResponse(url='/', status_code=302)
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.set_cookie(
        NIMBUS_SESSION_COOKIE,
        session_token,
        max_age=NIMBUS_SESSION_MAX_AGE_SECONDS,
        path='/',
        secure=True,
        httponly=True,
        samesite='lax',
    )
    return response
