"""Devices that have completed pairing, and the tokens they authenticate with.

A pairing code is a two-minute, single-use credential for the *act* of pairing.
What the browser holds afterwards is different: it is long-lived, it is used on
every reconnect, and it must survive the code being forgotten. Conflating the
two would mean either a code that never expires or a browser that re-pairs every
morning.

WHY THE TOKEN IS STORED HASHED
------------------------------
The relay only ever needs to ANSWER "does this token belong to this device",
never to reproduce it. Storing the hash means a dump of this table is not a set
of working browser credentials. The token itself exists in plaintext exactly
once, in the pairing response, and after that only the extension has it.

That is a different judgement from the pairing codes, which are held in memory
in the clear: those are worthless in two minutes, and hashing something with a
120-second life buys nothing.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone

from openhands.app_server.bridge.bridge_pairing import (
    MAX_DEVICE_ID_LENGTH,
    MAX_DEVICE_NAME_LENGTH,
    sanitize_device_field,
)

_logger = logging.getLogger(__name__)

# 32 bytes of urlsafe base64. This is a bearer credential for someone's browser.
TOKEN_BYTES = 32


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


@dataclass
class PairedDevice:
    """A browser this user has attached."""

    user_id: str
    device_id: str
    name: str
    token_hash: str
    paired_at: datetime


@dataclass
class DeviceStore:
    """Paired devices, keyed by (user, device).

    In-memory for now, and that is a real limitation rather than a design
    choice: a restart un-pairs every browser and the user has to enter a new
    code. Persisting it is a small change (the shape here is deliberately
    storage-agnostic) but it belongs with a migration rather than smuggled in
    alongside the protocol.
    """

    _devices: dict[tuple[str, str], PairedDevice] = field(default_factory=dict)

    def pair(self, user_id: str, device_id: str, name: str) -> tuple[PairedDevice, str]:
        """Register a device and mint its token.

        Returns (device, plaintext token). The plaintext is returned exactly
        once and never stored — the caller must hand it straight to the browser.
        """
        token = secrets.token_urlsafe(TOKEN_BYTES)
        device = PairedDevice(
            user_id=user_id,
            device_id=sanitize_device_field(device_id, limit=MAX_DEVICE_ID_LENGTH),
            name=sanitize_device_field(name, limit=MAX_DEVICE_NAME_LENGTH) or 'Browser',
            token_hash=hash_token(token),
            paired_at=datetime.now(timezone.utc),
        )
        # Re-pairing the same browser replaces its token rather than adding a
        # second one, so an old token cannot outlive the pairing that made it.
        self._devices[(device.user_id, device.device_id)] = device
        return device, token

    def authenticate(self, device_id: str, token: str) -> PairedDevice | None:
        """The device this token belongs to, or None.

        Compared in constant time, and the device id must match too: a valid
        token for one browser must not authenticate a different device id.
        """
        candidate = hash_token(token)
        for device in self._devices.values():
            if device.device_id != device_id:
                continue
            if secrets.compare_digest(device.token_hash, candidate):
                return device
        return None

    def devices_for(self, user_id: str) -> list[PairedDevice]:
        return [d for d in self._devices.values() if d.user_id == user_id]

    def unpair(self, user_id: str, device_id: str) -> bool:
        """Detach a browser. True if there was one."""
        return self._devices.pop((user_id, device_id), None) is not None
