"""Public reverse proxy from the app server to the in-container agent server.

WHY THIS EXISTS
---------------
With ``RUNTIME=process`` the agent server runs as a child process inside this
same container, and ``ProcessSandboxService`` advertises it as
``http://localhost:<port>`` (see ``process_sandbox_service.py::_local_agent_url``,
whose docstring correctly states that localhost is always right for the app
server's own health checks).

That URL is also handed to the BROWSER, in ``AppConversation.conversation_url``.
In the V1 architecture the browser talks to the agent server directly — which is
why it is given ``conversation_url`` and ``session_api_key`` at all. On a hosted
deployment ``localhost`` is the customer's own laptop, so nothing ever reaches
the agent: the UI sits on "Connecting… (this may take 1-2 minutes)", then shows
"Error occurred", ``accumulated_cost`` stays 0.0, every token counter stays 0,
``ApiKey.lastUsedAt`` stays NULL, and the event list returns
``{"items":[],"next_page_id":null}``. That is the entire "chat is broken"
symptom, and it is above the agent loop rather than inside it.

Azure Container Apps publishes exactly ONE port per app (``targetPort: 3000``,
``additionalPortMappings: null``), so the agent server's port cannot simply be
exposed. The app server has to carry the traffic.

ROUTING KEY: THE SESSION KEY, NOT THE PORT
------------------------------------------
The agent port is NOT fixed. ``ProcessSandboxService._find_unused_port`` starts
at ``base_port`` and increments, so concurrent sandboxes sit on 8000, 8001, …
(both were live when this was written). Hardcoding a port would work until the
second conversation.

``session_auth.validate_session_key`` already resolves a session key to its
``SandboxInfo`` and — importantly — already refuses keys for sandboxes that are
not RUNNING. Reusing it means this proxy inherits that check rather than
re-implementing it, and it also handles the browser calls that carry no
conversation id at all (``/api/git/*``, ``/api/vscode/*``, ``/api/file/*``),
where the session key is the only thing available to route on.

DELIBERATELY NOT USED: ``replace_localhost_hostname_for_docker``. That helper
rewrites ``localhost`` to ``host.docker.internal``, which does not resolve under
Container Apps.
"""

from __future__ import annotations

import base64
import logging
from typing import Final
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request, WebSocket, status
from fastapi.responses import StreamingResponse

from openhands.app_server.sandbox.sandbox_models import AGENT_SERVER, SandboxInfo
from openhands.app_server.sandbox.session_auth import validate_session_key

_logger = logging.getLogger(__name__)

agent_proxy_router = APIRouter()

# Hop-by-hop headers must not be forwarded — they describe the single TCP hop
# we are terminating, not the message. Forwarding content-length in particular
# corrupts any body httpx re-encodes.
_HOP_BY_HOP: Final[frozenset[str]] = frozenset(
    {
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'host',
        'content-length',
    }
)

# Long enough for a model turn to stream, short enough to fail rather than hang.
_PROXY_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=60.0, pool=10.0)


def _agent_base_url(sandbox: SandboxInfo) -> str:
    """The agent server's in-container base URL, e.g. http://localhost:8001."""
    for exposed in sandbox.exposed_urls or []:
        if exposed.name == AGENT_SERVER:
            return exposed.url.rstrip('/')
    raise HTTPException(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        detail='sandbox has no AGENT_SERVER url',
    )


async def _resolve(session_api_key: str | None) -> str:
    """Session key -> agent base URL. Raises 401 exactly as the agent would."""
    sandbox = await validate_session_key(session_api_key)
    return _agent_base_url(sandbox)


