"""Serve the customer's own dev server back to their browser.

An agent that edits a web app is working blind until someone can look at the
result, and today that means the customer runs it themselves outside the
product. This carries whatever is listening inside the sandbox out to an iframe.

WHY IT IS A PATH AND NOT A PORT
-------------------------------
Azure Container Apps publishes exactly ONE port per app (see the note in
``agent_proxy_router``), so a dev server on :5173 has no route of its own and
never will. Every byte has to enter through the app server, which is why this is
a sibling of the agent proxy rather than a new ingress: that module already
solved streaming, hop-by-hop headers and the auth handshake in this exact
architecture.

AUTH, AND WHY IT IS A COOKIE
----------------------------
An iframe cannot set a header on its document request, and neither can the
stylesheet and script requests the page then makes. So the first request carries
``?session_api_key=`` — the same bootstrap the events socket already uses, and
for the same reason — and the response sets a cookie scoped to this
conversation's preview path. Subresources ride on that.

The key is validated on every request, not just the first, so pausing or
deleting a conversation revokes its preview immediately rather than whenever the
cookie happens to expire.

WHAT THIS DELIBERATELY DOES NOT DO
----------------------------------
It does not rewrite HTML. An app that emits absolute asset paths (``/assets/x.js``)
will request them against our origin root and miss, and the honest fix for that
is a wildcard subdomain per conversation, not a regex over someone else's
markup — that direction is a tarpit and the reason is written down in
``docs/parity-roadmap.md`` rather than rediscovered.

It also strips ``X-Frame-Options`` and any ``frame-ancestors`` directive from
what it proxies. That is not a licence to frame anything: it is the response of
the customer's OWN dev server, which they asked us to show them, and a default
``helmet`` install would otherwise make the feature impossible. Nothing else in
the CSP is touched.
"""

from __future__ import annotations

import logging
import re
from typing import Final

import httpx
import psutil
from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse

from openhands.app_server.sandbox.session_auth import validate_session_key

_logger = logging.getLogger(__name__)

preview_proxy_router = APIRouter()

# Same reasoning as the agent proxy: these describe the hop we are terminating.
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

# Headers that would stop the customer's own app rendering in the iframe we are
# rendering it in. See the module docstring: this is scoped to those two, not a
# general CSP strip.
_FRAME_BLOCKERS: Final[frozenset[str]] = frozenset({'x-frame-options'})
_FRAME_ANCESTORS = re.compile(r'frame-ancestors[^;]*;?\s*', re.IGNORECASE)

# A dev server takes a moment to compile on first hit; past that, fail loudly.
_PREVIEW_TIMEOUT = httpx.Timeout(connect=5.0, read=120.0, write=30.0, pool=10.0)

_COOKIE = 'nimbus_preview_key'

# Privileged ports are not where a dev server lives, and refusing them keeps
# this from being a way to reach whatever else happens to bind low in the
# container.
_MIN_PORT = 1024
_MAX_PORT = 65535


def _check_port(port: int) -> None:
    if not _MIN_PORT <= port <= _MAX_PORT:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=f'preview port must be between {_MIN_PORT} and {_MAX_PORT}',
        )


def _session_key(request: Request) -> str | None:
    """The key, from the query on first load and the cookie thereafter.

    Query first: it is how a fresh iframe navigation arrives, and it must be
    able to replace a stale cookie from a previous conversation rather than
    losing to it.
    """
    return request.query_params.get('session_api_key') or request.cookies.get(_COOKIE)


def _clean_response_headers(upstream: httpx.Response) -> dict[str, str]:
    headers: dict[str, str] = {}
    for key, value in upstream.headers.items():
        lowered = key.lower()
        if lowered in _HOP_BY_HOP or lowered in _FRAME_BLOCKERS:
            continue
        if lowered == 'content-security-policy':
            # Drop only the directive that blocks embedding. A dev server that
            # sets script-src or connect-src is describing its own app and we
            # have no business relaxing that.
            stripped = _FRAME_ANCESTORS.sub('', value).strip()
            if stripped:
                headers[key] = stripped
            continue
        headers[key] = value
    return headers


