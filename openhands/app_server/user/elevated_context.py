"""Is this request running under a deliberate in-code elevation?

WHY THIS PREDICATE EXISTS, AND WHY IT IS NOT `user_id is None`
--------------------------------------------------------------
Read paths fail closed when identity does not resolve: an absent user id used
to DROP the ownership predicate and widen the query from "yours" to
"everything". But "absent" covers two situations that must not be treated the
same:

  UNRESOLVED — a browser request whose identity could not be established.
    `DefaultUserAuth` returns None for every caller by design, and a resolver
    that throws is swallowed to None as well. Widening here is the bug.

  ELEVATED — `ADMIN` and `SandboxUserContext`, constructed explicitly in code
    for work that is legitimately not scoped to one customer: the agent
    server's webhook callbacks (`webhook_router`), background title
    generation, and `validate_session_key`, which must look up a sandbox that
    "could belong to *any* user".

Both arrive as `user_id is None`. Refusing on that alone breaks every callback
in the product — and a security change that breaks working things gets
reverted, which ends up less safe than not shipping it.

The discriminator is the TYPE, not the value: `SpecifyUserContext` is only ever
constructed in code, never derived from a request, so an absent id on one is a
statement of intent rather than a failure. That is why this is a type check and
not a flag someone can pass in.
"""

from __future__ import annotations

from openhands.app_server.user.specifiy_user_context import SpecifyUserContext
from openhands.app_server.user.user_context import UserContext


def is_elevated(user_context: UserContext | None) -> bool:
    """True when an absent user id is deliberate rather than unresolved.

    Covers ``SandboxUserContext`` too, which subclasses ``SpecifyUserContext``
    — a sandbox acting on its own behalf is the same kind of claim.
    """
    return isinstance(user_context, SpecifyUserContext)
