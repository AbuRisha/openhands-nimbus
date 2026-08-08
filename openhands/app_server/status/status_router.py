import os

from fastapi import APIRouter

from openhands.app_server.status.system_stats import get_system_info

# Baked in at image build time -- see containers/app/Dockerfile. Read ONCE at
# import: these cannot change while the process lives, and re-reading per
# request would imply they might.
_BUILD_VERSION = os.getenv('OPENHANDS_BUILD_VERSION') or 'unknown'
_GIT_SHA = os.getenv('OPENHANDS_GIT_SHA') or 'unknown'

router = APIRouter(tags=['Status'])


@router.get('/alive')
async def alive():
    """Endpoint for liveness probes.

    If this responds then the server is considered alive.
    """
    return {'status': 'ok'}


@router.get('/health')
async def health() -> str:
    """Health check endpoint.

    Returns 'OK' if the service is healthy and ready to accept requests.
    This is typically used by load balancers and orchestrators (e.g., Kubernetes)
    to determine if the service should receive traffic.
    """
    return 'OK'


@router.get('/server_info')
async def get_server_info():
    """Server information endpoint.

    Returns system information including CPU count, memory usage, and
    other runtime details about the server. Useful for monitoring and
    debugging purposes.

    ALSO REPORTS WHICH BUILD IS SERVING. `app_version` and `sdk_version` are
    package versions and change only on release, so on 2026-08-08 they were
    identical across three different images and could not distinguish a
    revision that carried a specific fix from one that did not. Answering that
    took a 48-second `az acr run` task that executed the image and grepped a
    source file. `build_version` and `git_sha` make it a curl, with no Azure
    access required.

    Both default to "unknown" rather than being omitted, so a missing value is
    visibly missing instead of looking like an older response shape. `unknown`
    means the image was built without the build args -- a local `docker build`,
    typically -- not that the endpoint is broken.

    The fields are merged HERE rather than in `system_stats.get_system_info`,
    because that module carries a Legacy-V0 do-not-extend banner and is
    scheduled for removal.
    """
    return {
        **get_system_info(),
        'build_version': _BUILD_VERSION,
        'git_sha': _GIT_SHA,
    }


@router.get('/ready')
async def ready() -> str:
    """Endpoint for readiness probes.

    For now this is functionally the same as the liveness probe, but should
    we need to establish further invariants in the future, having a separate
    endpoint will mean we don't need to change client code.
    """
    return 'OK'