async def _proxy_http(request: Request) -> StreamingResponse:
    base = await _resolve(request.headers.get('x-session-api-key'))
    target = f'{base}{request.url.path}'
    if request.url.query:
        target = f'{target}?{request.url.query}'

    headers = {
        k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP
    }
    body = await request.body()

    client = httpx.AsyncClient(timeout=_PROXY_TIMEOUT)
    req = client.build_request(
        request.method, target, headers=headers, content=body or None
    )
    try:
        upstream = await client.send(req, stream=True)
    except httpx.RequestError as e:
        await client.aclose()
        _logger.warning('agent proxy: upstream unreachable %s: %s', target, e)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, detail='agent server unreachable'
        ) from e

    async def body_iter():
        # Stream rather than .read(): event feeds are long and uploads are
        # multipart, and buffering either in the app server is how a proxy
        # turns into an OOM.
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    passthrough = {
        k: v
        for k, v in upstream.headers.items()
        if k.lower() not in _HOP_BY_HOP and k.lower() != 'content-encoding'
    }
    return StreamingResponse(
        body_iter(),
        status_code=upstream.status_code,
        headers=passthrough,
        media_type=upstream.headers.get('content-type'),
    )


# The browser reaches the agent server on these prefixes. They are API paths, so
# none of them collides with a React Router page route (`conversations/:id` has
# no /api prefix) or with /assets. This router MUST be registered before the SPA
# static mount at "/", or the catch-all answers first and every one of these
# returns index.html with a 200 — which is exactly what production did.
@agent_proxy_router.api_route(
    '/api/conversations/{rest:path}',
    methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
)
async def proxy_conversations(request: Request, rest: str) -> StreamingResponse:
    return await _proxy_http(request)


@agent_proxy_router.api_route(
    '/api/git/{rest:path}', methods=['GET', 'POST', 'OPTIONS']
)
async def proxy_git(request: Request, rest: str) -> StreamingResponse:
    return await _proxy_http(request)


@agent_proxy_router.api_route(
    '/api/vscode/{rest:path}', methods=['GET', 'OPTIONS']
)
async def proxy_vscode(request: Request, rest: str) -> StreamingResponse:
    return await _proxy_http(request)


@agent_proxy_router.api_route(
    '/api/file/{rest:path}', methods=['GET', 'POST', 'OPTIONS']
)
async def proxy_file(request: Request, rest: str) -> StreamingResponse:
    return await _proxy_http(request)


SESSION_KEY_SUBPROTOCOL = 'nimbus-session-key'


def _key_from_subprotocol(websocket: WebSocket) -> str | None:
    """Read the session key out of ``Sec-WebSocket-Protocol``.

    A browser cannot set arbitrary headers on a WebSocket handshake, which is
    why the key used to travel in the query string. It CAN set subprotocols --
    ``new WebSocket(url, [name, value])`` becomes
    ``Sec-WebSocket-Protocol: name, value`` -- so the key rides a header after
    all, and never reaches a URL that ingress logs.

    The value is base64url WITHOUT padding, because ``=`` is not a legal
    subprotocol token character (RFC 6455 defers to RFC 7230 tokens; the
    base64url alphabet is otherwise legal).
    """
    raw = websocket.headers.get('sec-websocket-protocol')
    if not raw:
        return None
    parts = [p.strip() for p in raw.split(',')]
    if len(parts) < 2 or parts[0] != SESSION_KEY_SUBPROTOCOL:
        return None
    encoded = parts[1]
    try:
        padded = encoded + '=' * (-len(encoded) % 4)
        return base64.urlsafe_b64decode(padded.encode()).decode()
    except (ValueError, UnicodeDecodeError):
        # A malformed value is treated as absent rather than raising: it then
        # falls through to the query parameter, and failing that to _resolve's
        # own rejection, which already closes the socket properly.
        return None


def _upstream_query(websocket: WebSocket, key: str | None) -> str:
    """Build the query string for the UPSTREAM leg.

    THE SANDBOX ONLY ACCEPTS THE KEY AS A QUERY PARAMETER. Its socket signature
    is ``session_api_key: Annotated[str | None, Query(...)]`` (SDK
    ``agent_server/sockets.py``) with no header alternative, so this leg cannot
    move to a header the way the browser leg just did, and stripping the key
    here would authenticate nothing and break every conversation.

    That is a smaller exposure and worth stating precisely rather than waving
    at: this leg is server-to-server inside the container or private network and
    never crosses ingress, which is the log the browser leg was landing in.
    """
    params = [
        (k, v) for k, v in websocket.query_params.multi_items()
        if k != 'session_api_key'
    ]
    if key is not None:
        params.append(('session_api_key', key))
    return urlencode(params)


