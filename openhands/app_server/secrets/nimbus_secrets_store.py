"""Per-customer secrets store.

Same defect and same fix as NimbusSettingsStore: FileSecretsStore writes every
customer's secrets to one ``secrets.json`` and ignores the ``user_id`` handed to
``get_instance``. Provider tokens are stored with ``expose_secrets: True``, so
on a multi-customer deployment one customer's git tokens are readable by all of
them.

Only the path changes; load/store are inherited.
"""

from __future__ import annotations

from dataclasses import dataclass

from openhands.app_server.secrets.file_secrets_store import FileSecretsStore
from openhands.app_server.settings.nimbus_settings_store import user_scoped_path


@dataclass
class NimbusSecretsStore(FileSecretsStore):
    @classmethod
    async def get_instance(cls, user_id: str | None) -> 'NimbusSecretsStore':
        from openhands.app_server.config import get_global_config

        return NimbusSecretsStore(
            file_store=get_global_config().file_store,
            path=user_scoped_path(user_id, 'secrets.json'),
        )
