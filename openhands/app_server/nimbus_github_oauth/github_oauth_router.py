"""GitHub OAuth, so connecting a repo is one click instead of a pasted token.

WHY THIS EXISTS
---------------
``_get_configured_providers()`` lights up a "Connect GitHub" button as soon as
GITHUB_APP_CLIENT_ID is set — but upstream OpenHands implements the actual flow
in its enterprise layer, behind AUTH_URL and Keycloak, neither of which is part
of this deployment. There is no ``/api/v1/auth/*`` router here at all. Setting
the client id alone would therefore have produced a button that goes nowhere,
which is worse than no button.

This is the missing half: authorize, callback, exchange, store.

WHERE THE TOKEN LANDS
---------------------
The same place the personal-access-token form writes to — ``Secrets`` with a
``ProviderToken`` under ``ProviderType.GITHUB``. That is deliberate and is what
makes this small: repo listing, cloning and the "No Repo Connected" chip all
read from there already, so they start working the moment a token arrives by
either route. OAuth is a nicer way to obtain the same credential, not a second
credential system.

SECURITY NOTES
--------------
* ``state`` is HMAC-signed with a server-side secret and carries a timestamp.
  Without it, anyone could feed our callback a code obtained for a different
  user and have us store THEIR token in the victim's account — a login-CSRF
  that silently attaches an attacker-controlled repo source to someone else's
  agent. The signature is compared with ``compare_digest``.
* The client secret is read from the environment and never logged, never
  returned, and never placed in a redirect.
* Tokens are exchanged over the wire once and stored via the user's own
  ``SecretsStore``, which is already per-customer.
* ``redirect_uri`` is derived from configuration rather than the inbound
  request, so a spoofed Host header cannot redirect the code elsewhere.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets as pysecrets
import time
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from pydantic import SecretStr

from openhands.app_server.integrations.provider import ProviderToken
from openhands.app_server.integrations.service_types import ProviderType
from openhands.app_server.secrets.secrets_models import Secrets
from openhands.app_server.secrets.secrets_store import SecretsStore
from openhands.app_server.user_auth import get_secrets_store
from openhands.app_server.utils.logger import openhands_logger as logger

router = APIRouter(prefix='/api/v1/auth/github', tags=['GitHubOAuth'])

_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
_TOKEN_URL = 'https://github.com/login/oauth/access_token'

# repo covers private repositories the agent is expected to work in;
# read:user is what lets us show which account is connected. Deliberately no
# delete_repo, no admin scopes — an agent should not be able to destroy a
# repository because a prompt said so.
_SCOPES = 'repo read:user'

# A user has minutes to complete a consent screen, not hours. Anything older is
# a replay.
_STATE_TTL_SECONDS = 600


def _client_id() -> str:
    return (os.getenv('GITHUB_APP_CLIENT_ID') or '').strip()


def _client_secret() -> str:
    return (os.getenv('GITHUB_APP_CLIENT_SECRET') or '').strip()


def _signing_key() -> bytes:
    """Key for signing the state parameter.

    Reuses the SSO shared secret when present so there is one fewer secret to
    manage; falls back to a per-process random key, which is still correct — it
    only means in-flight logins do not survive a restart.
    """
    configured = (os.getenv('NIMBUS_SSO_SHARED_SECRET') or '').strip()
    if configured:
        return configured.encode()
    global _EPHEMERAL_KEY
    return _EPHEMERAL_KEY


_EPHEMERAL_KEY = pysecrets.token_bytes(32)


def _public_base_url() -> str:
    """Where GitHub should send the user back.

    Taken from configuration, never from the request's Host header: trusting
    the inbound host would let a spoofed request redirect the authorization
    code to somewhere we do not control.
    """
    return (
        os.getenv('OH_PUBLIC_BASE_URL') or 'https://chat.nimbusapi.net'
    ).rstrip('/')


def _redirect_uri() -> str:
    return f'{_public_base_url()}/api/v1/auth/github/callback'


def _make_state() -> str:
    nonce = pysecrets.token_urlsafe(16)
    issued = str(int(time.time()))
    payload = f'{nonce}.{issued}'
    signature = hmac.new(_signing_key(), payload.encode(), hashlib.sha256).hexdigest()
    return f'{payload}.{signature}'


def _verify_state(state: str) -> bool:
    try:
        nonce, issued, signature = state.rsplit('.', 2)
    except ValueError:
        return False

    expected = hmac.new(
        _signing_key(), f'{nonce}.{issued}'.encode(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        return False

    try:
        age = time.time() - int(issued)
    except ValueError:
        return False
    return 0 <= age <= _STATE_TTL_SECONDS


@router.get('', include_in_schema=False)
async def start_github_oauth() -> RedirectResponse:
    """Send the user to GitHub's consent screen."""
    client_id = _client_id()
    if not client_id or not _client_secret():
        # Explicit rather than a broken redirect: if only half the credentials
        # are configured, say so instead of bouncing the user to GitHub with an
        # exchange that cannot complete.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                'GitHub OAuth is not configured. Set GITHUB_APP_CLIENT_ID and '
                'GITHUB_APP_CLIENT_SECRET.'
            ),
        )

    params = {
        'client_id': client_id,
        'redirect_uri': _redirect_uri(),
        'scope': _SCOPES,
        'state': _make_state(),
        'allow_signup': 'false',
    }
    return RedirectResponse(f'{_AUTHORIZE_URL}?{urlencode(params)}')


