"""Fail-closed execution gate for hosted Nimbus Chat."""

from __future__ import annotations

import os

from fastapi import HTTPException, status


def nimbus_auth_required() -> bool:
    """Hosted authentication is disabled only by an explicit false value."""
    return os.getenv('NIMBUS_AUTH_REQUIRED', 'true').strip().lower() not in (
        'false',
        '0',
    )


def customer_metering_ready() -> bool:
    return os.getenv('NIMBUS_CUSTOMER_METERING_READY', 'false').strip().lower() in (
        'true',
        '1',
    )


def require_customer_metering_ready() -> None:
    """Never execute against the container's shared key before wallet delegation."""
    if nimbus_auth_required() and not customer_metering_ready():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail='nimbus_customer_metering_not_configured',
        )
