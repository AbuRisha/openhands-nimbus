"""Per-customer persistence for artifacts.

ONE FILE PER ARTIFACT, not one document holding all of them.

`nimbus_memory` and `scheduled_task_store` both keep a single document per
customer, and copying that here would be wrong. An artifact carries up to 50
versions of up to 400k characters, so the combined document reaches hundreds of
megabytes — and a single-document store REWRITES THE WHOLE THING on every save.
Renaming one artifact would rewrite every version of every other one, and two
concurrent saves would lose whichever landed first in its entirety rather than
losing one field.

So: ``users/<id>/artifacts/<artifact_id>.json``, enumerated with
``FileStore.list``. The blast radius of a corrupt or half-written file is then
one artifact instead of the customer's whole library.

The identity rule is the same as the other two stores and matters more here,
because the content is the customer's own writing: the id is never taken from a
request, and an unidentified session gets NOTHING rather than a shared fallback.
"""

from __future__ import annotations

import json

from openhands.app_server.artifacts.artifact_models import (
    MAX_ARTIFACTS_PER_USER,
    Artifact,
    ArtifactSummary,
)
from openhands.app_server.utils.logger import openhands_logger as logger


class ArtifactError(Exception):
    """A caller error worth reporting rather than swallowing."""


def _safe(component: str) -> str:
    """Reduce an id to characters that cannot escape the directory.

    Belt and braces: ids are generated with `uuid4().hex`, but this function
    also receives ARTIFACT IDS FROM THE URL, and a path built from an
    unsanitised request value is how a store like this turns into "read any
    file on the box". `..` collapses to `__` here rather than being rejected,
    because a caller passing it gets a clean 404 instead of a 500 that confirms
    the path exists.
    """
    return ''.join(c if (c.isalnum() or c in '-_') else '_' for c in component)


def artifacts_dir(user_id: str | None) -> str | None:
    """``users/<id>/artifacts``, or None for an unidentified session."""
    if not user_id:
        return None
    safe = _safe(user_id)
    return f'users/{safe}/artifacts' if safe else None


def artifact_path(user_id: str | None, artifact_id: str) -> str | None:
    directory = artifacts_dir(user_id)
    if directory is None:
        return None
    safe_id = _safe(artifact_id)
    return f'{directory}/{safe_id}.json' if safe_id else None


def _file_store():
    from openhands.app_server.config import get_global_config

    return get_global_config().file_store


def load_artifact(user_id: str | None, artifact_id: str) -> Artifact | None:
    """Never raises. A missing or malformed file reads as None."""
    path = artifact_path(user_id, artifact_id)
    if path is None:
        return None

    try:
        raw = _file_store().read(path)
    except Exception:  # noqa: BLE001 - absent file is the common case
        return None

    try:
        return Artifact.model_validate(json.loads(raw or '{}'))
    except Exception:  # noqa: BLE001
        logger.warning('artifacts: could not parse %s, treating as absent', path)
        return None


def list_artifacts(user_id: str | None) -> list[ArtifactSummary]:
    """Summaries only, newest-updated first.

    ONE CORRUPT FILE MUST NOT EMPTY THE GALLERY. Each artifact is parsed
    independently and a failure skips that entry, because the alternative — a
    single try around the loop — means one bad file makes the customer's whole
    library look deleted.
    """
    directory = artifacts_dir(user_id)
    if directory is None:
        return []

    try:
        paths = _file_store().list(directory)
    except Exception:  # noqa: BLE001 - no directory yet
        return []

    summaries: list[ArtifactSummary] = []
    for path in paths:
        if not path.endswith('.json'):
            continue
        try:
            raw = _file_store().read(path)
            summaries.append(
                ArtifactSummary.of(Artifact.model_validate(json.loads(raw or '{}')))
            )
        except Exception:  # noqa: BLE001
            logger.warning('artifacts: skipping unreadable %s', path)
            continue

    summaries.sort(key=lambda s: s.updated_at, reverse=True)
    return summaries


def save_artifact(user_id: str | None, artifact: Artifact) -> Artifact:
    path = artifact_path(user_id, artifact.id)
    if path is None:
        logger.warning('artifacts: refusing to save for an unidentified session')
        raise ArtifactError('No account is associated with this session.')

    _file_store().write(path, artifact.model_dump_json(indent=2))
    return artifact


def create_artifact(user_id: str | None, artifact: Artifact) -> Artifact:
    """Enforces the per-account cap.

    Counted with `list` rather than a stored counter: a counter drifts the
    first time a write fails halfway, and then either blocks a customer under
    the cap or lets them past it, with nothing to reconcile against.
    """
    if artifacts_dir(user_id) is None:
        raise ArtifactError('No account is associated with this session.')

    if len(list_artifacts(user_id)) >= MAX_ARTIFACTS_PER_USER:
        raise ArtifactError(
            f'At most {MAX_ARTIFACTS_PER_USER} artifacts per account.'
        )

    return save_artifact(user_id, artifact)


def delete_artifact(user_id: str | None, artifact_id: str) -> bool:
    """True if something was deleted, False if it was not there.

    Deliberately NOT idempotent-by-lying: the router turns False into a 404 so
    a client that thinks it deleted something it did not is told.
    """
    path = artifact_path(user_id, artifact_id)
    if path is None:
        return False

    if load_artifact(user_id, artifact_id) is None:
        return False

    try:
        _file_store().delete(path)
    except Exception:  # noqa: BLE001
        logger.warning('artifacts: delete failed for %s', path)
        return False
    return True
