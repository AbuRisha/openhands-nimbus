"""Searching conversations by title.

"How did I fix this last month" is the most common reason to go back, and the
backend for it already existed — it was just case-sensitive in production and
case-insensitive in the tests, which is the worst combination: the suite is
green and the user says search is broken.
"""

from __future__ import annotations

from sqlalchemy.dialects import postgresql, sqlite

from openhands.app_server.app_conversation.sql_app_conversation_info_service import (
    SQLAppConversationInfoService,
    StoredConversationMetadata,
)


def _service() -> SQLAppConversationInfoService:
    """_apply_filters touches no instance state, so an unconstructed object is
    enough — and avoids dragging a db session into a pure SQL-shape test."""
    return object.__new__(SQLAppConversationInfoService)


def _compiled(dialect) -> str:
    """The SQL this filter actually produces for a given database."""
    from sqlalchemy import select

    query = SQLAppConversationInfoService._apply_filters(
        _service(),
        query=select(StoredConversationMetadata),
        title__contains='billing',
    )
    return str(query.compile(dialect=dialect()))


class TestCaseInsensitivity:
    def test_postgres_gets_a_case_insensitive_match(self):
        """The bug this fixes.

        Postgres LIKE is case-sensitive, so `.like()` meant a user typing
        "billing" never found a conversation titled "Billing". Asserting on the
        COMPILED SQL because a behavioural test cannot see it — SQLite's LIKE is
        case-insensitive, so the suite passed either way.
        """
        sql = _compiled(postgresql.dialect).lower()

        assert 'ilike' in sql or 'lower(' in sql

    def test_sqlite_also_matches_case_insensitively(self):
        """Whatever SQLAlchemy emits for ilike here, it must not regress the
        backend the tests actually run against."""
        sql = _compiled(sqlite.dialect).lower()

        assert 'like' in sql

    def test_the_filter_is_a_contains_match(self):
        """Users search for a word from the middle of a title, not a prefix."""
        from sqlalchemy import select

        query = SQLAppConversationInfoService._apply_filters(
            _service(),
            query=select(StoredConversationMetadata),
            title__contains='billing',
        )
        params = query.compile(dialect=postgresql.dialect()).params

        assert any(isinstance(v, str) and v == '%billing%' for v in params.values()), (
            params
        )


class TestNoFilter:
    def test_absent_title_adds_no_condition(self):
        """A blank search box must list everything rather than nothing."""
        from sqlalchemy import select

        query = SQLAppConversationInfoService._apply_filters(
            _service(),
            query=select(StoredConversationMetadata),
        )
        sql = str(query.compile(dialect=postgresql.dialect())).lower()

        assert 'like' not in sql
