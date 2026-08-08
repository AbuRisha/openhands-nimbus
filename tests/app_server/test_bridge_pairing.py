"""Attaching a browser to an account.

The bridge lets the agent drive the customer's own logged-in browser, so WHICH
browser gets attached is the entire security story. Every test here is about a
way the wrong one could be.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from openhands.app_server.bridge.bridge_pairing import (
    MAX_ATTEMPTS,
    MAX_DEVICE_ID_LENGTH,
    PAIRING_ALPHABET,
    PAIRING_CODE_LENGTH,
    PAIRING_TTL,
    PairingResult,
    PairingStore,
    generate_pairing_code,
    sanitize_device_field,
)


class TestCodeGeneration:
    def test_code_has_the_expected_shape(self):
        code = generate_pairing_code()

        assert len(code) == PAIRING_CODE_LENGTH
        assert all(ch in PAIRING_ALPHABET for ch in code)

    def test_alphabet_excludes_glyphs_a_human_cannot_distinguish(self):
        """A code that fails because someone read O for 0 teaches them to paste
        credentials from somewhere less careful."""
        for ambiguous in '01OIL':
            assert ambiguous not in PAIRING_ALPHABET

    def test_codes_do_not_repeat(self):
        """Not proof of entropy, but it would catch a constant or a seeded RNG."""
        codes = {generate_pairing_code() for _ in range(200)}

        assert len(codes) == 200


class TestRedeeming:
    def test_a_correct_code_pairs(self):
        store = PairingStore()
        request = store.create('user-1')

        result, matched = store.redeem(request.code, 'device-abc')

        assert result == PairingResult.OK
        assert matched is not None
        assert matched.user_id == 'user-1'
        assert matched.consumed_by == 'device-abc'

    def test_an_unknown_code_is_refused(self):
        store = PairingStore()
        store.create('user-1')

        result, matched = store.redeem('ZZZZZZZZ', 'device-abc')

        assert result == PairingResult.UNKNOWN
        assert matched is None

    def test_a_failed_attempt_never_reveals_whose_code_it_was(self):
        """A caller that failed has no business learning which account a code
        belongs to — that turns guessing into enumeration."""
        store = PairingStore()
        store.create('user-1')

        _, matched = store.redeem('ZZZZZZZZ', 'attacker-device')

        assert matched is None

    def test_a_code_cannot_be_used_twice(self):
        """Otherwise a code seen over someone's shoulder stays live for the
        rest of its TTL after the legitimate device has already paired."""
        store = PairingStore()
        request = store.create('user-1')
        store.redeem(request.code, 'device-1')

        result, matched = store.redeem(request.code, 'device-2')

        assert result == PairingResult.ALREADY_USED
        assert matched is None

    def test_case_is_normalised(self):
        """People type codes in lowercase. Refusing that is not security."""
        store = PairingStore()
        request = store.create('user-1')

        result, _ = store.redeem(request.code.lower(), 'device-abc')

        assert result == PairingResult.OK


class TestExpiry:
    def test_an_expired_code_is_refused(self):
        store = PairingStore()
        request = store.create('user-1')
        request.created_at = (
            datetime.now(timezone.utc) - PAIRING_TTL - timedelta(seconds=1)
        )

        result, matched = store.redeem(request.code, 'device-abc')

        assert result == PairingResult.EXPIRED
        assert matched is None

    def test_expiry_is_not_merely_hidden(self):
        """An expired code must be GONE, not filtered on read — otherwise it
        lingers in memory as a live credential."""
        store = PairingStore()
        request = store.create('user-1')
        request.created_at = (
            datetime.now(timezone.utc) - PAIRING_TTL - timedelta(seconds=1)
        )

        store.redeem(request.code, 'device-abc')

        assert store.outstanding_for('user-1') is None

    def test_purge_removes_only_the_dead(self):
        store = PairingStore()
        fresh = store.create('user-1')
        stale = store.create('user-2')
        stale.created_at = (
            datetime.now(timezone.utc) - PAIRING_TTL - timedelta(seconds=1)
        )

        removed = store.purge_expired()

        assert removed == 1
        assert store.outstanding_for('user-1') is not None
        assert store.outstanding_for('user-1').code == fresh.code


class TestBruteForce:
    def test_the_code_dies_after_too_many_attempts(self):
        """Killing the code ends the attempt. Throttling the guesser only slows
        one down, and they have the whole TTL to keep trying."""
        store = PairingStore()
        request = store.create('user-1')

        # Wrong device ids, right code: the attempt counter is what is on trial.
        for _ in range(MAX_ATTEMPTS):
            store.redeem(request.code, 'device')

        result, matched = store.redeem(request.code, 'device')

        assert result in (PairingResult.EXHAUSTED, PairingResult.ALREADY_USED)
        assert matched is None

    def test_a_dead_code_cannot_be_revived_by_waiting(self):
        store = PairingStore()
        request = store.create('user-1')
        for _ in range(MAX_ATTEMPTS + 2):
            store.redeem(request.code, 'device')

        result, _ = store.redeem(request.code, 'device')

        assert result != PairingResult.OK


class TestOnePerUser:
    def test_creating_a_second_code_invalidates_the_first(self):
        """Two live codes means a user reading an older one off a stale screen,
        and an attacker two chances instead of one."""
        store = PairingStore()
        first = store.create('user-1')
        store.create('user-1')

        result, _ = store.redeem(first.code, 'device')

        assert result == PairingResult.UNKNOWN

    def test_users_do_not_invalidate_each_other(self):
        store = PairingStore()
        theirs = store.create('user-1')
        store.create('user-2')

        result, _ = store.redeem(theirs.code, 'device')

        assert result == PairingResult.OK


class TestDeviceFields:
    def test_control_characters_are_stripped(self):
        """A device name goes in a picker. A newline or an escape sequence in it
        is never legitimate."""
        assert sanitize_device_field('good\x1b[31mname\n', limit=64) == 'good[31mname'

    def test_length_is_bounded(self):
        long_id = 'x' * 500

        assert len(sanitize_device_field(long_id, limit=MAX_DEVICE_ID_LENGTH)) == (
            MAX_DEVICE_ID_LENGTH
        )

    def test_a_stored_device_id_is_sanitised(self):
        store = PairingStore()
        request = store.create('user-1')

        _, matched = store.redeem(request.code, 'y' * 500)

        assert matched is not None
        assert len(matched.consumed_by) == MAX_DEVICE_ID_LENGTH
