"""Add nimbus_user_id to conversation_metadata for per-customer isolation

Revision ID: 015
Revises: 014
Create Date: 2026-08-02

conversation_metadata had no owner column of any kind. Upstream keeps the owner
in ConversationMetadataSaas, which lives under enterprise/ and is not part of
this deployment, and _to_info hardcodes created_by_user_id=None.

The consequence was that _secure_select could not scope a query to a customer
even in principle: it filtered on conversation_version alone, so every caller
saw every conversation. Returning a real user_id from UserAuth would not have
changed that by itself — there was nothing to compare it against.

Nullable on purpose. Rows written before this migration have no owner and stay
NULL; they are visible only to an unauthenticated context, never attributed to
whichever customer happens to sign in next.
"""

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '015'
down_revision: str | None = '014'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # batch_alter_table for SQLite compatibility; a plain passthrough on
    # PostgreSQL. Note this is a String column, not an Enum — deliberately, so
    # it cannot repeat the CREATE TYPE problem that made 002 unrunnable on
    # PostgreSQL.
    with op.batch_alter_table('conversation_metadata') as batch_op:
        batch_op.add_column(
            sa.Column('nimbus_user_id', sa.String(), nullable=True)
        )
    op.create_index(
        'ix_conversation_metadata_nimbus_user_id',
        'conversation_metadata',
        ['nimbus_user_id'],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index(
        'ix_conversation_metadata_nimbus_user_id',
        table_name='conversation_metadata',
        if_exists=True,
    )
    with op.batch_alter_table('conversation_metadata') as batch_op:
        batch_op.drop_column('nimbus_user_id')
