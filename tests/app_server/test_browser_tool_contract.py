"""The two contracts the browser bridge sits between, neither of which was held.

Both failures below shipped, and both were invisible to every existing test
because each half was correct in isolation.

── 1. The tool names collided with the SDK's own ───────────────────────────
The bridge registered `browser_navigate` and `browser_list_tabs`. The SDK's
browser_use toolset already NAMES two of its fourteen tools exactly that
(``openhands/tools/browser_use/definition.py``), and `get_default_tools`
pulls that toolset in. With both in the agent's tool list the SDK refuses to
start the conversation:

    Duplicate tool names found: {'browser_list_tabs', 'browser_navigate'}

That is not a degraded browser feature — it blocks EVERY message send in the
product, including for customers who have never paired a browser. `browser_read_page`
did not collide, which is why the error named two tools and not three, and why
it read as something exotic rather than as a naming clash.

── 2. The wire verb was the tool name ──────────────────────────────────────
`extension/background.js` switches `message.tool` over a fixed vocabulary —
get_page_text / get_page_url / navigate / list_tabs — and throws
"unsupported tool" on anything else. The executor sent the TOOL NAME. So once
the collision was fixed and a browser was paired, every call would still have
been refused by the extension.

These are different vocabularies owned by different sides: the tool name is ours
and just changed; the wire verb is a contract with an extension already
installed in customers' browsers. The test asserts they stay separate.
"""

from __future__ import annotations

import pytest


def _sdk_tool_names(module) -> set[str]:
    """Tool names an SDK module occupies.

    Reads ``.name``, which is the field ``AgentBase`` de-duplicates on
    (sdk/agent/base.py:597). An earlier version of this test read
    ``annotations.title`` and passed — the two happen to agree here, but only
    ``.name`` is load-bearing, and a test that checks the wrong field is worth
    less than no test because it reads as coverage.
    """
    import inspect

    from openhands.sdk.tool import ToolDefinition

    return {
        obj.name
        for obj in vars(module).values()
        if inspect.isclass(obj)
        and issubclass(obj, ToolDefinition)
        and obj is not ToolDefinition
        and isinstance(getattr(obj, 'name', None), str)
    }


class TestNoCollisionWithTheSDK:
    def test_bridge_tool_names_are_disjoint_from_the_sdk_browser_toolset(self):
        from openhands.nimbus_bootstrap import nimbus_browser_tools as mod
        from openhands.tools.browser_use import definition as sdk_browser

        ours = set(mod._WIRE_VERB)
        theirs = _sdk_tool_names(sdk_browser)

        # Sanity-check the instrument before trusting a pass: if the import
        # moved and this set came back empty, disjointness would be vacuous.
        assert 'browser_navigate' in theirs and 'browser_list_tabs' in theirs, (
            f'expected the SDK browser toolset here, got {sorted(theirs)}'
        )

        # Any overlap is a hard failure of conversation startup, not a warning.
        assert ours.isdisjoint(theirs), (
            f'these names are taken by the SDK browser toolset: {sorted(ours & theirs)}. '
            'Registering both puts two tools with one name in front of the agent '
            'and the SDK refuses the whole conversation.'
        )

    def test_no_nimbus_tool_shadows_any_sdk_tool(self):
        """The general form of the bug, not just the instance that shipped.

        The browser collision was found by a customer, in production, because
        nothing compared the two name spaces. Nimbus registers media and
        workflow tools beside these, and every one of them is a name chosen
        without looking at what the SDK already ships — this is what turns that
        into a test failure rather than an outage.
        """
        import importlib
        import pkgutil

        import openhands.tools as sdk_tools
        from openhands.nimbus_bootstrap import nimbus_browser_tools as mod

        sdk_names: set[str] = set()
        for info in pkgutil.iter_modules(sdk_tools.__path__):
            try:
                pkg = importlib.import_module(f'openhands.tools.{info.name}')
            except Exception:
                # A toolset whose optional deps are absent cannot collide with
                # us in this process either, so skipping it is honest.
                continue
            sdk_names |= _sdk_tool_names(pkg)
            definition = getattr(pkg, 'definition', None)
            if definition is not None:
                sdk_names |= _sdk_tool_names(definition)

        ours = {t.name for t in mod._TOOLS}
        assert ours.isdisjoint(sdk_names), (
            f'Nimbus tools collide with SDK tool names: {sorted(ours & sdk_names)}'
        )

    def test_the_names_say_whose_browser_it_is(self):
        from openhands.nimbus_bootstrap import nimbus_browser_tools as mod

        # Not cosmetic: the model has to choose between a sandboxed headless
        # browser and the customer's own signed-in one, and the only thing
        # distinguishing them at the call site is the name.
        assert all(n.startswith('paired_browser_') for n in mod._WIRE_VERB)


