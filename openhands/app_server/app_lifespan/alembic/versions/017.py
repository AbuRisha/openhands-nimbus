"""Return orphaned conversations to their owner

Revision ID: 017
Revises: 016
Create Date: 2026-08-03

save_app_conversation_info re-derived nimbus_user_id from the CALLER on every
write, and several callers are background processors running under the ADMIN
context (SetTitleCallbackProcessor most visibly, a few seconds after each user
message). Those writes set the column to NULL, and _secure_select filters on it,
so a conversation went invisible to the customer who created it. The write-side
guard landed separately; this repairs the rows it already damaged.

Damaged rows cannot heal themselves, which is why a migration is the right tool
rather than waiting for the next save:
  - every owner-context save path first reads through _secure_select, which now
    misses, and returns early on `info is None`
  - the one path that runs as the sandbox owner, on_conversation_update, is
    gated by valid_conversation, which compares the row's owner against the
    sandbox's and raises AuthError when they differ. NULL != owner, so it 401s
    before reaching the save — which also means these conversations stopped
    persisting new events, not merely stopped being listed.

THE SAFETY RULE
---------------
Only runs when the table contains EXACTLY ONE distinct non-NULL owner. Under
that condition every orphan provably belonged to that customer, because no other
customer has ever owned a row here. The moment a second customer exists the
premise fails and this becomes a no-op rather than a guess — handing one
customer's conversations to another is a far worse outcome than leaving them
hidden, so the ambiguous case declines to act.

That makes it safe to run anywhere: on a fresh deployment it finds zero owners
and does nothing; on a multi-customer deployment it finds several and does
nothing; only on the single-customer deployment this actually happened to does
it repair anything.

Deliberately NOT reversible. The downgrade cannot know which rows were NULL
before, and re-NULLing them would recreate the exact defect this repairs.
"""

from typing import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '017'
down_revision: str | None = '016'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    conn = op.get_bind()

    owners = conn.execute(
        sa.text(
            'SELECT DISTINCT nimbus_user_id FROM conversation_metadata '
            'WHERE nimbus_user_id IS NOT NULL'
        )
    ).fetchall()

    if len(owners) != 1:
        # Zero owners (nothing to attribute to) or several (ambiguous). Both are
        # correct no-ops; see THE SAFETY RULE above.
        # ASCII only. This runs inside the app lifespan, so an encoding error
        # here does not just lose a log line -- it propagates out as a nested
        # ExceptionGroup and aborts startup. An em-dash cost a Windows dev box
        # a boot with a 130-line traceback whose real cause (cp932 cannot encode
        # U+2014) was the very last line.
        print(
            f'017: {len(owners)} distinct owners found - skipping backfill '
            '(needs exactly one to attribute orphans unambiguously)'
        )
        return

    owner = owners[0][0]
    result = conn.execute(
        sa.text(
            'UPDATE conversation_metadata SET nimbus_user_id = :owner '
            'WHERE nimbus_user_id IS NULL'
        ),
        {'owner': owner},
    )
    print(f'017: returned {result.rowcount} orphaned conversation(s) to {owner}')


def downgrade() -> None:
    # Intentionally empty. Re-NULLing these would reintroduce the bug.
    pass
