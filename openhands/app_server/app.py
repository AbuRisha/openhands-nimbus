import contextlib
import os
import warnings

from fastapi.routing import Mount

with warnings.catch_warnings():
    warnings.simplefilter('ignore')

from fastapi import (
    FastAPI,
    Request,
)
from fastapi.responses import JSONResponse

from openhands.app_server import v1_router
from openhands.app_server.config import get_app_lifespan_service
from openhands.app_server.integrations.service_types import AuthenticationError
from openhands.app_server.mcp.mcp_router import init_tavily_proxy, mcp_server
from openhands.app_server.middleware import (
    CacheControlMiddleware,
    InMemoryRateLimiter,
    LocalhostCORSMiddleware,
    RateLimitMiddleware,
)
from openhands.app_server.nimbus_sso.nimbus_sso_router import (
    router as nimbus_sso_router,
)
from openhands.app_server.nimbus_github_oauth.github_oauth_router import (
    router as github_oauth_router,
)
from openhands.app_server.sandbox.agent_proxy_router import agent_proxy_router
from openhands.app_server.nimbus_sso.nimbus_auth_gate import (
    NimbusAuthGateMiddleware,
)
from openhands.app_server.static import SPAStaticFiles
from openhands.app_server.status.status_router import router as health_router
from openhands.app_server.version import get_version

# Initialize the Tavily MCP proxy before creating the app
init_tavily_proxy()

mcp_app = mcp_server.http_app(path='/mcp', stateless_http=True)


def combine_lifespans(*lifespans):
    # Create a combined lifespan to manage multiple session managers
    @contextlib.asynccontextmanager
    async def combined_lifespan(app):
        async with contextlib.AsyncExitStack() as stack:
            for lifespan in lifespans:
                await stack.enter_async_context(lifespan(app))
            yield

    return combined_lifespan


lifespans = [mcp_app.lifespan]
app_lifespan_ = get_app_lifespan_service()
if app_lifespan_:
    lifespans.append(app_lifespan_.lifespan)


app = FastAPI(
    title='OpenHands',
    description='OpenHands: Code Less, Make More',
    version=get_version(),
    lifespan=combine_lifespans(*lifespans),
    routes=[Mount(path='/mcp', app=mcp_app)],
)


@app.exception_handler(AuthenticationError)
async def authentication_error_handler(request: Request, exc: AuthenticationError):
    return JSONResponse(
        status_code=401,
        content=str(exc),
    )


app.include_router(v1_router.router)
app.include_router(health_router)
# Nimbus SSO handoff (nimbusapi.net dashboard -> chat.nimbusapi.net).
# Registered before the SPA static mount at "/" so the route wins over
# the catch-all frontend.
app.include_router(nimbus_sso_router)

# Reverse proxy to the in-container agent server. Registered here for the SAME
# reason as nimbus_sso_router above: Starlette matches in registration order and
# the SPA mount at "/" below is a catch-all. Before this router existed, every
# agent path (/api/conversations/*, /api/git/*, /api/vscode/*, /api/file/*,
# /sockets/events/*) fell through to the frontend and returned index.html with a
# 200 — a "successful" response containing HTML where the client expected JSON.
# See agent_proxy_router.py for why the browser could not reach the agent at all.
app.include_router(agent_proxy_router)

# GitHub OAuth. Registered before the SPA catch-all for the same reason as the
# two routers above: Starlette matches in registration order, so a route added
# after the "/" mount would return index.html with a 200 instead of running.
#
# This half did not exist. _get_configured_providers() lights up a "Connect
# GitHub" button from GITHUB_APP_CLIENT_ID alone, but upstream implements the
# flow in its enterprise layer behind AUTH_URL/Keycloak, which is not part of
# this deployment. Setting the client id without this router would have shipped
# a button that goes nowhere.
app.include_router(github_oauth_router)

# Middleware and static file setup (merged from listen.py)
if os.getenv('SERVE_FRONTEND', 'true').lower() == 'true':
    if os.path.isdir('./frontend/build'):
        app.mount(
            '/', SPAStaticFiles(directory='./frontend/build', html=True), name='dist'
        )

# Default-deny on /api. Added last so it runs FIRST — Starlette applies
# middleware in reverse registration order, and an auth gate that runs after
# anything else is an auth gate that something else already answered past.
app.add_middleware(NimbusAuthGateMiddleware)
app.add_middleware(LocalhostCORSMiddleware)
app.add_middleware(CacheControlMiddleware)
app.add_middleware(
    RateLimitMiddleware,
    rate_limiter=InMemoryRateLimiter(requests=10, seconds=1),
)
