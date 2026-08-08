"""The fork state copier must run INSIDE a sandbox, as loose files.

That is the whole claim of ``fork_state_cli``, and it is the one thing a normal
unit test would not catch: importing the module in-process proves nothing about
whether it works when uploaded as two files next to each other, because the
installed package is already on ``sys.path``.

So the load-bearing test here copies both modules into a bare directory and runs
the CLI as a SUBPROCESS from there, which is what
``POST /file/upload`` + ``POST /bash/execute_bash_command`` actually produce. If
the dual-import fallback is wrong, that test fails and the in-process ones pass.

Why this matters beyond tidiness: the alternative wirings were (a) expand a
customer's conversation state on shared app-server disk every fork, or (b)
re-express the mutation as a shell one-liner and give up the copier's tests,
including the 100,000-event ordering case. Running the tested code in the sandbox
avoids both. See docs/fork-conversation-design.md.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import pytest

from openhands.app_server.app_conversation import fork_conversation_state as fcs_mod
from openhands.app_server.app_conversation import fork_state_cli
from openhands.app_server.app_conversation.fork_conversation_state import (
    conversation_state_dir,
)


def _seed(conversations: Path, conversation_id, n_events: int = 3) -> list[str]:
    """A minimal but real persistence dir: base_state.json plus n event files.

    Event ids must be UUID-shaped. ``EVENT_NAME_RE`` requires
    ``[0-9a-fA-F-]{8,}``, so a readable placeholder like ``evt000`` does not
    match and the copier correctly sees an empty log — which is how the first
    draft of this fixture silently produced ``{"copied": 0}`` and looked like a
    bug in the code. A fixture that cannot be produced by the real writer tests
    nothing.
    """
    state_dir = conversation_state_dir(conversations, conversation_id)
    (state_dir / 'events').mkdir(parents=True, exist_ok=True)
    (state_dir / 'base_state.json').write_text(
        json.dumps({'id': str(conversation_id), 'agent': {'kind': 'test'}}),
        encoding='utf-8',
    )
    ids = []
    for i in range(n_events):
        event_id = str(uuid4())
        ids.append(event_id)
        (state_dir / 'events' / f'event-{i:05d}-{event_id}.json').write_text(
            json.dumps({'id': event_id, 'seq': i}), encoding='utf-8'
        )
    return ids


class TestRunsAsLooseFilesInASandbox:
    """The deployment mode. This is why the module exists."""

    def test_subprocess_from_a_bare_directory_with_only_the_two_modules(
        self, tmp_path: Path
    ):
        # Exactly what upload + bash produces: two files, no package around them.
        drop = tmp_path / 'oh-fork'
        drop.mkdir()
        shutil.copy(Path(fcs_mod.__file__), drop / 'fork_conversation_state.py')
        shutil.copy(Path(fork_state_cli.__file__), drop / 'fork_state_cli.py')
        assert sorted(p.name for p in drop.iterdir()) == [
            'fork_conversation_state.py',
            'fork_state_cli.py',
        ]

        conversations = tmp_path / 'conversations'
        src, tgt = uuid4(), uuid4()
        _seed(conversations, src, n_events=3)

        result = subprocess.run(
            [
                sys.executable,
                str(drop / 'fork_state_cli.py'),
                '--conversations-path',
                str(conversations),
                '--source-id',
                str(src),
                '--target-id',
                str(tgt),
            ],
            capture_output=True,
            text=True,
            # cwd deliberately NOT the drop dir: a sandbox runs the command from
            # wherever the shell happens to be, so the module must not rely on
            # cwd being its own directory.
            cwd=str(tmp_path),
        )

        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout.strip()) == {'copied': 3}

        # And the fork is actually resumable: id rewritten, events present.
        target_dir = conversation_state_dir(conversations, tgt)
        base = json.loads((target_dir / 'base_state.json').read_text('utf-8'))
        assert base['id'] == str(tgt), (
            'the id must be rewritten or ConversationState.create raises '
            'ValueError on resume (state.py:525) and the fork is dead'
        )
        assert len(list((target_dir / 'events').iterdir())) == 3

    def test_source_state_is_left_untouched(self, tmp_path: Path):
        """A fork that damages its parent is worse than no fork."""
        conversations = tmp_path / 'conversations'
        src, tgt = uuid4(), uuid4()
        _seed(conversations, src, n_events=2)
        src_dir = conversation_state_dir(conversations, src)
        before = json.loads((src_dir / 'base_state.json').read_text('utf-8'))

        assert (
            fork_state_cli.main(
                [
                    '--conversations-path',
                    str(conversations),
                    '--source-id',
                    str(src),
                    '--target-id',
                    str(tgt),
                ]
            )
            == 0
        )

        after = json.loads((src_dir / 'base_state.json').read_text('utf-8'))
        assert after == before
        assert after['id'] == str(src)


class TestExitCodesDistinguishFailureFromAnEmptyFork:
    """The transport only sees stdout and an exit status.

    "Forked nothing" and "did not run" must not look the same, or a broken fork
    presents as an agent that has forgotten everything -- silently.
    """

    def test_missing_source_state_exits_nonzero_with_an_error(self, tmp_path: Path):
        conversations = tmp_path / 'conversations'
        conversations.mkdir()
        code = fork_state_cli.main(
            [
                '--conversations-path',
                str(conversations),
                '--source-id',
                str(uuid4()),
                '--target-id',
                str(uuid4()),
            ]
        )
        assert code == 1

    def test_malformed_uuid_exits_nonzero_rather_than_traceback(
        self, tmp_path: Path, capsys: pytest.CaptureFixture
    ):
        code = fork_state_cli.main(
            [
                '--conversations-path',
                str(tmp_path),
                '--source-id',
                'not-a-uuid',
                '--target-id',
                str(uuid4()),
            ]
        )
        assert code == 1
        payload = json.loads(capsys.readouterr().out.strip())
        assert 'error' in payload

    def test_success_prints_the_count_so_a_caller_can_check_it(
        self, tmp_path: Path, capsys: pytest.CaptureFixture
    ):
        conversations = tmp_path / 'conversations'
        src, tgt = uuid4(), uuid4()
        ids = _seed(conversations, src, n_events=5)

        # Inclusive cutoff, matching copy_events_until: the named event is KEPT.
        code = fork_state_cli.main(
            [
                '--conversations-path',
                str(conversations),
                '--source-id',
                str(src),
                '--target-id',
                str(tgt),
                '--up-to-event-id',
                ids[2],
            ]
        )
        assert code == 0
        assert json.loads(capsys.readouterr().out.strip()) == {'copied': 3}


class TestCrossSandboxTargetPath:
    def test_target_can_be_a_different_conversations_root(self, tmp_path: Path):
        """The normal case: the fork lands in its own sandbox.

        In production the two roots are on different hosts and the archive is
        relayed between them; here they are two directories, which is the same
        shape the function sees.
        """
        source_root = tmp_path / 'sandbox-a' / 'conversations'
        target_root = tmp_path / 'sandbox-b' / 'conversations'
        src, tgt = uuid4(), uuid4()
        _seed(source_root, src, n_events=2)

        assert (
            fork_state_cli.main(
                [
                    '--conversations-path',
                    str(source_root),
                    '--source-id',
                    str(src),
                    '--target-id',
                    str(tgt),
                    '--target-conversations-path',
                    str(target_root),
                ]
            )
            == 0
        )

        assert (conversation_state_dir(target_root, tgt) / 'base_state.json').exists()
        assert not (conversation_state_dir(source_root, tgt)).exists()
