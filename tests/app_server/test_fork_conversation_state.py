"""Forking the agent's own state — the half `copy_events_until` does not do."""

import json
from pathlib import Path
from uuid import uuid4

import pytest

from openhands.app_server.app_conversation.fork_conversation_state import (
    ForkStateError,
    conversation_state_dir,
    fork_conversation_state,
)
from openhands.sdk.conversation.persistence_const import BASE_STATE, EVENTS_DIR


def _eid(tag: str) -> str:
    """A realistic event id.

    `EVENT_NAME_RE` requires 8+ hex characters, because real ids are UUIDs.
    The first version of these fixtures used bare 'aaa'/'bbb' and every copy
    test reported zero events — the SDK's regex was right and the fixture was
    wrong.
    Kept as a helper so the tests stay readable while the ids stay real.
    """
    return f'{tag}0000-1111-2222-3333-444444444444'


def _seed(
    conversations_path: Path,
    conversation_id,
    event_ids: list[str],
    *,
    start_index: int = 0,
) -> Path:
    """Write a source conversation the way the SDK does."""
    state_dir = conversation_state_dir(conversations_path, conversation_id)
    (state_dir / EVENTS_DIR).mkdir(parents=True, exist_ok=True)
    (state_dir / BASE_STATE).write_text(
        json.dumps({'id': str(conversation_id), 'agent': {'kind': 'Agent'}}),
        encoding='utf-8',
    )
    for offset, event_id in enumerate(event_ids):
        index = start_index + offset
        name = f'event-{index:05d}-{event_id}.json'
        (state_dir / EVENTS_DIR / name).write_text(
            json.dumps({'id': event_id}), encoding='utf-8'
        )
    return state_dir


def _copied_event_ids(conversations_path: Path, conversation_id) -> list[str]:
    events = conversation_state_dir(conversations_path, conversation_id) / EVENTS_DIR
    if not events.is_dir():
        return []
    names = sorted(p.name for p in events.iterdir())
    return [n.split('-', 2)[2].removesuffix('.json') for n in names]


