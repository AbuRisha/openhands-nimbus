"""Seed one LLM profile per Nimbus catalog model, so the chat model picker works.

THE PROBLEM
-----------
``SwitchProfileButton`` — the model picker in the chat header — begins with::

    if (profiles.length === 0) {
      return null;
    }

Profiles are user-created, and in production ``GET /api/v1/settings/profiles``
returns ``{"profiles": [], "active_profile": null}``. So the picker renders
nothing at all, and the only way to get one is to open LLM settings and hand-add
a profile per model — twenty-seven times, against a catalog the deployment
already knows. Reported as "there is no model picker, I shouldn't have to go to
settings" and "all nimbus models should be showing live in the chat, it's
redundant to have to go to LLM settings and set that all up for every model one
by one".

The catalog is already authoritative (``NIMBUS_CHAT_MODELS``). This turns it
into profiles on first load so the picker has something to show.

WHY PROFILES CARRY NO API KEY
-----------------------------
``resolve_profile_llm`` falls back to the user's effective settings key when a
profile has none. Copying the key into twenty-seven profiles would instead
freeze it: ``_upgrade_shared_key`` moves customers off the shared deployment key
onto their own, and any copy made before that would keep billing the deployment
forever. Leaving the key unset means every profile follows whatever key the
customer currently has, including after a rotation.

WHY base_url IS PINNED EXPLICITLY
---------------------------------
This one is a security property, not a nicety. ``resolve_llm_base_url`` returns
the provider's real endpoint when a profile stores no base_url::

    if is_openhands_model(model):
        return managed_proxy_url
    return get_provider_api_base(model)

``anthropic/claude-sonnet-5`` is not an OpenHands model, so a profile with no
base_url resolves to ``https://api.anthropic.com`` — and the fallback above
would then attach the customer's ``sk-nim-live-`` key to a request sent to
Anthropic directly. That both fails and hands a Nimbus credential to a third
party. Every seeded profile therefore pins the gateway explicitly.
"""

from __future__ import annotations

import os
from typing import Any

from openhands.app_server.config_api.nimbus_llm_model_service import (
    NIMBUS_CHAT_MODELS,
    NIMBUS_DEFAULT_MODEL,
)
from openhands.app_server.utils.logger import openhands_logger as logger

# Tokens that look wrong when naively capitalised. "gpt-5.6-sol" reading as
# "Gpt 5.6 Sol" in a product surface is the kind of detail that makes a picker
# feel unfinished.
_UPPER_TOKENS = {'gpt', 'glm', 'ai'}


def display_name(model: str) -> str:
    """``anthropic/claude-sonnet-5`` -> ``Claude Sonnet 5``.

    The provider is deliberately dropped from the NAME: the picker's dropdown
    already renders the full model id underneath each entry, so repeating it
    would just make every row longer without adding information. Where two
    providers ever ship the same bare name, the ids below them still
    disambiguate.
    """
    bare = model.split('/', 1)[1] if '/' in model else model
    parts: list[str] = []
    for token in bare.split('-'):
        if not token:
            continue
        if token.lower() in _UPPER_TOKENS:
            parts.append(token.upper())
        elif token[0].isdigit():
            # Version-ish ("5.6", "4.5", "3") — leave exactly as written.
            parts.append(token)
        else:
            parts.append(token[0].upper() + token[1:])
    return ' '.join(parts) if parts else model


# Weekly Free's id is stable but the MODEL BEHIND IT rotates weekly, so its
# label is the one thing in this catalog that must not be derived from the id.
# "Weekly Free" alone tells a customer nothing about what they are about to run.
_WEEKLY_FREE_ID = 'nimbus/weekly-free'
_weekly_free_name_cache: dict[str, str] = {}


def _weekly_free_label() -> str:
    """``Weekly Free (Qwen3.5-397B)`` — the current model, read at runtime.

    Asks the gateway's own ``/v1/free/models`` for ``name``. Cached for the
    process: the model changes weekly, not per settings load.

    Falls back to a plain ``Weekly Free`` on any failure. A label that is merely
    less specific is fine; refusing to seed the profile, or naming last week's
    model, is not — the whole point of reading it at runtime is that nobody has
    to remember to edit a string every Monday.
    """
    if 'label' in _weekly_free_name_cache:
        return _weekly_free_name_cache['label']

    label = 'Weekly Free'
    base = (os.getenv('LLM_BASE_URL') or '').rstrip('/')
    key = os.getenv('LLM_API_KEY') or ''
    if base and key:
        try:
            import json
            import urllib.request

            req = urllib.request.Request(
                f'{base}/v1/free/models',
                headers={'Authorization': f'Bearer {key}'},
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read())
            for row in (data or {}).get('data') or []:
                if row.get('id') == 'weekly-free':
                    name = str(row.get('name') or '').strip()
                    if name:
                        label = f'Weekly Free ({name})'
                    break
        except Exception as exc:  # noqa: BLE001 - never block seeding
            logger.info(
                'nimbus_catalog: could not read the weekly-free name (%s); '
                'using the generic label',
                type(exc).__name__,
            )

    _weekly_free_name_cache['label'] = label
    return label


def gateway_base_url() -> str | None:
    """The gateway every catalog model is served through."""
    return os.getenv('LLM_BASE_URL') or None


def _catalog_models() -> dict[str, str]:
    """``{display name: model id}`` for the whole catalog, order preserved."""
    out: dict[str, str] = {}
    for model in NIMBUS_CHAT_MODELS:
        name = _weekly_free_label() if model == _WEEKLY_FREE_ID else display_name(model)
        out[name] = model
    return out


