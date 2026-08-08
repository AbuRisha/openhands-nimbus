"""REST API router for pending messages."""

import logging

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import TypeAdapter, ValidationError

from openhands.agent_server.models import ImageContent, TextContent
from openhands.app_server.config import depends_pending_message_service
from openhands.app_server.nimbus_sso.nimbus_execution_gate import (
    require_customer_metering_ready,
)
from openhands.app_server.pending_messages.pending_message_models import (
    PendingMessage,
    PendingMessageResponse,
)
from openhands.app_server.pending_messages.pending_message_service import (
    PendingMessageService,
)
from openhands.app_server.utils.dependencies import get_dependencies

logger = logging.getLogger(__name__)

# Type adapter for validating content from request
_content_type_adapter = TypeAdapter(list[TextContent | ImageContent])

# Create router with authentication dependencies
router = APIRouter(
    prefix='/conversations/{conversation_id}/pending-messages',
    tags=['Pending Messages'],
    dependencies=get_dependencies(),
)

# Create dependency at module level
pending_message_service_dependency = depends_pending_message_service()


@router.post(
    '', response_model=PendingMessageResponse, status_code=status.HTTP_201_CREATED
)
async def queue_pending_message(
    conversation_id: str,
    request: Request,
    pending_service: PendingMessageService = pending_message_service_dependency,
) -> PendingMessageResponse:
    """Queue a message for delivery when conversation becomes ready.

    This endpoint allows users to submit messages even when the conversation's
    WebSocket connection is not yet established. Messages are stored server-side
    and delivered automatically when the conversation transitions to READY status.

    Args:
        conversation_id: The conversation ID (can be task ID before conversation is ready)
        request: The FastAPI request containing message content

    Returns:
        PendingMessageResponse with the message ID and queue position

    Raises:
        HTTPException 400: If the request body is invalid
        HTTPException 429: If too many pending messages are queued (limit: 10)
    """
    require_customer_metering_ready()

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='Invalid request body',
        )

    raw_content = body.get('content')
    role = body.get('role', 'user')

    if not raw_content or not isinstance(raw_content, list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='content must be a non-empty list',
        )

    # Validate and parse content into typed objects
    try:
        content = _content_type_adapter.validate_python(raw_content)
    except ValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Invalid content format: {e}',
        ) from e

    # Rate limit: max 10 pending messages per conversation
    pending_count = await pending_service.count_pending_messages(conversation_id)
    if pending_count >= 10:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail='Too many pending messages. Maximum 10 messages per conversation.',
        )

    response = await pending_service.add_message(
        conversation_id=conversation_id,
        content=content,
        role=role,
    )

    logger.info(
        f'Queued pending message {response.id} for conversation {conversation_id} '
        f'(position: {response.position})'
    )

    return response


@router.get('', response_model=list[PendingMessage])
async def list_pending_messages(
    conversation_id: str,
    pending_service: PendingMessageService = pending_message_service_dependency,
) -> list[PendingMessage]:
    """The messages waiting to be delivered, oldest first.

    Queuing existed without any way to SEE the queue, so a message typed while
    the agent was busy left no trace anywhere in the product until it was
    delivered. The composer had already been cleared, so the only reading
    available to the user was that their message was lost.
    """
    return await pending_service.get_pending_messages(conversation_id)


@router.delete(
    '/{message_id}',
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def cancel_pending_message(
    conversation_id: str,
    message_id: str,
    pending_service: PendingMessageService = pending_message_service_dependency,
) -> Response:
    """Cancel a queued message before it is delivered.

    Deleting something already gone answers 204, not 404. The queue drains by
    itself the moment the agent becomes ready, so losing the race is the
    ordinary outcome of clicking cancel a fraction too late — and the user's
    intent ("this must not be sent") is satisfied either way. A 404 would report
    a failure for the state they asked for.
    """
    deleted = await pending_service.delete_message(conversation_id, message_id)
    if deleted:
        logger.info(
            f'Cancelled pending message {message_id} for conversation {conversation_id}'
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
