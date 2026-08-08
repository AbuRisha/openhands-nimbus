"""Every route outside ``/api`` must be classified, deliberately.

── Why this file exists ────────────────────────────────────────────────────
``nimbus_auth_gate`` demands a session only for paths under ``/api``:

    if not path.startswith('/api'):
        ...
        return await call_next(request)

For a non-page-load request that is a straight pass-through. The consequence is
not that the gate is wrong — ``/preview`` and ``/sockets`` genuinely must
authenticate themselves, because they carry an ``X-Session-API-Key`` rather than
a cookie — it is that a router mounted outside ``/api`` is unprotected BY
DEFAULT, and nothing anywhere says so out loud.

That default is what shipped ``POST /bridge/call`` and
``GET /bridge/devices/{user_id}`` with no credential at all: both took the user's
identity from caller-supplied input, and between them they allowed an
unauthenticated request to drive somebody else's signed-in Chrome. The module
docstring even claimed the call endpoint was "session authenticated". Nobody was
lying; the gate simply never applied and no test looked at the route surface.

── What this test does about it ────────────────────────────────────────────
It enumerates the app's real routes and requires each non-``/api`` one to appear
in ``CLASSIFIED`` below, with a reason. Adding a router outside ``/api`` now
fails here until somebody writes down which of the four cases it is:

    SELF_AUTH       — authenticates itself (session key, token, cookie)
    PUBLIC          — deliberately reachable by anyone, with the reason stated
    STATIC          — asset/SPA serving, no user data
    UNAUTHENTICATED — reachable by anyone and it should NOT be. A recorded
                      finding, not a decision. Only legitimate with evidence
                      attached and a reason it is not being fixed here.

This cannot verify that a handler's auth is CORRECT — nothing static can. What
it prevents is the failure that actually happened: a new unauthenticated route
appearing without anyone making a decision about it.
"""

from __future__ import annotations

import pytest

SELF_AUTH = 'self-authenticating'
PUBLIC = 'deliberately public'
STATIC = 'static/SPA'
UNAUTHENTICATED = 'unauthenticated — recorded finding, not a decision'

