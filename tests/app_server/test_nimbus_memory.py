"""Memory is injected into EVERY conversation, which is what makes its edges
matter more than its happy path.

Two properties carry real risk:
  * the cap, because this text is a standing tax on the context window the
    agent has to work in — unbounded memory silently shrinks every conversation
  * path scoping, because the user id arrives from a cookie and a document is
    read back into a prompt
"""

from __future__ import annotations

import pytest

from openhands.app_server.app_conversation import nimbus_memory


class _FakeStore:
    def __init__(self) -> None:
        self.files: dict[str, str] = {}

    def read(self, path: str) -> str:
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path]

    def write(self, path: str, contents) -> None:  # noqa: ANN001
        self.files[path] = contents


@pytest.fixture(autouse=True)
def _store(monkeypatch):
    store = _FakeStore()

    class _Config:
        file_store = store

    monkeypatch.setattr(
        'openhands.app_server.config.get_global_config', lambda: _Config()
    )
    return store


def test_absent_memory_is_empty_not_an_error():
    """A customer with no memory is the common case, not a failure."""
    assert nimbus_memory.load_memory('cust_1') == ''
    assert nimbus_memory.memory_block('cust_1') is None


def test_round_trip():
    nimbus_memory.save_memory('cust_1', 'Deploy with: az acr build')
    assert nimbus_memory.load_memory('cust_1') == 'Deploy with: az acr build'


def test_memory_is_scoped_per_customer():
    nimbus_memory.save_memory('cust_1', 'first customer notes')
    nimbus_memory.save_memory('cust_2', 'second customer notes')

    assert nimbus_memory.load_memory('cust_1') == 'first customer notes'
    assert nimbus_memory.load_memory('cust_2') == 'second customer notes'


def test_path_cannot_escape_the_user_directory():
    """The id comes from a cookie; traversal would read another user's file."""
    path = nimbus_memory.memory_path('../../etc/passwd')

    assert '..' not in path
    assert path.startswith('users/')


def test_write_is_capped():
    stored = nimbus_memory.save_memory('cust_1', 'x' * (nimbus_memory.MAX_MEMORY_CHARS * 3))

    assert len(stored) == nimbus_memory.MAX_MEMORY_CHARS


def test_read_is_capped_too(_store):
    """Enforced on read as well: a document that grew by some other path must
    not quietly consume the context window."""
    _store.files[nimbus_memory.memory_path('cust_1')] = 'y' * (
        nimbus_memory.MAX_MEMORY_CHARS * 2
    )

    assert len(nimbus_memory.load_memory('cust_1')) == nimbus_memory.MAX_MEMORY_CHARS


def test_a_broken_store_does_not_raise(monkeypatch):
    """A conversation must start whether or not memory loads."""

    class _Exploding:
        file_store = property(lambda self: (_ for _ in ()).throw(RuntimeError('boom')))

    monkeypatch.setattr(
        'openhands.app_server.config.get_global_config', lambda: _Exploding()
    )

    assert nimbus_memory.load_memory('cust_1') == ''
    assert nimbus_memory.memory_block('cust_1') is None


def test_block_is_labelled_as_context_not_instruction():
    """Memory is user-authored text auto-injected into every prompt. "Always
    deploy to prod" is a note about the past, not a command to run now."""
    nimbus_memory.save_memory('cust_1', 'Prefers pnpm over npm')
    block = nimbus_memory.memory_block('cust_1')

    assert block is not None
    assert 'NIMBUS_MEMORY' in block
    assert 'not as instructions' in block
    assert 'Prefers pnpm over npm' in block
