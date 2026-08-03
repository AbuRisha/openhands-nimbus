"""Pins the sticky-model rule: a new conversation reuses the user's last model.

── The bug this exists to stop ─────────────────────────────────────────────
`llm_model` was already persisted per conversation, and nothing ever read it
back. So a customer who deliberately picked a model got silently reset to the
platform default (anthropic/claude-sonnet-5) every time they opened chat.

Owner report, 2026-08-03: "it's always auto on sonnet 5 ... it should stick to
that same model when the person comes to the chat."

These import `sticky_model` rather than the conversation service, which pulls
in FastAPI and the agent-server SDK. The rule is the part worth pinning and it
is pure; the wiring around it is one call.
"""

from types import SimpleNamespace

from openhands.app_server.app_conversation.sticky_model import (
    STICKY_MODEL_LOOKBACK,
    pick_last_used_model,
)


def test_picks_the_most_recent_recorded_model():
    rows = [SimpleNamespace(llm_model='openai/gpt-5.6-sol')]
    assert pick_last_used_model(rows) == 'openai/gpt-5.6-sol'


def test_skips_rows_with_no_recorded_model():
    """`llm_model` is nullable and predates some rows, so the newest
    conversation may legitimately have none. Take the newest that HAS one."""
    rows = [
        SimpleNamespace(llm_model=None),
        SimpleNamespace(llm_model=None),
        SimpleNamespace(llm_model='z-ai/glm-5.2'),
        SimpleNamespace(llm_model='anthropic/claude-opus-5'),
    ]
    assert pick_last_used_model(rows) == 'z-ai/glm-5.2'


def test_no_history_returns_none_so_the_default_stands():
    assert pick_last_used_model([]) is None


def test_rows_missing_the_attribute_entirely_are_tolerated():
    """Older records and other row shapes must not raise."""
    rows = [SimpleNamespace(), SimpleNamespace(llm_model='qwen/qwen3-coder')]
    assert pick_last_used_model(rows) == 'qwen/qwen3-coder'


def test_blank_and_non_string_models_are_ignored():
    rows = [
        SimpleNamespace(llm_model=''),
        SimpleNamespace(llm_model='   '),
        SimpleNamespace(llm_model=123),
        SimpleNamespace(llm_model='moonshotai/kimi-k3'),
    ]
    assert pick_last_used_model(rows) == 'moonshotai/kimi-k3'


def test_lookback_scans_a_window_not_a_single_row():
    # A single-row lookup would miss the preference whenever the last session
    # happened not to record a model — which is the common case for old rows.
    assert STICKY_MODEL_LOOKBACK > 1