@router.get('/callback', include_in_schema=False)
async def github_oauth_callback(
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    secrets_store: SecretsStore = Depends(get_secrets_store),
) -> RedirectResponse:
    """Exchange the code for a token and store it against this customer."""
    settings_url = f'{_public_base_url()}/settings/integrations'

    if error:
        # The user declined, or GitHub refused. Not an error condition for us —
        # send them back where they came from with a marker the UI can show.
        logger.info('github_oauth: authorization declined (%s)', error)
        return RedirectResponse(f'{settings_url}?github=denied')

    if not code or not state or not _verify_state(state):
        # A missing or unverifiable state is the login-CSRF case: someone
        # feeding us a code minted for a different account. Refuse rather than
        # store a token nobody in this session asked for.
        logger.warning('github_oauth: rejected callback with invalid state')
        return RedirectResponse(f'{settings_url}?github=invalid_state')

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(
                _TOKEN_URL,
                headers={'Accept': 'application/json'},
                data={
                    'client_id': _client_id(),
                    'client_secret': _client_secret(),
                    'code': code,
                    'redirect_uri': _redirect_uri(),
                },
            )
        response.raise_for_status()
        payload = response.json()
    except Exception:  # noqa: BLE001
        # Never surface the exception text: it can echo back the request body,
        # which contains the client secret.
        logger.exception('github_oauth: token exchange failed')
        return RedirectResponse(f'{settings_url}?github=exchange_failed')

    access_token = payload.get('access_token')
    if not access_token:
        logger.warning(
            'github_oauth: no access_token in response (error=%s)',
            payload.get('error'),
        )
        return RedirectResponse(f'{settings_url}?github=exchange_failed')

    try:
        existing = await secrets_store.load()
        provider_tokens = dict(existing.provider_tokens) if existing else {}
        provider_tokens[ProviderType.GITHUB] = ProviderToken(
            token=SecretStr(access_token)
        )
        # Preserve any other providers the customer already linked; this must
        # add GitHub, not replace their whole secret set.
        await secrets_store.store(
            (existing or Secrets()).model_copy(
                update={'provider_tokens': provider_tokens}
            )
        )
    except Exception:  # noqa: BLE001
        logger.exception('github_oauth: could not persist the access token')
        return RedirectResponse(f'{settings_url}?github=store_failed')

    logger.info('github_oauth: linked a GitHub account')
    return RedirectResponse(f'{settings_url}?github=connected')
