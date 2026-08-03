"""Process-based sandbox service implementation.

This service creates sandboxes by spawning separate agent server processes,
each running within a dedicated directory.
"""

import asyncio
import json
import logging
import os
import socket
import subprocess

import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime
from typing import AsyncGenerator

import base62
import httpx
import psutil
from fastapi import Request
from openhands.agent_server.utils import utc_now
from pydantic import BaseModel, ConfigDict, Field

from openhands.app_server.errors import SandboxError
from openhands.app_server.sandbox.nimbus_uid_allocator import (
    can_isolate,
    uid_for_user,
)
from openhands.app_server.sandbox.sandbox_models import (
    AGENT_SERVER,
    ExposedUrl,
    SandboxInfo,
    SandboxPage,
    SandboxRecord,
    SandboxStatus,
)
from openhands.app_server.sandbox.sandbox_service import (
    WEBHOOK_CALLBACK_VARIABLE,
    SandboxService,
    SandboxServiceInjector,
)
from openhands.app_server.sandbox.sandbox_spec_models import SandboxSpecInfo
from openhands.app_server.sandbox.sandbox_spec_service import (
    SandboxSpecService,
    resolve_sandbox_spec,
)
from openhands.app_server.services.injector import InjectorState

_logger = logging.getLogger(__name__)


def _local_agent_url(port: int, path: str = '') -> str:
    """URL for reaching a ProcessSandbox child from the same container.

    ProcessSandbox spawns the child agent-server as a sibling PROCESS in the
    same container, so localhost is always the correct hostname. The generic
    ``replace_localhost_hostname_for_docker`` helper is designed for the case
    where the parent needs to reach a sibling CONTAINER (Docker sandbox) and
    would rewrite this to ``host.docker.internal`` — that hostname does not
    resolve in ACA / k8s-underlaid environments where cgroups contain
    ``kubepods`` and ``is_running_in_docker()`` returns True, breaking
    ProcessSandbox health checks. Keep localhost here regardless of runtime.
    """
    return f'http://localhost:{port}{path}'


class ProcessInfo(BaseModel):
    """Information about a running process."""

    pid: int
    port: int
    user_id: str | None
    working_dir: str
    session_api_key: str
    created_at: datetime
    sandbox_spec_id: str

    model_config = ConfigDict(frozen=True)


# Global store
_processes: dict[str, ProcessInfo] = {}