def listening_ports_for(pid: int, exclude: set[int] | None = None) -> list[int]:
    """TCP ports a process or its descendants are listening on.

    Reporting what is ACTUALLY bound beats parsing package.json for a dev
    script, which is what a product whose runtime is detached from the agent has
    to do. Ours is not: the dev server is started by the agent's own terminal
    tool, in the same process tree, so the truthful answer is available and the
    guessed one is never needed.

    Descendants matter because nobody starts a server directly — `npm run dev`
    forks node, which is the process that actually binds.
    """
    skip = exclude or set()
    found: set[int] = set()

    try:
        root = psutil.Process(pid)
        processes = [root, *root.children(recursive=True)]
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return []

    for process in processes:
        try:
            for conn in process.net_connections(kind='tcp'):
                if conn.status != psutil.CONN_LISTEN or not conn.laddr:
                    continue
                port = conn.laddr.port
                if port in skip or not _MIN_PORT <= port <= _MAX_PORT:
                    continue
                found.add(port)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            # A child exiting mid-scan is ordinary, not an error worth failing
            # the whole listing over.
            continue

    return sorted(found)


def _set_preview_cookie(
    response: Response, conversation_id: str, key: str | None
) -> None:
    """Scope the session key to this conversation's preview path."""
    if not key:
        return
    response.set_cookie(
        _COOKIE,
        key,
        path=f'/preview/{conversation_id}/',
        httponly=True,
        samesite='lax',
    )


@preview_proxy_router.get('/preview/{conversation_id}/ports')
async def preview_ports(
    request: Request, response: Response, conversation_id: str
) -> dict:
    """Which ports this conversation currently has something listening on.

    Declared BEFORE the catch-all below: FastAPI matches in order, and
    `/preview/x/ports` would otherwise try to parse "ports" as the port integer
    and 422.

    THIS ALSO SETS THE PREVIEW COOKIE, and that is not incidental.
    Without it a client's only way to authenticate the iframe would be to put
    the session key in the `src` attribute — where it persists in the DOM, in
    any screenshot of the page, and in the browser's history. Calling this
    first sets the cookie, so the iframe src can be the bare
    `/preview/{id}/{port}/` with no credential in it at all. A client asks
    which ports exist before it can show a preview anyway, so this costs no
    extra round trip.
    """
    key = _session_key(request)
    sandbox = await validate_session_key(key)
    _set_preview_cookie(response, conversation_id, key)

    from openhands.app_server.sandbox.process_sandbox_service import _processes

    process_info = _processes.get(sandbox.id)
    if process_info is None:
        # A remote runtime has no local process tree to scan. Saying so beats
        # an empty list, which reads as "your server is not running" — those
        # are different states and deserve different words in the UI.
        return {'ports': [], 'supported': False}

    # The agent server's own port is not a preview.
    ports = listening_ports_for(process_info.pid, exclude={process_info.port})
    return {'ports': ports, 'supported': True}


@preview_proxy_router.api_route(
    '/preview/{conversation_id}/{port}/{path:path}',
    methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
)
async def proxy_preview(
    request: Request, conversation_id: str, port: int, path: str
) -> Response:
    """Proxy one request to a port inside this conversation's sandbox."""
    _check_port(port)

    key = _session_key(request)
    # Validated per request, not per session: revocation should take effect the
    # moment a conversation is paused, not when a cookie expires.
    await validate_session_key(key)

    target = f'http://localhost:{port}/{path}'
    if request.url.query:
        # The bootstrap parameter is ours, not the app's. Forwarding it would
        # leak the session key into the customer's own server logs.
        query = '&'.join(
            part
            for part in request.url.query.split('&')
            if not part.startswith('session_api_key=')
        )
        if query:
            target = f'{target}?{query}'

    headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP}
    body = await request.body()

    client = httpx.AsyncClient(timeout=_PREVIEW_TIMEOUT)
    upstream_request = client.build_request(
        request.method, target, headers=headers, content=body or None
    )
    try:
        upstream = await client.send(upstream_request, stream=True)
    except httpx.RequestError as e:
        await client.aclose()
        # Nothing listening is the NORMAL case — the customer has not started
        # their dev server yet — so this says which port rather than reading as
        # a fault in the product.
        _logger.info('preview: nothing listening on %s: %s', target, e)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            detail=f'nothing is listening on port {port} in this workspace',
        ) from e

    async def body_iter():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    response = StreamingResponse(
        body_iter(),
        status_code=upstream.status_code,
        headers=_clean_response_headers(upstream),
    )

    # Re-issue on every request carrying an explicit key, so a reload after a
    # conversation switch replaces the previous cookie instead of racing it.
    _set_preview_cookie(
        response, conversation_id, request.query_params.get('session_api_key')
    )
    return response
