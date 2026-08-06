"""Routing a tool call to the right browser, and accepting the right answer.

The pairing module's lesson repeats one layer down: if a response is matched
only on request_id, any connected peer that learns an id can answer a call sent
to a different browser — and the agent believes it.
"""

from __future__ import annotations

import asyncio

import pytest

from openhands.app_server.bridge.bridge_registry import (
    BridgeRegistry,
    BridgeTimeout,
    NoSuchDevice,
    Peer,
)


def _peer(registry: BridgeRegistry, user_id: str, device_id: str) -> list[dict]:
    """Register a peer that records what it was sent."""
    sent: list[dict] = []

    async def send(message):
        sent.append(message)

    registry.register(
        Peer(user_id=user_id, device_id=device_id, name=device_id, send=send)
    )
    return sent


class TestRouting:
    @pytest.mark.asyncio
    async def test_a_call_reaches_its_device_and_returns_the_answer(self):
        registry = BridgeRegistry()
        sent = _peer(registry, 'user-1', 'dev-1')

        task = asyncio.create_task(
            registry.call('user-1', 'dev-1', {'tool': 'read_page'})
        )
        await asyncio.sleep(0)

        assert sent[0]['tool'] == 'read_page'
        registry.resolve('dev-1', sent[0]['request_id'], {'text': 'hello'})

        assert await task == {'text': 'hello'}

    @pytest.mark.asyncio
    async def test_calling_an_unknown_device_fails_fast(self):
        registry = BridgeRegistry()

        with pytest.raises(NoSuchDevice):
            await registry.call('user-1', 'nope', {'tool': 'read_page'})

    @pytest.mark.asyncio
    async def test_a_device_id_alone_cannot_reach_another_users_browser(self):
        """Scoped by user AND device. Otherwise one customer could address
        another's browser by guessing a device id."""
        registry = BridgeRegistry()
        _peer(registry, 'owner', 'dev-1')

        with pytest.raises(NoSuchDevice):
            await registry.call('someone-else', 'dev-1', {'tool': 'read_page'})


class TestResponseAuthorisation:
    @pytest.mark.asyncio
    async def test_a_different_device_cannot_answer_the_call(self):
        """The whole point of this module.

        Matching on request_id alone would let the fastest connected peer decide
        what a page says.
        """
        registry = BridgeRegistry()
        sent = _peer(registry, 'user-1', 'dev-1')
        _peer(registry, 'user-1', 'attacker')

        task = asyncio.create_task(
            registry.call('user-1', 'dev-1', {'tool': 'read_page'}, timeout=0.3)
        )
        await asyncio.sleep(0)
        request_id = sent[0]['request_id']

        accepted = registry.resolve('attacker', request_id, {'text': 'lies'})

        assert accepted is False
        # And the real call is still outstanding, not poisoned.
        with pytest.raises(BridgeTimeout):
            await task

    def test_an_unmatched_response_is_dropped(self):
        registry = BridgeRegistry()

        assert registry.resolve('dev-1', 'never-asked', {'x': 1}) is False

    @pytest.mark.asyncio
    async def test_a_late_answer_after_timeout_is_dropped(self):
        """The future is already gone; resolving it must not raise."""
        registry = BridgeRegistry()
        sent = _peer(registry, 'user-1', 'dev-1')

        task = asyncio.create_task(
            registry.call('user-1', 'dev-1', {'tool': 'x'}, timeout=0.05)
        )
        with pytest.raises(BridgeTimeout):
            await task

        assert registry.resolve('dev-1', sent[0]['request_id'], {'late': True}) is False


class TestLifecycle:
    @pytest.mark.asyncio
    async def test_a_timeout_fails_rather_than_hanging(self):
        """A closed laptop lid must not present as a frozen product."""
        registry = BridgeRegistry()
        _peer(registry, 'user-1', 'dev-1')

        with pytest.raises(BridgeTimeout):
            await registry.call('user-1', 'dev-1', {'tool': 'x'}, timeout=0.05)

    @pytest.mark.asyncio
    async def test_disconnecting_fails_calls_waiting_on_that_device(self):
        """Leaving them pending would hang the agent for the full timeout on a
        socket already known to be gone."""
        registry = BridgeRegistry()
        _peer(registry, 'user-1', 'dev-1')

        task = asyncio.create_task(
            registry.call('user-1', 'dev-1', {'tool': 'x'}, timeout=5)
        )
        await asyncio.sleep(0)
        registry.unregister('user-1', 'dev-1')

        with pytest.raises(NoSuchDevice):
            await task

    @pytest.mark.asyncio
    async def test_disconnecting_one_device_leaves_another_alone(self):
        registry = BridgeRegistry()
        sent = _peer(registry, 'user-1', 'dev-1')
        _peer(registry, 'user-1', 'dev-2')

        task = asyncio.create_task(
            registry.call('user-1', 'dev-1', {'tool': 'x'}, timeout=5)
        )
        await asyncio.sleep(0)
        registry.unregister('user-1', 'dev-2')

        registry.resolve('dev-1', sent[0]['request_id'], {'ok': True})
        assert await task == {'ok': True}

    def test_peers_are_listed_per_user_only(self):
        registry = BridgeRegistry()
        _peer(registry, 'user-1', 'dev-1')
        _peer(registry, 'user-2', 'dev-2')

        assert [p.device_id for p in registry.peers_for('user-1')] == ['dev-1']

    @pytest.mark.asyncio
    async def test_a_reconnect_sends_to_the_new_socket_not_the_stale_one(self):
        """Otherwise a stale socket keeps receiving calls nobody will answer.

        Asserting on WHICH socket receives the call, rather than just on the
        peer count — a registry that kept both would still report one peer if
        it overwrote the dict entry but left the old handle wired somewhere.
        """
        registry = BridgeRegistry()
        first = _peer(registry, 'user-1', 'dev-1')
        second = _peer(registry, 'user-1', 'dev-1')

        assert len(registry.peers_for('user-1')) == 1

        task = asyncio.create_task(
            registry.call('user-1', 'dev-1', {'tool': 'x'}, timeout=0.2)
        )
        await asyncio.sleep(0)

        assert second, 'the reconnected socket should have received the call'
        assert first == [], 'the stale socket should receive nothing'

        registry.resolve('dev-1', second[0]['request_id'], {'ok': True})
        assert await task == {'ok': True}
