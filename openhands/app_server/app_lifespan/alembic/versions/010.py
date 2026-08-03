"""Add composite index on event_callback for execute_callbacks query

Revision ID: 010
Revises: 009
Create Date: 2026-06-03

The execute_callbacks query filters on (status, event_kind, conversation_id)
but none of these columns were indexed, causing full table scans on every
event dispatch. This index directly covers that query.

CREATE INDEX CONCURRENTLY is used to avoid locking the table during deployment.
"""

from typing import Sequence

from alembic import op

revision: str = '010'
down_revision: str | None = '009'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 2026-08-02: CREATE INDEX CONCURRENTLY inside op.get_context()
    # .autocommit_block() cannot run on this stack. Alembic's autocommit_block
    # asks the driver to leave the transaction; pg8000 (the SYNC driver this
    # project uses for migrations - see db_session_injector, which picks
    # postgresql+pg8000 for Alembic and postgresql+asyncpg for the app) does not
    # honour that, so PostgreSQL refuses the statement and every following
    # statement fails with:
    #
    #   sqlalchemy.exc.InterfaceError: (pg8000.exceptions.InterfaceError)
    #     in failed transaction block
    #   ERROR:    Application startup failed. Exiting.
    #
    # CONCURRENTLY exists to avoid locking a live table during deployment. A
    # migration that cannot run at all does not avoid anything - and on any
    # database reaching this revision for the first time, event_callback is
    # empty or near-empty, so the plain form takes a lock nobody can perceive.
    # If this ever needs to run against a large populated table, do it by hand
    # outside Alembic with psql, which can issue a genuine out-of-transaction
    # CREATE INDEX CONCURRENTLY.
    #
    # if_not_exists is kept so a hand-built index does not break the migration.
    op.create_index(
        'ix_event_callback_conversation_id_status_event_kind',
        'event_callback',
        ['conversation_id', 'status', 'event_kind'],
        if_not_exists=True,
    )


def downgrade() -> None:
    # Mirror of upgrade(): no autocommit_block, no CONCURRENTLY.
    op.drop_index(
        'ix_event_callback_conversation_id_status_event_kind',
        table_name='event_callback',
        if_exists=True,
    )
