"""``POST /mcp/mcp`` must not act for a caller with no verified identity.

── What was wrong ──────────────────────────────────────────────────────────
``/mcp`` is an ASGI **Mount** outside ``/api``. ``nimbus_auth_gate`` demands a
session only under ``/api``; for anything else a non-page-load request falls
straight through to ``call_next``, and ``/mcp`` is not exempt-listed either —
the gate simply never applied. FastMCP is built with no auth provider, and
``get_user_id`` returns ``str | None`` WITHOUT raising. So an unauthenticated
request off the public internet reached the tools with ``user_id=None`` and
EXECUTED, resolving to the legacy shared ``secrets.json`` at the file-store root
and acting with whatever provider tokens were in it.

Confirmed against a real ASGI server, because it cannot be confirmed any other
way: ``TestClient`` never runs the app lifespan, so FastMCP's
``StreamableHTTPSessionManager`` is not started and every request to /mcp/mcp
dies with "task group was not initialized" — a 500 that says nothing about auth.
That is why this file tests the two halves directly instead of over HTTP.

── The two halves ──────────────────────────────────────────────────────────
Requiring a credential is useless on its own: ``get_mcp_api_key`` returned None,
so the LEGITIMATE sandbox also called /mcp/mcp anonymously. Deny-first would
have broken ``create_pr`` for real users while looking like a fix. So:

  1. ``NimbusUserAuth.get_mcp_api_key`` mints a signed, purpose-scoped token,
     which ``_add_system_mcp_servers`` already puts in ``X-Session-API-Key``.
  2. ``NimbusUserAuth.get_instance`` accepts that token — on the ``/mcp`` path
     ONLY — and the tools refuse when identity is still absent.

The purpose claim is the part most likely to be got wrong, so it is tested in
both directions: the two token types share one secret and one wire format, and
if they were interchangeable the "fix" would hand anyone who lifted an MCP token
out of a sandbox a full browser session.
"""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest
from fastmcp.exceptions import ToolError

from openhands.app_server.nimbus_sso.nimbus_session import (
    COOKIE_SESSION,
    issue_mcp_token,
    issue_session,
    mcp_token_user_id,
    read_session,
    session_user_id,
)

SECRET = {'NIMBUS_SSO_SHARED_SECRET': 'test-secret-not-a-real-one'}
USER = 'cus_test_customer_1'


class _FakeURL:
    def __init__(self, path: str) -> None:
        self.path = path


class _FakeRequest:
    """Only what get_instance touches: cookies, headers, url.path."""

    def __init__(
        self,
        *,
        path: str = '/mcp/mcp',
        cookies: dict | None = None,
        headers: dict | None = None,
    ) -> None:
        self.url = _FakeURL(path)
        self.cookies = cookies or {}
        self.headers = headers or {}
        self.state = type('S', (), {})()


# ── The purpose separation ──────────────────────────────────────────────────


class TestTokenPurposesAreNotInterchangeable:
    def test_mcp_token_is_not_accepted_as_a_session(self):
        """The escalation this claim exists to prevent.

        Both tokens are HMAC'd with the same secret and have identical shape. If
        purpose were merely descriptive, a token scraped out of a sandbox would
        be a valid ``nimbus_session`` cookie — a privilege escalation introduced
        BY the fix.
        """
        with patch.dict(os.environ, SECRET):
            mcp = issue_mcp_token(USER)
            assert mcp is not None
            assert read_session(mcp) is None
            assert session_user_id(mcp) is None

    def test_session_cookie_is_not_accepted_as_an_mcp_token(self):
        """And the other direction, so neither is a superset of the other."""
        with patch.dict(os.environ, SECRET):
            session = issue_session(USER, 'a@b.c')
            assert session is not None
            assert mcp_token_user_id(session) is None

    def test_each_token_verifies_for_its_own_purpose(self):
        with patch.dict(os.environ, SECRET):
            assert session_user_id(issue_session(USER)) == USER
            assert mcp_token_user_id(issue_mcp_token(USER)) == USER

    def test_legacy_session_without_a_purpose_claim_still_verifies(self):
        """Cookies minted before ``purpose`` existed must not log everyone out.

        A missing claim reads as ``session`` — the only defaulting allowed, and
        the reason the MCP purpose has to be explicit rather than inferred.
        """
        import hashlib
        import hmac
        import json
        import time

        from openhands.app_server.nimbus_sso.nimbus_session import _b64e

        with patch.dict(os.environ, SECRET):
            payload = json.dumps(
                {'sub': USER, 'email': '', 'exp': int(time.time()) + 600},
                separators=(',', ':'),
                sort_keys=True,
            ).encode('utf-8')
            body = _b64e(payload)
            sig = _b64e(
                hmac.new(
                    SECRET['NIMBUS_SSO_SHARED_SECRET'].encode(),
                    body.encode('ascii'),
                    hashlib.sha256,
                ).digest()
            )
            legacy = f'{body}.{sig}'

            assert session_user_id(legacy) == USER
            # ...but it is still not an MCP token.
            assert mcp_token_user_id(legacy) is None

    def test_a_forged_token_is_refused(self):
        with patch.dict(os.environ, SECRET):
            good = issue_mcp_token(USER)
            assert good is not None
            body, _, _sig = good.partition('.')
            assert mcp_token_user_id(f'{body}.deadbeef') is None

    def test_no_secret_means_no_token_rather_than_an_unsigned_one(self):
        with patch.dict(os.environ, {'NIMBUS_SSO_SHARED_SECRET': ''}):
            assert issue_mcp_token(USER) is None
            assert mcp_token_user_id('anything') is None


