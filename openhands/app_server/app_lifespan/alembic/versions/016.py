"""Create conversation_cost_events — the table the cost ledger already writes to

Revision ID: 016
Revises: 015
Create Date: 2026-08-03

StoredConversationCostEvent has existed since 898045db1 and
_record_bucket_cost_deltas SELECTs and INSERTs against it, but no migration
ever created the table. On PostgreSQL that is not a silent no-op: the first
statement raises UndefinedTableError.

The path that hits it is the webhook handler —
webhook_router._sync_live_conversation_stats -> update_conversation_statistics
-> _record_bucket_cost_deltas — which is the same handler that persists events.
So a conversation whose stats sync fires loses the whole POST, the transcript
stops being written, and the UI sits on "Waiting for runtime to start..."
until it gives up with "Error occurred". The cost ledger was the trigger, but
the casualty was event persistence.

Columns mirror the model exactly. usage_id/llm_model/prompt_tokens/
completion_tokens are nullable because the model documents rows written before
attribution existed; on a table created fresh here nothing is unattributed yet,
but _record_bucket_cost_deltas explicitly buckets prior rows under a NULL
usage_id key and drains that as `cost_drain`, so the NULL case must stay
representable or that drain silently stops working on older deployments.

The FK cascades: cost rows are meaningless once the conversation they bill is
gone, and leaving them would let a deleted customer's spend linger in a table
nothing else prunes.
"""

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '016'
down_revision: str | None = '015'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'conversation_cost_events',
        sa.Column('id', sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column(
            'conversation_id',
            sa.String(),
            sa.ForeignKey(
                'conversation_metadata.conversation_id', ondelete='CASCADE'
            ),
            nullable=False,
        ),
        sa.Column('cost_delta', sa.Float(), nullable=False, server_default='0'),
        sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('usage_id', sa.String(), nullable=True),
        sa.Column('llm_model', sa.String(), nullable=True),
        sa.Column('prompt_tokens', sa.Integer(), nullable=True),
        sa.Column('completion_tokens', sa.Integer(), nullable=True),
    )
    # Both indexes back real query shapes: _record_bucket_cost_deltas filters
    # on conversation_id, and any spend-over-time reporting orders by
    # occurred_at. Declared here rather than via index=True on the columns so
    # the names are stable and downgrade can drop them explicitly.
    op.create_index(
        'ix_conversation_cost_events_conversation_id',
        'conversation_cost_events',
        ['conversation_id'],
        if_not_exists=True,
    )
    op.create_index(
        'ix_conversation_cost_events_occurred_at',
        'conversation_cost_events',
        ['occurred_at'],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index(
        'ix_conversation_cost_events_occurred_at',
        table_name='conversation_cost_events',
        if_exists=True,
    )
    op.drop_index(
        'ix_conversation_cost_events_conversation_id',
        table_name='conversation_cost_events',
        if_exists=True,
    )
    op.drop_table('conversation_cost_events')
