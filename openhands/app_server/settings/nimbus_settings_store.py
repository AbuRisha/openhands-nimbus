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

import os
from dataclasses import dataclass

from openhands.app_server.settings.file_settings_store import FileSettingsStore
from openhands.app_server.utils.logger import openhands_logger as logger


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

    async def load(
        self,
        *,
        resolve_agent_profile: bool = False,
        override_agent_profile_id: str | None = None,
    ):
        """Per-customer settings, falling back to the deployment default.

        Making settings per-customer creates a first-run problem that the shared
        blob hid: a brand new customer has no settings file, so no LLM, so the
        agent never constructs and the conversation hangs at "Connecting..." -
        the exact symptom this whole effort set out to remove. HIDE_LLM_SETTINGS
        is on, so they cannot configure it themselves either.

        When a customer has nothing stored, seed from the deployment's env
        (LLM_MODEL / LLM_BASE_URL / LLM_API_KEY) so chat works on first use. The
        seed is WRITTEN to their own file, so from then on it is genuinely
        theirs and they can diverge from the default.

        This is the point where per-customer key billing will hook in: swap the
        env key for the customer's own sk-nim-live- key and their usage draws
        down their own balance, with no change anywhere else.
        """
        settings = await super().load(
            resolve_agent_profile=resolve_agent_profile,
            override_agent_profile_id=override_agent_profile_id,
        )
        if settings is not None:
            return settings

        model = os.getenv('LLM_MODEL')
        api_key = os.getenv('LLM_API_KEY')
        base_url = os.getenv('LLM_BASE_URL')
        if not model or not api_key:
            logger.warning(
                'nimbus_settings: no stored settings and LLM_MODEL/LLM_API_KEY '
                'are not both set - this customer has no usable LLM config'
            )
            return None

        from openhands.app_server.settings.settings_models import Settings

        seeded = Settings(
            **{
                'agent_settings': {
                    'llm': {
                        'model': model,
                        'api_key': api_key,
                        **({'base_url': base_url} if base_url else {}),
                    }
                }
            }
        )
        seeded.v1_enabled = True
        try:
            await self.store(seeded)
            logger.info('nimbus_settings: seeded defaults into %s', self.path)
        except Exception as e:  # noqa: BLE001 - serving the request matters more
            logger.warning('nimbus_settings: could not persist seed: %s', e)
        return seeded