# ── Half 1: the sandbox gets a credential to send ───────────────────────────


class TestSandboxGetsACredential:
    @pytest.mark.asyncio
    async def test_signed_in_user_gets_an_mcp_token(self):
        """This returned None, which is what made the endpoint identity-less.

        ``_add_system_mcp_servers`` only sets ``X-Session-API-Key`` ``if
        mcp_api_key``, so None meant the header was omitted and the real agent
        was indistinguishable from an anonymous caller.
        """
        from openhands.app_server.user_auth.nimbus_user_auth import NimbusUserAuth

        with patch.dict(os.environ, SECRET):
            auth = NimbusUserAuth(_user_id=USER)
            key = await auth.get_mcp_api_key()
            assert key is not None
            assert mcp_token_user_id(key) == USER

    @pytest.mark.asyncio
    async def test_anonymous_auth_mints_nothing(self):
        from openhands.app_server.user_auth.nimbus_user_auth import NimbusUserAuth

        with patch.dict(os.environ, SECRET):
            assert await NimbusUserAuth().get_mcp_api_key() is None


# ── Half 2: the token is accepted on /mcp, and nowhere else ─────────────────


class TestMcpTokenIsScopedToTheMcpPath:
    @pytest.mark.asyncio
    async def test_token_resolves_identity_on_the_mcp_path(self):
        from openhands.app_server.user_auth.nimbus_user_auth import NimbusUserAuth

        with patch.dict(os.environ, SECRET):
            token = issue_mcp_token(USER)
            auth = await NimbusUserAuth.get_instance(
                _FakeRequest(path='/mcp/mcp', headers={'X-Session-API-Key': token})
            )
            assert await auth.get_user_id() == USER

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        'path', ['/api/v1/settings', '/bridge/call', '/preview/x/ports', '/sockets/x']
    )
    async def test_token_is_useless_off_the_mcp_path(self, path: str):
        """Least authority: it works where the sandbox needs it and nowhere else.

        Without the path scope, a token minted for MCP would stand in for a
        session cookie across the whole app.
        """
        from openhands.app_server.user_auth.nimbus_user_auth import NimbusUserAuth

        with patch.dict(os.environ, SECRET):
            token = issue_mcp_token(USER)
            auth = await NimbusUserAuth.get_instance(
                _FakeRequest(path=path, headers={'X-Session-API-Key': token})
            )
            assert await auth.get_user_id() is None

    @pytest.mark.asyncio
    async def test_session_cookie_still_wins_when_present(self):
        from openhands.app_server.user_auth.nimbus_user_auth import NimbusUserAuth

        with patch.dict(os.environ, SECRET):
            auth = await NimbusUserAuth.get_instance(
                _FakeRequest(
                    path='/mcp/mcp',
                    cookies={COOKIE_SESSION: issue_session(USER, 'a@b.c')},
                )
            )
            assert await auth.get_user_id() == USER

    @pytest.mark.asyncio
    async def test_a_session_cookie_value_in_the_mcp_header_is_refused(self):
        """Purpose confusion at the boundary that actually consumes the header."""
        from openhands.app_server.user_auth.nimbus_user_auth import NimbusUserAuth

        with patch.dict(os.environ, SECRET):
            auth = await NimbusUserAuth.get_instance(
                _FakeRequest(
                    path='/mcp/mcp',
                    headers={'X-Session-API-Key': issue_session(USER)},
                )
            )
            assert await auth.get_user_id() is None


# ── The refusal itself ──────────────────────────────────────────────────────


class TestToolsRefuseAnonymousCallers:
    @pytest.mark.asyncio
    async def test_anonymous_call_raises_rather_than_acting(self):
        from openhands.app_server.mcp.mcp_router import _require_identity

        async def _none(_request):
            return None

        with patch.dict(os.environ, {'NIMBUS_REQUIRE_AUTH': '1'}):
            with patch('openhands.app_server.mcp.mcp_router.get_user_id', new=_none):
                with pytest.raises(ToolError, match='Authentication required'):
                    await _require_identity(_FakeRequest())

    @pytest.mark.asyncio
    async def test_identified_call_is_allowed_through(self):
        from openhands.app_server.mcp.mcp_router import _require_identity

        async def _user(_request):
            return USER

        with patch.dict(os.environ, {'NIMBUS_REQUIRE_AUTH': '1'}):
            with patch('openhands.app_server.mcp.mcp_router.get_user_id', new=_user):
                assert await _require_identity(_FakeRequest()) == USER

    @pytest.mark.asyncio
    async def test_upstream_oss_deployments_keep_working(self):
        """``NIMBUS_REQUIRE_AUTH=0`` must not take create_pr away.

        ``DefaultUserAuth.get_user_id`` returns None for EVERY caller by design
        ("does not support multi tenancy"). Refusing on None unconditionally
        would disable these tools for any deployment that has not opted into
        Nimbus auth, which is a regression dressed as a hardening.
        """
        from openhands.app_server.mcp.mcp_router import _require_identity

        async def _none(_request):
            return None

        with patch.dict(os.environ, {'NIMBUS_REQUIRE_AUTH': '0'}):
            with patch('openhands.app_server.mcp.mcp_router.get_user_id', new=_none):
                assert await _require_identity(_FakeRequest()) is None
