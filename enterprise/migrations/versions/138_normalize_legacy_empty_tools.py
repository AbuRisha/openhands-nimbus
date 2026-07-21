"""Normalize legacy empty tool settings."""

from typing import Any

import sqlalchemy as sa
from alembic import op

revision = '138'
down_revision = '137'
branch_labels = None
depends_on = None


def _normalize_empty_tools(settings: Any) -> dict[str, Any] | None:
    if not isinstance(settings, dict) or settings.get('tools') != []:
        return None
    normalized = dict(settings)
    normalized['tools'] = None
    return normalized


def upgrade() -> None:
    bind = op.get_bind()

    org = sa.table(
        'org',
        sa.column('id', sa.Uuid()),
        sa.column('agent_settings', sa.JSON()),
    )
    for row in bind.execute(sa.select(org.c.id, org.c.agent_settings)).mappings():
        normalized = _normalize_empty_tools(row['agent_settings'])
        if normalized is not None:
            bind.execute(
                org.update()
                .where(org.c.id == row['id'])
                .values(agent_settings=normalized)
            )

    org_member = sa.table(
        'org_member',
        sa.column('org_id', sa.Uuid()),
        sa.column('user_id', sa.Uuid()),
        sa.column('agent_settings_diff', sa.JSON()),
    )
    for row in bind.execute(
        sa.select(
            org_member.c.org_id,
            org_member.c.user_id,
            org_member.c.agent_settings_diff,
        )
    ).mappings():
        normalized = _normalize_empty_tools(row['agent_settings_diff'])
        if normalized is not None:
            bind.execute(
                org_member.update()
                .where(org_member.c.org_id == row['org_id'])
                .where(org_member.c.user_id == row['user_id'])
                .values(agent_settings_diff=normalized)
            )


def downgrade() -> None:
    pass
