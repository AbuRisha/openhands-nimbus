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

from pydantic import SecretStr

from openhands.app_server.settings.file_settings_store import FileSettingsStore
from openhands.app_server.settings.nimbus_catalog_profiles import (
    prune_retired_catalog_profiles,
    repair_catalog_profile_base_urls,
    seed_catalog_profiles,
)
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
            settings = self._repair_base_url(settings)
            settings = await self._ensure_catalog_profiles(settings)
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
        # Seed the model picker in the same pass. Doing it here rather than on
        # the next load means a brand new customer's first view of chat already
        # has every Nimbus model in the header dropdown.
        seed_catalog_profiles(seeded)
        try:
            await self.store(seeded)
            logger.info('nimbus_settings: seeded defaults into %s', self.path)
        except Exception as e:  # noqa: BLE001 - serving the request matters more
            logger.warning('nimbus_settings: could not persist seed: %s', e)
        return seeded

    async def _ensure_catalog_profiles(self, settings):
        """Give the chat model picker something to show, and keep it pointed here.

        The picker hides itself entirely when a user has no LLM profiles, which
        in practice meant it never appeared: profiles are hand-created and
        nobody creates twenty-seven of them. See nimbus_catalog_profiles for
        why the seeded profiles carry no API key and always pin a base_url.

        Persists only when something actually changed, so the common case —
        already seeded, gateway unchanged — costs a dict lookup per model and
        no write.
        """
        try:
            added = seed_catalog_profiles(settings)
            repaired = repair_catalog_profile_base_urls(settings)
            # Withdrawing a model from the catalog has to withdraw it from the
            # picker too, or the seed leaves behind an entry that 404s.
            pruned = prune_retired_catalog_profiles(settings)
        except Exception as e:  # noqa: BLE001
            # A broken picker is a degraded chat; a raised exception here is no
            # chat at all, because every settings load goes through this.
            logger.warning('nimbus_settings: catalog profile seed failed: %s', e)
            return settings

        if not (added or repaired or pruned):
            return settings

        try:
            await self.store(settings)
        except Exception as e:  # noqa: BLE001
            # Serve the request with the in-memory profiles anyway; the next
            # load will try again.
            logger.warning('nimbus_settings: could not persist catalog profiles: %s', e)
        return settings

    def _repair_base_url(self, settings):
        """Re-point stored settings at the CURRENT gateway base URL.

        THE BUG THIS FIXES
        ------------------
        Every message returned "Error occurred". The reason was one path
        segment:

            litellm.NotFoundError: AnthropicException -
            {"message":"not_found: POST /v1/v1/messages"}

        LiteLLM picks its wire format from the model prefix. For anthropic/*
        it speaks the Anthropic API and appends "/v1/messages" to the base
        URL; for openai/* it appends only "/chat/completions". With a base of
        "https://api.nimbusapi.net/v1" the first becomes /v1/v1/messages and
        404s. There is no single base URL that satisfies both formats, so the
        gateway now also answers /chat/completions at the root and the base
        URL drops its /v1.

        Changing LLM_BASE_URL alone was not enough. That env var only seeds
        customers who have NO stored settings; anyone who had ever opened chat
        already had the old value written to their own settings file and would
        have kept hitting the dead path forever. Their model choice is theirs
        to keep, but the base URL is deployment infrastructure — it should
        follow the deployment, not be frozen at whatever it was on the day
        they first signed in.

        Idempotent, and a no-op when the two already agree, so it costs a
        string compare on the normal path.
        """
        want = os.getenv('LLM_BASE_URL')
        if not want:
            return settings

        agent = getattr(settings, 'agent_settings', None)
        llm = getattr(agent, 'llm', None) if agent else None
        if llm is None:
            return settings

        have = getattr(llm, 'base_url', None)
        if have == want:
            return settings

        try:
            llm.base_url = want
        except Exception as e:  # noqa: BLE001
            # Never fail a settings load over this. A wrong base URL breaks
            # sending a message; a raised exception breaks loading chat at all.
            logger.warning('nimbus_settings: could not repair base_url: %s', e)
            return settings

        logger.info(
            'nimbus_settings: repaired stale base_url %r -> %r for %s',
            have,
            want,
            self.nimbus_user_id or 'anonymous',
        )
        return settings

    async def _upgrade_shared_key(self, settings):
        """Serialised wrapper — see _upgrade_shared_key_locked for the logic.

        The lock inside fetch_customer_api_key only serialises the MINT. The
        read-compare-write around it was still concurrent, so two loads that both
        read the shared key before either wrote would both upgrade: observed as
        two keys 465ms apart, one immediately revoked.

        Self-limiting (once a customer is upgraded, later loads skip) but
        pointless churn in their dashboard, so hold the lock across the whole
        sequence instead.
        """
        if not self.nimbus_user_id:
            return settings
        from openhands.app_server.settings.nimbus_customer_key import _lock_for

        async with await _lock_for(f'settings:{self.nimbus_user_id}'):
            return await self._upgrade_shared_key_locked(settings)

    async def _upgrade_shared_key_locked(self, settings):
        """Make sure the stored key is the customer's own AND still valid.

        Two jobs, because they share the same lock and the same write path:
        migrate a customer off the shared deployment key, and confirm a key they
        already own has not been revoked underneath them.

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
            if llm is None:
                # There is nothing to upgrade, and every path below dereferences
                # it. This was already true implicitly — a missing llm gave
                # plain=None, which is neither the shared key nor an sk-nim-
                # string, so both branches returned — but only by way of two
                # separate coincidences several screens apart.
                return settings
            current = getattr(llm, 'api_key', None)
            # api_key may be a SecretStr; compare the plain value either way.
            # isinstance rather than hasattr: the field is typed SecretStr|None,
            # and assignment bypasses coercion (see below), so the only two
            # things it can hold are a SecretStr and a raw str.
            plain = (
                current.get_secret_value()
                if isinstance(current, SecretStr)
                else current
            )
            holds_shared = plain == shared
        except Exception:  # noqa: BLE001 - never break a load over this
            return settings

        if holds_shared:
            own = await fetch_customer_api_key(self.nimbus_user_id)
            if not own:
                logger.error(
                    'nimbus_settings: %s still holds the shared deployment key '
                    'and a per-customer key could not be minted - their usage is '
                    'billing to the deployment, not to them',
                    self.nimbus_user_id,
                )
                return settings
        else:
            # The customer holds their OWN key. Confirm it is still live rather
            # than assuming it is.
            #
            # Nothing here ever re-minted once a key was stored, and the mint
            # endpoint revoked-and-replaced on every call. So one extra call for
            # this customer from anywhere — a cold start, the Builder, someone
            # investigating — revoked the key still sitting in these settings,
            # and every conversation afterwards failed to authenticate with no
            # path back. Permanent, per customer, and invisible from here.
            #
            # Sending the held key makes the server confirm it instead of
            # rotating, so the normal answer is "same key, nothing changed". A
            # different key comes back only when the stored one is genuinely
            # dead, and that is exactly when it should be replaced.
            if not isinstance(plain, str) or not plain.startswith('sk-nim-'):
                return settings
            own = await fetch_customer_api_key(self.nimbus_user_id, current_key=plain)
            if not own:
                # Could not reach the site, or the customer is inactive. Keep
                # what is stored: it may well still work, and discarding a
                # possibly-good key over a transport failure would cause the
                # outage this is meant to prevent.
                return settings
            if own == plain:
                return settings
            logger.warning(
                'nimbus_settings: the stored chat key for %s was no longer '
                'valid and has been replaced',
                self.nimbus_user_id,
            )

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
            llm.api_key = SecretStr(own)
            await self.store(settings)

            # Prove it stuck. A mint that returns 200 is not evidence the key was
            # saved, and treating it as such is what let this run for a minute.
            written = await super().load()
            saved = getattr(getattr(written, 'agent_settings', None), 'llm', None)
            saved_key = getattr(saved, 'api_key', None)
            plain_saved = (
                saved_key.get_secret_value()
                if isinstance(saved_key, SecretStr)
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
