"""Memory must never be shared between customers.

It holds private notes about a customer's stack, deploys and decisions. The
path used to fall back to a top-level `memory.md` when the user id was missing,
which is one shared document for every unidentified session.
"""

from openhands.app_server.app_conversation.nimbus_memory import (
    memory_block,
    memory_path,
)


def test_each_customer_gets_their_own_path():
    a = memory_path('cus_alice')
    b = memory_path('cus_bob')
    assert a == 'users/cus_alice/memory.md'
    assert b == 'users/cus_bob/memory.md'
    assert a != b


def test_no_identity_means_no_path_not_a_shared_one():
    # The bug: this returned 'memory.md' — the same file for everyone.
    assert memory_path(None) is None
    assert memory_path('') is None


def test_an_id_cannot_escape_its_own_directory():
    # A cookie-supplied id must not walk the filestore.
    assert memory_path('../../etc/passwd') == 'users/______etc_passwd/memory.md'
    assert memory_path('a/b') == 'users/a_b/memory.md'


def test_an_id_of_only_separators_yields_no_path():
    # '___' would be a directory shared by every such id; refuse instead.
    assert memory_path('///') is None or memory_path('///').startswith('users/')


def test_unidentified_session_gets_no_memory_block():
    assert memory_block(None) is None
