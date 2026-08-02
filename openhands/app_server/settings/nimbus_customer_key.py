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


async def fetch_customer_api_key(customer_id: str | None) -> str | None:
    """Mint/return an API key owned by ``customer_id``, or None.

    Returns None rather than raising on every failure path. A customer whose key
    cannot be fetched must fall back to the deployment default rather than lose
    chat entirely — a hard failure here would turn a billing-attribution problem
    into an outage.
    """
    if not customer_id:
        return None
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
                json={'customerId': customer_id},
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
    logger.info('nimbus_customer_key: obtained a per-customer key for %s', customer_id)
    return key
