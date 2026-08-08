"""Artifacts: version arithmetic, restore semantics, and per-customer scoping.

The store is exercised against an in-memory FileStore rather than mocked, so
these cover the JSON round trip too — a model that serialises but does not
deserialise would pass a pure-model test and fail in production on the second
request.
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from pydantic import ValidationError

from openhands.app_server.artifacts import artifact_store
from openhands.app_server.artifacts.artifact_models import (
    MAX_CONTENT_CHARS,
    MAX_VERSIONS_PER_ARTIFACT,
    Artifact,
    ArtifactKind,
    ArtifactSummary,
)


class InMemoryFileStore:
    """Enough of the FileStore contract for these tests, including the parts
    that matter: `read` on a missing path RAISES (it does not return empty),
    and `list` returns full paths."""

    def __init__(self) -> None:
        self.files: dict[str, str] = {}

    def write(self, path: str, contents: str | bytes) -> None:
        self.files[path] = (
            contents.decode() if isinstance(contents, bytes) else contents
        )

    def read(self, path: str) -> str:
        if path not in self.files:
            raise FileNotFoundError(path)
        return self.files[path]

    def list(self, path: str) -> list[str]:
        prefix = path.rstrip('/') + '/'
        if not any(p.startswith(prefix) for p in self.files):
            raise FileNotFoundError(path)
        return [p for p in self.files if p.startswith(prefix)]

    def delete(self, path: str) -> None:
        if path not in self.files:
            raise FileNotFoundError(path)
        del self.files[path]

    def exists(self, path: str) -> bool:
        return path in self.files


@pytest.fixture
def store():
    fs = InMemoryFileStore()
    with patch.object(artifact_store, '_file_store', return_value=fs):
        yield fs


def _artifact(title: str = 'Notes', content: str = 'v1 body') -> Artifact:
    a = Artifact(title=title, kind=ArtifactKind.MARKDOWN)
    a.add_version(content)
    return a


class TestPathScoping:
    """Same rule as memory and scheduled tasks, and it matters more here: the
    content is the customer's own writing."""

    def test_each_customer_gets_their_own_directory(self):
        assert artifact_store.artifacts_dir('cus_alice') == 'users/cus_alice/artifacts'
        assert artifact_store.artifacts_dir('cus_bob') == 'users/cus_bob/artifacts'

    def test_no_identity_means_no_path_not_a_shared_one(self):
        assert artifact_store.artifacts_dir(None) is None
        assert artifact_store.artifacts_dir('') is None
        assert artifact_store.artifact_path(None, 'abc') is None

    def test_an_artifact_id_from_the_url_cannot_escape_the_directory(self):
        """The id comes straight off the URL, so this is the injection point."""
        path = artifact_store.artifact_path('cus_alice', '../../../etc/passwd')
        assert path is not None
        assert '..' not in path
        assert path.startswith('users/cus_alice/artifacts/')

    def test_a_user_id_cannot_escape_either(self):
        path = artifact_store.artifact_path('../../etc', 'abc')
        assert path is not None
        assert '..' not in path


class TestVersioning:
    def test_first_version_is_one(self):
        a = _artifact()
        assert a.current is not None
        assert a.current.version == 1
        assert a.version_count == 1

    def test_each_edit_appends_rather_than_overwriting(self):
        a = _artifact(content='first')
        a.add_version('second')
        assert a.version_count == 2
        assert a.current.content == 'second'
        # The whole point: the old content is still reachable.
        assert a.find_version(1).content == 'first'

    def test_content_is_truncated_to_the_cap(self):
        a = Artifact(title='big')
        a.add_version('x' * (MAX_CONTENT_CHARS + 500))
        assert len(a.current.content) == MAX_CONTENT_CHARS

    def test_history_is_trimmed_from_the_OLDEST_end(self):
        a = Artifact(title='long-lived')
        for i in range(MAX_VERSIONS_PER_ARTIFACT + 5):
            a.add_version(f'body {i}')

        assert a.version_count == MAX_VERSIONS_PER_ARTIFACT
        # The newest survives; the earliest is gone.
        assert a.current.content == f'body {MAX_VERSIONS_PER_ARTIFACT + 4}'
        assert a.find_version(1) is None

    def test_version_numbers_are_NOT_renumbered_after_a_trim(self):
        """Renumbering would silently change what "restore v3" means for a
        customer who is looking at a history list they loaded a minute ago."""
        a = Artifact(title='long-lived')
        for i in range(MAX_VERSIONS_PER_ARTIFACT + 3):
            a.add_version(f'body {i}')

        first_surviving = a.versions[0].version
        assert first_surviving == 4  # not 1
        assert a.find_version(first_surviving) is not None
        # And numbers keep climbing rather than restarting.
        assert a.current.version == MAX_VERSIONS_PER_ARTIFACT + 3

    def test_updated_at_moves_with_the_newest_version(self):
        a = _artifact()
        created = a.updated_at
        a.add_version('later')
        assert a.updated_at >= created
        assert a.updated_at == a.current.created_at


