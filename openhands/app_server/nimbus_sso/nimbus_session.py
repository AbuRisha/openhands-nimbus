"""Signed, HttpOnly Nimbus Chat session cookies.

The dashboard handoff JWT is intentionally short lived. After validating it,
the chat service exchanges it for this audience-bound session token so normal
API requests can be authenticated without exposing identity fields to JS.
"""

from __future__ import annotations

import time
from typing import Any, Final

import jwt

NIMBUS_SESSION_COOKIE: Final[str] = 'nimbus_chat_session'
NIMBUS_SESSION_AUDIENCE: Final[str] = 'chat-session'
NIMBUS_SESSION_ISSUER: Final[str] = 'chat.nimbusapi.net'
NIMBUS_SESSION_MAX_AGE_SECONDS: Final[int] = 60 * 60 * 24 * 7


def mint_nimbus_session(
    handoff_payload: dict[str, Any], secret: str, *, now: int | None = None
) -> str:
    issued_at = int(time.time()) if now is None else now
    subject = handoff_payload.get('sub')
    email = handoff_payload.get('email')
    if not isinstance(subject, str) or not subject:
        raise ValueError('missing subject')
    if not isinstance(email, str) or not email:
        raise ValueError('missing email')
    payload = {
        'sub': subject,
        'email': email,
        'name': handoff_payload.get('name'),
        'aud': NIMBUS_SESSION_AUDIENCE,
        'iss': NIMBUS_SESSION_ISSUER,
        'iat': issued_at,
        'exp': issued_at + NIMBUS_SESSION_MAX_AGE_SECONDS,
    }
    return jwt.encode(payload, secret, algorithm='HS256')


def decode_nimbus_session(token: str, secret: str) -> dict[str, Any]:
    payload = jwt.decode(
        token,
        secret,
        algorithms=['HS256'],
        audience=NIMBUS_SESSION_AUDIENCE,
        issuer=NIMBUS_SESSION_ISSUER,
        leeway=5,
    )
    subject = payload.get('sub')
    email = payload.get('email')
    if not isinstance(subject, str) or not subject:
        raise jwt.InvalidTokenError('missing subject')
    if not isinstance(email, str) or not email:
        raise jwt.InvalidTokenError('missing email')
    return payload
