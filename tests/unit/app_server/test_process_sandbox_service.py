"""Tests for ProcessSandboxService."""

import os
import tempfile
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import psutil
import pytest

from openhands.app_server.sandbox.process_sandbox_service import (
    ProcessInfo,
    ProcessSandboxService,
    ProcessSandboxServiceInjector,
)
from openhands.app_server.sandbox.sandbox_models import SandboxStatus


class MockSandboxSpec:
    """Mock sandbox specification."""

    def __init__(self):
        self.id = 'test-spec'
        self.initial_env = {'TEST_VAR': 'test_value'}
        self.plugins = []


class MockSandboxSpecService:
    """Mock sandbox spec service."""

    async def get_default_sandbox_spec(self):
        return MockSandboxSpec()

    async def get_sandbox_spec(self, spec_id: str):
        if spec_id == 'test-spec':
            return MockSandboxSpec()
        return None


@pytest.fixture
def mock_httpx_client():
    """Mock httpx client."""
    client = AsyncMock(spec=httpx.AsyncClient)
    return client


@pytest.fixture
def temp_dir():
    """Create a temporary directory for testing."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


@pytest.fixture
def process_sandbox_service(mock_httpx_client, temp_dir):
    """Create a ProcessSandboxService instance for testing."""
    return ProcessSandboxService(
        user_id='test-user-id',
        sandbox_spec_service=MockSandboxSpecService(),
        base_working_dir=temp_dir,
        base_port=9000,
        python_executable='python',
        agent_server_module='openhands.agent_server',
        health_check_path='/alive',
        httpx_client=mock_httpx_client,
    )


class TestProcessSandboxService:
    """Test cases for ProcessSandboxService."""

    def test_find_unused_port(self, process_sandbox_service):
        """Test finding an unused port."""
        port = process_sandbox_service._find_unused_port()
        assert port >= process_sandbox_service.base_port
        assert port < process_sandbox_service.base_port + 10000

    @patch('os.makedirs')
    def test_create_sandbox_directory(self, mock_makedirs, process_sandbox_service):
        """Test creating a sandbox directory."""
        sandbox_dir = process_sandbox_service._create_sandbox_directory('test-id')

        expected_dir = os.path.join(process_sandbox_service.base_working_dir, 'test-id')
        assert sandbox_dir == expected_dir
        mock_makedirs.assert_called_once_with(expected_dir, exist_ok=True)

    @pytest.mark.asyncio
    async def test_wait_for_server_ready_success(self, process_sandbox_service):
        """Test waiting for server to be ready - success case."""
        # Mock successful response
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {'status': 'ok'}
        process_sandbox_service.httpx_client.get.return_value = mock_response

        result = await process_sandbox_service._wait_for_server_ready(9000, timeout=1)
        assert result is True

    @pytest.mark.asyncio
    async def test_wait_for_server_ready_timeout(self, process_sandbox_service):
        """Test waiting for server to be ready - timeout case."""
        # Mock failed response
        process_sandbox_service.httpx_client.get.side_effect = Exception(
            'Connection failed'
        )

        result = await process_sandbox_service._wait_for_server_ready(9000, timeout=1)
        assert result is False

    @patch('psutil.Process')
    def test_get_process_status_running(
        self, mock_process_class, process_sandbox_service
    ):
        """Test getting process status for running process."""
        mock_process = MagicMock()
        mock_process.is_running.return_value = True
        mock_process.status.return_value = psutil.STATUS_RUNNING
        mock_process_class.return_value = mock_process

        process_info = ProcessInfo(
            pid=1234,
            port=9000,
            user_id='test-user-id',
            working_dir='/tmp/test',
            session_api_key='test-key',
            created_at=datetime.now(),
            sandbox_spec_id='test-spec',
        )

        status = process_sandbox_service._get_process_status(process_info)
        assert status == SandboxStatus.RUNNING

    @patch('psutil.Process')
    def test_get_process_status_missing(
        self, mock_process_class, process_sandbox_service
    ):
        """Test getting process status for missing process."""
        import psutil

        mock_process_class.side_effect = psutil.NoSuchProcess(1234)

        process_info = ProcessInfo(
            pid=1234,
            port=9000,
            user_id='test-user-id',
            working_dir='/tmp/test',
            session_api_key='test-key',
            created_at=datetime.now(),
            sandbox_spec_id='test-spec',
        )

        status = process_sandbox_service._get_process_status(process_info)
        assert status == SandboxStatus.MISSING

    @pytest.mark.asyncio
    async def test_search_sandboxes_empty(self, process_sandbox_service):
        """Test searching sandboxes when none exist."""
        result = await process_sandbox_service.search_sandboxes()

        assert len(result.items) == 0
        assert result.next_page_id is None

    @pytest.mark.asyncio
    async def test_get_sandbox_not_found(self, process_sandbox_service):
        """Test getting a sandbox that doesn't exist."""
        result = await process_sandbox_service.get_sandbox('nonexistent')
        assert result is None

    @pytest.mark.asyncio
    async def test_resume_sandbox_not_found(self, process_sandbox_service):
        """Test resuming a sandbox that doesn't exist."""
        result = await process_sandbox_service.resume_sandbox('nonexistent')
        assert result is False

    @pytest.mark.asyncio
    async def test_pause_sandbox_not_found(self, process_sandbox_service):
        """Test pausing a sandbox that doesn't exist."""
        result = await process_sandbox_service.pause_sandbox('nonexistent')
        assert result is False

    @pytest.mark.asyncio
    async def test_delete_sandbox_not_found(self, process_sandbox_service):
        """Test deleting a sandbox that doesn't exist."""
        result = await process_sandbox_service.delete_sandbox('nonexistent')
        assert result is False

    @pytest.mark.asyncio
    async def test_start_sandbox_with_sandbox_id(self, process_sandbox_service):
        """Test starting a sandbox with a specified sandbox_id."""
        # Mock subprocess and waiting for server
        with (
            patch.object(
                process_sandbox_service, '_start_agent_process'
            ) as mock_start_process,
            patch.object(
                process_sandbox_service, '_wait_for_server_ready', return_value=True
            ),
            patch.object(
                process_sandbox_service,
                '_get_process_status',
                return_value=SandboxStatus.RUNNING,
            ),
        ):
            mock_process = MagicMock()
            mock_process.pid = 1234
            mock_start_process.return_value = mock_process

            # Mock successful health check response
            mock_response = MagicMock()
            mock_response.status_code = 200
            process_sandbox_service.httpx_client.get.return_value = mock_response

            # Execute with custom sandbox_id
            result = await process_sandbox_service.start_sandbox(
                sandbox_id='custom_sandbox_id'
            )

            # Verify
            assert result is not None
            assert result.id == 'custom_sandbox_id'

    @patch('psutil.Process')
    def test_get_process_status_paused(
        self, mock_process_class, process_sandbox_service
    ):
        """Test getting process status for paused process."""
        mock_process = MagicMock()
        mock_process.is_running.return_value = True
        mock_process.status.return_value = psutil.STATUS_STOPPED
        mock_process_class.return_value = mock_process

        process_info = ProcessInfo(
            pid=1234,
            port=9000,
            user_id='test-user-id',
            working_dir='/tmp/test',
            session_api_key='test-key',
            created_at=datetime.now(),
            sandbox_spec_id='test-spec',
        )

        status = process_sandbox_service._get_process_status(process_info)
        assert status == SandboxStatus.PAUSED

    @patch('psutil.Process')
    def test_get_process_status_starting(
        self, mock_process_class, process_sandbox_service
    ):
        """Test getting process status for starting process."""
        mock_process = MagicMock()
        mock_process.is_running.return_value = True
        mock_process.status.return_value = psutil.STATUS_SLEEPING
        mock_process_class.return_value = mock_process

        process_info = ProcessInfo(
            pid=1234,
            port=9000,
            user_id='test-user-id',
            working_dir='/tmp/test',
            session_api_key='test-key',
            created_at=datetime.now(),
            sandbox_spec_id='test-spec',
        )

        status = process_sandbox_service._get_process_status(process_info)
        assert status == SandboxStatus.STARTING

    @patch('psutil.Process')
    def test_get_process_status_access_denied(
        self, mock_process_class, process_sandbox_service
    ):
        """Test getting process status when access is denied."""
        mock_process_class.side_effect = psutil.AccessDenied(1234)

        process_info = ProcessInfo(
            pid=1234,
            port=9000,
            user_id='test-user-id',
            working_dir='/tmp/test',
            session_api_key='test-key',
            created_at=datetime.now(),
            sandbox_spec_id='test-spec',
        )

        status = process_sandbox_service._get_process_status(process_info)
        assert status == SandboxStatus.MISSING

    @pytest.mark.asyncio
    async def test_process_to_sandbox_info_error_status(self, process_sandbox_service):
        """Test converting process info to sandbox info when server is not responding."""
        # Mock a process that's running but server is not responding
        with patch.object(
            process_sandbox_service,
            '_get_process_status',
            return_value=SandboxStatus.RUNNING,
        ):
            # Mock httpx client to return error response
            mock_response = MagicMock()
            mock_response.status_code = 500
            process_sandbox_service.httpx_client.get.return_value = mock_response

            process_info = ProcessInfo(
                pid=1234,
                port=9000,
                user_id='test-user-id',
                working_dir='/tmp/test',
                session_api_key='test-key',
                created_at=datetime.now(),
                sandbox_spec_id='test-spec',
            )

            sandbox_info = await process_sandbox_service._process_to_sandbox_info(
                'test-sandbox', process_info
            )

            assert sandbox_info.status == SandboxStatus.ERROR
            assert sandbox_info.session_api_key is None
            assert sandbox_info.exposed_urls is None

    @pytest.mark.asyncio
    async def test_process_to_sandbox_info_exception(self, process_sandbox_service):
        """Test converting process info to sandbox info when httpx raises exception."""
        # Mock a process that's running but httpx raises exception
        with patch.object(
            process_sandbox_service,
            '_get_process_status',
            return_value=SandboxStatus.RUNNING,
        ):
            # Mock httpx client to raise exception
            process_sandbox_service.httpx_client.get.side_effect = Exception(
                'Connection failed'
            )

            process_info = ProcessInfo(
                pid=1234,
                port=9000,
                user_id='test-user-id',
                working_dir='/tmp/test',
                session_api_key='test-key',
                created_at=datetime.now(),
                sandbox_spec_id='test-spec',
            )

            sandbox_info = await process_sandbox_service._process_to_sandbox_info(
                'test-sandbox', process_info
            )

            assert sandbox_info.status == SandboxStatus.ERROR
            assert sandbox_info.session_api_key is None
            assert sandbox_info.exposed_urls is None


