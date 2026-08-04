"""Read and write the customer's durable memory document.

Deliberately tiny and deliberately NOT a chat-visible tool yet. Getting the
storage, the cap and the injection point right is what makes an agent-writable
memory safe to add next; doing it in the other order means an agent can grow the
document before anything bounds it.

Scoped per customer by ``get_user_id`` — the same identity that scopes settings,
secrets and conversations. There is no path here to read another customer's
memory, because the id is never taken from the request.
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel, Field

from openhands.app_server.app_conversation.nimbus_memory import (
    MAX_MEMORY_CHARS,
    load_memory,
    save_memory,
)
from openhands.app_server.user_auth import get_user_id
from openhands.app_server.utils.dependencies import get_dependencies

router = APIRouter(
    prefix='/memory',
    tags=['Memory'],
    dependencies=get_dependencies(),
)


class MemoryDocument(BaseModel):
    """The document, plus the cap so a client can show remaining room."""

    text: str = Field(default='')
    max_chars: int = Field(default=MAX_MEMORY_CHARS)
    used_chars: int = Field(default=0)


@router.get('', response_model=MemoryDocument)
async def get_memory(user_id: str | None = Depends(get_user_id)) -> MemoryDocument:
    text = load_memory(user_id)
    return MemoryDocument(
        text=text, max_chars=MAX_MEMORY_CHARS, used_chars=len(text)
    )


@router.put('', response_model=MemoryDocument)
async def put_memory(
    text: str = Body(embed=True, default=''),
    user_id: str | None = Depends(get_user_id),
) -> MemoryDocument:
    """Replace the document.

    Returns what was actually stored rather than what was sent: the value is
    truncated to the cap, and a caller that assumed otherwise would silently
    believe it saved more than it did.
    """
    stored = save_memory(user_id, text)
    return MemoryDocument(
        text=stored, max_chars=MAX_MEMORY_CHARS, used_chars=len(stored)
    )