class TestRestore:
    def test_restore_appends_rather_than_deleting(self):
        a = _artifact(content='good')
        a.add_version('bad')
        assert a.version_count == 2

        restored = a.restore(1)

        assert restored is not None
        assert a.version_count == 3, 'restore must not truncate history'
        assert a.current.content == 'good'
        assert a.current.version == 3

    def test_restore_records_where_it_came_from(self):
        """Otherwise a restore is indistinguishable from an ordinary edit that
        happened to reproduce old text."""
        a = _artifact(content='good')
        a.add_version('bad')
        a.restore(1)
        assert a.current.restored_from == 1

    def test_a_restore_can_itself_be_undone(self):
        """The case that makes 'append, never truncate' load-bearing."""
        a = _artifact(content='original')
        a.add_version('edit')
        a.restore(1)          # back to original
        a.restore(2)          # ...and forward again to the edit

        assert a.current.content == 'edit'
        assert a.current.restored_from == 2
        assert a.version_count == 4

    def test_restoring_a_trimmed_version_returns_None_not_a_neighbour(self):
        a = Artifact(title='long-lived')
        for i in range(MAX_VERSIONS_PER_ARTIFACT + 5):
            a.add_version(f'body {i}')

        # Version 1 has been trimmed. Answering with version 4 here would look
        # like it worked while showing content nobody asked for.
        assert a.restore(1) is None
        assert a.find_version(1) is None

    def test_restoring_a_version_that_never_existed_returns_None(self):
        assert _artifact().restore(999) is None


class TestStore:
    def test_save_then_load_round_trips_through_json(self, store):
        a = _artifact(content='body')
        artifact_store.save_artifact('cus_alice', a)

        loaded = artifact_store.load_artifact('cus_alice', a.id)

        assert loaded is not None
        assert loaded.id == a.id
        assert loaded.title == 'Notes'
        assert loaded.kind == ArtifactKind.MARKDOWN
        assert loaded.current is not None
        assert loaded.current.content == 'body'

    def test_one_artifact_per_file(self, store):
        a, b = _artifact('A'), _artifact('B')
        artifact_store.save_artifact('cus_alice', a)
        artifact_store.save_artifact('cus_alice', b)
        assert len(store.files) == 2

    def test_one_customer_cannot_load_anothers_artifact(self, store):
        a = _artifact()
        artifact_store.save_artifact('cus_alice', a)
        assert artifact_store.load_artifact('cus_bob', a.id) is None

    def test_listing_is_scoped_and_newest_updated_first(self, store):
        older = _artifact('Older')
        newer = _artifact('Newer')
        newer.add_version('touched')  # moves updated_at forward

        artifact_store.save_artifact('cus_alice', older)
        artifact_store.save_artifact('cus_alice', newer)
        artifact_store.save_artifact('cus_bob', _artifact('Theirs'))

        titles = [s.title for s in artifact_store.list_artifacts('cus_alice')]
        assert titles == ['Newer', 'Older']

    def test_a_summary_carries_no_content(self, store):
        a = _artifact(content='secret body')
        summary = ArtifactSummary.of(a)
        assert 'content' not in summary.model_dump()
        assert summary.version_count == 1

    def test_ONE_corrupt_file_does_not_empty_the_gallery(self, store):
        good = _artifact('Good')
        artifact_store.save_artifact('cus_alice', good)
        store.files['users/cus_alice/artifacts/broken.json'] = '{ not json'

        listed = artifact_store.list_artifacts('cus_alice')

        assert [s.title for s in listed] == ['Good']

    def test_a_corrupt_artifact_reads_as_absent_rather_than_raising(self, store):
        store.files['users/cus_alice/artifacts/x.json'] = 'not json at all'
        assert artifact_store.load_artifact('cus_alice', 'x') is None

    def test_listing_an_account_with_no_artifacts_is_empty_not_an_error(self, store):
        assert artifact_store.list_artifacts('cus_nobody') == []

    def test_an_unidentified_session_gets_nothing(self, store):
        assert artifact_store.list_artifacts(None) == []
        assert artifact_store.load_artifact(None, 'abc') is None
        with pytest.raises(artifact_store.ArtifactError):
            artifact_store.save_artifact(None, _artifact())

    def test_delete_removes_it_and_reports_whether_it_was_there(self, store):
        a = _artifact()
        artifact_store.save_artifact('cus_alice', a)

        assert artifact_store.delete_artifact('cus_alice', a.id) is True
        assert artifact_store.load_artifact('cus_alice', a.id) is None
        # Second delete reports False so the router can 404 rather than
        # claiming it removed something that was already gone.
        assert artifact_store.delete_artifact('cus_alice', a.id) is False

    def test_one_customer_cannot_delete_anothers_artifact(self, store):
        a = _artifact()
        artifact_store.save_artifact('cus_alice', a)

        assert artifact_store.delete_artifact('cus_bob', a.id) is False
        assert artifact_store.load_artifact('cus_alice', a.id) is not None

    def test_the_per_account_cap_is_enforced_on_create(self, store):
        with patch(
            'openhands.app_server.artifacts.artifact_store.MAX_ARTIFACTS_PER_USER',
            2,
        ):
            artifact_store.create_artifact('cus_alice', _artifact('one'))
            artifact_store.create_artifact('cus_alice', _artifact('two'))
            with pytest.raises(artifact_store.ArtifactError):
                artifact_store.create_artifact('cus_alice', _artifact('three'))

    def test_stored_json_is_readable_rather_than_opaque(self, store):
        """The file is a customer's document; a human should be able to open it
        during an incident without a decoder."""
        a = _artifact(content='hello')
        artifact_store.save_artifact('cus_alice', a)
        raw = json.loads(next(iter(store.files.values())))
        assert raw['title'] == 'Notes'
        assert raw['versions'][0]['content'] == 'hello'


class TestValidation:
    def test_a_title_is_required(self):
        with pytest.raises(ValidationError):
            Artifact(title='')

    def test_an_unknown_kind_is_rejected(self):
        with pytest.raises(ValidationError):
            Artifact(title='x', kind='spreadsheet')

    def test_an_unknown_language_is_accepted(self):
        """A whitelist would turn a new language into a 422; the field only
        drives syntax highlighting."""
        assert Artifact(title='x', language='zig').language == 'zig'

    def test_an_artifact_with_no_versions_has_no_current(self):
        assert Artifact(title='empty').current is None
        assert Artifact(title='empty').version_count == 0
