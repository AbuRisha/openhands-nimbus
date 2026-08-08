"""Pairing a browser extension to a customer's account.

The bridge lets the agent drive the customer's own logged-in browser. That is a
high-capability relationship — page reading, navigation, form filling, script
execution — so the question of WHICH browser gets attached is the whole security
story, not a setup detail.

WHAT WE ARE DELIBERATELY NOT COPYING
------------------------------------
The comparable product treats "pairing" as *device selection among peers already
authenticated to the account*: it auto-selects when exactly one extension is
present, and otherwise broadcasts a request that any connected peer may answer.
Its own audit notes the consequence — a malicious extension signed into the same
account "is visible as a peer and may respond to a user-broadcast pairing
request". Whoever answers first wins.

Here the user reads a code in the chat and types it into the extension. A peer
that did not see the code cannot answer, so being connected to the account is
not sufficient to be selected. That costs one interaction and removes the race.

WHY THESE NUMBERS
-----------------
* 8 characters from a 32-symbol alphabet is ~10^12 combinations. Against a
  120-second window and an attempt cap, guessing is not the weak link.
* The alphabet excludes 0/O/1/I/L. A code that is read aloud or retyped and
  fails because of a glyph the user cannot distinguish trains people to paste
  credentials from somewhere less careful.
* 120 seconds matches the pairing timeout users already meet elsewhere, and is
  short enough that an abandoned code is not left usable.
* Five attempts, then the code dies rather than the requester being throttled.
  Rate-limiting the guesser lets them keep going; killing the code ends it.
"""

from __future__ import annotations

import logging
import secrets
import string
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

_logger = logging.getLogger(__name__)

# No 0/O/1/I/L: a code is read by a human and typed into another window.
PAIRING_ALPHABET = ''.join(
    c for c in string.ascii_uppercase + string.digits if c not in '01OIL'
)
PAIRING_CODE_LENGTH = 8
PAIRING_TTL = timedelta(seconds=120)
MAX_ATTEMPTS = 5

# The competitor sanitises device ids to 64 chars; the same bound is sensible
# and keeps a hostile peer from using the field as a payload carrier.
MAX_DEVICE_ID_LENGTH = 64
MAX_DEVICE_NAME_LENGTH = 64


def generate_pairing_code() -> str:
    """A fresh code. `secrets`, never `random` — this is a credential."""
    return ''.join(secrets.choice(PAIRING_ALPHABET) for _ in range(PAIRING_CODE_LENGTH))


def sanitize_device_field(value: str, *, limit: int) -> str:
    """Trim a peer-supplied string to something safe to store and display.

    Control characters are stripped rather than escaped: a device name is shown
    in a picker, and a newline or an ANSI escape in it is never legitimate.
    """
    cleaned = ''.join(ch for ch in value if ch.isprintable())
    return cleaned.strip()[:limit]


@dataclass
class PairingRequest:
    """One outstanding attempt to attach a browser to an account."""

    code: str
    user_id: str
    created_at: datetime
    attempts: int = 0
    consumed_by: str | None = None

    def is_expired(self, now: datetime) -> bool:
        return now - self.created_at >= PAIRING_TTL

    @property
    def is_consumed(self) -> bool:
        return self.consumed_by is not None


class PairingResult:
    """Why a pairing attempt failed, in terms the UI can act on."""

    OK = 'ok'
    UNKNOWN = 'unknown_code'
    EXPIRED = 'expired'
    EXHAUSTED = 'too_many_attempts'
    ALREADY_USED = 'already_used'


@dataclass
class PairingStore:
    """In-memory pairing attempts.

    Deliberately not persisted. A pairing code is valid for two minutes and is
    meaningless afterwards, so surviving a restart buys nothing and storing it
    would mean writing a live credential to disk for no reason.
    """

    _requests: dict[str, PairingRequest] = field(default_factory=dict)

    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    def create(self, user_id: str) -> PairingRequest:
        """Start a pairing attempt for a user, replacing any previous one.

        One outstanding code per user: two live codes means a user reading the
        older one off a stale screen, and an attacker two chances instead of
        one.
        """
        self.purge_expired()
        for code, request in list(self._requests.items()):
            if request.user_id == user_id:
                del self._requests[code]

        request = PairingRequest(
            code=generate_pairing_code(), user_id=user_id, created_at=self._now()
        )
        self._requests[request.code] = request
        return request

    def redeem(self, code: str, device_id: str) -> tuple[str, PairingRequest | None]:
        """Attempt to claim a code for a device.

        Returns (result, request). The request is only returned on success —
        a caller that failed has no business reading who the code belonged to.
        """
        now = self._now()
        submitted = sanitize_device_field(code, limit=PAIRING_CODE_LENGTH).upper()

        # Constant-time lookup over live codes rather than a dict hit, so a
        # timing difference does not distinguish "no such code" from "wrong
        # code for an existing request".
        match: PairingRequest | None = None
        for candidate in self._requests.values():
            if secrets.compare_digest(candidate.code, submitted):
                match = candidate

        if match is None:
            return PairingResult.UNKNOWN, None
        if match.is_consumed:
            return PairingResult.ALREADY_USED, None
        if match.is_expired(now):
            del self._requests[match.code]
            return PairingResult.EXPIRED, None

        match.attempts += 1
        if match.attempts > MAX_ATTEMPTS:
            # Kill the code rather than throttle the guesser: throttling lets
            # them keep going, and a dead code ends the attempt entirely.
            del self._requests[match.code]
            _logger.warning(
                'bridge_pairing: code for user %s exceeded %d attempts and was '
                'discarded',
                match.user_id,
                MAX_ATTEMPTS,
            )
            return PairingResult.EXHAUSTED, None

        match.consumed_by = sanitize_device_field(device_id, limit=MAX_DEVICE_ID_LENGTH)
        return PairingResult.OK, match

    def purge_expired(self) -> int:
        """Drop codes past their TTL. Returns how many went."""
        now = self._now()
        dead = [
            code for code, request in self._requests.items() if request.is_expired(now)
        ]
        for code in dead:
            del self._requests[code]
        return len(dead)

    def outstanding_for(self, user_id: str) -> PairingRequest | None:
        self.purge_expired()
        for request in self._requests.values():
            if request.user_id == user_id and not request.is_consumed:
                return request
        return None
