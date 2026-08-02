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
from openhands.app_server.settings.nimbus_customer_key import (
    fetch_customer_api_key,
)
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
    # Whose settings these are. Needed so the first-run seed can ask nimbus-v2
    # for a key belonging to THIS customer rather than falling back to the
    # shared deployment key.
    nimbus_user_id: str | None = None

    @classmethod
    async def get_instance(cls, user_id: str | None) -> 'NimbusSettingsStore':
        from openhands.app_server.config import get_global_config

        return NimbusSettingsStore(
            file_store=get_global_config().file_store,
            path=user_scoped_path(user_id, 'settings.json'),
            nimbus_user_id=user_id,
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
            return await self._upgrade_shared_key(settings)

        model = os.getenv('LLM_MODEL')
        base_url = os.getenv('LLM_BASE_URL')

        # Bill the CUSTOMER, not the deployment. Their own sk-nim-live- key
        # resolves at the gateway to their customerId and their balance, so
        # usage draws down their credit (free/welcome credit included) and never
        # anybody else's. This is the whole point of per-customer chat.
        api_key = await fetch_customer_api_key(self.nimbus_user_id)
        if api_key:
            logger.info(
                'nimbus_settings: seeding %s with the customer own API key',
                self.path,
            )
        else:
            # Falling back to the shared key means this customer's usage bills
            # to the deployment. That is a correctness problem, not a crash, so
            # chat keeps working - but it must be visible, because the symptom
            # (someone else's balance draining) is otherwise silent.
            api_key = os.getenv('LLM_API_KEY')
            if self.nimbus_user_id:
                logger.error(
                    'nimbus_settings: could not obtain a per-customer key for %s '
                    '- falling back to the shared deployment key, so this '
                    'customer usage will NOT bill to their own balance',
                    self.nimbus_user_id,
                )

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

    async def _upgrade_shared_key(self, settings):
        """Move a customer off the shared deployment key onto their own.

        Customers seeded before per-customer keys existed hold the deployment's
        LLM_API_KEY in their settings, so their usage bills to the deployment
        rather than to them. `load` only seeds when nothing is stored, so
        without this they would keep the shared key forever and the billing fix
        would silently apply to new customers only.

        Only rewrites when the stored key is EXACTLY the deployment key. A
        customer who has set their own is left alone.
        """
        shared = os.getenv('LLM_API_KEY')
        if not shared or not self.nimbus_user_id:
            return settings
        try:
            llm = getattr(getattr(settings, 'agent_settings', None), 'llm', None)
            current = getattr(llm, 'api_key', None)
            # api_key may be a SecretStr; compare the plain value either way.
            plain = (
                current.get_secret_value()
                if hasattr(current, 'get_secret_value')
                else current
            )
            if plain != shared:
                return settings
        except Exception:  # noqa: BLE001 - never break a load over this
            return settings

        own = await fetch_customer_api_key(self.nimbus_user_id)
        if not own:
            logger.error(
                'nimbus_settings: %s still holds the shared deployment key and a '
                'per-customer key could not be minted - their usage is billing to '
                'the deployment, not to them',
                self.nimbus_user_id,
            )
            return settings

        try:
            # SecretStr, not a plain str. `api_key` is typed SecretStr | None and
            # this model deliberately bypasses validate_assignment (see the
            # object.__setattr__ note in settings_models.py), so assigning a raw
            # string does NOT get coerced — it is stored as-is and the field
            # serializer then fails on the missing .get_secret_value().
            #
            # That is what produced the churn loop: store() raised, the except
            # below swallowed it, nothing persisted, so the next settings load
            # saw the old key and minted again. Sixteen keys in about a minute,
            # none ever used, and whatever the customer's settings held was
            # revoked seconds later — which surfaced as chat returning 500.
            #
            # The seed path was unaffected because Settings(**{...}) goes through
            # the constructor, which DOES validate and coerce. Only assignment
            # skips it, which is exactly why the bug hid: seeding looked fine.
            from pydantic import SecretStr

            llm.api_key = SecretStr(own)
            await self.store(settings)

            # Prove it stuck. A mint that returns 200 is not evidence the key was
            # saved, and treating it as such is what let this run for a minute.
            written = await super().load()
            saved = getattr(getattr(written, 'agent_settings', None), 'llm', None)
            saved_key = getattr(saved, 'api_key', None)
            plain_saved = (
                saved_key.get_secret_value()
                if hasattr(saved_key, 'get_secret_value')
                else saved_key
            )
            if plain_saved != own:
                logger.error(
                    'nimbus_settings: key upgrade did NOT persist for %s - '
                    'refusing to report success; chat will keep using the '
                    'previous key rather than re-minting on every load',
                    self.nimbus_user_id,
                )
                return settings
            logger.info(
                'nimbus_settings: upgraded %s from the shared key to their own',
                self.nimbus_user_id,
            )
        except Exception as e:  # noqa: BLE001
            logger.error('nimbus_settings: could not persist key upgrade: %s', e)
        return settings