# path -> (classification, why)
CLASSIFIED: dict[str, tuple[str, str]] = {
    '/bridge/pair': (
        PUBLIC,
        'The pairing CODE is the credential: 8 chars from a 32-symbol alphabet, '
        '120s, single-use, dies after 5 attempts, and only ever shown inside an '
        'authenticated session. The user id comes from the redeemed request, '
        'never from the body. An extension cannot carry the app session.',
    ),
    '/bridge/pair/code': (
        SELF_AUTH,
        'Session cookie. Mints the code that /bridge/pair then redeems, for the '
        'cookie user — which is what makes the public redeem endpoint safe.',
    ),
    '/bridge/device': (
        SELF_AUTH,
        'WS. Device token in the first application message, not the URL, so it '
        'stays out of proxy logs.',
    ),
    '/bridge/call': (
        SELF_AUTH,
        'X-Session-API-Key resolved to a RUNNING sandbox; the user is derived '
        'from the sandbox, not supplied by the caller.',
    ),
    '/bridge/devices': (
        SELF_AUTH,
        'Session cookie. No path parameter, so there is nothing to enumerate.',
    ),
    '/health': (PUBLIC, 'Liveness probe. No user data.'),
    '/alive': (PUBLIC, 'Liveness probe. No user data.'),
    '/ready': (PUBLIC, 'Readiness probe. Returns the string OK.'),
    # ── Upstream OpenHands routes, classified rather than changed ───────────
    # These predate the fork. They are recorded so the list describes the real
    # surface; where the note says "not verified", it means exactly that.
    '/server_info': (
        PUBLIC,
        'Upstream. Returns CPU count and memory usage — infrastructure '
        'fingerprinting, not user data. Worth a look at whether it should be '
        'behind the gate, but it is not an account-scoped leak.',
    ),
    '/mcp': (
        SELF_AUTH,
        'X-Session-API-Key carrying a signed, purpose-scoped MCP token; the user '
        'is derived from the token, never from caller input. FIXED 2026-08-07 — '
        'the history below is kept because the shape of the hole is the reason '
        'this file exists, and because the ORDER of the fix is the load-bearing '
        'part. See tests/app_server/test_mcp_auth.py for the enforcement tests. '
        'Upstream, and an ASGI Mount rather than a route — the real endpoint is '
        'POST /mcp/mcp. Tools resolve identity from the REQUEST '
        '(get_provider_tokens/get_access_token/get_user_id), never from caller '
        'input, which is the property this file guards. '
        'WHAT WAS WRONG, answered 2026-08-07: an anonymous caller was NOT '
        'refused. Run the app under uvicorn so the FastMCP lifespan actually '
        'starts, then POST /mcp/mcp with no cookie and no X-Access-Token — '
        'tools/list returned 200 and the full five-tool inventory without even an '
        'initialize, and tools/call returned 200 having EXECUTED the tool body '
        'with user_id=None. Nothing rejected it: /mcp is outside /api so '
        'nimbus_auth_gate falls through to call_next, it is not in '
        '_EXEMPT_PREFIXES either, FastMCP is constructed with no auth provider, '
        'and get_user_id returns `str | None` without raising. '
        'What an anonymous call can DO is the part that matters, and it is not '
        'nothing. user_id=None sends get_provider_tokens to '
        'user_scoped_path(None, "secrets.json") — the LEGACY SHARED secrets file '
        'at the file-store root, not a per-customer one. With a github provider '
        'token seeded there, the anonymous create_pr picks it up and reaches '
        'GitHub with it: the error moves from "Illegal header value b\'Bearer \'" '
        '(empty token, httpx refusing to build the request locally, so it never '
        'left the process) to "Invalid github token", which http_client.py '
        'raises ONLY from a real HTTP 401. What bounds this is therefore '
        'whatever happens to sit in the shared secrets.json — not the absence of '
        'a code path. Identical under NimbusServerConfig and under the default '
        'OSS config, where FileSecretsStore.get_instance ignores its user_id '
        'argument outright. '
        'ON THE LIVE DEPLOYMENT (checked 2026-08-07) that shared file does not '
        'exist, and it is the only reason this is not currently exploitable. '
        'chat.nimbusapi.net answers an unauthenticated tools/list with 200 and '
        'the full inventory — ACA ingress is external with ipSecurityRestrictions '
        'null, and nothing in containers/ filters by path, so the endpoint is '
        'straightforwardly on the public internet. An anonymous create_pr there '
        'returns the empty-token "Illegal header value" failure, i.e. it executes '
        'and cannot act. The AzureFile share behind OH_PERSISTENCE_DIR '
        '(/data/openhands) has settings.json at its root but NO secrets.json; the '
        'one real github token in the deployment sits at '
        'users/<customer>/secrets.json, which an anonymous caller never resolves '
        'to. So per-customer isolation is what is holding this shut, and the '
        'share is a persistent AzureFile volume — anything that ever writes '
        'provider tokens to the root path turns a reachable-but-inert endpoint '
        'into a live one, with no code change and no deploy. Treat the absent '
        'file as the control it accidentally is, not as safety. '
        'Upstream DOES authenticate this endpoint, which is what the fix follows: '
        'enterprise/server/middleware.py returns True for path.startswith("/mcp") '
        'in its should-authenticate predicate, and SaasUserAuth.get_mcp_api_key '
        'mints the key the sandbox presents as X-Session-API-Key. That middleware '
        'lives in enterprise/ and is not part of this deployment, and '
        'NimbusUserAuth.get_mcp_api_key returned None — so the LEGITIMATE sandbox '
        'also called /mcp/mcp with no credential and also resolved to '
        'user_id=None. That is why the gap was invisible in normal use, and it '
        'dictates the order: DENY-FIRST WOULD HAVE BROKEN create_pr FOR REAL '
        'USERS while looking like a fix. '
        'THE FIX, in the only order that works. (1) '
        'NimbusUserAuth.get_mcp_api_key now mints a signed token via '
        'nimbus_session.issue_mcp_token, which _add_system_mcp_servers already '
        'puts into X-Session-API-Key — so the legitimate caller has something to '
        'send BEFORE anything is required. (2) NimbusUserAuth.get_instance '
        'accepts that token, on the /mcp path ONLY, so a token minted for MCP '
        'cannot stand in for a session on /api or /bridge. (3) mcp_router.'
        '_require_identity refuses when identity is still absent, checked BEFORE '
        'any secrets store is read so a refused call never even loads a token it '
        'may not use. '
        'Two things the fix had to get right. The token carries a `purpose` claim '
        'and read_session/mcp_token_user_id each accept only their own — without '
        'it the two are byte-identical in shape and an MCP token lifted from a '
        'sandbox would be a valid nimbus_session cookie, an escalation created BY '
        'the fix. And the refusal is tied to NIMBUS_REQUIRE_AUTH, because '
        'upstream DefaultUserAuth returns user_id=None for EVERY caller by '
        'design; refusing unconditionally would delete create_pr for any '
        'deployment that never opted into Nimbus auth. '
        'Verified on a real ASGI server, all four states: anonymous refused, '
        'valid MCP token accepted AND resolving to that customer own '
        'users/<id>/secrets.json rather than the shared root file, a session '
        'cookie value in the MCP header refused, and NIMBUS_REQUIRE_AUTH=0 still '
        'behaving as upstream. The isolation bug went with it: create_pr now uses '
        'the signed-in customer provider tokens instead of the legacy shared '
        'ones.',
    ),
    '/openapi.json': (
        PUBLIC,
        'Upstream FastAPI. Publishes the full API schema. Standard for this '
        'framework and it exposes shape, not data.',
    ),
    '/docs': (PUBLIC, 'Upstream FastAPI Swagger UI over /openapi.json.'),
    '/docs/oauth2-redirect': (PUBLIC, 'Upstream FastAPI Swagger OAuth callback.'),
    '/redoc': (PUBLIC, 'Upstream FastAPI ReDoc over /openapi.json.'),
}