@dataclass
class ProcessSandboxService(SandboxService):
    """Sandbox service that spawns separate agent server processes.

    Each sandbox is implemented as a separate Python process running the
    action execution server, with each process:
    - Operating in a dedicated directory
    - Listening on a unique port
    - Having its own session API key
    """

    user_id: str | None
    sandbox_spec_service: SandboxSpecService
    base_working_dir: str
    base_port: int
    python_executable: str
    agent_server_module: str
    health_check_path: str
    httpx_client: httpx.AsyncClient
    default_sandbox_spec_id: str | None = None

    def __post_init__(self):
        """Initialize the service after dataclass creation."""
        # Ensure base working directory exists
        os.makedirs(self.base_working_dir, exist_ok=True)

    def _find_unused_port(self) -> int:
        """Find an unused port starting from base_port."""
        port = self.base_port
        while port < self.base_port + 10000:  # Try up to 10000 ports
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.bind(('', port))
                    return port
            except OSError:
                port += 1
        raise SandboxError('No available ports found')

    def _create_sandbox_directory(self, sandbox_id: str) -> str:
        """Create a dedicated directory for the sandbox, owned by its customer.

        Each sandbox already got its own directory, but every one of them was
        created and run as the SAME OS user with default permissions - so the
        shell the agent hands a customer could simply walk up one level and read
        another customer's workspace. Separate directories are not isolation if
        one uid owns them all.
        """
        sandbox_dir = os.path.join(self.base_working_dir, sandbox_id)
        os.makedirs(sandbox_dir, exist_ok=True)

        uid = uid_for_user(self.user_id)
        if uid is None or not can_isolate():
            if uid is not None and not can_isolate():
                # Do not fail the request, but never let this pass silently -
                # the deployment believes it is isolating customers.
                _logger.error(
                    'nimbus_isolation: not running as root, cannot chown sandbox '
                    '%s to uid %s - agent processes will share an OS user and '
                    'CAN read each other files',
                    sandbox_id,
                    uid,
                )
            return sandbox_dir

        # The parent must stay traversable so a child can reach its own
        # directory, but NOT listable, so it cannot enumerate its neighbours.
        try:
            os.chmod(self.base_working_dir, 0o711)
        except OSError as e:
            _logger.warning('nimbus_isolation: could not chmod base dir: %s', e)

        os.chown(sandbox_dir, uid, uid)
        os.chmod(sandbox_dir, 0o700)
        _logger.info(
            'nimbus_isolation: sandbox %s owned by uid %s (mode 0700)',
            sandbox_id,
            uid,
        )
        return sandbox_dir

    async def _start_agent_process(
        self,
        sandbox_id: str,
        port: int,
        working_dir: str,
        session_api_key: str,
        sandbox_spec: SandboxSpecInfo,
    ) -> subprocess.Popen:
        """Start the agent server process."""

        # Prepare environment variables
        env = os.environ.copy()
        env.update(sandbox_spec.initial_env)
        env['SESSION_API_KEY'] = session_api_key

        # Tell the agent server where to POST its events, or nothing is ever
        # persisted.
        #
        # Events reach durable storage exactly one way in this runtime: the
        # agent server POSTs them to the app server's /api/v1/webhooks, which
        # calls event_service.save_event(). remote_sandbox_service sets this
        # variable; THIS service never did. So with RUNTIME=process the child
        # had no callback address, sent nothing, and every conversation's
        # history lived only in that process's memory.
        #
        # Measured on production 2026-08-03 before this fix: three
        # conversations, all with completed multi-step agent runs, and
        # /conversation/{id}/events/count returned 0 for every one. Any restart
        # - a deploy, a scale event, a crash - left customers looking at "This
        # conversation is archived and read-only / No conversation history
        # available" with the transcript gone for good. The Azure Files mount
        # at OH_PERSISTENCE_DIR had been configured correctly the whole time;
        # nothing was ever handed to it.
        #
        # Loopback by default: the agent server is a child process on this same
        # host, so the callback never needs to leave the box. Overridable for
        # deployments where the app server is fronted differently.
        webhook_base = os.getenv('OH_APP_SERVER_WEBHOOK_BASE_URL') or (
            f'http://127.0.0.1:{os.getenv("PORT", "3000")}'
        )
        env[WEBHOOK_CALLBACK_VARIABLE] = f'{webhook_base}/api/v1/webhooks'

        # ...and how to authenticate when it gets there.
        #
        # The base URL alone is not enough. /api/v1/webhooks authenticates on
        # X-Session-API-Key (valid_sandbox -> get_sandbox_record_by_session_
        # api_key), and WebhookSpec carries its own `headers` dict for exactly
        # this. Without it the agent server posts anonymously and every event
        # comes back 401 Unauthorized — observed on production 2026-08-03 after
        # the callback URL alone was added: the POSTs finally appeared in the
        # log, and every one of them was rejected.
        #
        # This is the same key the child already uses to authenticate INBOUND
        # requests, so it needs no new secret, and the lookup it feeds resolves
        # only to this sandbox's own record.
        env['OH_WEBHOOKS_0_HEADERS'] = json.dumps(
            {'X-Session-API-Key': session_api_key}
        )

        # Prepare command arguments
        cmd = [
            self.python_executable,
            '-m',
            self.agent_server_module,
            '--port',
            str(port),
        ]

        _logger.info(
            f'Starting agent process for sandbox {sandbox_id}: {" ".join(cmd)}'
        )

        try:
            # Start the process, directing output to a log file to avoid pipe-buffer deadlocks
            log_path = os.path.join(working_dir, '.openhands-agent-server.log')
            # Drop privileges to the customer's own uid. Popen(user=/group=) is
            # available on Python 3.9+ and the image is 3.13. The log file is
            # opened by the parent and inherited as a file descriptor, so the
            # child can still write to it without owning it.
            uid = uid_for_user(self.user_id)
            spawn_kwargs: dict = {}
            if uid is not None and can_isolate():
                spawn_kwargs['user'] = uid
                spawn_kwargs['group'] = uid
                # HOME must live inside the sandbox: left pointing at the app
                # user's home, tooling would write there as the customer's uid
                # and either fail or leak between customers.
                env['HOME'] = working_dir
            with open(log_path, 'a', buffering=1) as log_handle:
                try:
                    process = subprocess.Popen(
                        cmd,
                        env=env,
                        cwd=working_dir,
                        stdout=log_handle,
                        stderr=log_handle,
                        **spawn_kwargs,
                    )
                except (PermissionError, OSError) as e:
                    # Dropping privileges must never be able to take chat down.
                    #
                    # It did, once: the customer uid could not execute
                    # /app/.venv/bin/python because the venv was not readable by
                    # other users, so every conversation died with
                    #   PermissionError: [Errno 13] Permission denied
                    # and the failure looked like a chat outage rather than a
                    # permissions problem. The Dockerfile now chmods the runtime
                    # a+rX, but a hard dependency on image permissions is a bad
                    # bet for something that silently breaks conversations.
                    #
                    # Retry unisolated and say so at ERROR level. Weaker
                    # isolation that is visible beats strong isolation that
                    # takes the product offline, and this line is what tells
                    # someone which one they have.
                    if not spawn_kwargs:
                        raise
                    _logger.error(
                        'nimbus_isolation: could not spawn agent as uid %s (%s) - '
                        'falling back to the shared app user, so this sandbox is '
                        'NOT file-isolated from other customers',
                        spawn_kwargs.get('user'),
                        e,
                    )
                    process = subprocess.Popen(
                        cmd,
                        env=env,
                        cwd=working_dir,
                        stdout=log_handle,
                        stderr=log_handle,
                    )

            # Wait a moment for the process to start
            await asyncio.sleep(1)

            # Check if process is still running
            if process.poll() is not None:
                raise SandboxError(
                    f'Agent process failed to start (exit code {process.returncode}). '
                    f'See {log_path} for details.'
                )

            return process

        except Exception as e:
            raise SandboxError('Failed to start agent process') from e

    async def _wait_for_server_ready(self, port: int, timeout: int = 30) -> bool:
        """Wait for the agent server to be ready."""
        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                url = _local_agent_url(port, '/alive')
                response = await self.httpx_client.get(url, timeout=5.0)
                if response.status_code == 200:
                    data = response.json()
                    if data.get('status') == 'ok':
                        return True
            except Exception:
                pass
            await asyncio.sleep(1)
        return False

    def _get_process_status(self, process_info: ProcessInfo) -> SandboxStatus:
        """Get the status of a process.

        A healthy uvicorn worker spends almost all its time in
        ``psutil.STATUS_SLEEPING`` (kernel state ``S``) waiting on I/O — only
        code actively burning CPU is briefly in ``STATUS_RUNNING`` (``R``).
        Treating anything alive-and-not-stopped as RUNNING here matches
        operator intent: the aliveness of the HTTP server is verified via the
        ``/alive`` probe in ``_process_to_sandbox_info`` and the outer
        ``wait_for_sandbox_running`` loop, which is where a real ERROR is
        surfaced. Keeping only ``STATUS_RUNNING`` == RUNNING here caused the
        120s outer poll to time out on every ProcessSandbox start.
        """
        try:
            process = psutil.Process(process_info.pid)
            if not process.is_running():
                return SandboxStatus.MISSING
            status = process.status()
            if status == psutil.STATUS_STOPPED:
                return SandboxStatus.PAUSED
            if status in (psutil.STATUS_ZOMBIE, psutil.STATUS_DEAD):
                return SandboxStatus.MISSING
            # Sleeping (idle I/O wait), running, disk-sleep, etc. all mean
            # "the process is up" from a supervisor perspective.
            return SandboxStatus.RUNNING
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return SandboxStatus.MISSING

    async def _process_to_sandbox_info(
        self, sandbox_id: str, process_info: ProcessInfo
    ) -> SandboxInfo:
        """Convert process info to sandbox info."""
        status = self._get_process_status(process_info)

        exposed_urls = None
        session_api_key = None

        if status == SandboxStatus.RUNNING:
            # Check if server is actually responding
            try:
                url = _local_agent_url(process_info.port, self.health_check_path)
                response = await self.httpx_client.get(url, timeout=5.0)
                if response.status_code == 200:
                    exposed_urls = [
                        ExposedUrl(
                            name=AGENT_SERVER,
                            url=_local_agent_url(process_info.port),
                            port=process_info.port,
                        ),
                    ]
                    session_api_key = process_info.session_api_key
                else:
                    status = SandboxStatus.ERROR
            except Exception:
                status = SandboxStatus.ERROR

        return SandboxInfo(
            id=sandbox_id,
            created_by_user_id=process_info.user_id,
            sandbox_spec_id=process_info.sandbox_spec_id,
            status=status,
            session_api_key=session_api_key,
            exposed_urls=exposed_urls,
            created_at=process_info.created_at,
        )

    async def search_sandboxes(
        self,
        page_id: str | None = None,
        limit: int = 100,
    ) -> SandboxPage:
        """Search for sandboxes."""
        # Get all process infos
        all_processes = list(_processes.items())

        # Sort by creation time (newest first)
        all_processes.sort(key=lambda x: x[1].created_at, reverse=True)

        # Apply pagination
        start_idx = 0
        if page_id:
            try:
                start_idx = int(page_id)
            except ValueError:
                start_idx = 0

        end_idx = start_idx + limit
        paginated_processes = all_processes[start_idx:end_idx]

        # Convert to sandbox infos
        items = []
        for sandbox_id, process_info in paginated_processes:
            sandbox_info = await self._process_to_sandbox_info(sandbox_id, process_info)
            items.append(sandbox_info)

        # Determine next page ID
        next_page_id = None
        if end_idx < len(all_processes):
            next_page_id = str(end_idx)

        return SandboxPage(items=items, next_page_id=next_page_id)

    async def get_sandbox(self, sandbox_id: str) -> SandboxInfo | None:
        """Get a single sandbox."""
        process_info = _processes.get(sandbox_id)
        if process_info is None:
            return None

        return await self._process_to_sandbox_info(sandbox_id, process_info)

    async def get_sandbox_by_session_api_key(
        self, session_api_key: str
    ) -> SandboxInfo | None:
        """Get a single sandbox by session API key."""
        # Search through all processes to find one with matching session_api_key
        for sandbox_id, process_info in _processes.items():
            if process_info.session_api_key == session_api_key:
                return await self._process_to_sandbox_info(sandbox_id, process_info)

        return None

    async def get_sandbox_record_by_session_api_key(
        self, session_api_key: str
    ) -> SandboxRecord | None:
        """Get persisted sandbox identity by session API key."""
        for sandbox_id, process_info in _processes.items():
            if process_info.session_api_key == session_api_key:
                return SandboxRecord(
                    id=sandbox_id,
                    created_by_user_id=process_info.user_id,
                )
        return None

    async def start_sandbox(
        self, sandbox_spec_id: str | None = None, sandbox_id: str | None = None
    ) -> SandboxInfo:
        """Start a new sandbox."""
        # Get sandbox spec
        sandbox_spec = await resolve_sandbox_spec(
            sandbox_spec_id,
            self.default_sandbox_spec_id,
            self.sandbox_spec_service,
            _logger,
        )

        # Generate unique sandbox ID and session API key
        # Use provided sandbox_id if available, otherwise generate a random one
        if sandbox_id is None:
            sandbox_id = base62.encodebytes(os.urandom(16))
        session_api_key = base62.encodebytes(os.urandom(32))

        # Find available port
        port = self._find_unused_port()

        # Create sandbox directory
        working_dir = self._create_sandbox_directory(sandbox_id)

        # Start the agent process
        process = await self._start_agent_process(
            sandbox_id=sandbox_id,
            port=port,
            working_dir=working_dir,
            session_api_key=session_api_key,
            sandbox_spec=sandbox_spec,
        )

        # Store process info
        process_info = ProcessInfo(
            pid=process.pid,
            port=port,
            user_id=self.user_id,
            working_dir=working_dir,
            session_api_key=session_api_key,
            created_at=utc_now(),
            sandbox_spec_id=sandbox_spec.id,
        )
        _processes[sandbox_id] = process_info

        # Wait for server to be ready
        if not await self._wait_for_server_ready(port):
            # Clean up if server didn't start properly
            await self.delete_sandbox(sandbox_id)
            raise SandboxError('Agent Server Failed to start properly')

        return await self._process_to_sandbox_info(sandbox_id, process_info)

    async def resume_sandbox(self, sandbox_id: str) -> bool:
        """Resume a paused sandbox."""
        process_info = _processes.get(sandbox_id)
        if process_info is None:
            return False

        try:
            process = psutil.Process(process_info.pid)
            if process.status() == psutil.STATUS_STOPPED:
                process.resume()
            return True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False

    async def pause_sandbox(self, sandbox_id: str) -> bool:
        """Pause a running sandbox."""
        process_info = _processes.get(sandbox_id)
        if process_info is None:
            return False

        try:
            process = psutil.Process(process_info.pid)
            if process.is_running():
                process.suspend()
            return True
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return False

    async def delete_sandbox(self, sandbox_id: str) -> bool:
        """Delete a sandbox. (No workspace archiving for local processes.)"""
        process_info = _processes.get(sandbox_id)
        if process_info is None:
            return False

        try:
            # Terminate the process
            process = psutil.Process(process_info.pid)
            if process.is_running():
                # Try graceful termination first
                process.terminate()
                try:
                    process.wait(timeout=10)
                except psutil.TimeoutExpired:
                    # Force kill if graceful termination fails
                    process.kill()
                    process.wait(timeout=5)

            # Clean up the working directory
            import shutil

            if os.path.exists(process_info.working_dir):
                shutil.rmtree(process_info.working_dir, ignore_errors=True)

            # Remove from our tracking
            del _processes[sandbox_id]

            return True

        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError) as e:
            _logger.warning(f'Error deleting sandbox {sandbox_id}: {e}')
            # Still remove from tracking even if cleanup failed
            if sandbox_id in _processes:
                del _processes[sandbox_id]
            return True


