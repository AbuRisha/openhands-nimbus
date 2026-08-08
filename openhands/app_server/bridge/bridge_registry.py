"""Routing agent tool calls to a paired browser, and answers back.

Once a browser is paired the agent can ask it to do things — read a page,
navigate, fill a form. This is the part that decides which socket a request goes
down and which answer is allowed to satisfy it.

THE MISTAKE THIS IS BUILT TO AVOID
----------------------------------
The comparable product's pairing flaw is that any connected peer may answer a
broadcast. The same shape of bug exists one layer down: if a response is matched
only on ``request_id``, then any connected peer that learns or guesses an id can
answer a request that was sent to a different browser — and the agent will
believe it. Reading a page is then whatever the fastest peer says it is.

So a response is accepted only when it arrives from the device the request was
sent to. That is checked here rather than trusted from the payload, because the
payload is written by the peer.

WHY A TIMEOUT IS NOT OPTIONAL
-----------------------------
A browser can close a laptop lid mid-call. Without a deadline the agent's turn
hangs on a socket that will never answer, which presents to the customer as the
product being frozen. Failing is recoverable; hanging is not.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

_logger = logging.getLogger(__name__)

# Long enough for a page load and a screenshot, short enough that a closed lid
# does not look like a frozen product.
DEFAULT_CALL_TIMEOUT = 30.0


class BridgeError(Exception):
    """A call could not be delivered or answered."""


class NoSuchDevice(BridgeError):
    """No connected peer with that id for that user."""


class BridgeTimeout(BridgeError):
    """The device did not answer in time."""


SendFn = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class Peer:
    """One connected browser."""

    user_id: str
    device_id: str
    name: str
    send: SendFn


@dataclass
class _Pending:
    """An in-flight call, and the device it is allowed to be answered by."""

    device_id: str
    future: asyncio.Future


@dataclass
class BridgeRegistry:
    """Connected browsers and the calls outstanding against them.

    In-process by design for now: peers are held as live socket handles, which
    cannot be shared across replicas anyway. Multi-replica routing needs a
    shared broker and is a different piece of work — noted rather than faked
    with a registry that silently only works when there is one replica.
    """

    _peers: dict[tuple[str, str], Peer] = field(default_factory=dict)
    _pending: dict[str, _Pending] = field(default_factory=dict)

    # ---- peer lifecycle -------------------------------------------------

    def register(self, peer: Peer) -> None:
        """Attach a browser. A reconnect replaces the previous socket."""
        key = (peer.user_id, peer.device_id)
        if key in self._peers:
            _logger.info(
                'bridge: device %s for user %s reconnected, replacing socket',
                peer.device_id,
                peer.user_id,
            )
        self._peers[key] = peer

    def unregister(self, user_id: str, device_id: str) -> None:
        """Detach a browser and fail anything waiting on it.

        Leaving the futures pending would hang the agent for the full timeout on
        a socket already known to be gone.
        """
        self._peers.pop((user_id, device_id), None)

        for request_id, pending in list(self._pending.items()):
            if pending.device_id != device_id:
                continue
            del self._pending[request_id]
            if not pending.future.done():
                pending.future.set_exception(
                    NoSuchDevice(f'device {device_id} disconnected')
                )

    def peers_for(self, user_id: str) -> list[Peer]:
        """Browsers connected for this user, and only this user."""
        return [peer for (uid, _), peer in self._peers.items() if uid == user_id]

    # ---- calls ----------------------------------------------------------

    async def call(
        self,
        user_id: str,
        device_id: str,
        payload: dict[str, Any],
        timeout: float = DEFAULT_CALL_TIMEOUT,
    ) -> dict[str, Any]:
        """Send a request to one browser and await its answer."""
        peer = self._peers.get((user_id, device_id))
        if peer is None:
            # Scoped by user as well as device: a device id alone must never be
            # enough to reach a browser, or one customer could address another's.
            raise NoSuchDevice(f'no connected device {device_id}')

        request_id = str(uuid.uuid4())
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = _Pending(device_id=device_id, future=future)

        try:
            await peer.send({**payload, 'request_id': request_id})
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError as e:
            raise BridgeTimeout(
                f'device {device_id} did not answer within {timeout}s'
            ) from e
        finally:
            self._pending.pop(request_id, None)

    def resolve(self, device_id: str, request_id: str, result: dict[str, Any]) -> bool:
        """Deliver a browser's answer. False if it was not wanted.

        The device check is the point. Matching on request_id alone would let
        any connected peer answer a call sent to a different browser, and the
        agent would believe it — the same failure as a pairing broadcast, one
        layer down.
        """
        pending = self._pending.get(request_id)
        if pending is None:
            # Late answer to something already timed out, or an id nobody asked
            # about. Dropping it is correct; logging it is how we would notice a
            # peer probing.
            _logger.info('bridge: unmatched response %s from %s', request_id, device_id)
            return False

        if pending.device_id != device_id:
            _logger.warning(
                'bridge: device %s tried to answer a request routed to %s',
                device_id,
                pending.device_id,
            )
            return False

        if not pending.future.done():
            pending.future.set_result(result)
        return True
