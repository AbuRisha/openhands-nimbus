"""``/api/v1/artifacts`` — the customer's artifacts, and their history.

Scoped per customer by ``get_user_id``, the same identity that scopes settings,
secrets, memory and conversations. The id is never read from the request, so
there is no path here to reach another customer's documents.

WHY RESTORE IS A POST AND NOT A PUT
-----------------------------------
Restoring does not overwrite anything — it APPENDS the old content as a new
version, so the artifact moves forward rather than back. PUT would advertise
idempotence this does not have: calling it twice produces two new versions, and
a client retrying on a timeout would double-write with no way to tell.

WHAT IS DELIBERATELY ABSENT
---------------------------
No share endpoint. Sharing an artifact means deciding what an unauthenticated
reader sees, how a link is revoked, and whether the whole history travels with
it — and the history is the part that leaks, since it holds every draft the
customer thought better of. That is a decision to take on its own terms, not
one to imply by adding a `public` flag now. Storage and versioning do not
depend on it.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from openhands.app_server.artifacts.artifact_models import (
    MAX_CONTENT_CHARS,
    Artifact,
    ArtifactKind,
    ArtifactSummary,
    ArtifactVersion,
)
from openhands.app_server.artifacts.artifact_store import (
    ArtifactError,
    create_artifact,
    delete_artifact,
    list_artifacts,
    load_artifact,
    save_artifact,
)
from openhands.app_server.user_auth import get_user_id
from openhands.app_server.utils.dependencies import get_dependencies

router = APIRouter(
    prefix='/artifacts',
    tags=['Artifacts'],
    dependencies=get_dependencies(),
)


class CreateArtifactRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(default='')
    kind: ArtifactKind = ArtifactKind.TEXT
    language: str | None = Field(default=None, max_length=40)
    conversation_id: str | None = None


class UpdateArtifactRequest(BaseModel):
    """Every field optional; only what is sent changes.

    Sending `content` creates a NEW VERSION rather than editing the current one
    in place. That is the entire point of the store — an edit that overwrote
    would make restore impossible, which is the one thing a file already does
    better than nothing.
    """

    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = None
    kind: ArtifactKind | None = None
    language: str | None = Field(default=None, max_length=40)
    conversation_id: str | None = None


class ArtifactDetail(BaseModel):
    """An artifact with its CURRENT content, and its history as metadata only.

    The version list omits content on purpose: 50 versions of a long document
    is most of the account's storage, and a client opening an artifact needs
    the current text plus enough to draw a history list. Old content is fetched
    one version at a time, which is also how it is used.
    """

    id: str
    title: str
    kind: ArtifactKind
    language: str | None
    created_at: str
    updated_at: str
    current_version: int | None
    content: str
    versions: list[dict]

    @classmethod
    def of(cls, artifact: Artifact) -> 'ArtifactDetail':
        current = artifact.current
        return cls(
            id=artifact.id,
            title=artifact.title,
            kind=artifact.kind,
            language=artifact.language,
            created_at=artifact.created_at.isoformat(),
            updated_at=artifact.updated_at.isoformat(),
            current_version=current.version if current else None,
            content=current.content if current else '',
            versions=[
                {
                    'version': v.version,
                    'created_at': v.created_at.isoformat(),
                    'restored_from': v.restored_from,
                    'conversation_id': v.conversation_id,
                    'size_chars': len(v.content),
                }
                for v in artifact.versions
            ],
        )


def _require(user_id: str | None, artifact_id: str) -> Artifact:
    artifact = load_artifact(user_id, artifact_id)
    if artifact is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail='Artifact not found')
    return artifact


@router.get('', response_model=list[ArtifactSummary])
async def get_artifacts(
    user_id: str | None = Depends(get_user_id),
) -> list[ArtifactSummary]:
    """The gallery. Summaries only — see ArtifactSummary for why."""
    return list_artifacts(user_id)


@router.post('', response_model=ArtifactDetail, status_code=status.HTTP_201_CREATED)
async def post_artifact(
    request: CreateArtifactRequest,
    user_id: str | None = Depends(get_user_id),
) -> ArtifactDetail:
    artifact = Artifact(
        title=request.title,
        kind=request.kind,
        language=request.language,
    )
    # Version 1 exists even for empty content, so an artifact always has a
    # history to restore INTO. Creating with no version would make the first
    # edit unrecoverable, which is the one case a customer most expects to undo.
    artifact.add_version(request.content, conversation_id=request.conversation_id)

    try:
        create_artifact(user_id, artifact)
    except ArtifactError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, detail=str(e)) from e

    return ArtifactDetail.of(artifact)


@router.get('/{artifact_id}', response_model=ArtifactDetail)
async def get_artifact(
    artifact_id: str,
    user_id: str | None = Depends(get_user_id),
) -> ArtifactDetail:
    return ArtifactDetail.of(_require(user_id, artifact_id))


@router.patch('/{artifact_id}', response_model=ArtifactDetail)
async def patch_artifact(
    artifact_id: str,
    request: UpdateArtifactRequest,
    user_id: str | None = Depends(get_user_id),
) -> ArtifactDetail:
    artifact = _require(user_id, artifact_id)

    if request.title is not None:
        artifact.title = request.title
    if request.kind is not None:
        artifact.kind = request.kind
    if request.language is not None:
        artifact.language = request.language

    # Checked against None, not falsiness: clearing an artifact to empty is a
    # legitimate edit, and `if request.content:` would silently ignore it.
    if request.content is not None:
        artifact.add_version(
            request.content, conversation_id=request.conversation_id
        )

    save_artifact(user_id, artifact)
    return ArtifactDetail.of(artifact)


@router.get('/{artifact_id}/versions/{version}', response_model=ArtifactVersion)
async def get_artifact_version(
    artifact_id: str,
    version: int,
    user_id: str | None = Depends(get_user_id),
) -> ArtifactVersion:
    """One historical version, WITH its content."""
    artifact = _require(user_id, artifact_id)
    found = artifact.find_version(version)
    if found is None:
        # 404 rather than the nearest surviving version. History is trimmed
        # from the front, so a missing number is normal — and answering with an
        # adjacent version would show the customer content they did not ask for
        # while labelling it as the one they did.
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f'Version {version} is no longer retained',
        )
    return found


@router.post('/{artifact_id}/restore/{version}', response_model=ArtifactDetail)
async def post_restore_artifact(
    artifact_id: str,
    version: int,
    user_id: str | None = Depends(get_user_id),
) -> ArtifactDetail:
    """Make an older version current by appending it again.

    Nothing is deleted, so restoring a restore works. See Artifact.restore.
    """
    artifact = _require(user_id, artifact_id)
    restored = artifact.restore(version)
    if restored is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f'Version {version} is no longer retained',
        )
    save_artifact(user_id, artifact)
    return ArtifactDetail.of(artifact)


@router.delete('/{artifact_id}', status_code=status.HTTP_204_NO_CONTENT)
async def remove_artifact(
    artifact_id: str,
    user_id: str | None = Depends(get_user_id),
) -> None:
    if not delete_artifact(user_id, artifact_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail='Artifact not found')


class ArtifactLimits(BaseModel):
    max_content_chars: int = MAX_CONTENT_CHARS


@router.get('/meta/limits', response_model=ArtifactLimits)
async def get_limits() -> ArtifactLimits:
    """So a client can show remaining room instead of discovering the cap by
    having content silently truncated."""
    return ArtifactLimits()
