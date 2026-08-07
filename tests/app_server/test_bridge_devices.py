"""Tokens a paired browser authenticates with.

A pairing code is a two-minute credential for the ACT of pairing. What the
browser keeps afterwards is long-lived and used on every reconnect, so it is a
different thing with different rules.
"""

from __future__ import annotations

from openhands.app_server.bridge.bridge_devices import (
    DeviceStore,
    hash_token,
)
from openhands.app_server.bridge.bridge_pairing import MAX_DEVICE_ID_LENGTH


class TestPairing:
    def test_pairing_returns_a_token_and_registers_the_device(self):
        store = DeviceStore()

        device, token = store.pair('user-1', 'dev-1', 'Chrome')

        assert token
        assert store.authenticate('dev-1', token) is device

    def test_the_plaintext_token_is_never_stored(self):
        """A dump of this table must not be a set of working credentials."""
        store = DeviceStore()

        device, token = store.pair('user-1', 'dev-1', 'Chrome')

        assert token not in device.token_hash
        assert device.token_hash == hash_token(token)

    def test_re_pairing_replaces_the_previous_token(self):
        """An old token must not outlive the pairing that created it."""
        store = DeviceStore()
        _, first = store.pair('user-1', 'dev-1', 'Chrome')
        _, second = store.pair('user-1', 'dev-1', 'Chrome')

        assert store.authenticate('dev-1', first) is None
        assert store.authenticate('dev-1', second) is not None

    def test_device_fields_are_sanitised(self):
        store = DeviceStore()

        device, _ = store.pair('user-1', 'x' * 500, 'name\nwith\x00control')

        assert len(device.device_id) == MAX_DEVICE_ID_LENGTH
        assert '\n' not in device.name

    def test_a_blank_name_gets_a_usable_default(self):
        """The name goes in a picker; an empty row is not selectable."""
        store = DeviceStore()

        device, _ = store.pair('user-1', 'dev-1', '   ')

        assert device.name == 'Browser'


class TestAuthentication:
    def test_a_wrong_token_is_refused(self):
        store = DeviceStore()
        store.pair('user-1', 'dev-1', 'Chrome')

        assert store.authenticate('dev-1', 'not-the-token') is None

    def test_a_valid_token_cannot_authenticate_a_different_device_id(self):
        """Otherwise one browser's token lets a peer claim to be another."""
        store = DeviceStore()
        store.pair('user-1', 'dev-1', 'Chrome')
        _, other = store.pair('user-1', 'dev-2', 'Firefox')

        assert store.authenticate('dev-1', other) is None

    def test_unknown_device_is_refused(self):
        store = DeviceStore()

        assert store.authenticate('nope', 'anything') is None


class TestListingAndUnpairing:
    def test_devices_are_listed_per_user(self):
        store = DeviceStore()
        store.pair('user-1', 'dev-1', 'Chrome')
        store.pair('user-2', 'dev-2', 'Chrome')

        assert [d.device_id for d in store.devices_for('user-1')] == ['dev-1']

    def test_unpairing_revokes_the_token(self):
        store = DeviceStore()
        _, token = store.pair('user-1', 'dev-1', 'Chrome')

        assert store.unpair('user-1', 'dev-1') is True
        assert store.authenticate('dev-1', token) is None

    def test_unpairing_something_absent_reports_false(self):
        store = DeviceStore()

        assert store.unpair('user-1', 'nope') is False
