"""Which MCP servers a customer may attach.

Every case here is about the direction an ambiguity resolves in. An MCP server
is arbitrary local process execution, so "we could not tell what the operator
meant" has to mean fewer servers running, not more — and the tempting readings
all go the other way.
"""

from __future__ import annotations

import pytest

from openhands.app_server.mcp.mcp_policy import (
    ENV_ALLOWED,
    ENV_DENIED,
    ENV_MANAGED_ONLY,
    MCPPolicy,
    filter_servers,
    load_policy,
    permits,
)


class TestLoading:
    def test_no_configuration_permits_everything(self):
        """The default has to stay open, or every existing deployment breaks."""
        policy = load_policy({})

        assert policy.allowed is None
        assert policy.denied == frozenset()
        assert policy.managed_only is False
        assert policy.is_restricting is False

    def test_parses_a_comma_separated_allowlist(self):
        policy = load_policy({ENV_ALLOWED: 'github, sentry ,linear'})

        assert policy.allowed == frozenset({'github', 'sentry', 'linear'})

    def test_a_trailing_comma_is_a_typo_not_an_unnameable_server(self):
        policy = load_policy({ENV_ALLOWED: 'github,'})

        assert policy.allowed == frozenset({'github'})

    def test_an_allowlist_that_names_nothing_stays_empty_not_absent(self):
        """The distinction that keeps fail-closed from becoming fail-open.

        `allowed is None` permits anything not denied; an EMPTY allowlist
        permits nothing. Collapsing the two would turn a typo into "no
        restriction at all", which is the opposite of what the operator asked
        for by setting the variable in the first place.
        """
        policy = load_policy({ENV_ALLOWED: '   ,  '})

        assert policy.allowed == frozenset()
        assert policy.allowed is not None
        assert permits(policy, 'anything') is False

    @pytest.mark.parametrize('raw', ['1', 'true', 'TRUE', 'yes', 'on', ' On '])
    def test_recognises_truthy_managed_only(self, raw):
        assert load_policy({ENV_MANAGED_ONLY: raw}).managed_only is True

    @pytest.mark.parametrize('raw', ['0', 'false', 'FALSE', 'no', 'off'])
    def test_recognises_falsy_managed_only(self, raw):
        assert load_policy({ENV_MANAGED_ONLY: raw}).managed_only is False

    @pytest.mark.parametrize('raw', ['maybe', 'True-ish', '', 'null'])
    def test_an_unreadable_managed_only_flag_becomes_true(self, raw):
        """Not "fall back to the default".

        Somebody set this and we cannot tell what they meant. Defaulting to
        permissive would mean a fat-fingered flag quietly grants more than an
        unset one.
        """
        assert load_policy({ENV_MANAGED_ONLY: raw}).managed_only is True


class TestPermits:
    def test_allows_a_named_server(self):
        policy = MCPPolicy(
            allowed=frozenset({'github'}), denied=frozenset(), managed_only=False
        )

        assert permits(policy, 'github') is True

    def test_refuses_a_server_missing_from_the_allowlist(self):
        policy = MCPPolicy(
            allowed=frozenset({'github'}), denied=frozenset(), managed_only=False
        )

        assert permits(policy, 'something-else') is False

    def test_denied_wins_over_allowed(self):
        """A name in both lists means somebody is unsure, and refusal is the
        more specific statement."""
        policy = MCPPolicy(
            allowed=frozenset({'github'}),
            denied=frozenset({'github'}),
            managed_only=False,
        )

        assert permits(policy, 'github') is False

    def test_managed_only_refuses_even_an_allowlisted_server(self):
        """Otherwise the two settings contradict each other and the weaker wins."""
        policy = MCPPolicy(
            allowed=frozenset({'github'}), denied=frozenset(), managed_only=True
        )

        assert permits(policy, 'github') is False

    def test_no_allowlist_permits_anything_not_denied(self):
        policy = MCPPolicy(allowed=None, denied=frozenset({'bad'}), managed_only=False)

        assert permits(policy, 'anything') is True
        assert permits(policy, 'bad') is False


class TestFiltering:
    def test_splits_permitted_from_rejected(self):
        policy = load_policy({ENV_DENIED: 'shady'})
        servers = {'github': object(), 'shady': object()}

        permitted, rejected = filter_servers(servers, policy)

        assert set(permitted) == {'github'}
        assert rejected == ['shady']

    def test_reports_rejected_names_rather_than_dropping_them_silently(self):
        """A server that silently fails to appear is indistinguishable from one
        that was never configured — which turns a policy decision into a support
        ticket about a broken feature."""
        policy = load_policy({ENV_MANAGED_ONLY: 'true'})
        servers = {'b': object(), 'a': object()}

        permitted, rejected = filter_servers(servers, policy)

        assert permitted == {}
        # Sorted, so a log line is stable rather than dict-ordered.
        assert rejected == ['a', 'b']

    def test_passes_everything_through_when_nothing_is_configured(self):
        servers = {'github': object(), 'linear': object()}

        permitted, rejected = filter_servers(servers, load_policy({}))

        assert set(permitted) == {'github', 'linear'}
        assert rejected == []
