"""Per-customer settings store.

FileSettingsStore writes every customer's settings to one path, ``settings.json``.
Its ``get_instance(cls, user_id)`` accepts the id and never references it, so all
customers share one blob — including ``agent_settings.llm.api_key``, which
``store()`` writes with ``expose_secrets: True``. On a multi-customer deployment
that is not a settings bug, it is a credential-sharing bug: whoever configures a
key last configures it for everybody, and everybody spends against it.

This subclass changes exactly one thing — the path is keyed by the verified
customer id, so each customer gets their own file. Load/store logic, the legacy
llm_profiles seeding and the serialization are all inherited unchanged.

An anonymous caller (user_id None) gets the legacy shared path rather than an
error. That keeps a single-user or not-yet-signed-in deployment working exactly
as before, and it is safe because the auth dependency refuses anonymous requests
before they reach a store — see nimbus_auth_gate.
"""

from __future__ import annotations

from dataclasses import dataclass

from openhands.app_server.settings.file_settings_store import FileSettingsStore


def user_scoped_path(user_id: str | None, filename: str) -> str:
    """``users/<id>/<filename>`` for a known customer, else the legacy path.

    The id is a Nimbus customer id (``cus_...`` / cuid), which is alphanumeric,
    but it arrives from a cookie so it is sanitised anyway: anything that is not
    alphanumeric, dash or underscore is replaced. A user_id must never be able
    to walk out of its directory via ``..`` or an absolute path.
    """
    if not user_id:
        return filename
    safe = ''.join(c if (c.isalnum() or c in '-_') else '_' for c in user_id)
    if not safe:
        return filename
    return f'users/{safe}/{filename}'


@dataclass
class NimbusSettingsStore(FileSettingsStore):
    @classmethod
    async def get_instance(cls, user_id: str | None) -> 'NimbusSettingsStore':
        from openhands.app_server.config import get_global_config

        return NimbusSettingsStore(
            file_store=get_global_config().file_store,
            path=user_scoped_path(user_id, 'settings.json'),
        )