def seed_catalog_profiles(settings: Any) -> bool:
    """Add a profile for each catalog model the user does not already have.

    Returns True when anything changed, so the caller knows whether a write is
    warranted — this runs on every settings load and must not turn each one
    into a store().

    Only ever ADDS. An existing profile of the same name is left completely
    alone, including one the user edited to point somewhere else: their
    configuration outranks the catalog. Seeding is also skipped entirely when
    the gateway URL is unknown, because a profile without one resolves to the
    provider's own endpoint (see the module docstring).
    """
    base_url = gateway_base_url()
    if not base_url:
        logger.warning(
            'nimbus_catalog_profiles: LLM_BASE_URL is unset — not seeding model '
            'profiles, since profiles without a base_url would resolve to the '
            'provider endpoint instead of the Nimbus gateway'
        )
        return False

    profiles = getattr(settings, 'llm_profiles', None)
    if profiles is None:
        return False

    from openhands.sdk.llm import LLM  # noqa: PLC0415

    changed = False
    for name, model in _catalog_models().items():
        if profiles.has(name):
            continue
        try:
            # Written straight into the dict rather than through save(): save()
            # enforces MAX_PROFILES_PER_USER, which exists to bound what a USER
            # can accumulate. These are deployment catalog entries, and letting
            # that cap decide how much of our own catalog is visible would mean
            # the picker silently showed the first N models.
            profiles.profiles[name] = LLM(model=model, base_url=base_url)
            changed = True
        except Exception as e:  # noqa: BLE001 - one bad model must not block the rest
            logger.warning(
                'nimbus_catalog_profiles: could not seed profile %r (%s): %s',
                name,
                model,
                e,
            )

    if changed and profiles.active is None:
        default_name = display_name(NIMBUS_DEFAULT_MODEL)
        if profiles.has(default_name):
            profiles.active = default_name

    if changed:
        logger.info(
            'nimbus_catalog_profiles: seeded model profiles (now %d)',
            len(profiles.profiles),
        )
    return changed


def prune_retired_catalog_profiles(settings: Any) -> bool:
    """Remove seeded profiles whose model has left the catalog.

    Seeding only ever ADDS, which leaves a hole: a model withdrawn from
    NIMBUS_CHAT_MODELS keeps its profile forever, so the picker goes on offering
    something that cannot answer. That is exactly the failure the withdrawal was
    meant to prevent — alibaba/qwen3.8-max was pulled because it 404s through our
    own gateway, and every account seeded before the pull still had it listed.

    Only removes profiles this module could have created: no API key of its own
    and a base_url equal to the gateway. A profile the user made, or edited to
    point elsewhere, or gave a key to, is left alone even if its model is not in
    the catalog — that is a deliberate BYOR choice and not ours to delete.

    The active profile is cleared if it pointed at a pruned entry, so the picker
    falls back rather than showing a selection that no longer exists.
    """
    base_url = gateway_base_url()
    if not base_url:
        return False

    profiles = getattr(settings, 'llm_profiles', None)
    if profiles is None:
        return False

    catalog = set(NIMBUS_CHAT_MODELS)
    removed: list[str] = []
    for name, llm in list(profiles.profiles.items()):
        if getattr(llm, 'model', None) in catalog:
            continue
        if getattr(llm, 'base_url', None) != base_url:
            continue  # points somewhere else — the user's, not ours
        key = getattr(llm, 'api_key', None)
        plain = key.get_secret_value() if hasattr(key, 'get_secret_value') else key
        if plain:
            continue  # carries its own credential — user-configured
        removed.append(name)

    if not removed:
        return False

    for name in removed:
        profiles.profiles.pop(name, None)
    if profiles.active in removed:
        profiles.active = None

    logger.info(
        'nimbus_catalog_profiles: pruned %d retired profile(s): %s',
        len(removed),
        ', '.join(removed),
    )
    return True


def repair_catalog_profile_base_urls(settings: Any) -> bool:
    """Re-point seeded profiles at the CURRENT gateway.

    The same reasoning as ``NimbusSettingsStore._repair_base_url``: the gateway
    URL is deployment infrastructure and moved once already today (dropping its
    ``/v1`` so both wire formats could be served). A profile frozen at the old
    value 404s forever, and nobody would connect a dead model picker entry to a
    base URL written weeks earlier.

    Scoped to catalog models on purpose. A profile for some other model may
    legitimately point at a third-party endpoint with the user's own key, and
    rewriting that to the Nimbus gateway would break it and misroute their
    traffic. Catalog models are only ever served by us, so for those the
    gateway is the only correct answer.
    """
    want = gateway_base_url()
    if not want:
        return False

    profiles = getattr(settings, 'llm_profiles', None)
    if profiles is None:
        return False

    catalog = set(NIMBUS_CHAT_MODELS)
    changed = False
    for name, llm in list(profiles.profiles.items()):
        if getattr(llm, 'model', None) not in catalog:
            continue
        have = getattr(llm, 'base_url', None)
        if have == want:
            continue
        try:
            profiles.profiles[name] = llm.model_copy(update={'base_url': want})
            changed = True
            logger.info(
                'nimbus_catalog_profiles: repaired base_url %r -> %r on profile %r',
                have,
                want,
                name,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(
                'nimbus_catalog_profiles: could not repair base_url on %r: %s',
                name,
                e,
            )
    return changed
