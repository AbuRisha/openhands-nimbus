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

# ── Token purpose ───────────────────────────────────────────────────────────
# Two different things are now signed with this one secret: the browser session
# cookie, and the MCP token a sandbox presents to POST /mcp/mcp. They MUST NOT
# be interchangeable. Without a purpose claim they would be byte-identical in
# shape, so an MCP token lifted out of a sandbox could be pasted in as a
# ``nimbus_session`` cookie and become a full browser session — a privilege
# escalation created by the fix rather than closed by it.
#
# So purpose is part of what is verified, not part of what is described. Every
# read path names the purpose it will accept and rejects every other value.
PURPOSE_SESSION: Final[str] = 'session'
PURPOSE_MCP: Final[str] = 'mcp'

# Session cookies minted before the purpose claim existed carry no ``purpose``
# key. They are still genuine sessions, so a missing claim reads as
# PURPOSE_SESSION — that is the ONLY defaulting allowed here, and it is why the
# MCP purpose has to be stated explicitly rather than inferred.
_LEGACY_PURPOSE: Final[str] = PURPOSE_SESSION

# Much shorter than the session cookie. The MCP token is minted fresh every
# time ``_configure_llm_and_mcp`` builds a conversation's agent config, so the
# ceiling only has to outlast a single conversation, not a login.
MCP_TOKEN_MAX_AGE_SECONDS: Final[int] = 60 * 60 * 24 * 7


def _secret() -> bytes | None:
    raw = os.getenv('NIMBUS_SSO_SHARED_SECRET') or ''
    return raw.encode('utf-8') if raw else None


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _b64d(text: str) -> bytes:
    pad = '=' * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def _issue(
    sub: str, purpose: str, max_age: int, extra: dict | None = None
) -> str | None:
    """Mint a signed token for ``sub``, stamped with ``purpose``.

    Returns None when no shared secret is configured — the caller must treat
    that as "cannot establish a credential" rather than falling back to an
    unsigned one.
    """
    secret = _secret()
    if not secret or not sub:
        return None
    claims = {
        'sub': sub,
        'purpose': purpose,
        'exp': int(time.time()) + max_age,
        **(extra or {}),
    }
    payload = json.dumps(claims, separators=(',', ':'), sort_keys=True).encode('utf-8')
    body = _b64e(payload)
    sig = _b64e(hmac.new(secret, body.encode('ascii'), hashlib.sha256).digest())
    return f'{body}.{sig}'


def _read(token: str | None, purpose: str) -> dict | None:
    """Verify a token AND that it was minted for ``purpose``; else None.

    Every failure path returns None. There is no "partially valid" result and
    no exception escapes: a caller that gets None must treat the request as
    unauthenticated. A valid signature over the wrong purpose is a failure —
    that check is what keeps an MCP token from acting as a session cookie.
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
    claimed = payload.get('purpose', _LEGACY_PURPOSE)
    if claimed != purpose:
        return None
    exp = payload.get('exp')
    if not isinstance(exp, int) or exp < int(time.time()):
        return None
    sub = payload.get('sub')
    if not isinstance(sub, str) or not sub:
        return None
    return payload


def issue_session(sub: str, email: str | None = None) -> str | None:
    """Mint a signed browser-session token for a verified Nimbus customer id."""
    return _issue(sub, PURPOSE_SESSION, SESSION_MAX_AGE_SECONDS, {'email': email or ''})


def read_session(token: str | None) -> dict | None:
    """Verify a browser-session token and return its payload, or None."""
    return _read(token, PURPOSE_SESSION)


def session_user_id(token: str | None) -> str | None:
    """The verified Nimbus customer id carried by a session token, or None."""
    payload = read_session(token)
    if payload is None:
        return None
    return payload.get('sub')


def issue_mcp_token(sub: str) -> str | None:
    """Mint the credential a sandbox presents to ``POST /mcp/mcp``.

    Scoped to one customer and to the MCP purpose, so it conveys exactly the
    authority that customer already has over their own provider tokens — it is
    not an escalation, it is the identity that was previously missing entirely.
    """
    return _issue(sub, PURPOSE_MCP, MCP_TOKEN_MAX_AGE_SECONDS)


def mcp_token_user_id(token: str | None) -> str | None:
    """The verified customer id carried by an MCP token, or None.

    A browser session cookie presented here returns None: it is signed with the
    same secret but stamped ``purpose=session``, and the two are deliberately
    not interchangeable in either direction.
    """
    payload = _read(token, PURPOSE_MCP)
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
