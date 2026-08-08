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

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from openhands.app_server.sandbox import agent_proxy_router as mod


@pytest.fixture
def client(monkeypatch) -> TestClient:
    async def _refuse(_key):
        raise HTTPException(status_code=401, detail='invalid session key')

    monkeypatch.setattr(mod, '_resolve', _refuse)

    app = FastAPI()
    app.include_router(mod.agent_proxy_router)
    return TestClient(app)


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
