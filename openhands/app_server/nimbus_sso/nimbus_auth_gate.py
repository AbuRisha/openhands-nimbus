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

SIGNED-OUT PAGE LOADS
---------------------
Blocking /api while letting the SPA render was supposed to leave the app free
to show a sign-in prompt. It does not have one -- this fork is entered only by
SSO from the dashboard, so upstream's signed-out UI was never wired up. What a
visitor to https://chat.nimbusapi.net actually got was a BLANK PAGE: the shell
loaded, its first two calls (/api/v1/settings and app-conversations/search)
came back 401, and nothing rendered. Anyone arriving from a bookmark, or with
an expired session, saw an empty screen with no way forward.

So an unauthenticated HTML page load now redirects to the dashboard's SSO
entry point instead. For a customer already signed in to Nimbus that is a
silent round trip and they land back here logged in -- the same "no second
login" behaviour the Builder already has. For a signed-out one it lands on the
Nimbus login page, which is the prompt this was always meant to show.

Deliberately narrow, to avoid breaking the shell it is trying to fix: GET only,
`Accept: text/html` only. Asset and data requests do not match and are
unaffected. There is no redirect loop -- the SSO callback lands on
/api/auth/nimbus-sso, which is exempt above and sets the cookie before any
further navigation.
"""

from __future__ import annotations

import os
from typing import Final

from fastapi import Request, status
from fastapi.responses import JSONResponse, RedirectResponse
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
    # Event webhook. The agent server POSTs its event stream here and it is
    # the ONLY path by which a conversation transcript reaches durable
    # storage. It carries no browser cookie — it authenticates on
    # X-Session-API-Key resolved to a sandbox record, which is narrower than a
    # session cookie, not weaker. Gating it on the cookie would 401 every
    # event and silently return us to conversations that vanish on restart.
    '/api/v1/webhooks',
    # OAuth/OIDC callbacks. Not under /api, so these only matter for the
    # signed-out page redirect — a callback arrives with no session by
    # definition, and bouncing it to the dashboard would discard the code it
    # is carrying and make the login unfinishable.
    '/oauth/',
)


def _enabled() -> bool:
    """Default ON. NIMBUS_REQUIRE_AUTH=0 disables it without a rebuild.

    An auth change that can only be reverted by a 20-minute image build is a
    change you hesitate to make; the kill switch is what makes shipping this
    safe. It is opt-OUT, so the secure state is the one you get by doing
    nothing.
    """
    return os.getenv('NIMBUS_REQUIRE_AUTH', '1') != '0'


def auth_required() -> bool:
    """Public read of the same switch, for enforcement outside this middleware.

    ``/mcp`` is an ASGI Mount outside ``/api``, so this middleware never gates
    it; the MCP tools have to refuse anonymous callers themselves. They ask
    here rather than re-reading the env var so there is ONE answer to "does
    this deployment authenticate" and one switch that turns it all off.
    """
    return _enabled()


def _sso_entry_url() -> str:
    """Where to send a signed-out page load.

    /dashboard/chat mints the handoff JWT and redirects back here; if the
    visitor is not signed in to Nimbus it falls through to the login page. One
    URL covers both cases, which is why this is the target rather than /login.
    """
    base = (os.getenv('NIMBUS_SITE_BASE_URL') or 'https://nimbusapi.net').rstrip('/')
    return f'{base}/dashboard/chat'


def _is_page_load(request: Request) -> bool:
    """A top-level navigation, as opposed to an asset or data fetch.

    Redirecting anything broader would break the very shell this is meant to
    fix -- /assets/*.js is not under /api either.
    """
    if request.method != 'GET':
        return False
    return 'text/html' in request.headers.get('accept', '')


class NimbusAuthGateMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not _enabled():
            return await call_next(request)

        path = request.url.path

        # Exemptions are checked FIRST, before either branch below. They used
        # to be checked only on the /api path, which was harmless while
        # non-/api requests were passed through untouched. It stops being
        # harmless now that a signed-out page load is redirected: /health and
        # /alive are not under /api, and a probe that happens to send
        # `Accept: text/html` would have been answered with a 302 and read as
        # a failed liveness check.
        if any(path.startswith(p) for p in _EXEMPT_PREFIXES):
            return await call_next(request)

        if not path.startswith('/api'):
            # Signed-out page load -> hand off to the dashboard rather than
            # render a shell whose every data call will 401 into a blank page.
            if (
                _is_page_load(request)
                and read_session(request.cookies.get(COOKIE_SESSION)) is None
            ):
                logger.info(
                    'nimbus_auth_gate: redirecting signed-out page load %s to SSO', path
                )
                return RedirectResponse(
                    url=_sso_entry_url(), status_code=status.HTTP_302_FOUND
                )

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