# Prefixes whose sub-paths are covered by one classification, because the router
# authenticates uniformly across them.
CLASSIFIED_PREFIXES: dict[str, tuple[str, str]] = {
    '/preview': (
        SELF_AUTH,
        'validate_session_key on the ports endpoint, which sets a path-scoped '
        'httponly cookie the iframe then carries.',
    ),
    '/sockets': (
        SELF_AUTH,
        'X-Session-API-Key, and exempt-listed in the gate on purpose.',
    ),
}


def _app_routes() -> list[str]:
    from openhands.app_server.app import app

    return [
        route.path
        for route in app.routes
        if getattr(route, 'path', None) and not route.path.startswith('/api')
    ]


def _classification(path: str) -> tuple[str, str] | None:
    if path in CLASSIFIED:
        return CLASSIFIED[path]
    for prefix, entry in CLASSIFIED_PREFIXES.items():
        if path.startswith(prefix):
            return entry
    return None


class TestNonApiRoutesAreClassified:
    def test_every_non_api_route_has_a_stated_reason(self):
        """A new route outside /api fails here until it is classified."""
        unclassified = [
            path
            for path in _app_routes()
            # Starlette's own mounts and the SPA catch-all serve files, not user
            # data, and they are not what this guards.
            if not path.startswith(('/assets', '/static', '/{'))
            and path not in ('/', '/{path:path}')
            and _classification(path) is None
        ]

        assert not unclassified, (
            'These routes are outside /api, which means nimbus_auth_gate does '
            'NOT require a session for them, and nobody has said why that is '
            f'acceptable: {sorted(unclassified)}. Add them to CLASSIFIED with a '
            'reason, or move them under /api.'
        )

    def test_no_route_takes_a_user_id_in_its_path(self):
        """The exact shape of the /bridge/devices/{user_id} leak.

        A user id in the path of an unauthenticated route is an enumeration
        oracle even when the body is harmless: it distinguishes a real account
        from an invented one. Identity belongs to the credential.
        """
        offenders = [
            path for path in _app_routes() if '{user_id}' in path or '{userId}' in path
        ]

        assert not offenders, (
            f'Routes outside /api addressing a user by path: {sorted(offenders)}. '
            'Derive the user from the session or session key instead.'
        )


@pytest.mark.parametrize('path', sorted(CLASSIFIED))
def test_classified_routes_still_exist(path: str):
    """Keeps the list honest in the other direction.

    A stale entry is worse than no entry: it reads as a considered decision
    about a route that no longer exists, and it would silently cover a future
    route that happens to reuse the path.
    """
    assert path in _app_routes(), (
        f'{path} is classified here but is not mounted. Remove the entry.'
    )
