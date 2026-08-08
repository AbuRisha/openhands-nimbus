"""``POST /api/v1/app-conversations/{id}/fork`` — fork a conversation.

A SEPARATE router rather than another route in ``app_conversation_router``,
deliberately: that file is 1100+ lines and several sessions edit it, and a new
endpoint does not need to be in the middle of it. It mounts under the same prefix,
so the URL is unchanged from a client's point of view.

WHAT A FORK ACTUALLY REQUIRES
-----------------------------
Two stores, both mandatory (see docs/fork-conversation-design.md):

  - the agent's memory  -> the sandbox's persistence dir, moved by the transport
  - the transcript      -> the app-server event mirror, via copy_events_until

The transcript alone is the amnesiac fork the whole feature exists to prevent.
``fork_conversation`` composes them in the order that fails safely.

WHY THIS IS SYNCHRONOUS, unlike POST ''
---------------------------------------
Starting a conversation is a background task because it can start a sandbox.
Forking has to wait for that anyway — the target's sandbox must be RUNNING before
its filesystem can be written, and ``validate_session_key`` refuses non-RUNNING
sandboxes. So this endpoint iterates the start task to a terminal status and then
does the transfer. It is slow by nature; that is a property of the operation, not
of the wiring.

The alternative — return early and transfer in the background — would mean a fork
that is briefly a complete-looking conversation with no agent memory, which is the
exact failure mode being designed out. Better to make the client wait than to hand
it something that looks finished and is not.
"""

from __future__ import annotations

import logging
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from openhands.app_server.app_conversation.app_conversation_models import (
    AppConversationStartRequest,
    AppConversationStartTaskStatus,
)
from openhands.app_server.app_conversation.app_conversation_service import (
    AppConversationService,
)
from openhands.app_server.app_conversation.fork_conversation import (
    ForkError,
    fork_conversation,
)
from openhands.app_server.app_conversation.fork_state_transport import (
    ForkTransportError,
    SandboxEndpoint,
    resolve_conversations_path,
)
from openhands.app_server.config import (
    depends_app_conversation_info_service,
    depends_app_conversation_service,
    depends_event_service,
    depends_httpx_client,
    depends_sandbox_service,
)
from openhands.app_server.event.event_service import EventService
from openhands.app_server.sandbox.agent_proxy_router import _agent_base_url
from openhands.app_server.sandbox.sandbox_models import SandboxInfo, SandboxStatus
from openhands.app_server.sandbox.sandbox_service import SandboxService

_logger = logging.getLogger(__name__)

fork_router = APIRouter(prefix='/app-conversations', tags=['Conversations'])

_app_conversation_service_dep = depends_app_conversation_service()
_app_conversation_info_service_dep = depends_app_conversation_info_service()
_sandbox_service_dep = depends_sandbox_service()
_event_service_dep = depends_event_service()
_httpx_client_dep = depends_httpx_client()


class ForkConversationRequest(BaseModel):
    up_to_event_id: str | None = Field(
        default=None,
        description=(
            'Last event to KEEP. Inclusive: a user forks *from* a message they '
            'can see, so the event they pointed at is included. An id that does '
            'not appear copies the whole history rather than nothing, matching '
            'EventService.copy_events_until.'
        ),
    )
    title: str | None = Field(default=None)


class ForkConversationResponse(BaseModel):
    conversation_id: UUID
    sandbox_id: str | None = None
    events_in_agent_state: int
    events_in_transcript: int
    halves_agree: bool = Field(
        description=(
            'False means the agent state and the transcript were cut at '
            'different points. Should be impossible; surfaced rather than hidden.'
        )
    )


def _endpoint_for(sandbox: SandboxInfo) -> SandboxEndpoint:
    if not sandbox.session_api_key:
        # None when the sandbox is STARTING/PAUSED or the caller lacks full
        # access, per SandboxInfo's own field description.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f'sandbox {sandbox.id} exposes no session key; it may not be running',
        )
    return SandboxEndpoint(
        base_url=_agent_base_url(sandbox), session_api_key=sandbox.session_api_key
    )


async def _running_sandbox(
    sandbox_service: SandboxService, sandbox_id: str | None, which: str
) -> SandboxInfo:
    if not sandbox_id:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail=f'{which} conversation has no sandbox'
        )
    sandbox = await sandbox_service.get_sandbox(sandbox_id)
    if sandbox is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail=f'{which} sandbox {sandbox_id} not found'
        )
    if sandbox.status != SandboxStatus.RUNNING:
        # Stated as a product constraint, not an internal error: the parent has to
        # be started before it can be forked, because its persistence directory
        # cannot be read cold.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=(
                f'{which} sandbox is {sandbox.status.value}, not RUNNING. '
                'Start the conversation before forking it.'
            ),
        )
    return sandbox