@agent_proxy_router.websocket('/sockets/events/{conversation_id}')
async def proxy_events_socket(websocket: WebSocket, conversation_id: str) -> None:
    """Bidirectional pump for the agent event stream.

    The session key arrives EITHER in ``Sec-WebSocket-Protocol`` (preferred; see
    ``_key_from_subprotocol``) OR as the ``session_api_key`` query parameter.

    BOTH ARE ACCEPTED ON PURPOSE, and the fallback is not dead weight. This is
    every chat session's auth on a hot path: a browser tab that is already open,
    or one holding a cached copy of the previous bundle, still connects the old
    way. Dropping the query parameter in the same release that adds the header
    would have disconnected every live session at the moment of the swap. The
    parameter can be removed once no bundle in circulation sends it.
    """
    # Imported here rather than at module scope: this is the only code path that
    # needs it, and keeping it local means a missing optional dep degrades the
    # socket instead of preventing the whole app from importing.
    import websockets

    subprotocol_key = _key_from_subprotocol(websocket)
    key = subprotocol_key or websocket.query_params.get('session_api_key')
    # Only echo a subprotocol we were actually offered. Selecting one the client
    # did not send makes a conforming client fail the connection (RFC 6455 4.1).
    agreed = SESSION_KEY_SUBPROTOCOL if subprotocol_key is not None else None
    try:
        base = await _resolve(key)
    except HTTPException:
        # ACCEPT FIRST, then close. This looks backwards and is not.
        #
        # Closing before accept makes uvicorn refuse the handshake with a plain
        # HTTP 403 ("connection rejected (403 Forbidden)" in the logs). A
        # refused handshake never completes, so RFC 6455 has no closing frame to
        # deliver and the browser synthesises CloseEvent code **1006** —
        # the same code it reports for a yanked network cable. The close code
        # chosen here never left the process.
        #
        # That is what made the rejection retry forever: the client could not
        # tell "this key is dead, get a new one" from "the wifi blipped", so it
        # treated a permanent failure as a transient one, at a flat 3s, with no
        # attempt ceiling. Accepting first completes the handshake, so 1008
        # arrives as 1008 and `classifyCloseCode` in the frontend can act on it.
        #
        # The failure is still just as visible in the logs, one line below.
        # `bridge_router.device_socket` already closes this way for the same
        # reason.
        _logger.info(
            'agent proxy: refused event socket for %s (invalid session key)',
            conversation_id,
        )
        await websocket.accept(subprotocol=agreed)
        await websocket.close(
            code=status.WS_1008_POLICY_VIOLATION, reason='invalid session key'
        )
        return

    query = _upstream_query(websocket, key)
    upstream_url = (
        base.replace('http://', 'ws://', 1).replace('https://', 'wss://', 1)
        + f'/sockets/events/{conversation_id}'
        + (f'?{query}' if query else '')
    )

    await websocket.accept(subprotocol=agreed)
    try:
        async with websockets.connect(upstream_url, max_size=None) as upstream:
            import asyncio

            async def client_to_agent() -> None:
                while True:
                    msg = await websocket.receive()
                    if msg.get('type') == 'websocket.disconnect':
                        return
                    if (text := msg.get('text')) is not None:
                        await upstream.send(text)
                    elif (data := msg.get('bytes')) is not None:
                        await upstream.send(data)

            async def agent_to_client() -> None:
                async for message in upstream:
                    if isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_text(message)

            done, pending = await asyncio.wait(
                [
                    asyncio.create_task(client_to_agent()),
                    asyncio.create_task(agent_to_client()),
                ],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
    except Exception as e:  # noqa: BLE001 - a proxy must not leak upstream errors
        _logger.warning(
            'agent proxy: websocket relay ended for %s: %s', conversation_id, e
        )
    finally:
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001 - already closed
            pass