class TestTheRealProductionToolList:
    """The list the agent is actually built from, not a hand-written one.

    Everything above reasons about name sets I assembled myself, which is
    exactly the kind of reasoning that produced the bug: each half was checked
    against my model of the other half rather than against it. This builds the
    real thing — `get_default_tools(enable_browser=True)` then
    `_add_nimbus_extra_tools`, the two calls at
    live_status_app_conversation_service.py:2364 — and asserts on the result.
    """

    def test_the_injected_set_has_no_duplicate_names(self, monkeypatch):
        from collections import Counter

        # The bridge tools are only injected under the process sandbox, which
        # is what production runs; without this the branch is skipped and the
        # test passes while asserting nothing.
        monkeypatch.setenv('RUNTIME', 'process')

        from openhands.app_server.app_conversation.live_status_app_conversation_service import (  # noqa: E501
            _add_nimbus_extra_tools,
        )
        from openhands.tools.preset.default import (
            get_default_tools,
            register_builtins_agents,
        )

        register_builtins_agents(enable_browser=True)
        tools = _add_nimbus_extra_tools(
            get_default_tools(enable_browser=True, enable_sub_agents=False)
        )

        names = [t.name for t in tools]

        # Guard against a silently-empty injection: if the registry gate started
        # skipping these, every assertion below would hold vacuously.
        assert 'paired_browser_read_page' in names, (
            f'the bridge tools were not injected at all; got {names}'
        )

        duplicates = {n for n, c in Counter(names).items() if c > 1}
        assert not duplicates, f'agent construction will raise on {duplicates}'

    def test_the_browser_toolset_that_shipped_the_collision_is_still_present(self):
        """The other half of the collision must stay in the picture.

        `browser_tool_set` is one spec that expands into fourteen tools, two of
        which are the names this bug was about. If browser support were ever
        turned off, the duplicate test above would pass for a reason that has
        nothing to do with the fix — so the collision partner is asserted
        explicitly rather than assumed.
        """
        import inspect

        from openhands.nimbus_bootstrap import nimbus_browser_tools as mod
        from openhands.tools.browser_use.definition import BrowserToolSet

        # Static list inside create(), so the expansion is deterministic and
        # readable without launching a browser.
        source = inspect.getsource(BrowserToolSet.create)
        assert 'BrowserNavigateTool' in source
        assert 'BrowserListTabsTool' in source

        # And those expand to the two names we had to give up.
        from openhands.tools.browser_use.definition import (
            BrowserListTabsTool,
            BrowserNavigateTool,
        )

        collided = {BrowserNavigateTool.name, BrowserListTabsTool.name}
        assert collided == {'browser_navigate', 'browser_list_tabs'}
        assert collided.isdisjoint({t.name for t in mod._TOOLS})


class TestToolsCanBeSerialized:
    """The third bug in the same three tools, found by actually sending a message.

    With the name collision fixed the agent finally built, and the next POST to
    /events returned 500 from the agent server:

        PydanticSerializationError: Error calling function
        `_serialize_by_kind`: RecursionError

    `_make_tool` built the class under a throwaway name and reassigned
    ``__name__`` afterwards. Pydantic had already captured the original when it
    built the core schema, so `_serialize_by_kind` compared the two names,
    found them different, delegated to `model_dump`, and re-entered itself
    forever (sdk/utils/models.py).

    Sending any message failed the moment these tools were really in the agent -
    which is exactly why the duplicate-name bug hid it: the agent never got
    built, so nothing ever tried to serialize them.
    """

    def test_every_bridge_tool_serializes(self):
        from openhands.nimbus_bootstrap import nimbus_browser_tools as mod

        for cls in mod._TOOLS:
            tool = cls.create()[0]
            # The real failure was RecursionError inside pydantic, so this must
            # actually serialize rather than merely construct.
            payload = tool.model_dump_json()
            assert payload, f'{cls.__name__} serialized to nothing'

    def test_the_class_name_matches_what_pydantic_recorded(self):
        """The invariant behind the fix, stated directly.

        Asserting on the class name rather than only on serialization means a
        future refactor that reintroduces the rename fails here with an obvious
        message instead of a RecursionError three layers down inside pydantic.
        """
        from openhands.nimbus_bootstrap import nimbus_browser_tools as mod

        for cls in mod._TOOLS:
            assert cls.__name__ == cls.name, (
                f'class is named {cls.__name__!r} but the tool is {cls.name!r}; '
                'pydantic captures the class name when it builds the schema, so '
                'renaming afterwards makes _serialize_by_kind recurse forever'
            )


class TestWireVerbContract:
    def test_every_tool_has_a_verb_the_extension_understands(self):
        from openhands.nimbus_bootstrap import nimbus_browser_tools as mod

        # The vocabulary in extension/background.js's switch. Hardcoded on
        # purpose: it is a contract with software already installed on customer
        # machines, so it must be asserted against a literal rather than
        # against whatever the code currently sends.
        understood = {'get_page_text', 'get_page_url', 'navigate', 'list_tabs'}

        unknown = set(mod._WIRE_VERB.values()) - understood
        assert not unknown, (
            f'the extension throws "unsupported tool" for {sorted(unknown)}; '
            'see extension/background.js handleCall()'
        )

    def test_the_executor_sends_the_verb_not_the_tool_name(self):
        from openhands.nimbus_bootstrap import nimbus_browser_tools as mod

        ex = mod.BrowserBridgeExecutor('paired_browser_read_page')

        # The bug: self._tool went on the wire. A rename of ours must never
        # reach an extension we do not control.
        assert ex._verb == 'get_page_text'
        assert ex._verb != 'paired_browser_read_page'

    def test_a_tool_with_no_verb_fails_at_construction(self):
        from openhands.nimbus_bootstrap import nimbus_browser_tools as mod

        # Loudly, and early. Without this a tool added without a verb registers
        # fine, appears in the agent's tool list, and only fails when a customer
        # uses it.
        with pytest.raises(KeyError):
            mod.BrowserBridgeExecutor('paired_browser_something_new')