class TestProcessSandboxOwnershipScoping:
    """`_processes` is a module-global shared by every request in the worker.

    Listing it unfiltered handed each caller every other user's sandbox, and a
    RUNNING sandbox's ``SandboxInfo`` carries its ``session_api_key`` -- the
    credential the agent proxy accepts for file and git access into that sandbox.
    Verified against production 2026-08-08: two freshly-minted sessions owning
    nothing could both read a third user's sandbox and its key.

    These tests assert on the OWNER of what comes back, not merely on the count,
    so they still fail if a future filter keeps the right number of the wrong rows.
    """

    @staticmethod
    def _running(user_id: str | None, key: str) -> ProcessInfo:
        return ProcessInfo(
            pid=1234,
            port=9000,
            user_id=user_id,
            working_dir='/tmp/test',
            session_api_key=key,
            created_at=datetime.now(),
            sandbox_spec_id='test-spec',
        )

    @pytest.fixture
    def two_users_processes(self):
        """One sandbox owned by the caller, one owned by somebody else."""
        procs = {
            'mine': self._running('test-user-id', 'my-key'),
            'theirs': self._running('a-different-user', 'their-key'),
        }
        with patch(
            'openhands.app_server.sandbox.process_sandbox_service._processes', procs
        ):
            yield procs

    @pytest.mark.asyncio
    async def test_search_returns_only_the_callers_sandbox(
        self, process_sandbox_service, two_users_processes
    ):
        # MISSING status keeps _process_to_sandbox_info off the network; ownership
        # filtering happens before status is ever consulted.
        with patch('psutil.Process', side_effect=psutil.NoSuchProcess(1234)):
            page = await process_sandbox_service.search_sandboxes()

        assert [item.id for item in page.items] == ['mine']
        assert all(item.created_by_user_id == 'test-user-id' for item in page.items)

    @pytest.mark.asyncio
    async def test_get_sandbox_hides_another_users_sandbox(
        self, process_sandbox_service, two_users_processes
    ):
        with patch('psutil.Process', side_effect=psutil.NoSuchProcess(1234)):
            mine = await process_sandbox_service.get_sandbox('mine')
            theirs = await process_sandbox_service.get_sandbox('theirs')

        assert mine is not None
        # Absent rather than forbidden: callers map None to 404, and a 403 here
        # would confirm the id exists.
        assert theirs is None

    @pytest.mark.asyncio
    async def test_batch_get_nulls_out_another_users_sandbox(
        self, process_sandbox_service, two_users_processes
    ):
        """The batch route fans out to get_sandbox, so it inherits the scoping."""
        with patch('psutil.Process', side_effect=psutil.NoSuchProcess(1234)):
            results = await process_sandbox_service.batch_get_sandboxes(
                ['mine', 'theirs']
            )

        assert results[0] is not None
        assert results[1] is None

    @pytest.mark.asyncio
    async def test_session_api_key_of_another_user_is_never_returned(
        self, process_sandbox_service
    ):
        """The point of the whole fix, asserted on the credential itself.

        A RUNNING sandbox is the only case that populates `session_api_key`, so
        this is the state that actually leaked -- the earlier tests use MISSING
        processes and would pass even if RUNNING rows were exempt from filtering.
        """
        procs = {'theirs': self._running('a-different-user', 'their-secret-key')}
        mock_process = MagicMock()
        mock_process.is_running.return_value = True
        mock_process.status.return_value = psutil.STATUS_RUNNING

        response = MagicMock()
        response.status_code = 200
        process_sandbox_service.httpx_client.get = AsyncMock(return_value=response)

        with (
            patch(
                'openhands.app_server.sandbox.process_sandbox_service._processes', procs
            ),
            patch('psutil.Process', return_value=mock_process),
        ):
            page = await process_sandbox_service.search_sandboxes()
            direct = await process_sandbox_service.get_sandbox('theirs')

        assert page.items == []
        assert direct is None

    @pytest.mark.asyncio
    async def test_session_key_lookup_stays_unscoped(self, process_sandbox_service):
        """Server-to-server key auth must NOT be user-scoped.

        `validate_session_key` runs with no user context -- the key itself is the
        credential. Scoping this lookup would break the agent proxy and the
        in-sandbox secrets endpoints for every user at once, so it is asserted
        here to stop a later "make it consistent" change from doing that.
        """
        procs = {'theirs': self._running('a-different-user', 'their-key')}
        with (
            patch(
                'openhands.app_server.sandbox.process_sandbox_service._processes', procs
            ),
            patch('psutil.Process', side_effect=psutil.NoSuchProcess(1234)),
        ):
            found = await process_sandbox_service.get_sandbox_by_session_api_key(
                'their-key'
            )
            record = await (
                process_sandbox_service.get_sandbox_record_by_session_api_key(
                    'their-key'
                )
            )

        assert found is not None and found.id == 'theirs'
        assert record is not None and record.created_by_user_id == 'a-different-user'

    @pytest.mark.asyncio
    async def test_single_user_server_still_sees_its_own_sandboxes(
        self, mock_httpx_client, temp_dir
    ):
        """A falsy user id must not be special-cased into "see everything".

        With auth off, both the service and its processes carry ``user_id=None``,
        so equality matches and the operator still sees their sandboxes -- without
        reintroducing an `if user_id:` escape hatch that would fail open.
        """
        service = ProcessSandboxService(
            user_id=None,
            sandbox_spec_service=MockSandboxSpecService(),
            base_working_dir=temp_dir,
            base_port=9000,
            python_executable='python',
            agent_server_module='openhands.agent_server',
            health_check_path='/alive',
            httpx_client=mock_httpx_client,
        )
        procs = {
            'anon': self._running(None, 'anon-key'),
            'owned': self._running('somebody', 'owned-key'),
        }
        with (
            patch(
                'openhands.app_server.sandbox.process_sandbox_service._processes', procs
            ),
            patch('psutil.Process', side_effect=psutil.NoSuchProcess(1234)),
        ):
            page = await service.search_sandboxes()

        assert [item.id for item in page.items] == ['anon']


class TestProcessSandboxServiceInjector:
    """Test cases for ProcessSandboxServiceInjector."""

    def test_default_values(self):
        """Test default configuration values."""
        injector = ProcessSandboxServiceInjector()

        assert injector.base_working_dir == '/tmp/openhands-sandboxes'
        assert injector.base_port == 8000
        assert injector.health_check_path == '/alive'
        assert injector.agent_server_module == 'openhands.agent_server'

    def test_custom_values(self):
        """Test custom configuration values."""
        injector = ProcessSandboxServiceInjector(
            base_working_dir='/custom/path',
            base_port=9000,
            health_check_path='/health',
            agent_server_module='custom.agent.module',
        )

        assert injector.base_working_dir == '/custom/path'
        assert injector.base_port == 9000
        assert injector.health_check_path == '/health'
        assert injector.agent_server_module == 'custom.agent.module'
