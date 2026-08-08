"""Read-path isolation must fail CLOSED, and only where that is safe.

THE BUG, in two services that never referenced each other:

    if user_id: query = query.where(...owner == user_id)

An identity that does not resolve DROPS the predicate, so the query widens
from "yours" to "everything" — silently, on a read path, with the scoping code
visibly present. That last part is why it survives review: there is something
to point at.

THE None THAT MATTERS IS NOT THE ANONYMOUS ONE. Upstream
``DefaultUserAuth.get_user_id`` returns None for EVERY caller by design, and
``_nimbus_user_id`` converts any resolution failure into None as well. Both
arrive on fully authenticated requests, which the auth gate passes by
definition — so "the gate refuses anonymous requests" defends a different door.

AND WHY IT IS CONDITIONAL. Refusing a None unconditionally would delete every
read path on any deployment running ``DefaultUserAuth`` — the same trap as
applying an ownership equality to a service that records no owner. The shape
is copied from ``mcp_router._require_identity``: refuse when identity is absent
AND this deployment authenticates.

The OSS tests below are not padding. They are the half that says the fix is
not an outage.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from openhands.app_server.app_conversation import (
    sql_app_conversation_info_service as conv_mod,
)
from openhands.app_server.sandbox import remote_sandbox_service as remote_mod


class _Ctx:
    """A user context that resolves to whatever the test says, or explodes."""

    def __init__(self, user_id=None, boom=False):
        self._user_id = user_id
        self._boom = boom

    async def get_user_id(self):
        if self._boom:
            raise RuntimeError('identity provider unreachable')
        return self._user_id


class _RemoteSvc:
    """Only `_secure_select` is under test, and it touches only user_context."""

    _secure_select = remote_mod.RemoteSandboxService._secure_select

    def __init__(self, ctx):
        self.user_context = ctx


class _ConvSvc:
    _secure_select = conv_mod.SQLAppConversationInfoService._secure_select
    _nimbus_user_id = conv_mod.SQLAppConversationInfoService._nimbus_user_id

    def __init__(self, ctx):
        self.user_context = ctx


def _where(query) -> str:
    """The WHERE clause ONLY.

    `str(query)` includes the SELECT column list, so `'nimbus_user_id' in
    str(query)` is true whether or not the row is filtered by it — an assertion
    that passes on the bug it exists to catch. Found by these tests failing on
    correct code, which is the cheap direction to find it.
    """
    return str(query.whereclause) if query.whereclause is not None else ''


class TestRemoteSandboxListing:
    """The leak here would hand out `session_api_key`, which is the credential
    `validate_session_key` accepts and the agent proxy routes on."""

    @pytest.mark.asyncio
    async def test_refuses_when_identity_is_absent_and_auth_is_required(
        self, monkeypatch
    ):
        monkeypatch.setattr(remote_mod, 'auth_required', lambda: True)

        with pytest.raises(HTTPException) as excinfo:
            await _RemoteSvc(_Ctx(user_id=None))._secure_select()

        assert excinfo.value.status_code == 401

    @pytest.mark.asyncio
    async def test_an_empty_string_id_counts_as_absent(self, monkeypatch):
        # '' is a real bucket. Every unowned row would share it.
        monkeypatch.setattr(remote_mod, 'auth_required', lambda: True)

        with pytest.raises(HTTPException):
            await _RemoteSvc(_Ctx(user_id=''))._secure_select()

    @pytest.mark.asyncio
    async def test_scopes_to_the_caller_when_identity_resolves(self, monkeypatch):
        monkeypatch.setattr(remote_mod, 'auth_required', lambda: True)

        query = await _RemoteSvc(_Ctx(user_id='cust-1'))._secure_select()

        assert 'created_by_user_id' in _where(query)

    @pytest.mark.asyncio
    async def test_OSS_KEEPS_WORKING_when_auth_is_not_required(self, monkeypatch):
        """`DefaultUserAuth` returns None for every caller by design.

        If this test ever fails, the fix has become an outage for every
        deployment that never opted into Nimbus auth.
        """
        monkeypatch.setattr(remote_mod, 'auth_required', lambda: False)

        query = await _RemoteSvc(_Ctx(user_id=None))._secure_select()

        assert 'created_by_user_id' not in _where(query)


class TestConversationReads:
    @pytest.mark.asyncio
    async def test_refuses_when_identity_is_absent_and_auth_is_required(
        self, monkeypatch
    ):
        monkeypatch.setattr(conv_mod, 'auth_required', lambda: True)

        with pytest.raises(HTTPException) as excinfo:
            await _ConvSvc(_Ctx(user_id=None))._secure_select()

        assert excinfo.value.status_code == 401

    @pytest.mark.asyncio
    async def test_a_swallowed_resolution_failure_no_longer_widens(self, monkeypatch):
        """The exact case the old docstring claimed was handled.

        `_nimbus_user_id` catches everything and returns None. Before the
        refusal, that turned an identity-provider outage into an open query on
        an authenticated deployment.
        """
        monkeypatch.setattr(conv_mod, 'auth_required', lambda: True)

        with pytest.raises(HTTPException):
            await _ConvSvc(_Ctx(boom=True))._secure_select()

    @pytest.mark.asyncio
    async def test_scopes_to_the_caller_when_identity_resolves(self, monkeypatch):
        monkeypatch.setattr(conv_mod, 'auth_required', lambda: True)

        query = await _ConvSvc(_Ctx(user_id='cust-1'))._secure_select()

        assert 'nimbus_user_id' in _where(query)

    @pytest.mark.asyncio
    async def test_the_version_filter_survives_the_change(self, monkeypatch):
        # Scoping must not quietly replace the V1 predicate that was already there.
        monkeypatch.setattr(conv_mod, 'auth_required', lambda: True)

        query = await _ConvSvc(_Ctx(user_id='cust-1'))._secure_select()

        assert 'conversation_version' in _where(query)

    @pytest.mark.asyncio
    async def test_OSS_KEEPS_WORKING_when_auth_is_not_required(self, monkeypatch):
        monkeypatch.setattr(conv_mod, 'auth_required', lambda: False)

        query = await _ConvSvc(_Ctx(user_id=None))._secure_select()

        assert 'nimbus_user_id' not in _where(query)

    @pytest.mark.asyncio
    async def test_a_swallowed_failure_on_OSS_still_does_not_raise(self, monkeypatch):
        """An identity provider that is not even configured must not 500 a
        deployment that never wanted identity."""
        monkeypatch.setattr(conv_mod, 'auth_required', lambda: False)

        query = await _ConvSvc(_Ctx(boom=True))._secure_select()

        assert 'nimbus_user_id' not in _where(query)


class TestTheSwitchIsTheRepoWideOne:
    def test_both_services_read_the_same_switch(self):
        """One answer to "does this deployment authenticate", per
        `nimbus_auth_gate.auth_required`'s own docstring. Two services drifting
        apart on that question is how half a fix ships."""
        from openhands.app_server.nimbus_sso.nimbus_auth_gate import auth_required

        assert remote_mod.auth_required is auth_required
        assert conv_mod.auth_required is auth_required
