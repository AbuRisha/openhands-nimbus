"""Recurring agent runs, owned by a customer.

WHY A NARROW SCHEDULE RATHER THAN CRON
--------------------------------------
Five-field cron is the obvious choice and the wrong one to start with. It needs
a parser, it is a footgun in a text box (``* * * * *`` is a runaway that bills
the customer every minute), and almost every real request is "every N hours" or
"at 09:00". So the schedule is one of exactly two shapes, both of which can be
validated completely and neither of which can express "constantly".

Cron can be added later behind the same `next_due_at` interface without moving
anything else.

WHAT IS NOT BUILT, AND THE DECISION IT NEEDS FIRST
--------------------------------------------------
There is no runner. Nothing here fires, and NO UI SHIPS UNTIL ONE DOES — a
schedule a customer can create and that silently never runs is worse than the
absence of the feature.

Enumeration is solved: `FileStore.list()` exists (sdk/io/base.py:37), so the
scheduler can walk `users/` and read each `scheduled_tasks.json`.

The blocker is IDENTITY, and it is a security decision rather than plumbing.
`AppConversationService` requires a `UserContext`
(app_conversation_service_base.py:98) and calls `get_user_info()` on it; today
that is constructed from a request's session cookie. A scheduler has no
request. So firing a task means giving background code a way to ACT AS A
CUSTOMER — starting conversations and spending their credit — with no
authenticated caller anywhere in the chain.

That is the same shape as the /mcp finding on this codebase: an identity
derived from something that carries none, which resolved to a real, shared
bucket. It should be decided deliberately rather than invented, and the
question to answer is narrow:

    what constructs a UserContext for a user id with no request, what bounds
    it, and what stops a bug in the scheduler from spending the wrong
    customer's money?

Until that is answered, this module is a validated data model with a store and
nothing that runs.

WHY THE HISTORY IS BOUNDED AND STORED WITH THE TASK
---------------------------------------------------
"Did last night's run work?" is the only question a schedule owner actually
asks, and it needs to be answerable without a second lookup. Unbounded history
would grow this document without limit — the same silent tax the memory cap
exists to prevent — so it keeps the last few runs and drops the rest.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator

# A run every few minutes is almost always a mistake rather than an intent, and
# each one costs the customer a conversation. The floor is a guard against a
# typo, not a product limit.
MIN_INTERVAL_MINUTES = 15
MAX_TASKS_PER_USER = 20
MAX_HISTORY_PER_TASK = 10

_DAILY_AT_RE = re.compile(r'^([01]\d|2[0-3]):([0-5]\d)$')


class RunStatus(str, Enum):
    STARTED = 'started'
    FAILED = 'failed'


class TaskRun(BaseModel):
    """One firing. Deliberately thin — it records that the run was STARTED,
    not what the agent concluded, because the conversation itself is the
    record of that and duplicating it here would go stale."""

    at: datetime
    status: RunStatus
    conversation_id: str | None = None
    detail: str | None = None


class ScheduledTask(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str = Field(min_length=1, max_length=120)
    prompt: str = Field(min_length=1, max_length=8000)

    # Exactly one of these is set; `kind` says which.
    kind: Literal['interval', 'daily'] = 'interval'
    interval_minutes: int | None = None
    daily_at: str | None = None

    enabled: bool = True
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    last_run_at: datetime | None = None
    runs: list[TaskRun] = Field(default_factory=list)

    @field_validator('daily_at')
    @classmethod
    def _validate_daily_at(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not _DAILY_AT_RE.match(v):
            raise ValueError('daily_at must be HH:MM in 24-hour time')
        return v

    @field_validator('interval_minutes')
    @classmethod
    def _validate_interval(cls, v: int | None) -> int | None:
        if v is None:
            return v
        if v < MIN_INTERVAL_MINUTES:
            raise ValueError(
                f'interval_minutes must be at least {MIN_INTERVAL_MINUTES}'
            )
        return v

    def next_due_at(self, now: datetime) -> datetime | None:
        """When this should next fire, or None if it never should.

        `now` is passed in rather than read here so the caller — and the tests —
        control the clock. A scheduler that reads the wall clock in three places
        can disagree with itself within one tick.
        """
        if not self.enabled:
            return None

        if self.kind == 'interval':
            if not self.interval_minutes:
                return None
            if self.last_run_at is None:
                # Never run: due now. The alternative — waiting a full interval
                # after creation — makes a new task look broken for hours.
                return now
            return self.last_run_at + timedelta(minutes=self.interval_minutes)

        if self.kind == 'daily':
            if not self.daily_at:
                return None
            hh, mm = (int(p) for p in self.daily_at.split(':'))
            candidate = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
            # Already fired within this minute today -> tomorrow.
            if self.last_run_at is not None and self.last_run_at >= candidate:
                return candidate + timedelta(days=1)
            return candidate

        # Unreachable to mypy, because `kind` is a Literal of exactly the two
        # branches above. That is a static claim about a value we deserialize
        # from the database, so it holds until a row says otherwise - an older
        # kind, a hand-edited row, a half-finished migration. Scheduling nothing
        # is the safe answer there; falling off the end and returning an
        # implicit None would be the same behaviour with no statement saying so.
        return None  # type: ignore[unreachable]

    def is_due(self, now: datetime) -> bool:
        due = self.next_due_at(now)
        return due is not None and due <= now

    def record_run(self, run: TaskRun) -> None:
        """Append a run and trim, keeping the MOST RECENT."""
        self.runs.append(run)
        if len(self.runs) > MAX_HISTORY_PER_TASK:
            self.runs = self.runs[-MAX_HISTORY_PER_TASK:]
        # last_run_at moves for FAILED runs too. Otherwise a task that fails
        # every time is due on every tick, and a broken schedule becomes a
        # tight loop against the model.
        self.last_run_at = run.at


class ScheduledTaskList(BaseModel):
    tasks: list[ScheduledTask] = Field(default_factory=list)
    max_tasks: int = MAX_TASKS_PER_USER
