"""Asking the agent to check its own browser-visible work.

The failure this addresses is not a crash. It is an agent editing a component
and reporting that the button now works, having never rendered it — which is
indistinguishable from success until a customer looks.
"""

from __future__ import annotations

import pytest

from openhands.app_server.app_conversation.live_status_app_conversation_service import (
    ENV_SELF_VERIFICATION,
    SELF_VERIFICATION_CONTEXT,
    LiveStatusAppConversationService,
    append_system_context,
)


class _Service:
    """The method under test reads only os.environ and its argument."""

    _maybe_append_self_verification = (
        LiveStatusAppConversationService._maybe_append_self_verification
    )


@pytest.fixture
def service() -> _Service:
    return _Service()


class TestGating:
    def test_off_when_unset(self, service, monkeypatch):
        """Default off is a cost decision, not caution: verifying spends tokens
        on every turn touching previewable code, and that is the customer's
        money on a metered product."""
        monkeypatch.delenv(ENV_SELF_VERIFICATION, raising=False)

        assert service._maybe_append_self_verification(None) is None

    @pytest.mark.parametrize('raw', ['1', 'true', 'TRUE', 'yes', 'on', ' On '])
    def test_on_for_recognised_truthy_values(self, service, monkeypatch, raw):
        monkeypatch.setenv(ENV_SELF_VERIFICATION, raw)

        assert service._maybe_append_self_verification(None) == (
            SELF_VERIFICATION_CONTEXT
        )

    @pytest.mark.parametrize('raw', ['0', 'false', 'no', 'off', 'maybe', ''])
    def test_off_for_anything_else(self, service, monkeypatch, raw):
        """Unlike the MCP policy, the permissive reading here is the SAFE one.

        Failing to verify costs tokens nobody agreed to spend; failing to
        restrict an MCP server runs code nobody agreed to run. Same shape of
        ambiguity, opposite correct default — so this is stated rather than
        copied from the other module.
        """
        monkeypatch.setenv(ENV_SELF_VERIFICATION, raw)

        assert service._maybe_append_self_verification(None) is None


class TestComposition:
    def test_preserves_an_existing_suffix(self, service, monkeypatch):
        """It is appended alongside memory and git context, not instead of them."""
        monkeypatch.setenv(ENV_SELF_VERIFICATION, 'true')

        result = service._maybe_append_self_verification('EXISTING')

        assert result is not None
        assert 'EXISTING' in result
        assert SELF_VERIFICATION_CONTEXT in result

    def test_does_not_duplicate_on_a_second_pass(self, service, monkeypatch):
        """Two conversation paths call this; a retry must not stack the block."""
        monkeypatch.setenv(ENV_SELF_VERIFICATION, 'true')

        once = service._maybe_append_self_verification(None)
        twice = service._maybe_append_self_verification(once)

        assert twice == once
        assert twice.count('<VERIFICATION_WORKFLOW>') == 1


class TestContent:
    def test_tells_the_agent_not_to_delegate_the_check_to_the_user(self):
        assert 'Do not ask the user to check manually' in SELF_VERIFICATION_CONTEXT

    def test_scopes_itself_out_when_nothing_is_observable(self):
        """Without this it starts a dev server to 'verify' a type change."""
        assert 'Skip this entirely' in SELF_VERIFICATION_CONTEXT

    def test_forbids_claiming_a_result_it_did_not_observe(self):
        """The actual failure mode: reporting success from having edited a file."""
        assert 'on the strength of having edited the file' in (
            SELF_VERIFICATION_CONTEXT
        )

    def test_keeps_javascript_for_diagnosis_rather_than_for_fixes(self):
        """Patching the live page makes a broken build look fixed."""
        assert 'never to implement a fix' in SELF_VERIFICATION_CONTEXT


def test_append_system_context_is_idempotent():
    """The property the no-duplicate behaviour above rests on."""
    once = append_system_context(None, 'BLOCK')

    assert append_system_context(once, 'BLOCK') == once


class TestItActuallyFires:
    """The failure mode this whole class exists for: silence.

    Self-verification is prompt text behind an env flag. If the flag name is
    wrong, or the injection point is never reached, nothing raises and no test
    above would notice — the agent simply never verifies, forever, and the only
    signal is a customer eventually saying the agent claims things it did not
    check.
    """

    def test_the_env_var_name_is_pinned_to_its_literal(self):
        """Every other test imports ENV_SELF_VERIFICATION, so a rename would be
        consistently wrong and completely invisible: the code and the tests
        would agree with each other and disagree with the deployment.

        This is the one place the literal is written out. If it changes, the
        env var in the deployment config has to change with it.
        """
        assert ENV_SELF_VERIFICATION == 'NIMBUS_AGENT_SELF_VERIFY'

    def test_the_injector_is_called_wherever_its_proven_siblings_are(self):
        """Wiring with no runtime signal, so it is checked structurally.

        _maybe_append_memory and _maybe_append_shallow_clone_context are both
        long-established and reach the agent, and there are two conversation
        start paths. Appearing in fewer places than they do means one path
        silently skips verification — which is exactly the bug that would never
        surface in a unit test of the method itself.
        """
        import inspect

        from openhands.app_server.app_conversation import (
            live_status_app_conversation_service as module,
        )

        source = inspect.getsource(module)

        def occurrences(name: str) -> int:
            return source.count(name)

        # One definition plus one call per conversation start path.
        assert occurrences('_maybe_append_self_verification') == occurrences(
            '_maybe_append_memory'
        )
        assert occurrences('_maybe_append_self_verification') == occurrences(
            '_maybe_append_shallow_clone_context'
        )

    def test_the_block_is_non_empty_and_delimited(self):
        """An empty or untagged block would inject nothing useful while every
        gating test above still passed."""
        assert SELF_VERIFICATION_CONTEXT.startswith('<VERIFICATION_WORKFLOW>')
        assert SELF_VERIFICATION_CONTEXT.rstrip().endswith('</VERIFICATION_WORKFLOW>')
        assert len(SELF_VERIFICATION_CONTEXT) > 500
