"""HTTP and WebSocket surface for the browser bridge.

Three endpoints, and the split between them is the security model:

* ``POST /bridge/pair`` — unauthenticated by design. The extension has no
  credential yet; the pairing CODE is the credential, and it came from an
  authenticated session that displayed it to the user.
* ``WS /bridge/device`` — the extension's long-lived socket, authenticated by
  the token pairing issued.
* ``POST /bridge/call`` — how the agent asks a browser to do something. Session
  authenticated, because it is the agent server calling in, not a browser.

WHY ``/bridge/pair`` TAKING NO SESSION IS NOT A HOLE
----------------------------------------------------
A browser extension cannot carry the user's app session — it is a different
origin with different storage, which is the whole reason pairing exists. What
protects this endpoint is that a code is 8 characters from a 32-symbol alphabet,
lives 120 seconds, is single-use, dies after five attempts, and only ever
appeared inside an authenticated conversation. Requiring a session here would
not add security; it would make the feature impossible.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel, Field

from openhands.app_server.bridge.bridge_devices import DeviceStore
from openhands.app_server.bridge.bridge_pairing import (
    MAX_DEVICE_ID_LENGTH,
    MAX_DEVICE_NAME_LENGTH,
    PairingResult,
    PairingStore,
)
from openhands.app_server.bridge.bridge_registry import (
    BridgeRegistry,
    BridgeTimeout,
    NoSuchDevice,
    Peer,
)

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


class CallRequest(BaseModel):
    user_id: str
    device_id: str
    tool: str
    params: dict = Field(default_factory=dict)


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
async def call_device(body: CallRequest) -> dict:
    """Ask a paired browser to do something, and wait for the answer."""
    try:
        return await REGISTRY.call(
            body.user_id, body.device_id, {'tool': body.tool, **body.params}
        )
    except NoSuchDevice as e:
        # 409, not 404: the device exists as a pairing, it just is not connected
        # right now. "Open your browser" is a different instruction from "pair
        # one first", and the agent should be able to tell the user which.
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(e)) from e
    except BridgeTimeout as e:
        raise HTTPException(status.HTTP_504_GATEWAY_TIMEOUT, detail=str(e)) from e


@bridge_router.get('/bridge/devices/{user_id}')
async def list_devices(user_id: str) -> dict:
    """Which browsers this user has paired, and which are connected now."""
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
