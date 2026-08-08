"""HTTP and WebSocket surface for the browser bridge.

Four endpoints, and the split between them is the security model:

* ``POST /bridge/pair`` — unauthenticated by design. The extension has no
  credential yet; the pairing CODE is the credential, and it came from an
  authenticated session that displayed it to the user.
* ``WS /bridge/device`` — the extension's long-lived socket, authenticated by
  the token pairing issued.
* ``POST /bridge/call`` — how the agent asks a browser to do something.
  Authenticated by ``X-Session-API-Key`` resolved to a RUNNING sandbox, because
  it is the agent server calling in, not a browser.
* ``GET /bridge/devices`` — which browsers the CALLER has paired. Authenticated
  by the session cookie.

NOTHING HERE MAY TAKE AN IDENTITY FROM THE CALLER
-------------------------------------------------
This is the rule the module got wrong once, so it is written down. ``/bridge/call``
used to read ``user_id`` from its request BODY and ``/bridge/devices/{user_id}``
from its PATH, with no credential on either. Both were reachable unauthenticated:
this router is mounted at ``/bridge``, and ``nimbus_auth_gate`` only demands a
session for paths under ``/api`` — anything else falls through to ``call_next``
unless it is a signed-out page load. ``/preview`` and ``/sockets`` are outside
``/api`` too and survive that because they authenticate themselves. These two did
not, so an unauthenticated POST could drive ANY user's paired Chrome through the
browser tools, and an unauthenticated GET listed their devices to find the id.

The docstring above this one asserted ``/bridge/call`` was "session
authenticated" while the function had no ``Depends`` at all — the description of
the design outlived the code that never implemented it. So: the caller supplies
a CREDENTIAL and the server derives the identity from it. Never the reverse.

WHY ``/bridge/pair`` TAKING NO SESSION IS NOT A HOLE
----------------------------------------------------
A browser extension cannot carry the user's app session — it is a different
origin with different storage, which is the whole reason pairing exists. What
protects this endpoint is that a code is 8 characters from a 32-symbol alphabet,
lives 120 seconds, is single-use, dies after five attempts, and only ever
appeared inside an authenticated conversation. Requiring a session here would
not add security; it would make the feature impossible. Note that pairing still
never lets the CALLER name the account: the user id comes from the redeemed
code's stored request, not from the body.
"""

from __future__ import annotations

import logging

from fastapi import (
    APIRouter,
    Header,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from pydantic import BaseModel, Field

from openhands.app_server.bridge.bridge_devices import DeviceStore
from openhands.app_server.bridge.bridge_pairing import (
    MAX_DEVICE_ID_LENGTH,
    MAX_DEVICE_NAME_LENGTH,
    PAIRING_TTL,
    PairingResult,
    PairingStore,
)
from openhands.app_server.bridge.bridge_registry import (
    BridgeRegistry,
    BridgeTimeout,
    NoSuchDevice,
    Peer,
)
from openhands.app_server.nimbus_sso.nimbus_session import (
    COOKIE_SESSION,
    session_user_id,
)
from openhands.app_server.sandbox.session_auth import validate_session_key

_logger = logging.getLogger(__name__)

bridge_router = APIRouter()

# Process-wide, matching the registry's own scope. See BridgeRegistry for why
# this cannot span replicas without a shared broker.
PAIRING = PairingStore()
DEVICES = DeviceStore()
REGISTRY = BridgeRegistry()


class PairRequest(BaseModel):
    code: str = Field(max_length=32)
    device_id: str = Field(max_length=MAX_DEVICE_ID_LENGTH)
    device_name: str = Field(default='Browser', max_length=MAX_DEVICE_NAME_LENGTH)


class PairResponse(BaseModel):
    token: str
    device_id: str


class PairCodeResponse(BaseModel):
    code: str
    # Sent rather than an absolute timestamp: the browser's clock may be wrong
    # by more than the 120s this lives, which would show a code as expired the
    # moment it appeared.
    expires_in_seconds: int


class CallRequest(BaseModel):
    # No user_id. It is derived from the session key — see the module docstring.
    device_id: str
    tool: str
    params: dict = Field(default_factory=dict)


async def _caller_from_session_key(session_api_key: str | None) -> str:
    """The user a sandbox belongs to, or 401.

    ``validate_session_key`` already refuses a missing key, an unknown key, and
    a key whose sandbox is not RUNNING. What is added here is the last step:
    a sandbox with no owner does NOT become the empty-string user. Devices are
    keyed by user id, so an empty id is a real bucket that any unowned sandbox
    could reach — and pairing under it is possible if a session ever carried an
    empty ``sub``. Fail closed instead.
    """
    sandbox = await validate_session_key(session_api_key)
    user_id = sandbox.created_by_user_id
    if not user_id:
        _logger.warning(
            'bridge: refusing call from sandbox %s, which has no owning user',
            sandbox.id,
        )
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail='Session key does not identify a user',
        )
    return user_id


