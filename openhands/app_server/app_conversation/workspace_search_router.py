"""``GET /api/v1/app-conversations/{id}/workspace/files`` — list workspace files.

WHY THIS EXISTS
---------------
An @-mention picker needs to enumerate the files in a conversation's workspace,
and **the browser cannot**. The agent proxy exposes exactly four HTTP paths
(``agent_proxy_router`` lines 152-178): ``/api/conversations``, ``/api/git``,
``/api/vscode``, ``/api/file``. Behind ``/file`` the agent server offers upload,
download, home, search_subdirs, download-trajectory and archive — and not one of
them lists files. ``search_subdirs`` says so outright: *"Symlinks and files are
skipped."* ``/file/download`` needs a path you already know. ``/file/archive``
returns the entire tree as a tar.gz.

So the browser-reachable surface is: put one, get one by known path, or transfer
everything. The roadmap recorded this item as blocked on "a schema decision —
content search vs filename match". That was the wrong blocker: there is no
endpoint to decide between.

WHY IT SHELLS OUT, AND WHY THAT IS NOT THE THING WE REFUSED
-----------------------------------------------------------
``/api/bash/*`` is deliberately NOT proxied to the browser, and must stay that
way — exposing arbitrary command execution to a client is a security change
wearing a convenience costume, and ``_EXEMPT_PREFIXES`` would have to grow to
match.

This is the other thing. The command is authored HERE, in full, server-side, and
the caller's query never reaches a shell — matching happens in Python, below.
The app server already talks to the agent's bash this way
(``fork_state_transport._bash``, ``workspace_archive``), so this adds no new
execution surface; it reuses an existing server-to-server one.

The alternative — walking the tree from the app server — is not available: the
workspace lives inside the sandbox, and the only way in is the agent server.

WHY ``git ls-files`` FIRST
--------------------------
``-co --exclude-standard`` is tracked files plus untracked ones, minus anything
gitignored. That is precisely the set a human would @-mention, and it excludes
``node_modules`` and build output without maintaining a denylist. A workspace
that is not a git repo falls back to ``find``, which needs the exclusions spelled
out and is the worse answer we take only when the better one is unavailable.
"""

from __future__ import annotations

import logging
from typing import Annotated
from uuid import UUID

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from openhands.app_server.app_conversation.fork_state_transport import (
    ForkTransportError,
    SandboxEndpoint,
    _bash,
)
from openhands.app_server.config import (
    depends_app_conversation_info_service,
    depends_httpx_client,
    depends_sandbox_service,
)
from openhands.app_server.sandbox.agent_proxy_router import _agent_base_url
from openhands.app_server.sandbox.sandbox_models import SandboxInfo, SandboxStatus
from openhands.app_server.sandbox.sandbox_service import SandboxService

_logger = logging.getLogger(__name__)

workspace_router = APIRouter(prefix='/app-conversations', tags=['Conversations'])

_app_conversation_info_service_dep = depends_app_conversation_info_service()
_sandbox_service_dep = depends_sandbox_service()
_httpx_client_dep = depends_httpx_client()

# Ceiling on what the sandbox is asked to emit, applied INSIDE the sandbox.
# A monorepo can hold hundreds of thousands of paths, and the cost of pulling
# them across only to discard them lands on the app server's memory.
_LISTING_CEILING = 20000

# Ceiling on what a single response may carry, independent of what the caller
# asks for. A picker shows a dozen rows; nobody scrolls five thousand.
_MAX_LIMIT = 200

# One command, authored here in full. The caller's query is NOT part of it —
# see _rank(). Interpolating a query would turn a file picker into the
# arbitrary-execution endpoint this module's docstring refuses to build.
_LIST_COMMAND: str = (
    '(git ls-files -co --exclude-standard 2>/dev/null '
    "|| find . -type f -not -path '*/.*' -printf '%P\\n' 2>/dev/null) "
    f'| head -n {_LISTING_CEILING}'
)


class WorkspaceFile(BaseModel):
    path: str = Field(description='Path relative to the workspace root.')
    name: str = Field(description='Basename, which is what a picker matches on.')


class WorkspaceFilePage(BaseModel):
    items: list[WorkspaceFile]
    truncated: bool = Field(
        description=(
            'True when matches were dropped to fit the limit. A picker should '
            'say so rather than imply the list is exhaustive — a silent cut '
            'reads as "no such file".'
        )
    )