class ProcessSandboxServiceInjector(SandboxServiceInjector):
    """Dependency injector for process sandbox services."""

    base_working_dir: str = Field(
        default_factory=lambda: os.path.join(
            tempfile.gettempdir(), 'openhands-sandboxes'
        ),
        description='Base directory for sandbox working directories',
    )
    base_port: int = Field(
        default=8000, description='Base port number for agent servers'
    )
    python_executable: str = Field(
        default=sys.executable,
        description='Python executable to use for agent processes',
    )
    agent_server_module: str = Field(
        default='openhands.agent_server',
        description='Python module for the agent server',
    )
    health_check_path: str = Field(
        default='/alive', description='Health check endpoint path'
    )

    async def inject(
        self, state: InjectorState, request: Request | None = None
    ) -> AsyncGenerator[SandboxService, None]:
        # Define inline to prevent circular lookup
        from openhands.app_server.config import (
            get_httpx_client,
            get_sandbox_spec_service,
            get_user_context,
        )

        async with (
            get_httpx_client(state, request) as httpx_client,
            get_sandbox_spec_service(state, request) as sandbox_spec_service,
            get_user_context(state, request) as user_context,
        ):
            user_id = await user_context.get_user_id()
            default_sandbox_spec_id = await user_context.get_default_sandbox_spec_id()
            yield ProcessSandboxService(
                user_id=user_id,
                sandbox_spec_service=sandbox_spec_service,
                base_working_dir=self.base_working_dir,
                base_port=self.base_port,
                python_executable=self.python_executable,
                agent_server_module=self.agent_server_module,
                health_check_path=self.health_check_path,
                httpx_client=httpx_client,
                default_sandbox_spec_id=default_sandbox_spec_id,
            )
