"""Require a verified Nimbus session for the application API.

THE HOLE THIS CLOSES
--------------------
Before this, every /api/v1/* route answered anonymously. Verified from a clean
shell with no cookies and no credentials:

    curl "https://chat.nimbusapi.net/api/v1/app-conversations/search?limit=3"
    -> 200 application/json, returning conversations, sandbox ids, titles,
       conversation_urls, and live session_api_key values

`get_dependencies()` returns an empty list unless SESSION_API_KEY is set, and it
was not, so no route carried an auth dependency at all. Combined with
DefaultUserAuth returning user_id None, the result was one shared workspace that
the public internet could read.

A middleware rather than per-route dependencies, deliberately: a dependency has
to be remembered on every new router, and the failure mode of forgetting is an
open endpoint that looks exactly like a closed one. Default-deny at the edge
means a new route is protected before anyone thinks about it.

EXEMPTIONS, and why each one is safe
------------------------------------
  /api/auth/*        the SSO handoff itself - it is how a session is obtained,
                     and it verifies its own HS256 JWT before issuing one
  /api/v1/web-client/config
                     the SPA bootstraps from this to know how to render a
                     signed-out state; it returns no user data
  /health, /alive    liveness probes, no data
  /api/conversations, /api/git, /api/vscode, /api/file, /sockets
                     the agent proxy, which authenticates separately and more
                     strictly via X-Session-API-Key -> validate_session_key,
                     and which also refuses non-RUNNING sandboxes
Everything not under /api (the SPA, /assets, page routes) is untouched: the app
must still load in order to show a sign-in prompt.
"""

from __future__ import annotations

import os
from typing import Final

from fastapi import Request, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from openhands.app_server.nimbus_sso.nimbus_session import COOKIE_SESSION, read_session
from openhands.app_server.utils.logger import openhands_logger as logger

# Prefixes that must stay reachable without a Nimbus session.
_EXEMPT_PREFIXES: Final[tuple[str, ...]] = (
    '/api/auth/',
    '/api/v1/web-client/config',
    '/health',
    '/alive',
    # Agent proxy — authenticated by X-Session-API-Key, not by cookie.
    '/api/conversations',
    '/api/git',
    '/api/vscode',
    '/api/file',
    '/sockets',
)


def _enabled() -> bool:
    """Default ON. NIMBUS_REQUIRE_AUTH=0 disables it without a rebuild.

    An auth change that can only be reverted by a 20-minute image build is a
    change you hesitate to make; the kill switch is what makes shipping this
    safe. It is opt-OUT, so the secure state is the one you get by doing
    nothing.
    """
    return os.getenv('NIMBUS_REQUIRE_AUTH', '1') != '0'


class NimbusAuthGateMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not _enabled():
            return await call_next(request)

        path = request.url.path
        if not path.startswith('/api'):
            return await call_next(request)
        if any(path.startswith(p) for p in _EXEMPT_PREFIXES):
            return await call_next(request)

        if read_session(request.cookies.get(COOKIE_SESSION)) is None:
            logger.info('nimbus_auth_gate: refused unauthenticated %s', path)
            return JSONResponse(
                status_code=status.HTTP_401_UNAUTHORIZED,
                content={
                    'error': 'authentication_required',
                    'detail': 'Sign in through nimbusapi.net to use Nimbus Chat.',
                },
            )

        return await call_next(request)