def _endpoint_for(sandbox: SandboxInfo) -> SandboxEndpoint:
    if not sandbox.session_api_key:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=f'sandbox {sandbox.id} exposes no session key; it may not be running',
        )
    return SandboxEndpoint(
        base_url=_agent_base_url(sandbox), session_api_key=sandbox.session_api_key
    )


def _rank(paths: list[str], query: str, limit: int) -> tuple[list[str], bool]:
    """Filter and order in PYTHON, never in the shell.

    Basename matches outrank path matches: typing "router" means the file called
    router.py far more often than every file under ``src/router/``. Ties keep the
    listing's own order, which git returns sorted.
    """
    needle = query.strip().lower()
    if needle:
        by_name: list[str] = []
        by_path: list[str] = []
        for path in paths:
            name = path.rsplit('/', 1)[-1].lower()
            if needle in name:
                by_name.append(path)
            elif needle in path.lower():
                by_path.append(path)
        matches = by_name + by_path
    else:
        matches = list(paths)

    return matches[:limit], len(matches) > limit


async def search_workspace_files(
    conversation_id: UUID,
    query: str,
    limit: int,
    *,
    app_conversation_info_service,
    sandbox_service: SandboxService,
    httpx_client: httpx.AsyncClient,
) -> WorkspaceFilePage:
    """Taken as plain arguments so it is testable without FastAPI."""
    info = await app_conversation_info_service.get_app_conversation_info(
        conversation_id
    )
    if info is None:
        # Also the answer for someone else's conversation: the info service is
        # user-scoped, so a foreign id is indistinguishable from a missing one.
        # That is the intent — a different status would confirm it exists.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail=f'No such conversation {conversation_id}'
        )

    sandbox_id = getattr(info, 'sandbox_id', None)
    if not sandbox_id:
        raise HTTPException(
            status.HTTP_409_CONFLICT, detail='conversation has no sandbox'
        )
    sandbox = await sandbox_service.get_sandbox(sandbox_id)
    if sandbox is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, detail=f'sandbox {sandbox_id} not found'
        )
    if sandbox.status != SandboxStatus.RUNNING:
        # A product constraint, not an internal error: the workspace lives in the
        # sandbox, so a stopped one has nothing to list.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail=(
                f'sandbox is {sandbox.status.value}, not RUNNING. '
                'Start the conversation to browse its workspace.'
            ),
        )

    try:
        stdout = await _bash(
            httpx_client, _endpoint_for(sandbox), _LIST_COMMAND, timeout=30
        )
    except ForkTransportError as e:
        # 502, not 500: the failure is the sandbox's, and the distinction is what
        # tells an operator which side to look at.
        _logger.warning(
            'workspace listing failed for %s: %s', conversation_id, e
        )
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, detail='could not list the workspace'
        ) from e

    paths = [line.strip() for line in (stdout or '').splitlines() if line.strip()]
    matches, truncated = _rank(paths, query, limit)
    return WorkspaceFilePage(
        items=[
            WorkspaceFile(path=p, name=p.rsplit('/', 1)[-1]) for p in matches
        ],
        truncated=truncated,
    )


@workspace_router.get(
    '/{conversation_id}/workspace/files',
    responses={
        404: {'description': 'Conversation or sandbox not found'},
        409: {'description': 'The sandbox is not RUNNING, so it has no workspace'},
        502: {'description': 'The sandbox could not list its workspace'},
    },
)
async def get_workspace_files(
    conversation_id: UUID,
    q: Annotated[
        str,
        Query(
            title='Substring to match, case-insensitive. Empty lists the head '
            'of the workspace.'
        ),
    ] = '',
    limit: Annotated[int, Query(title='Max results', gt=0, le=_MAX_LIMIT)] = 50,
    app_conversation_info_service=_app_conversation_info_service_dep,
    sandbox_service: SandboxService = _sandbox_service_dep,
    httpx_client: httpx.AsyncClient = _httpx_client_dep,
) -> WorkspaceFilePage:
    """List files in the conversation's workspace, for an @-mention picker."""
    return await search_workspace_files(
        conversation_id,
        q,
        limit,
        app_conversation_info_service=app_conversation_info_service,
        sandbox_service=sandbox_service,
        httpx_client=httpx_client,
    )
