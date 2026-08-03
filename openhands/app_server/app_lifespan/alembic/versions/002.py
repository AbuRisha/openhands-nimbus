"""Sync DB with Models

Revision ID: 001
Revises:
Create Date: 2025-10-05 11:28:41.772294

"""

from enum import Enum
from typing import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = '002'
down_revision: str | None = '001'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


class EventCallbackStatus(Enum):
    ACTIVE = 'ACTIVE'
    DISABLED = 'DISABLED'
    COMPLETED = 'COMPLETED'
    ERROR = 'ERROR'


def upgrade() -> None:
    """Upgrade schema."""
    # op.create_table() emits CREATE TYPE for a sa.Enum automatically.
    # op.add_column() DOES NOT — a long-standing Alembic/PostgreSQL gotcha.
    #
    # It never surfaced because this app ran on SQLite, where sa.Enum is just
    # VARCHAR + a CHECK constraint and no type object is needed. The first boot
    # against PostgreSQL failed here:
    #
    #   sqlalchemy.exc.ProgrammingError: (pg8000.dbapi.ProgrammingError)
    #   type "eventcallbackstatus" does not exist
    #   ERROR:    Application startup failed. Exiting.
    #
    # Create the type explicitly first. checkfirst=True makes it idempotent for
    # a re-run, and Enum.create() is a no-op on SQLite, so this stays correct on
    # both backends.
    status_enum = sa.Enum(EventCallbackStatus, name='eventcallbackstatus')
    status_enum.create(op.get_bind(), checkfirst=True)

    op.add_column(
        'event_callback',
        sa.Column(
            'status',
            status_enum,
            nullable=False,
            server_default='ACTIVE',
        ),
    )
    op.add_column(
        'event_callback',
        sa.Column(
            'updated_at', sa.DateTime, nullable=False, server_default=sa.func.now()
        ),
    )
    op.drop_index('ix_event_callback_result_event_id')
    op.drop_column('event_callback_result', 'event_id')
    op.add_column(
        'event_callback_result', sa.Column('event_id', sa.String, nullable=True)
    )
    op.create_index(
        op.f('ix_event_callback_result_event_id'),
        'event_callback_result',
        ['event_id'],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('event_callback', 'status')
    # Mirror of the explicit create in upgrade(): dropping the column does not
    # drop the PostgreSQL type, and an orphaned type makes the schema state
    # depend on how many times you have cycled the migration. No-op on SQLite.
    sa.Enum(EventCallbackStatus, name='eventcallbackstatus').drop(
        op.get_bind(), checkfirst=True
    )
    op.drop_column('event_callback', 'updated_at')
    op.drop_index('ix_event_callback_result_event_id')
    op.drop_column('event_callback_result', 'event_id')
    op.add_column(
        'event_callback_result', sa.Column('event_id', sa.UUID, nullable=True)
    )
    op.create_index(
        op.f('ix_event_callback_result_event_id'),
        'event_callback_result',
        ['event_id'],
        unique=False,
    )