class TestForkConversationState:
    def test_copies_events_up_to_and_including_the_cutoff(self, tmp_path: Path):
        source, target = uuid4(), uuid4()
        _seed(tmp_path, source, [_eid('aaa'), _eid('bbb'), _eid('ccc'), _eid('ddd')])

        copied = fork_conversation_state(tmp_path, source, target, _eid('bbb'))

        assert copied == 2
        assert _copied_event_ids(tmp_path, target) == [_eid('aaa'), _eid('bbb')]

    def test_the_cutoff_is_inclusive(self, tmp_path: Path):
        """Matches `copy_events_until`. A user forks FROM a message they can
        see; excluding it drops the event they were reasoning about."""
        source, target = uuid4(), uuid4()
        _seed(tmp_path, source, [_eid('aaa'), _eid('bbb')])

        fork_conversation_state(tmp_path, source, target, _eid('aaa'))

        assert _copied_event_ids(tmp_path, target) == [_eid('aaa')]

    def test_an_unknown_cutoff_copies_everything(self, tmp_path: Path):
        """Also matches `copy_events_until`. An empty fork looks exactly like a
        broken feature; a complete copy is at worst more than was asked for."""
        source, target = uuid4(), uuid4()
        _seed(tmp_path, source, [_eid('aaa'), _eid('bbb'), _eid('ccc')])

        copied = fork_conversation_state(tmp_path, source, target, _eid('nop'))

        assert copied == 3
        assert _copied_event_ids(tmp_path, target) == [_eid('aaa'), _eid('bbb'), _eid('ccc')]

    def test_no_cutoff_copies_everything(self, tmp_path: Path):
        source, target = uuid4(), uuid4()
        _seed(tmp_path, source, [_eid('aaa'), _eid('bbb')])

        assert fork_conversation_state(tmp_path, source, target) == 2

    def test_rewrites_the_conversation_id(self, tmp_path: Path):
        """THE LOAD-BEARING ASSERTION. ConversationState.create raises
        ValueError when base_state's id differs from the id it is asked for, so
        without this rewrite the forked agent does not start at all."""
        source, target = uuid4(), uuid4()
        _seed(tmp_path, source, [_eid('aaa')])

        fork_conversation_state(tmp_path, source, target)

        written = json.loads(
            (conversation_state_dir(tmp_path, target) / BASE_STATE).read_text(
                encoding='utf-8'
            )
        )
        assert written['id'] == str(target)
        # Everything else survives — the agent config is what makes it resumable.
        assert written['agent'] == {'kind': 'Agent'}

    def test_leaves_the_source_untouched(self, tmp_path: Path):
        """Copy, never truncate. A fork that turns out to be a bad idea must
        cost nothing, and a cutoff bug must not be able to destroy history."""
        source, target = uuid4(), uuid4()
        _seed(tmp_path, source, [_eid('aaa'), _eid('bbb'), _eid('ccc')])

        fork_conversation_state(tmp_path, source, target, _eid('aaa'))

        assert _copied_event_ids(tmp_path, source) == [_eid('aaa'), _eid('bbb'), _eid('ccc')]
        source_state = json.loads(
            (conversation_state_dir(tmp_path, source) / BASE_STATE).read_text(
                encoding='utf-8'
            )
        )
        assert source_state['id'] == str(source)

    def test_forks_into_a_different_sandbox_directory(self, tmp_path: Path):
        """The normal case: a forked conversation gets its OWN sandbox, so
        source and target conversation dirs live under different roots."""
        source_root = tmp_path / 'sandbox-a' / 'workspace' / 'conversations'
        target_root = tmp_path / 'sandbox-b' / 'workspace' / 'conversations'
        source, target = uuid4(), uuid4()
        _seed(source_root, source, [_eid('aaa'), _eid('bbb')])

        copied = fork_conversation_state(
            source_root, source, target, _eid('aaa'), target_conversations_path=target_root
        )

        assert copied == 1
        assert _copied_event_ids(target_root, target) == [_eid('aaa')]

    def test_orders_by_parsed_index_not_filename(self, tmp_path: Path):
        """The writer pads to a FIVE-digit minimum without capping the width, so
        past 99_999 a lexicographic sort silently reorders history:
        'event-100000-...' sorts before 'event-99999-...'."""
        source, target = uuid4(), uuid4()
        _seed(tmp_path, source, [_eid('aaa'), _eid('bbb')], start_index=99_999)

        copied = fork_conversation_state(tmp_path, source, target, _eid('aaa'))

        # The first is index 99999 and the second 100000. Sorted by NAME,
        # 'event-100000-...' comes first, so a cutoff on the first event would
        # copy both.
        assert copied == 1
        assert _copied_event_ids(tmp_path, target) == [_eid('aaa')]

    def test_ignores_files_that_are_not_events(self, tmp_path: Path):
        """The directory belongs to the SDK and may grow sidecars. Refusing to
        fork because of an unrecognised file would be worse than skipping it."""
        source, target = uuid4(), uuid4()
        state_dir = _seed(tmp_path, source, [_eid('aaa')])
        (state_dir / EVENTS_DIR / 'README.txt').write_text('hi', encoding='utf-8')
        (state_dir / EVENTS_DIR / 'sub').mkdir()

        assert fork_conversation_state(tmp_path, source, target) == 1

    def test_state_without_events_copies_base_state_only(self, tmp_path: Path):
        """A conversation that never ran. Copyable, not an error."""
        source, target = uuid4(), uuid4()
        state_dir = conversation_state_dir(tmp_path, source)
        state_dir.mkdir(parents=True)
        (state_dir / BASE_STATE).write_text(
            json.dumps({'id': str(source)}), encoding='utf-8'
        )

        assert fork_conversation_state(tmp_path, source, target) == 0
        assert (conversation_state_dir(tmp_path, target) / BASE_STATE).is_file()

    def test_missing_source_state_raises_rather_than_forking_empty(
        self, tmp_path: Path
    ):
        """The one case that MUST fail loudly. A fork whose agent silently
        starts blank is the exact outcome this module exists to prevent, and it
        is indistinguishable from success at the API layer."""
        with pytest.raises(ForkStateError, match='has no'):
            fork_conversation_state(tmp_path, uuid4(), uuid4())

    def test_unreadable_source_state_raises(self, tmp_path: Path):
        source, target = uuid4(), uuid4()
        state_dir = conversation_state_dir(tmp_path, source)
        state_dir.mkdir(parents=True)
        (state_dir / BASE_STATE).write_text('{not json', encoding='utf-8')

        with pytest.raises(ForkStateError):
            fork_conversation_state(tmp_path, source, target)

    def test_state_dir_matches_the_sdk_layout(self, tmp_path: Path):
        """`Conversation.get_persistence_dir` is `Path(base) / id.hex`. If the
        SDK ever changes that, this fails here rather than producing forks the
        agent server cannot find."""
        conversation_id = uuid4()
        assert conversation_state_dir(tmp_path, conversation_id) == (
            tmp_path / conversation_id.hex
        )
