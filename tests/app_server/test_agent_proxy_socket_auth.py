"""How the event socket refuses a bad session key.

The interesting property is not THAT it refuses — it always did — but that the
refusal survives the trip to the browser as a close code.

Closing before ``accept`` makes uvicorn answer the upgrade with a plain HTTP
403. A handshake that never completed has no closing frame, so the browser
synthesises CloseEvent **1006**, the same code it reports for a dropped
network. The 1008 chosen on this side never leaves the process, and the client
cannot tell "get a new key" from "try again in a second".

That is what made a permanently invalid key retry forever in production: 38
rejected handshakes in a 200-line log tail, two conversations cycling every few
seconds. `frontend/src/utils/websocket-close.ts` is the other half of this
contract, and it can only act on a code that arrives.
"""

from __future__ import annotations

import sys

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from openhands.app_server.sandbox import agent_proxy_router as mod


def _app() -> TestClient:
    app = FastAPI()
    app.include_router(mod.agent_proxy_router)
    return TestClient(app)


@pytest.fixture
def client(monkeypatch) -> TestClient:
    async def _refuse(_key):
        raise HTTPException(status_code=401, detail='invalid session key')

    monkeypatch.setattr(mod, '_resolve', _refuse)
    return _app()


@pytest.fixture
def broken_client(monkeypatch) -> TestClient:
    """Not the customer's credential — the proxy's own machinery failing."""

    async def _explode(_key):
        raise RuntimeError('sandbox store unreachable at 10.0.0.4:5432')

    monkeypatch.setattr(mod, '_resolve', _explode)
    return _app()


def test_the_handshake_is_accepted_before_the_refusal(client):
    """The load-bearing assertion.

    Entering the context manager means the upgrade completed. On the previous
    behaviour it raised here instead, which is what erased the close code —
    so this test fails on the version it was written against.
    """
    with client.websocket_connect('/sockets/events/conv-1?session_api_key=bad') as ws:
        with pytest.raises(WebSocketDisconnect) as excinfo:
            ws.receive_text()

    assert excinfo.value.code == 1008


def test_the_reason_says_which_credential_was_wrong(client):
    """A close code alone reads as 'policy violation' and could be anything."""
    with client.websocket_connect('/sockets/events/conv-1?session_api_key=bad') as ws:
        with pytest.raises(WebSocketDisconnect) as excinfo:
            ws.receive_text()

    assert excinfo.value.reason == 'invalid session key'


def test_a_missing_key_is_refused_the_same_way(client):
    """No key and a stale key must be indistinguishable on the wire.

    Different answers would tell a prober which keys exist.
    """
    with client.websocket_connect('/sockets/events/conv-1') as ws:
        with pytest.raises(WebSocketDisconnect) as excinfo:
            ws.receive_text()

    assert excinfo.value.code == 1008


def test_nothing_upstream_is_contacted_for_a_refused_key(monkeypatch, client):
    """The refusal happens before the proxy dials the agent server.

    Verified by making any dial fail loudly: if the guard ever moved below the
    connect, this would surface as that error instead of a 1008.
    """
    import websockets

    def _boom(*args, **kwargs):
        raise AssertionError('dialled upstream for a refused key')

    monkeypatch.setattr(websockets, 'connect', _boom)

    with client.websocket_connect('/sockets/events/conv-1?session_api_key=bad') as ws:
        with pytest.raises(WebSocketDisconnect) as excinfo:
            ws.receive_text()

    assert excinfo.value.code == 1008


class TestNonAuthFailures:
    """The other pre-accept escapes, which reached the browser as 1006 too.

    `validate_session_key` documents only HTTPException, but it builds an
    InjectorState and reaches the sandbox store; and the function-local
    ``import websockets`` is an optional dependency by design. Both used to die
    before accept, and a 1006 is indistinguishable from a dropped network.
    """

    def test_a_store_fault_still_completes_the_handshake(self, broken_client):
        with broken_client.websocket_connect('/sockets/events/conv-1') as ws:
            with pytest.raises(WebSocketDisconnect) as excinfo:
                ws.receive_text()

        assert excinfo.value.code == 1011

    def test_a_store_fault_is_1011_and_not_1008(self, broken_client):
        """The distinction is the whole point.

        1008 tells the client the session is permanently dead, which surfaces
        "reload to reconnect" — advice that cannot work, because the reload
        hits the same fault. 1011 classifies as transient, so the client
        retries its bounded budget, which is right for something that recovers.
        """
        with broken_client.websocket_connect('/sockets/events/conv-1') as ws:
            with pytest.raises(WebSocketDisconnect) as excinfo:
                ws.receive_text()

        assert excinfo.value.code != 1008

    def test_the_reason_does_not_leak_internals(self, broken_client):
        """The reason crosses to the browser, and exception text carries hosts,
        ports and paths — here a database address."""
        with broken_client.websocket_connect('/sockets/events/conv-1') as ws:
            with pytest.raises(WebSocketDisconnect) as excinfo:
                ws.receive_text()

        assert excinfo.value.reason == 'proxy unavailable'
        assert '10.0.0.4' not in (excinfo.value.reason or '')

    def test_a_missing_optional_dependency_closes_cleanly(self, monkeypatch):
        """`import websockets` is function-local so a missing dep degrades this
        socket rather than the whole app — its own comment says so. It degraded
        into a pre-accept ImportError, which is a 1006 busy-loop."""

        async def _ok(_key):
            return 'http://localhost:8000'

        monkeypatch.setattr(mod, '_resolve', _ok)
        # None in sys.modules makes `import websockets` raise ImportError.
        monkeypatch.setitem(sys.modules, 'websockets', None)

        with _app().websocket_connect('/sockets/events/conv-1') as ws:
            with pytest.raises(WebSocketDisconnect) as excinfo:
                ws.receive_text()

        assert excinfo.value.code == 1011
