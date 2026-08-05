from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi import HTTPException

from openhands.app_server.app_conversation.app_conversation_router import (
    _stream_app_conversation_start,
    send_message_to_conversation,
    start_app_conversation,
    stream_app_conversation_start,
)
from openhands.app_server.nimbus_sso.nimbus_execution_gate import (
    customer_metering_ready,
    nimbus_auth_required,
    require_customer_metering_ready,
)
from openhands.app_server.pending_messages.pending_message_router import (
    queue_pending_message,
)
from openhands.app_server.sandbox.sandbox_router import resume_sandbox, start_sandbox


class TestStopSwitch:
    """Default-open semantics, and the override that closes it.

    The tests below all pin the variable, so without these the default branch —
    the one every real request takes — would be uncovered.
    """

    def test_open_by_default(self, monkeypatch):
        monkeypatch.delenv('NIMBUS_CUSTOMER_METERING_READY', raising=False)
        assert customer_metering_ready() is True

    def test_explicit_false_stops_execution(self, monkeypatch):
        monkeypatch.setenv('NIMBUS_CUSTOMER_METERING_READY', 'false')
        assert customer_metering_ready() is False

    def test_zero_also_stops_execution(self, monkeypatch):
        monkeypatch.setenv('NIMBUS_CUSTOMER_METERING_READY', '0')
        assert customer_metering_ready() is False

    def test_auth_flag_matches_the_auth_gate_variable(self, monkeypatch):
        # One concept, one variable. A second name is how a deployment ends up
        # half-authenticated because only one of the two got set.
        monkeypatch.delenv('NIMBUS_REQUIRE_AUTH', raising=False)
        assert nimbus_auth_required() is True
        monkeypatch.setenv('NIMBUS_REQUIRE_AUTH', '0')
        assert nimbus_auth_required() is False

    def test_gate_is_inert_when_auth_is_off(self, monkeypatch):
        # OSS/local mode: nothing to meter, so a stopped switch must not 503.
        monkeypatch.setenv('NIMBUS_REQUIRE_AUTH', '0')
        monkeypatch.setenv('NIMBUS_CUSTOMER_METERING_READY', 'false')
        require_customer_metering_ready()


def _assert_metering_block(exc_info: pytest.ExceptionInfo[HTTPException]) -> None:
    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == 'nimbus_customer_metering_not_configured'


@pytest.fixture(autouse=True)
def metering_not_ready(monkeypatch):
    monkeypatch.setenv('NIMBUS_REQUIRE_AUTH', '1')
    monkeypatch.setenv('NIMBUS_CUSTOMER_METERING_READY', 'false')


@pytest.mark.asyncio
async def test_standard_start_is_blocked_before_services_run():
    with pytest.raises(HTTPException) as exc_info:
        await start_app_conversation(None, None, None, None, None, None)  # type: ignore[arg-type]
    _assert_metering_block(exc_info)


@pytest.mark.asyncio
async def test_stream_start_and_generator_are_both_blocked():
    with pytest.raises(HTTPException) as exc_info:
        await stream_app_conversation_start(None, None)  # type: ignore[arg-type]
    _assert_metering_block(exc_info)

    stream = _stream_app_conversation_start(None, None)  # type: ignore[arg-type]
    with pytest.raises(HTTPException) as generator_exc:
        await anext(stream)
    _assert_metering_block(generator_exc)


@pytest.mark.asyncio
async def test_followup_send_is_blocked_before_agent_server_post():
    with pytest.raises(HTTPException) as exc_info:
        await send_message_to_conversation(
            uuid4(),
            None,
            None,
            None,
            None,  # type: ignore[arg-type]
        )
    _assert_metering_block(exc_info)


@pytest.mark.asyncio
async def test_sandbox_start_and_resume_are_blocked():
    with pytest.raises(HTTPException) as start_exc:
        await start_sandbox(None, None)  # type: ignore[arg-type]
    _assert_metering_block(start_exc)

    with pytest.raises(HTTPException) as resume_exc:
        await resume_sandbox('sandbox-id', None, None)  # type: ignore[arg-type]
    _assert_metering_block(resume_exc)


@pytest.mark.asyncio
async def test_pending_message_that_would_auto_run_is_blocked():
    with pytest.raises(HTTPException) as exc_info:
        await queue_pending_message('conversation-id', None, None)  # type: ignore[arg-type]
    _assert_metering_block(exc_info)
