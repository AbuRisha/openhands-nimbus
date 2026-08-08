"""`/server_info` must say which build is serving.

On 2026-08-08 three different images all reported the same `app_version` and
`sdk_version`, because those are package versions that change only on release.
Establishing whether a deployed revision carried a specific fix took a 48-second
`az acr run` task that executed the image and grepped a source file. These
fields make it a curl.
"""

import importlib

import pytest


def _reload_router(monkeypatch, build=None, sha=None):
    """Re-import the router so its module-level env reads happen again.

    The values are read ONCE at import, deliberately — they cannot change while
    the process lives. That means a test cannot just monkeypatch os.environ and
    call the endpoint; it has to reload the module, and this helper is the one
    place that knowledge lives.
    """
    for name, value in (
        ('OPENHANDS_BUILD_VERSION', build),
        ('OPENHANDS_GIT_SHA', sha),
    ):
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)

    from openhands.app_server.status import status_router

    return importlib.reload(status_router)


@pytest.mark.asyncio
async def test_reports_the_build_it_was_built_from(monkeypatch):
    mod = _reload_router(
        monkeypatch, build='forkverify-20260808', sha='c36b84e88deadbeef'
    )

    info = await mod.get_server_info()

    assert info['build_version'] == 'forkverify-20260808'
    assert info['git_sha'] == 'c36b84e88deadbeef'


@pytest.mark.asyncio
async def test_keeps_the_existing_fields(monkeypatch):
    """Additive only. Anything already parsing this response must keep working."""
    mod = _reload_router(monkeypatch, build='x', sha='y')

    info = await mod.get_server_info()

    for key in ('uptime', 'idle_time', 'app_version', 'sdk_version', 'resources'):
        assert key in info, key


@pytest.mark.asyncio
async def test_unset_reports_unknown_rather_than_omitting(monkeypatch):
    """A local `docker build` passes no build args.

    "unknown" is visibly missing; an absent KEY looks like an older response
    shape and sends the reader looking for a deployment problem that is not
    there.
    """
    mod = _reload_router(monkeypatch, build=None, sha=None)

    info = await mod.get_server_info()

    assert info['build_version'] == 'unknown'
    assert info['git_sha'] == 'unknown'


@pytest.mark.asyncio
async def test_empty_string_is_treated_as_unset(monkeypatch):
    """`ENV FOO=$UNSET_ARG` in a Dockerfile yields an EMPTY string, not an absent
    variable — so `os.getenv(name, 'unknown')` would report '' and render as a
    blank field. The `or` fallback is what makes that read as unknown."""
    mod = _reload_router(monkeypatch, build='', sha='')

    info = await mod.get_server_info()

    assert info['build_version'] == 'unknown'
    assert info['git_sha'] == 'unknown'
