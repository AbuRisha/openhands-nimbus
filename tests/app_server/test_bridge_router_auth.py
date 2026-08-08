"""Who is allowed to drive somebody's browser.

── The bug this exists to stop ─────────────────────────────────────────────
Both of these shipped reachable with NO credential of any kind:

    POST /bridge/call          {"user_id": "<anyone>", "device_id": ...}
    GET  /bridge/devices/<anyone>

The first drives that person's real Chrome through the browser tools while it is
signed into their accounts; the second hands over the device ids to aim it with.
Neither had a ``Depends``. ``nimbus_auth_gate`` did not cover them either: it
only demands a session for paths under ``/api``, and everything else falls
through to ``call_next`` unless it is a signed-out page load. ``/bridge`` is not
under ``/api`` and is not exempt-listed, so it was unprotected by DEFAULT rather
than by decision.

── Why the existing tests could not see it ─────────────────────────────────
There were three bridge test files — pairing, devices, registry — and all three
test the STORES. Not one sent an HTTP request, so the surface that was actually
exposed had no coverage at all, and the module docstring's claim that
``/bridge/call`` was "session authenticated" went unchallenged for as long as it
was only ever read.

So these go through the router. The point is not that the happy path works, it
is that the UNAUTHENTICATED path is refused and that a caller cannot name a user
it does not own — which is only observable on the wire.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from openhands.app_server.bridge import bridge_router as mod


class _Sandbox:
    def __init__(self, user_id: str | None) -> None:
        self.id = 'sandbox-1'
        self.created_by_user_id = user_id


@pytest.fixture
def calls() -> list[tuple[str, str]]:
    """Records (user_id, device_id) the registry was asked to reach."""
    return []


@pytest.fixture
def client(monkeypatch, calls) -> TestClient:
    async def fake_call(user_id: str, device_id: str, payload: dict) -> dict:
        calls.append((user_id, device_id))
        return {'ok': True}

    monkeypatch.setattr(mod.REGISTRY, 'call', fake_call)

    app = FastAPI()
    app.include_router(mod.bridge_router)
    return TestClient(app)


def _authenticate_as(monkeypatch, user_id: str | None) -> None:
    """Make any X-Session-API-Key resolve to a sandbox owned by ``user_id``."""

    async def fake_validate(key: str | None):
        if not key:
            from fastapi import HTTPException, status

            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail='missing')
        return _Sandbox(user_id)

    monkeypatch.setattr(mod, 'validate_session_key', fake_validate)


class TestCallRequiresACredential:
    def test_no_session_key_is_refused(self, client, calls):
        """The whole bug: this used to reach a browser."""
        r = client.post(
            '/bridge/call',
            json={'device_id': 'dev-1', 'tool': 'get_page_text', 'params': {}},
        )

        assert r.status_code == 401
        # And nothing was contacted on the way to being refused.
        assert calls == []

    def test_a_user_id_in_the_body_is_ignored(self, client, calls, monkeypatch):
        """The exact attack shape: name someone else and see whose browser moves."""
        _authenticate_as(monkeypatch, 'victim-is-not-me')

        client.post(
            '/bridge/call',
            headers={'X-Session-API-Key': 'k'},
            json={
                'user_id': 'somebody-else',
                'device_id': 'dev-1',
                'tool': 'get_page_text',
            },
        )

        # The reached user is the one the KEY resolved to, never the body's.
        assert calls == [('victim-is-not-me', 'dev-1')]

    def test_a_sandbox_with_no_owner_is_refused(self, client, calls, monkeypatch):
        """Fail closed rather than reaching the empty-string user's devices."""
        _authenticate_as(monkeypatch, None)

        r = client.post(
            '/bridge/call',
            headers={'X-Session-API-Key': 'k'},
            json={'device_id': 'dev-1', 'tool': 'get_page_text'},
        )

        assert r.status_code == 401
        assert calls == []


class TestPairingCodeRequiresASession:
    """The endpoint that mints codes, which did not exist at all.

    ``PairingStore.create`` was written and tested but never routed — only
    ``redeem`` had one — so no code was ever issued and the extension could not
    pair. Worth noting for what it says about coverage: the store's tests all
    passed, because the gap was not in the store.
    """

    def test_no_cookie_is_refused(self, client):
        r = client.post('/bridge/pair/code')
        assert r.status_code == 401

    def test_mints_a_code_for_the_COOKIE_user(self, client, monkeypatch):
        monkeypatch.setattr(mod, 'session_user_id', lambda token: 'me')
        minted: list[str] = []

        real_create = mod.PAIRING.create

        def spy(user_id: str):
            minted.append(user_id)
            return real_create(user_id)

        monkeypatch.setattr(mod.PAIRING, 'create', spy)

        r = client.post('/bridge/pair/code', cookies={mod.COOKIE_SESSION: 'x'})

        assert r.status_code == 200
        assert minted == ['me']
        body = r.json()
        assert body['code'] and body['expires_in_seconds'] > 0
        # A relative TTL, not an absolute time: a browser clock wrong by more
        # than 120s would show the code expired on arrival.
        assert isinstance(body['expires_in_seconds'], int)


class TestDevicesRequiresASession:
    def test_no_cookie_is_refused(self, client):
        r = client.get('/bridge/devices')
        assert r.status_code == 401

    def test_the_by_id_route_is_gone(self, client):
        """Not merely authenticated — removed, so there is nothing to enumerate."""
        r = client.get('/bridge/devices/some-other-user')
        assert r.status_code == 404

    def test_lists_only_the_cookie_users_devices(self, client, monkeypatch):
        monkeypatch.setattr(mod, 'session_user_id', lambda token: 'me')
        monkeypatch.setattr(mod.REGISTRY, 'peers_for', lambda uid: [])

        seen: list[str] = []

        def fake_devices_for(user_id: str):
            seen.append(user_id)
            return []

        monkeypatch.setattr(mod.DEVICES, 'devices_for', fake_devices_for)

        r = client.get('/bridge/devices', cookies={mod.COOKIE_SESSION: 'whatever'})

        assert r.status_code == 200
        # The identity came from the cookie. There is no other input it could
        # have come from, which is the property being pinned.
        assert seen == ['me']
