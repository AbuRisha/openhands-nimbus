"""Server config that turns on per-customer isolation.

Selected by setting, on the container:

    OPENHANDS_CONFIG_CLS=openhands.app_server.server_config.nimbus_server_config.NimbusServerConfig

`load_server_config()` resolves that string through `get_impl`, so this is the
supported extension point and nothing here forks upstream code.

Three swaps, and all three are required — any one alone leaves a hole:

  user_auth_class      DefaultUserAuth returns user_id None ("does not support
                       multi tenancy"), so every request is the same anonymous
                       root user. NimbusUserAuth returns the verified Nimbus
                       customer id from the signed session cookie.

  settings_store_class FileSettingsStore writes all customers to one
                       settings.json and ignores the user_id it is given. That
                       shares agent_settings.llm.api_key across customers.

  secret_store_class   FileSecretsStore has the identical defect for
                       secrets.json and provider tokens.

Conversation isolation is NOT configured here because it is not a pluggable
class: it is a query filter plus a column, in
sql_app_conversation_info_service and migration 015.
"""

from __future__ import annotations

from openhands.app_server.server_config.server_config import ServerConfig


class NimbusServerConfig(ServerConfig):
    user_auth_class: str = (
        'openhands.app_server.user_auth.nimbus_user_auth.NimbusUserAuth'
    )
    settings_store_class: str = (
        'openhands.app_server.settings.nimbus_settings_store.NimbusSettingsStore'
    )
    secret_store_class: str = (
        'openhands.app_server.secrets.nimbus_secrets_store.NimbusSecretsStore'
    )

    def verify_config(self):
        """Allow OPENHANDS_CONFIG_CLS to be set.

        The base implementation raises 'Unexpected config path provided'
        whenever config_cls is non-empty — which is unconditionally true for any
        custom config, because ServerConfig.config_cls reads the very env var
        used to select one. Left inherited, this class could never load: the
        only way to choose it also guarantees it rejects itself.
        """
        return None
