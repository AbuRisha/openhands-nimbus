"""Scheduling arithmetic. The clock is injected, so these are deterministic."""

from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from openhands.app_server.scheduled_tasks.scheduled_task_models import (
    MIN_INTERVAL_MINUTES,
    RunStatus,
    ScheduledTask,
    TaskRun,
)

NOW = datetime(2026, 8, 8, 12, 0, tzinfo=timezone.utc)


def _interval(**kw) -> ScheduledTask:
    return ScheduledTask(
        name='n', prompt='p', kind='interval', interval_minutes=60, **kw
    )


def _daily(at: str = '09:00', **kw) -> ScheduledTask:
    return ScheduledTask(name='n', prompt='p', kind='daily', daily_at=at, **kw)


class TestIntervalScheduling:
    def test_a_new_task_is_due_immediately(self):
        """Waiting a full interval after creation makes a new task look broken
        for hours, and the customer cannot tell it from a bug."""
        assert _interval().is_due(NOW) is True

    def test_not_due_before_the_interval_elapses(self):
        task = _interval(last_run_at=NOW - timedelta(minutes=59))
        assert task.is_due(NOW) is False

    def test_due_once_the_interval_elapses(self):
        task = _interval(last_run_at=NOW - timedelta(minutes=60))
        assert task.is_due(NOW) is True

    def test_disabled_is_never_due(self):
        assert _interval(enabled=False).is_due(NOW) is False
        assert _interval(enabled=False).next_due_at(NOW) is None


class TestDailyScheduling:
    def test_due_at_the_time_when_not_yet_run(self):
        assert _daily('12:00').is_due(NOW) is True

    def test_not_due_before_the_time(self):
        assert _daily('13:00').is_due(NOW) is False

    def test_does_not_fire_twice_in_one_day(self):
        """The failure this prevents: a tick every minute after 09:00 would
        re-fire a daily task on every tick for the rest of the day."""
        task = _daily('09:00', last_run_at=NOW.replace(hour=9, minute=0))
        assert task.is_due(NOW) is False
        assert task.next_due_at(NOW) == NOW.replace(
            hour=9, minute=0, second=0, microsecond=0
        ) + timedelta(days=1)

    def test_due_again_the_next_day(self):
        task = _daily('09:00', last_run_at=NOW - timedelta(days=1))
        assert task.is_due(NOW) is True


class TestValidation:
    def test_rejects_a_runaway_interval(self):
        """`* * * * *` in a text box is the reason this floor exists."""
        with pytest.raises(ValidationError):
            ScheduledTask(
                name='n', prompt='p', kind='interval', interval_minutes=1
            )

    def test_accepts_the_floor_exactly(self):
        ScheduledTask(
            name='n',
            prompt='p',
            kind='interval',
            interval_minutes=MIN_INTERVAL_MINUTES,
        )

    @pytest.mark.parametrize('bad', ['24:00', '9:00', '09:60', 'noon', ''])
    def test_rejects_malformed_times(self, bad):
        with pytest.raises(ValidationError):
            ScheduledTask(name='n', prompt='p', kind='daily', daily_at=bad)

    @pytest.mark.parametrize('good', ['00:00', '09:05', '23:59'])
    def test_accepts_valid_times(self, good):
        ScheduledTask(name='n', prompt='p', kind='daily', daily_at=good)

    def test_rejects_an_empty_prompt(self):
        with pytest.raises(ValidationError):
            ScheduledTask(name='n', prompt='', kind='interval', interval_minutes=60)


class TestRunHistory:
    def test_keeps_the_most_recent_runs(self):
        task = _interval()
        for i in range(15):
            task.record_run(
                TaskRun(at=NOW + timedelta(minutes=i), status=RunStatus.STARTED)
            )
        assert len(task.runs) == 10
        # Most recent kept, not the first ten.
        assert task.runs[-1].at == NOW + timedelta(minutes=14)

    def test_a_failed_run_still_advances_the_clock(self):
        """Otherwise a task that fails every time is due on every tick, and a
        broken schedule becomes a tight loop against the model."""
        task = _interval()
        task.record_run(TaskRun(at=NOW, status=RunStatus.FAILED))
        assert task.last_run_at == NOW
        assert task.is_due(NOW) is False