async def fork_app_conversation(
    conversation_id: UUID,
    fork_request: ForkConversationRequest,
    *,
    app_conversation_service: AppConversationService,
    app_conversation_info_service,
    sandbox_service: SandboxService,
    event_service: EventService,
    httpx_client: httpx.AsyncClient,
) -> ForkConversationResponse:
    """The fork itself, taken as plain arguments so it is testable without FastAPI."""
    source_info = await app_conversation_info_service.get_app_conversation_info(
        conversation_id
    )
    if source_info is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail=f'No such conversation {conversation_id}'
        )

    source_sandbox = await _running_sandbox(
        sandbox_service, getattr(source_info, 'sandbox_id', None), 'source'
    )
    source_endpoint = _endpoint_for(source_sandbox)

    # Start the fork. parent_conversation_id records the lineage, which is why the
    # field already exists on the request model.
    start_request = AppConversationStartRequest(
        parent_conversation_id=conversation_id,
        title=fork_request.title,
    )
    task = None
    async for update in app_conversation_service.start_app_conversation(start_request):
        task = update
        if update.status in (
            AppConversationStartTaskStatus.READY,
            AppConversationStartTaskStatus.ERROR,
        ):
            break

    if task is None or task.status != AppConversationStartTaskStatus.READY:
        detail = (task.detail if task else None) or 'conversation did not start'
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, detail=f'fork target not started: {detail}'
        )
    if task.app_conversation_id is None:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            detail='fork target reported READY without a conversation id',
        )

    target_sandbox = await _running_sandbox(sandbox_service, task.sandbox_id, 'target')
    target_endpoint = _endpoint_for(target_sandbox)

    # Ask the SOURCE where its conversations directory is. Not hardcoded: the
    # config default is relative, and /file/archive needs it absolute.
    conversations_path = await resolve_conversations_path(httpx_client, source_endpoint)

    try:
        result = await fork_conversation(
            event_service=event_service,
            httpx_client=httpx_client,
            source_sandbox=source_endpoint,
            target_sandbox=target_endpoint,
            conversations_path=conversations_path,
            source_conversation_id=conversation_id,
            target_conversation_id=task.app_conversation_id,
            up_to_event_id=fork_request.up_to_event_id,
        )
    except (ForkError, ForkTransportError) as e:
        # The target exists but is not a usable fork. 502 rather than 500: the
        # failure is in the sandbox round trip, and the message names the
        # conversation so it can be inspected or cleaned up.
        _logger.warning('fork of %s failed: %s', conversation_id, e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(e)) from e

    return ForkConversationResponse(
        conversation_id=task.app_conversation_id,
        sandbox_id=task.sandbox_id,
        events_in_agent_state=result.events_in_agent_state,
        events_in_transcript=result.events_in_transcript,
        halves_agree=result.halves_agree,
    )


# ── The route ───────────────────────────────────────────────────────────────
# Thin on purpose: it resolves dependencies and delegates to
# fork_app_conversation above, which takes plain arguments so the fork logic is
# testable without standing up FastAPI.
@fork_router.post(
    '/{conversation_id}/fork',
    responses={
        404: {'description': 'Conversation or sandbox not found'},
        409: {'description': 'A sandbox is not RUNNING, so it cannot be forked'},
        502: {'description': 'The fork target started but could not be populated'},
    },
)
async def fork_app_conversation_route(
    conversation_id: UUID,
    fork_request: ForkConversationRequest,
    app_conversation_service: AppConversationService = _app_conversation_service_dep,
    app_conversation_info_service=_app_conversation_info_service_dep,
    sandbox_service: SandboxService = _sandbox_service_dep,
    event_service: EventService = _event_service_dep,
    httpx_client: httpx.AsyncClient = _httpx_client_dep,
) -> ForkConversationResponse:
    """Fork a conversation, agent memory included."""
    return await fork_app_conversation(
        conversation_id,
        fork_request,
        app_conversation_service=app_conversation_service,
        app_conversation_info_service=app_conversation_info_service,
        sandbox_service=sandbox_service,
        event_service=event_service,
        httpx_client=httpx_client,
    )
