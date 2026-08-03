"""Stable, unique POSIX uid per Nimbus customer.

Used to run each customer's agent process as its own OS user so that the shell
the agent exposes cannot read another customer's files.

WHY NOT HASH THE CUSTOMER ID
----------------------------
The obvious implementation is ``uid = BASE + (hash(customer_id) % RANGE)``. It is
one line and it is wrong: two customers that collide get the SAME uid, which
means they get read/write access to each other's workspaces. A collision is
unlikely per pair and near-certain eventually (birthday bound), and its symptom
is silent cross-tenant access rather than an error. An isolation mechanism whose
failure mode is "isolation quietly stops working" is not one worth shipping.

So allocations are explicit and persisted. The map lives in the persistence dir,
which is an Azure Files mount, so it survives restarts along with settings —
a uid that changed on restart would orphan every file it had created.

Concurrency: the app runs at maxReplicas 1 (RUNTIME=process pins a conversation's
sandbox to the replica that started it), so a process-level lock is sufficient.
The file is written atomically via os.replace so a crash mid-write cannot leave a
truncated map that would hand out already-used uids.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Final

from openhands.app_server.utils.logger import openhands_logger as logger

# Comfortably above system/service accounts and the image's own `openhands`
# user, and below the 65534 nobody/overflow ids.
_UID_BASE: Final[int] = 30000
_UID_MAX: Final[int] = 59999

_MAP_FILENAME: Final[str] = 'nimbus_uids.json'
_lock = threading.Lock()


def _map_path() -> Path:
    from openhands.app_server.config import get_default_persistence_dir

    return Path(get_default_persistence_dir()) / _MAP_FILENAME


def _load(path: Path) -> dict[str, int]:
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}
    except Exception as e:  # noqa: BLE001
        # A corrupt map must NOT silently become an empty one — that would
        # re-issue uids already owning files on disk.
        raise RuntimeError(f'nimbus uid map at {path} is unreadable: {e}') from e
    if not isinstance(data, dict):
        raise RuntimeError(f'nimbus uid map at {path} is not an object')
    return {str(k): int(v) for k, v in data.items()}


def _store(path: Path, data: dict[str, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding='utf-8')
    os.replace(tmp, path)


def uid_for_user(user_id: str | None) -> int | None:
    """The uid owning this customer's sandboxes, allocating one if needed.

    Returns None for an anonymous caller — there is no per-customer identity to
    isolate, and the caller must decide what to do (we keep the previous
    same-user behaviour rather than inventing a shared "anonymous" uid, which
    would pool every unauthenticated session together under one owner).
    """
    if not user_id:
        return None
    path = _map_path()
    with _lock:
        mapping = _load(path)
        existing = mapping.get(user_id)
        if existing is not None:
            return existing
        used = set(mapping.values())
        for candidate in range(_UID_BASE, _UID_MAX + 1):
            if candidate not in used:
                mapping[user_id] = candidate
                _store(path, mapping)
                logger.info(
                    'nimbus_uid: allocated uid %s for customer %s', candidate, user_id
                )
                return candidate
    # Refuse rather than reuse. Reuse would hand a new customer another's files.
    raise RuntimeError(
        f'nimbus uid pool exhausted ({_UID_BASE}-{_UID_MAX}); refusing to reuse a uid'
    )


def can_isolate() -> bool:
    """True when this process can actually change file ownership.

    chown and setuid both require root. If we are not root, isolation cannot be
    enforced and the caller must say so loudly rather than continue and imply a
    guarantee that is not being met.
    """
    return hasattr(os, 'geteuid') and os.geteuid() == 0
