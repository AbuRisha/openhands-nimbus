"""Kill switch for agent execution on hosted Nimbus Chat.

WHAT IT IS FOR
--------------
Stopping conversation start, message send, sandbox start/resume and queued
auto-run — the paths that spend money — without taking the rest of the app
down. Reading history, settings and billing keeps working, so a customer can
still see their data while execution is halted.

WHAT IT IS *NOT* FOR, AND WHY THAT CHANGED
------------------------------------------
Written on 2026-08-01, this refused execution until someone hand-set
``NIMBUS_CUSTOMER_METERING_READY=true``, because per-customer key delegation did
not exist yet and every turn would otherwise bill the deployment's shared key.

Both halves of that premise are now false:

1. Delegation exists — ``settings/nimbus_customer_key.py``, wired at
   ``nimbus_settings_store.py:109``. Chat mints the signed-in customer's own
   ``sk-nim-live-`` key and bills their balance.
2. The failure it guarded cannot silently happen. Delegation needs
   ``NIMBUS_SSO_SHARED_SECRET``; without it ``nimbus_session.read_session``
   returns None for every request, and ``NimbusAuthGateMiddleware`` (default ON
   via ``NIMBUS_REQUIRE_AUTH``) blocks the API before any of these routes are
   reached. A deployment that cannot delegate also cannot authenticate.

So a default-closed gate would only ever 503 a working product behind an env var
somebody has to remember to flip. It now defaults OPEN and is opt-in as a stop
switch — the same shape as the auth gate's own kill switch, and for the same
reason: the state you get by doing nothing should be the one that works.
"""

from __future__ import annotations

import os

from fastapi import HTTPException, status


def nimbus_auth_required() -> bool:
    """Whether hosted authentication is on.

    Reads ``NIMBUS_REQUIRE_AUTH``, the variable ``nimbus_auth_gate`` already
    uses. This module previously invented ``NIMBUS_AUTH_REQUIRED`` — a second
    name for one concept, which is how a deployment ends up half-authenticated
    because only one of the two was set.
    """
    return os.getenv('NIMBUS_REQUIRE_AUTH', '1') != '0'


def customer_metering_ready() -> bool:
    """Whether execution may run. Open unless explicitly stopped."""
    return os.getenv('NIMBUS_CUSTOMER_METERING_READY', 'true').strip().lower() not in (
        'false',
        '0',
    )


def require_customer_metering_ready() -> None:
    """Refuse a money-spending request while execution is stopped."""
    if nimbus_auth_required() and not customer_metering_ready():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='nimbus_customer_metering_not_configured',
        )
