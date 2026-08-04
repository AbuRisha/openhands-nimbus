"""The sandbox must never inherit a credential.

RUNTIME=process makes the sandbox a child of the app container, so before the
allowlist it received the container's environment wholesale — DB_PASS, the full
DB connection details, LLM_API_KEY, NIMBUS_API_KEY and NIMBUS_SSO_SHARED_SECRET,
all readable by agent-authored code. An agent read them and printed them in its
own transcript, which is how it was found.

These tests exist because the fix is one line away from being undone: someone
restores ``os.environ.copy()``, or adds a secret to the Container App and
assumes it is covered. The first case is caught by the leak tests below; the
second by test_unknown_variables_are_dropped, which is the property that makes
this an allowlist rather than a denylist.

The counterpart matters just as much. The first version of the allowlist was
built from the Container App's 24 variables and silently dropped the ~15 the
IMAGE sets (CHROME_BIN, FILE_STORE, WORKSPACE_BASE, TIKTOKEN_CACHE_DIR...). The
agent server still imported cleanly, so a startup check passed, and
conversations then failed at runtime with execution_status "error". So there are
tests here for what must SURVIVE too — a sandbox with no browser binary is not a
safer sandbox, it is a broken one.
"""

from __future__ import annotations

import pytest

from openhands.app_server.sandbox.process_sandbox_service import _sandbox_base_env

# Exactly what the Container App holds as secretRef, plus the connection
# details that make the database password useful.
CREDENTIALS = [
    'DB_PASS',
    'LLM_API_KEY',
    'NIMBUS_API_KEY',
    'NIMBUS_SSO_SHARED_SECRET',
]

DB_TOPOLOGY = [
    'DB_HOST',
    'DB_USER',
    'DB_NAME',
    'DB_PORT',
    'DB_SSL_MODE',
]

# Set by the image rather than the deployment config. Every one is load-bearing
# at runtime, and dropping them is what broke the first attempt.
OPERATIONAL = [
    'PATH',
    'HOME',
    'CHROME_BIN',
    'PLAYWRIGHT_BROWSERS_PATH',
    'FILE_STORE',
    'FILE_STORE_PATH',
    'WORKSPACE_BASE',
    'TIKTOKEN_CACHE_DIR',
    'OPENHANDS_CONFIG_CLS',
    'RUN_AS_OPENHANDS',
    'SANDBOX_USER_ID',
    'OH_PERSISTENCE_DIR',
    'LLM_BASE_URL',
    'LLM_MODEL',
]


@pytest.fixture(autouse=True)
def _production_like_env(monkeypatch):
    """Recreate the real container environment, secrets and all."""
    for name in CREDENTIALS:
        monkeypatch.setenv(name, f'SECRET-VALUE-{name}')
    for name in DB_TOPOLOGY:
        monkeypatch.setenv(name, f'topology-{name}')
    for name in OPERATIONAL:
        monkeypatch.setenv(name, f'operational-{name}')


@pytest.mark.parametrize('name', CREDENTIALS)
def test_credentials_never_reach_the_sandbox(name):
    assert name not in _sandbox_base_env(), (
        f'{name} would be readable by agent-authored code in every sandbox'
    )


def test_no_credential_VALUE_leaks_under_any_name():
    """Guards against a rename or an alias smuggling the same value through.

    Checking names alone would miss `DATABASE_PASSWORD=<same secret>`.
    """
    leaked = [
        key
        for key, value in _sandbox_base_env().items()
        if value.startswith('SECRET-VALUE-')
    ]
    assert leaked == [], f'credential values present under: {leaked}'


@pytest.mark.parametrize('name', DB_TOPOLOGY)
def test_database_topology_stays_out(name):
    """The agent server never talks to Postgres — it POSTs to the webhook."""
    assert name not in _sandbox_base_env()


@pytest.mark.parametrize('name', OPERATIONAL)
def test_operational_configuration_survives(name):
    """A sandbox without its browser binary or file store is broken, not safe."""
    assert name in _sandbox_base_env(), (
        f'{name} is needed at runtime; dropping it fails conversations with '
        'execution_status "error" while still importing cleanly'
    )


def test_unknown_variables_are_dropped():
    """The allowlist property, and the whole reason it is not a denylist.

    A denylist fails open the next time someone adds a secret to the Container
    App — which is exactly how the original leak happened.
    """
    import os

    os.environ['SOME_FUTURE_SECRET'] = 'not-yet-imagined'
    try:
        assert 'SOME_FUTURE_SECRET' not in _sandbox_base_env()
    finally:
        os.environ.pop('SOME_FUTURE_SECRET', None)


def test_llm_routing_survives_without_the_key():
    """The child must still know WHERE to route, just not with what credential.

    The customer's own sk-nim-live- key arrives in the conversation payload.
    """
    env = _sandbox_base_env()
    assert 'LLM_BASE_URL' in env
    assert 'LLM_MODEL' in env
    assert 'LLM_API_KEY' not in env
