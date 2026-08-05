"""Fetch the signed-in customer's OWN Nimbus API key.

Chat used to run on one shared service key, so every customer's usage billed to
whoever owned it — and anyone who could read the settings blob could read the
key. Per-customer billing means chat must hold a key that belongs to the
customer, and then the rest is already built: the gateway's auth.mjs resolves an
``sk-nim-live-`` key to its customerId and balance, and ledger.mjs pre-authorises
and settles against that balance. Nothing new is needed on the money side.

The key cannot be READ back from Nimbus — ApiKey.hashedKey stores only a SHA-256
digest — so nimbus-v2 mints a dedicated "Nimbus Chat" key on request and returns
the raw value once. We store it in the customer's own settings file, which is
per-customer and on durable storage, so this happens once rather than on every
container start.

The request is authenticated by an HMAC over the customer id, keyed with
NIMBUS_SSO_SHARED_SECRET. Signing the id rather than sending a bare bearer token
matters: a leaked bearer alone would let the holder mint a key for ANY customer,
whereas a captured signed request is only good for the customer it was already
for.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
from typing import Final

import httpx

from openhands.app_server.utils.logger import openhands_logger as logger

_DEFAULT_BASE: Final[str] = 'https://nimbusapi.net'
_TIMEOUT: Final[float] = 15.0


def _base_url() -> str:
    return (os.getenv('NIMBUS_SITE_BASE_URL') or _DEFAULT_BASE).rstrip('/')


# One lock per customer, so concurrent settings loads for the SAME customer
# serialise instead of racing.
#
# Observed live the first time this worked: three "Nimbus Chat" keys minted for
# one customer inside nine seconds, two immediately revoked. The endpoint
# revokes-then-mints so exactly one ends up active and the result self-corrects,
# but a customer with two tabs open would watch keys churn in their dashboard
# for no reason.
#
# A process-level lock is sufficient because the app runs at maxReplicas 1 -
# RUNTIME=process pins a conversation's sandbox to the replica that started it,
# so the deployment cannot scale out anyway. If that ever changes this needs to
# become a database-level advisory lock, and this comment is the warning.
_key_locks: dict[str, asyncio.Lock] = {}
_locks_guard = asyncio.Lock()


async def _lock_for(customer_id: str) -> asyncio.Lock:
    async with _locks_guard:
        lock = _key_locks.get(customer_id)
        if lock is None:
            lock = asyncio.Lock()
            _key_locks[customer_id] = lock
        return lock


async def fetch_customer_api_key(
    customer_id: str | None, current_key: str | None = None
) -> str | None:
    """Mint/return an API key owned by ``customer_id``, or None.

    Returns None rather than raising on every failure path. A customer whose key
    cannot be fetched must fall back to the deployment default rather than lose
    chat entirely — a hard failure here would turn a billing-attribution problem
    into an outage.

    Pass ``current_key`` whenever one is already stored. The server confirms it
    instead of rotating, which matters more than it sounds: asking for a key
    used to REVOKE the one the caller was already using. We only mint when
    nothing is stored and never re-mint afterwards, so any second call for the
    same customer — a cold start, the Builder minting for the same person, or
    someone diagnosing the problem — permanently broke that customer's chat with
    an auth error. Sending the held key turns the call into a confirmation, and
    a rotation now only happens when the held key really is dead.
    """
    if not customer_id:
        return None

    # Serialise per customer. Without this, two concurrent settings loads each
    # mint a key and each revokes the other's.
    async with await _lock_for(customer_id):
        return await _fetch_customer_api_key_locked(customer_id, current_key)


async def _fetch_customer_api_key_locked(
    customer_id: str, current_key: str | None = None
) -> str | None:
    secret = os.getenv('NIMBUS_SSO_SHARED_SECRET') or ''
    if not secret:
        logger.warning(
            'nimbus_customer_key: NIMBUS_SSO_SHARED_SECRET unset - cannot request '
            'a per-customer key, chat will bill to the deployment default key'
        )
        return None

    sig = hmac.new(
        secret.encode('utf-8'), customer_id.encode('utf-8'), hashlib.sha256
    ).hexdigest()

    url = f'{_base_url()}/api/internal/chat-key'
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                url,
                json=(
                    {'customerId': customer_id, 'currentKey': current_key}
                    if current_key
                    else {'customerId': customer_id}
                ),
                headers={'x-nimbus-chat-sig': sig},
            )
    except httpx.RequestError as e:
        logger.warning('nimbus_customer_key: %s unreachable: %s', url, e)
        return None

    if resp.status_code != 200:
        # 403 customer_inactive and 404 customer_not_found are meaningful and
        # worth seeing in logs; they are not transport failures.
        logger.warning(
            'nimbus_customer_key: %s returned %s (%s)',
            url,
            resp.status_code,
            resp.text[:160],
        )
        return None

    try:
        key = (resp.json() or {}).get('apiKey')
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(key, str) or not key.startswith('sk-nim-'):
        logger.warning('nimbus_customer_key: response did not contain a usable key')
        return None
    try:
        reused = bool((resp.json() or {}).get('reused'))
    except Exception:  # noqa: BLE001
        reused = False
    if reused:
        logger.debug(
            'nimbus_customer_key: existing key confirmed for %s', customer_id
        )
    else:
        logger.info(
            'nimbus_customer_key: minted a new per-customer key for %s%s',
            customer_id,
            ' (the previous one was no longer valid)' if current_key else '',
        )
    return key
