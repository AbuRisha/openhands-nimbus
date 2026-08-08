"""Per-customer persistence for scheduled tasks.

Same file-store shape as `nimbus_memory`, and the same identity rule, for the
same reason: a task carries a prompt written by one customer and, when it
fires, spends that customer's credit. A shared document would cross both
between accounts.
"""

from __future__ import annotations

import json

from openhands.app_server.scheduled_tasks.scheduled_task_models import (
    MAX_TASKS_PER_USER,
    ScheduledTask,
    ScheduledTaskList,
)
from openhands.app_server.utils.logger import openhands_logger as logger


class ScheduledTaskError(Exception):
    """A caller error worth reporting rather than swallowing."""


def tasks_path(user_id: str | None) -> str | None:
    """``users/<id>/scheduled_tasks.json``.

    Returns None for an unidentified session, and callers must treat that as
    NO tasks rather than falling back to a shared file. `nimbus_memory` has the
    same rule and states the reasoning: a customer losing a schedule is a
    degraded feature, a customer running someone else's schedule is a breach —
    and this one also spends money.
    """
    if not user_id:
        return None
    safe = ''.join(c if (c.isalnum() or c in '-_') else '_' for c in user_id)
    return f'users/{safe}/scheduled_tasks.json' if safe else None


def load_tasks(user_id: str | None) -> ScheduledTaskList:
    """Never raises. A malformed document yields an EMPTY list rather than an
    error, because the scheduler ticks for every user and one corrupt file must
    not stop everyone else's tasks."""
    path = tasks_path(user_id)
    if path is None:
        return ScheduledTaskList()

    try:
        from openhands.app_server.config import get_global_config

        raw = get_global_config().file_store.read(path)
    except Exception:  # noqa: BLE001 - absent file is the common case
        return ScheduledTaskList()

    try:
        return ScheduledTaskList.model_validate(json.loads(raw or '{}'))
    except Exception:  # noqa: BLE001
        logger.warning(
            'scheduled_tasks: could not parse %s, treating as empty', path
        )
        return ScheduledTaskList()


def save_tasks(user_id: str | None, tasks: ScheduledTaskList) -> ScheduledTaskList:
    """Persist and return what was stored."""
    path = tasks_path(user_id)
    if path is None:
        logger.warning(
            'scheduled_tasks: refusing to save for an unidentified session'
        )
        return ScheduledTaskList()

    from openhands.app_server.config import get_global_config

    get_global_config().file_store.write(
        path, tasks.model_dump_json(indent=2)
    )
    return tasks


def add_task(user_id: str | None, task: ScheduledTask) -> ScheduledTask:
    current = load_tasks(user_id)
    if len(current.tasks) >= MAX_TASKS_PER_USER:
        raise ScheduledTaskError(
            f'At most {MAX_TASKS_PER_USER} scheduled tasks per account.'
        )
    current.tasks.append(task)
    save_tasks(user_id, current)
    return task


def update_task(
    user_id: str | None, task_id: str, changes: dict
) -> ScheduledTask | None:
    """Apply a partial update. Returns None if the task does not exist.

    `runs` and `last_run_at` are NOT updatable here — they are the scheduler's
    record of what happened, and letting an edit rewrite them would make the
    history a claim rather than a log.
    """
    current = load_tasks(user_id)
    protected = {'id', 'runs', 'last_run_at', 'created_at'}
    for index, existing in enumerate(current.tasks):
        if existing.id != task_id:
            continue
        merged = existing.model_dump()
        merged.update(
            {k: v for k, v in changes.items() if k not in protected}
        )
        updated = ScheduledTask.model_validate(merged)
        current.tasks[index] = updated
        save_tasks(user_id, current)
        return updated
    return None


def delete_task(user_id: str | None, task_id: str) -> bool:
    current = load_tasks(user_id)
    remaining = [t for t in current.tasks if t.id != task_id]
    if len(remaining) == len(current.tasks):
        return False
    current.tasks = remaining
    save_tasks(user_id, current)
    return True
