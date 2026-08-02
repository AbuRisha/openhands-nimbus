"""GET /api/auth/nimbus-sso — HS256 JWT handoff from nimbusapi.net dashboard.

The nimbusapi.net dashboard mints a 60-second HS256 JWT via its own
/api/auth/chat-token route, then navigates the browser here with
?token=<jwt>. We verify the JWT with the shared secret
(NIMBUS_SSO_SHARED_SECRET, identical on both sides), stamp cookies that
identify the Nimbus customer for downstream code that wants them, and
302 the user to the chat root. On ANY failure we redirect to
/?error=<code> so the frontend can surface a message rather than dumping
a stack trace.

DefaultUserAuth in this fork is single-user (returns None for user_id
and treats every request as root), so the cookies below are informational
- they let future middleware attach a Nimbus identity without breaking
today's flow.
"""

from __future__ import annotations

import os
from typing import Final

import jwt
from fastapi import APIRouter, Query
from fastapi.responses import RedirectResponse

from openhands.app_server.nimbus_sso.nimbus_session import (
    COOKIE_SESSION,
    SESSION_MAX_AGE_SECONDS,
    issue_session,
)
from openhands.app_server.utils.logger import openhands_logger as logger

router = APIRouter(tags=['NimbusSSO'])

# Cookies are informational for DefaultUserAuth today but let future
# middleware pin an identity without another round-trip to nimbus-v2.
_COOKIE_EMAIL: Final[str] = 'nimbus_sso_email'
_COOKIE_SUB: Final[str] = 'nimbus_sso_sub'
_COOKIE_NAME: Final[str] = 'nimbus_sso_name'
_COOKIE_MAX_AGE_SECONDS: Final[int] = 60 * 60 * 24 * 30  # 30 days
_JWT_LEEWAY_SECONDS: Final[int] = 5


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
    name = payload.get('name') or email.split('@')[0]

    logger.info('nimbus_sso:ok sub=%s email=%s', sub, email)

    # Redirect to SPA root and stamp identity cookies. Path=/ so the whole
    # app can read them; HttpOnly=False so the SPA can pick up displayName
    # without another /me round-trip; Secure=True since we're always TLS
    # behind ACA; SameSite=Lax so the cross-site redirect from
    # nimbusapi.net keeps the cookies.
    response = RedirectResponse(url='/', status_code=302)
    cookie_kwargs = dict(
        max_age=_COOKIE_MAX_AGE_SECONDS,
        path='/',
        secure=True,
        httponly=False,
        samesite='lax',
    )
    # The three cookies below are DISPLAY ONLY and deliberately not HttpOnly,
    # so the SPA can render a name without another round-trip. They are
    # therefore forgeable by any script on the page and MUST NOT be trusted for
    # identity. NimbusUserAuth reads the signed session cookie instead.
    session = issue_session(sub if isinstance(sub, str) else '', email)
    if session:
        response.set_cookie(
            COOKIE_SESSION,
            session,
            max_age=SESSION_MAX_AGE_SECONDS,
            path='/',
            secure=True,
            httponly=True,   # the whole point: page scripts cannot read or forge it
            samesite='lax',
        )
    else:
        # No shared secret, or no subject. Say so rather than silently signing
        # the user in with an identity nothing can verify.
        logger.error(
            'nimbus_sso: could not issue a signed session (missing '
            'NIMBUS_SSO_SHARED_SECRET or empty sub) - the user will be treated '
            'as unauthenticated'
        )

    response.set_cookie(_COOKIE_EMAIL, email, **cookie_kwargs)
    if isinstance(sub, str) and sub:
        response.set_cookie(_COOKIE_SUB, sub, **cookie_kwargs)
    if isinstance(name, str) and name:
        response.set_cookie(_COOKIE_NAME, name, **cookie_kwargs)
    return response
