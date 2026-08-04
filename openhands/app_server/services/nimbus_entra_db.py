"""Authenticate to Postgres with a managed identity instead of a password.

WHY
---
``DB_PASS`` was readable by every chat sandbox until the environment allowlist
landed, because RUNTIME=process makes the sandbox a child of the app container.
Scrubbing closed that path, but the password still exists, still sits in the
container environment, and is still the single thing standing between a leak and
the database.

Microsoft Entra authentication removes the secret rather than hiding it. The app
presents a token minted for its own managed identity, valid for about an hour,
scoped to one database role. There is nothing durable to steal: a token copied
out of the environment is useless within the hour, and useless immediately from
anywhere that cannot also prove it is this container app.

HOW THE TOKEN IS FETCHED
------------------------
Container Apps injects IDENTITY_ENDPOINT and IDENTITY_HEADER, the same contract
App Service uses. IMDS (169.254.169.254) is the fallback for hosts that do not.
Neither path needs a credential of its own — that is the entire point.

WHY A do_connect LISTENER RATHER THAN A PASSWORD IN THE URL
-----------------------------------------------------------
The URL is built once, at engine creation, and the engine outlives the token by
design. Baking a token into the URL would work for an hour and then fail every
new connection in the pool with an authentication error that looks nothing like
an expiry. SQLAlchemy's ``do_connect`` event fires per physical connection, so
each one gets a token that is current at the moment it is opened.

ROLLOUT
-------
Off unless NIMBUS_DB_ENTRA_AUTH is set. Password auth stays enabled on the
server, so the switch is reversible by unsetting one variable — no migration, no
redeploy of anything else. Given this same database took the site down earlier
today, an opt-in flag is worth more than the tidiness of removing the old path.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any

import httpx

from openhands.app_server.utils.logger import openhands_logger as logger

# The audience Azure Database for PostgreSQL accepts.
_OSSRDBMS_RESOURCE = 'https://ossrdbms-aad.database.windows.net'

# Refresh this far before expiry. A connection opened at the boundary must not
# race the token going stale mid-handshake.
_REFRESH_SKEW_SECONDS = 300

_lock = threading.Lock()
_cached_token: str | None = None
_cached_expires_at: float = 0.0


def entra_db_auth_enabled() -> bool:
    """Opt-in, and deliberately so — see ROLLOUT above."""
    return (os.getenv('NIMBUS_DB_ENTRA_AUTH') or '').strip().lower() in {
        '1',
        'true',
        'yes',
        'on',
    }


def _request_token() -> tuple[str, float]:
    """Mint a token from the platform's identity endpoint.

    Returns (token, absolute expiry epoch seconds).
    """
    identity_endpoint = os.getenv('IDENTITY_ENDPOINT')
    identity_header = os.getenv('IDENTITY_HEADER')

    if identity_endpoint and identity_header:
        url = identity_endpoint
        params = {'resource': _OSSRDBMS_RESOURCE, 'api-version': '2019-08-01'}
        headers = {'X-IDENTITY-HEADER': identity_header}
    else:
        # IMDS fallback for hosts without the App Service style contract.
        url = 'http://169.254.169.254/metadata/identity/oauth2/token'
        params = {'resource': _OSSRDBMS_RESOURCE, 'api-version': '2018-02-01'}
        headers = {'Metadata': 'true'}

    response = httpx.get(url, params=params, headers=headers, timeout=10.0)
    response.raise_for_status()
    payload = response.json()

    token = payload['access_token']
    # expires_on is a string of epoch seconds on both contracts; expires_in is a
    # relative fallback. Trust whichever is present.
    expires_on = payload.get('expires_on')
    if expires_on is not None:
        expires_at = float(expires_on)
    else:
        expires_at = time.time() + float(payload.get('expires_in', 3600))
    return token, expires_at


def get_db_token() -> str:
    """A currently-valid access token, cached until shortly before expiry.

    Serialised: a burst of new pool connections must not each mint their own
    token, which would be a thundering herd against the identity endpoint at
    exactly the moment the pool is under pressure.
    """
    global _cached_token, _cached_expires_at

    now = time.time()
    if _cached_token and now < (_cached_expires_at - _REFRESH_SKEW_SECONDS):
        return _cached_token

    with _lock:
        # Re-check inside the lock: another thread may have refreshed while we
        # waited.
        now = time.time()
        if _cached_token and now < (_cached_expires_at - _REFRESH_SKEW_SECONDS):
            return _cached_token

        token, expires_at = _request_token()
        _cached_token = token
        _cached_expires_at = expires_at
        logger.info(
            'nimbus_entra_db: minted a database token, valid for %d minutes',
            max(0, int((expires_at - time.time()) / 60)),
        )
        return token


def attach_token_provider(engine: Any) -> None:
    """Supply a fresh token as the password on every physical connection.

    Accepts either a sync Engine or an AsyncEngine; the listener is registered
    on the underlying sync engine in both cases, because that is where
    SQLAlchemy emits ``do_connect``.
    """
    from sqlalchemy import event

    target = getattr(engine, 'sync_engine', engine)

    @event.listens_for(target, 'do_connect')
    def _provide_token(dialect, conn_rec, cargs, cparams):  # noqa: ANN001
        try:
            cparams['password'] = get_db_token()
        except Exception:  # noqa: BLE001
            # Leave whatever password was already configured in place. With
            # password auth still enabled server-side that means a failed token
            # fetch degrades to the previous behaviour instead of taking the
            # database offline.
            logger.exception(
                'nimbus_entra_db: could not mint a database token; falling back '
                'to the configured password for this connection'
            )
        return None

    logger.info('nimbus_entra_db: token provider attached to %s', type(engine).__name__)
