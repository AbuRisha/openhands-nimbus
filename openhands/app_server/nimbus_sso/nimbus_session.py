"""Signed, tamper-proof session token for the Nimbus SSO handoff.

WHY THIS EXISTS
---------------
The SSO handoff already verifies an HS256 JWT from nimbusapi.net and then stamps
identity cookies (``nimbus_sso_sub``, ``nimbus_sso_email``, ``nimbus_sso_name``).
Those cookies are set with ``httponly=False`` on purpose, so the SPA can read
the display name without another round-trip.

That makes them a display convenience and NOTHING ELSE. Any script on the page —
and anyone with devtools — can rewrite ``nimbus_sso_sub`` to another customer's
id. An authentication layer that trusted that cookie would be a gate that only
looks like a gate: it would keep out people who do not know it exists, and admit
anyone who does, which is worse than no gate at all because it reads as secure.

So identity travels in a SEPARATE cookie that the browser cannot forge:

    nimbus_session = <base64url(payload)>.<base64url(hmac_sha256(payload))>

signed with NIMBUS_SSO_SHARED_SECRET — the same secret the inbound JWT is
verified against, so no new key material is introduced. It is HttpOnly, so page
scripts cannot read it either.

This is deliberately not a JWT. We already depend on PyJWT for the inbound
token, but a hand-rolled HMAC here keeps the trust boundary obvious: there is
exactly one algorithm, no ``alg`` field to confuse, and therefore no "alg=none"
class of bug.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Final

from openhands.app_server.utils.logger import openhands_logger as logger

COOKIE_SESSION: Final[str] = 'nimbus_session'

# Matches the 30-day identity cookies the SSO router already sets, so a user is
# not signed out of the session while the display cookies still claim they are
# signed in.
SESSION_MAX_AGE_SECONDS: Final[int] = 60 * 60 * 24 * 30


def _secret() -> bytes | None:
    raw = os.getenv('NIMBUS_SSO_SHARED_SECRET') or ''
    return raw.encode('utf-8') if raw else None


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _b64d(text: str) -> bytes:
    pad = '=' * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def issue_session(sub: str, email: str | None = None) -> str | None:
    """Mint a signed session token for a verified Nimbus customer id.

    Returns None when no shared secret is configured — the caller must treat
    that as "cannot establish a session" rather than falling back to an
    unsigned one.
    """
    secret = _secret()
    if not secret or not sub:
        return None
    payload = json.dumps(
        {'sub': sub, 'email': email or '', 'exp': int(time.time()) + SESSION_MAX_AGE_SECONDS},
        separators=(',', ':'),
        sort_keys=True,
    ).encode('utf-8')
    body = _b64e(payload)
    sig = _b64e(hmac.new(secret, body.encode('ascii'), hashlib.sha256).digest())
    return f'{body}.{sig}'


def read_session(token: str | None) -> dict | None:
    """Verify a session token and return its payload, or None.

    Every failure path returns None. There is no "partially valid" result and
    no exception escapes: a caller that gets None must treat the request as
    unauthenticated.
    """
    secret = _secret()
    if not secret or not token or '.' not in token:
        return None
    body, _, sig = token.partition('.')
    try:
        expected = hmac.new(secret, body.encode('ascii'), hashlib.sha256).digest()
        # compare_digest, not ==, so a wrong signature cannot be discovered one
        # byte at a time by timing the response.
        if not hmac.compare_digest(_b64d(sig), expected):
            return None
        payload = json.loads(_b64d(body))
    except Exception:  # noqa: BLE001 - malformed input is simply not a session
        return None
    if not isinstance(payload, dict):
        return None
    exp = payload.get('exp')
    if not isinstance(exp, int) or exp < int(time.time()):
        return None
    sub = payload.get('sub')
    if not isinstance(sub, str) or not sub:
        return None
    return payload


def session_user_id(token: str | None) -> str | None:
    """The verified Nimbus customer id carried by a session token, or None."""
    payload = read_session(token)
    if payload is None:
        return None
    return payload.get('sub')


def warn_if_unconfigured() -> None:
    """Log loudly at startup if sessions cannot be signed."""
    if _secret() is None:
        logger.warning(
            'nimbus_session: NIMBUS_SSO_SHARED_SECRET is not set — no session can '
            'be issued or verified, so every request will be unauthenticated.'
        )