@bridge_router.post('/bridge/pair', response_model=PairResponse)
async def pair_device(body: PairRequest) -> PairResponse:
    """Redeem a pairing code for a device token."""
    result, request = PAIRING.redeem(body.code, body.device_id)

    if result != PairingResult.OK or request is None:
        # The reason is returned because the user can act on the difference —
        # "expired" means generate a new one, "unknown" means check what you
        # typed. It reveals nothing about which account a code belonged to,
        # because redeem() never hands back the request on failure.
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={'reason': result},
        )

    device, token = DEVICES.pair(request.user_id, body.device_id, body.device_name)
    _logger.info(
        'bridge: paired device %s (%s) to user %s',
        device.device_id,
        device.name,
        device.user_id,
    )
    return PairResponse(token=token, device_id=device.device_id)


@bridge_router.websocket('/bridge/device')
async def device_socket(websocket: WebSocket) -> None:
    """The extension's socket.

    The token arrives in the first application message rather than the URL: a
    query string lands in proxy and server logs, and this credential is
    long-lived.
    """
    await websocket.accept()

    try:
        hello = await websocket.receive_json()
    except Exception:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    device_id = str(hello.get('device_id') or '')
    token = str(hello.get('token') or '')
    device = DEVICES.authenticate(device_id, token)
    if device is None:
        # Same close code for a bad token and an unknown device: distinguishing
        # them tells a prober which device ids exist.
        _logger.info('bridge: rejected device socket for %r', device_id[:64])
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    async def send(message: dict) -> None:
        await websocket.send_json(message)

    peer = Peer(
        user_id=device.user_id,
        device_id=device.device_id,
        name=device.name,
        send=send,
    )
    REGISTRY.register(peer)
    await websocket.send_json({'type': 'ready', 'device_id': device.device_id})

    try:
        while True:
            message = await websocket.receive_json()
            if message.get('type') != 'result':
                continue
            REGISTRY.resolve(
                device.device_id,
                str(message.get('request_id') or ''),
                message.get('result') or {},
            )
    except WebSocketDisconnect:
        pass
    except Exception:
        _logger.exception('bridge: device socket failed', stack_info=True)
    finally:
        # Always, so calls waiting on this device fail immediately rather than
        # hanging until their deadline against a socket already gone.
        REGISTRY.unregister(device.user_id, device.device_id)


@bridge_router.post('/bridge/call')
async def call_device(
    body: CallRequest,
    x_session_api_key: str | None = Header(default=None, alias='X-Session-API-Key'),
) -> dict:
    """Ask a paired browser to do something, and wait for the answer.

    The caller proves which sandbox it is; the server decides whose browser that
    reaches. A sandbox cannot address a device belonging to anyone else, because
    it never gets to say whose device it wants — only which of its own.
    """
    user_id = await _caller_from_session_key(x_session_api_key)
    try:
        return await REGISTRY.call(
            user_id, body.device_id, {'tool': body.tool, **body.params}
        )
    except NoSuchDevice as e:
        # 409, not 404: the device exists as a pairing, it just is not connected
        # right now. "Open your browser" is a different instruction from "pair
        # one first", and the agent should be able to tell the user which.
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(e)) from e
    except BridgeTimeout as e:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, detail=str(e)) from e


@bridge_router.post('/bridge/pair/code', response_model=PairCodeResponse)
async def create_pairing_code(request: Request) -> PairCodeResponse:
    """Issue a pairing code for the signed-in user.

    This was missing entirely. ``PairingStore.create`` existed, was tested, and
    was called from nowhere — only ``redeem`` had a route — so no code was ever
    issued and the extension could not pair at all. The store was right; there
    was simply no way to reach it.

    Cookie authenticated, and the user comes from the cookie. That is the whole
    reason ``/bridge/pair`` can afford to be public: the code is only meaningful
    because it was minted for an account that had already proved who it was, and
    the account travels with the code rather than with the redeeming caller.
    """
    user_id = session_user_id(request.cookies.get(COOKIE_SESSION))
    if not user_id:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail='Sign in to pair a browser.',
        )

    pairing = PAIRING.create(user_id)
    _logger.info('bridge: issued a pairing code for user %s', user_id)
    return PairCodeResponse(
        code=pairing.code,
        expires_in_seconds=int(PAIRING_TTL.total_seconds()),
    )


@bridge_router.get('/bridge/devices')
async def list_devices(request: Request) -> dict:
    """Which browsers the CALLER has paired, and which are connected now.

    No path parameter. The user comes from the session cookie, which means there
    is nothing to enumerate and — the reason this shape was wrong in both
    directions — nothing for the frontend to supply either. The browser has no
    way to learn its own user id: ``useMe`` is SaaS-gated and this ships oss, and
    ``/api/v1/nimbus/account`` returns email and balance but no id. So the
    by-id signature was not merely unsafe, it was unbuildable.
    """
    user_id = session_user_id(request.cookies.get(COOKIE_SESSION))
    if not user_id:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            detail='Sign in to list paired browsers.',
        )

    connected = {p.device_id for p in REGISTRY.peers_for(user_id)}
    return {
        'devices': [
            {
                'device_id': d.device_id,
                'name': d.name,
                'connected': d.device_id in connected,
                'paired_at': d.paired_at.isoformat(),
            }
            for d in DEVICES.devices_for(user_id)
        ]
    }
