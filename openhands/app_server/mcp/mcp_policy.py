"""Deployment policy over which MCP servers a customer may attach.

An MCP server is arbitrary local process execution by design: the stdio
transport runs a command with arguments inside the sandbox. That is the point of
the feature, and it is fine as long as somebody decided which servers are
acceptable. Until now nobody could: ``_merge_custom_mcp_config`` took whatever
was in user settings and merged it, and a deployment had no way to say
otherwise.

FAIL CLOSED, AND WHY THAT IS NOT PARANOIA
-----------------------------------------
Every ambiguous case here resolves toward *fewer* servers running:

* An allowlist that is configured but unparseable becomes EMPTY, not absent.
  The tempting reading — "the setting is broken, so ignore it" — inverts the
  operator's intent at exactly the moment they most need it honoured. Someone
  who typed an allowlist wanted a restriction; a typo should cost them working
  servers, not silently remove the restriction.
* A managed-only flag that is not a recognisable boolean becomes TRUE.
* A server named in both lists is DENIED. Denial is the more specific
  statement, and a conflict means somebody is unsure.

The cost of being wrong in the closed direction is a customer telling you their
MCP server stopped working. The cost of being wrong in the open direction is
arbitrary code you did not intend to permit, running inside your sandbox, and
nobody telling you anything.

SYSTEM SERVERS ARE NOT SUBJECT TO THIS
--------------------------------------
The servers this deployment generates itself are not what the policy is about
and are never filtered — locking an operator out of their own tooling by
misconfiguring a customer-facing allowlist would be a self-inflicted outage.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Final, Mapping

_logger = logging.getLogger(__name__)

ENV_ALLOWED: Final = 'NIMBUS_MCP_ALLOWED_SERVERS'
ENV_DENIED: Final = 'NIMBUS_MCP_DENIED_SERVERS'
ENV_MANAGED_ONLY: Final = 'NIMBUS_MCP_MANAGED_ONLY'

_TRUE: Final = frozenset({'1', 'true', 'yes', 'on'})
_FALSE: Final = frozenset({'0', 'false', 'no', 'off'})


@dataclass(frozen=True)
class MCPPolicy:
    """What a customer is permitted to attach.

    ``allowed is None`` means no allowlist was configured, which is different
    from an allowlist that is empty — the first permits anything not denied, the
    second permits nothing. Collapsing those two into one empty set is how a
    fail-closed design accidentally becomes fail-open.
    """

    allowed: frozenset[str] | None
    denied: frozenset[str]
    managed_only: bool

    @property
    def is_restricting(self) -> bool:
        return self.managed_only or self.allowed is not None or bool(self.denied)


def _parse_name_list(raw: str | None) -> frozenset[str] | None:
    """Comma-separated server names, or None when unset.

    An entry that is only whitespace is dropped rather than becoming an empty
    name that can never match — a trailing comma is a typo, not a rule.
    """
    if raw is None:
        return None
    names = {part.strip() for part in raw.split(',')}
    return frozenset(name for name in names if name)


def _parse_bool(raw: str | None, *, default: bool) -> bool:
    if raw is None:
        return default
    value = raw.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    # Unrecognised is not "use the default" — somebody tried to set this and we
    # cannot tell what they meant, so take the restrictive reading and say so.
    _logger.warning(
        'mcp_policy: %r is not a recognisable boolean for %s; treating as managed-only',
        raw,
        ENV_MANAGED_ONLY,
    )
    return True


def load_policy(env: Mapping[str, str] | None = None) -> MCPPolicy:
    """Read the policy from the environment."""
    source = env if env is not None else os.environ

    raw_allowed = source.get(ENV_ALLOWED)
    allowed = _parse_name_list(raw_allowed)
    if raw_allowed is not None and allowed is not None and not allowed:
        # Configured but yielded nothing — e.g. "," or "   ". Keep it as an
        # EMPTY allowlist rather than None: the operator asked for a
        # restriction and got a typo, and dropping it would grant more than
        # they asked for.
        _logger.warning(
            'mcp_policy: %s is set but names no servers; no customer MCP '
            'servers will be permitted',
            ENV_ALLOWED,
        )

    return MCPPolicy(
        allowed=allowed,
        denied=_parse_name_list(source.get(ENV_DENIED)) or frozenset(),
        managed_only=_parse_bool(source.get(ENV_MANAGED_ONLY), default=False),
    )


def permits(policy: MCPPolicy, name: str) -> bool:
    """Whether a customer-configured server of this name may run."""
    if policy.managed_only:
        return False
    # Denied wins over allowed. A name in both lists means somebody is unsure,
    # and the more specific statement is the refusal.
    if name in policy.denied:
        return False
    if policy.allowed is None:
        return True
    return name in policy.allowed


def filter_servers(
    servers: Mapping[str, object], policy: MCPPolicy
) -> tuple[dict[str, object], list[str]]:
    """Split customer servers into (permitted, rejected-names).

    Rejected names are returned rather than just dropped so the caller can log
    them. A server that silently fails to appear is indistinguishable from one
    that was never configured, and that turns a policy decision into a support
    ticket about a broken feature.
    """
    permitted: dict[str, object] = {}
    rejected: list[str] = []

    for name, server in servers.items():
        if permits(policy, name):
            permitted[name] = server
        else:
            rejected.append(name)

    return permitted, sorted(rejected)
