"""Who is signed in, what they have left, and what chat has cost them.

Chat runs on chat.nimbusapi.net and holds only the customer's own
``sk-nim-live-`` key. It has never been able to show the signed-in account, the
balance, or what chat itself has spent — so a customer could not tell whether
chat was billing them at all, let alone correctly.

This is a thin read-through to nimbus-v2's ``/api/internal/chat-account``,
authorised the same way ``nimbus_customer_key`` already authorises minting: an
HMAC over the customer id keyed with ``NIMBUS_SSO_SHARED_SECRET``. The customer
id comes from the SIGNED session (``get_user_id``), never from a request body or
a cookie the browser can rewrite, so a caller cannot ask about somebody else's
account by changing a parameter.

Nothing is cached here. The whole value of the spend figure is that it moves the
moment a turn is billed — a stale number would be worse than no number, because
it would look like billing had failed.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from typing import Final

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, status
from pydantic import BaseModel, Field

from openhands.app_server.user_auth import get_user_id
from openhands.app_server.utils.dependencies import get_dependencies
from openhands.app_server.utils.logger import openhands_logger as logger

router = APIRouter(
    prefix='/nimbus',
    tags=['NimbusAccount'],
    dependencies=get_dependencies(),
)

_DEFAULT_BASE: Final[str] = 'https://nimbusapi.net'
_TIMEOUT: Final[float] = 10.0


def _base_url() -> str:
    return (os.getenv('NIMBUS_SITE_BASE_URL') or _DEFAULT_BASE).rstrip('/')


def _signature(customer_id: str) -> str | None:
    secret = os.getenv('NIMBUS_SSO_SHARED_SECRET') or ''
    if not secret:
        return None
    return hmac.new(
        secret.encode('utf-8'), customer_id.encode('utf-8'), hashlib.sha256
    ).hexdigest()


class ChatSpend(BaseModel):
    has_key: bool = Field(default=False)
    spend_cap_usd: float | None = Field(default=None)
    spent_usd: float = Field(default=0.0)
    request_count: int = Field(default=0)


class NimbusAccount(BaseModel):
    """Deliberately explicit about not knowing.

    ``configured`` is False when the shared secret is absent or the site cannot
    be reached. The UI must render that as "unavailable" rather than as a zero
    balance — showing $0.00 to someone who has money is the kind of wrong that
    makes people stop trusting the number entirely.
    """

    configured: bool = Field(default=False)
    email: str | None = Field(default=None)
    balance_usd: float | None = Field(default=None)
    chat: ChatSpend = Field(default_factory=ChatSpend)


async def _post(path: str, payload: dict) -> dict | None:
    customer_id = payload.get('customerId') or ''
    sig = _signature(str(customer_id))
    if not sig:
        logger.warning('nimbus_account: NIMBUS_SSO_SHARED_SECRET unset')
        return None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                f'{_base_url()}{path}',
                json=payload,
                headers={'x-nimbus-chat-sig': sig},
            )
    except httpx.RequestError as exc:
        logger.warning('nimbus_account: %s unreachable: %s', path, exc)
        return None
    if resp.status_code != 200:
        logger.warning(
            'nimbus_account: %s returned %s (%s)',
            path,
            resp.status_code,
            resp.text[:160],
        )
        return None
    try:
        data = resp.json()
    except Exception:  # noqa: BLE001
        return None
    return data if isinstance(data, dict) else None


@router.get('/account', response_model=NimbusAccount)
async def get_account(user_id: str | None = Depends(get_user_id)) -> NimbusAccount:
    if not user_id:
        return NimbusAccount(configured=False)
    data = await _post('/api/internal/chat-account', {'customerId': user_id})
    if not data:
        return NimbusAccount(configured=False)
    chat = data.get('chat') or {}
    return NimbusAccount(
        configured=True,
        email=data.get('email'),
        balance_usd=float(data.get('balanceUsd') or 0.0),
        chat=ChatSpend(
            has_key=bool(chat.get('hasKey')),
            spend_cap_usd=(
                None
                if chat.get('spendCapUsd') is None
                else float(chat['spendCapUsd'])
            ),
            spent_usd=float(chat.get('spentUsd') or 0.0),
            request_count=int(chat.get('requestCount') or 0),
        ),
    )


class SpendCapRequest(BaseModel):
    """``None`` clears the cap; the field being absent is not expressible here,
    so this endpoint always means "set it to exactly this"."""

    spend_cap_usd: float | None = Field(default=None)


@router.put('/account/spend-cap', response_model=NimbusAccount)
async def set_spend_cap(
    body: SpendCapRequest = Body(...),
    user_id: str | None = Depends(get_user_id),
) -> NimbusAccount:
    """Set a chat-only ceiling, separate from the account balance.

    Routed through chat-key rather than a new write path because that endpoint
    already owns this key: it applies the cap to the live row IN PLACE, so the
    key every open session is holding keeps working. Rotating a key to change a
    limit would sign the customer out of their own chat.
    """
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail='not_signed_in'
        )
    cap = body.spend_cap_usd
    if cap is not None and (cap < 0 or cap != cap):  # NaN-safe
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail='spend_cap_invalid'
        )

    # Send the key we hold so the cap is applied without rotating it. Read from
    # the customer's own settings; if we cannot read it the server will mint a
    # fresh one, which is correct but does invalidate the old value — so this is
    # a fallback, not the normal path.
    current_key: str | None = None
    try:
        from openhands.app_server.settings.nimbus_settings_store import (
            NimbusSettingsStore,
        )

        store = await NimbusSettingsStore.get_instance(user_id)
        settings = await store.load()
        llm = getattr(getattr(settings, 'agent_settings', None), 'llm', None)
        raw = getattr(llm, 'api_key', None)
        current_key = (
            raw.get_secret_value() if hasattr(raw, 'get_secret_value') else raw
        )
    except Exception as exc:  # noqa: BLE001 - fallback is a fresh mint
        logger.info(
            'nimbus_account: could not read the stored chat key (%s); the cap '
            'change will mint a new one',
            type(exc).__name__,
        )

    payload: dict = {'customerId': user_id, 'spendCapUsd': cap}
    if current_key:
        payload['currentKey'] = current_key
    result = await _post('/api/internal/chat-key', payload)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='nimbus_unreachable',
        )
    return await get_account(user_id=user_id)
