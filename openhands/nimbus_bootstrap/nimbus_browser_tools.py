"""``browser_*`` tools that drive the customer's OWN logged-in browser.

The agent already has a browser: a headless Chromium in the sandbox. This is a
different thing, and the difference is the point — the sandbox browser is signed
into nothing, so "check my orders" or "read the ticket" is impossible there and
trivial in the browser the customer is already using.

WHY THESE CALL BACK TO THE APP SERVER
-------------------------------------
The bridge registry holds live WebSocket handles to paired extensions, and it
lives in the APP server. Tools register and run in the AGENT server, a separate
process under RUNTIME=process. A socket cannot be shared across that boundary,
so the tool makes an HTTP call inward and the app server does the routing. Same
shape as the media tools calling the gateway, and for the same reason.

WHAT THE AGENT IS TOLD WHEN IT CANNOT REACH A BROWSER
-----------------------------------------------------
Three failures that look identical from here mean different things to the user,
so they are reported differently rather than collapsed into "browser
unavailable":

* no browser paired at all — they need to install and pair the extension
* paired but not connected — the browser is closed; opening it is enough
* connected but did not answer — the page or the tab is wedged

An agent that says "I could not reach your browser" for all three sends the user
looking in the wrong place.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Sequence
from typing import Any, ClassVar

import httpx
from pydantic import Field

from openhands.sdk import TextContent
from openhands.sdk.tool import (
    Action,
    Observation,
    ToolAnnotations,
    ToolDefinition,
    ToolExecutor,
    list_registered_tools,
    register_tool,
)

_logger = logging.getLogger(__name__)

# The app server is reachable from the agent process on localhost under
# RUNTIME=process; the env var exists so a different runtime can point at it.
APP_SERVER_URL = os.getenv('NIMBUS_APP_SERVER_URL', 'http://localhost:3000')

# A browser call crosses two hops and waits on a human's machine, so it is
# slower than an in-sandbox tool — but a wedged tab must still fail rather than
# hold the agent's turn open indefinitely.
BRIDGE_TIMEOUT = 45.0


class BrowserBridgeAction(Action):
    """Shared shape: which tool, and which browser if the user has several."""

    device_id: str | None = Field(
        default=None,
        description=(
            'Which paired browser to use. Omit when the user has only one, '
            'which is the normal case.'
        ),
    )


class BrowserReadPageAction(BrowserBridgeAction):
    """Read the visible text of the page the user is currently looking at."""


class BrowserNavigateAction(BrowserBridgeAction):
    url: str = Field(description='An http or https URL to open in the active tab.')


class BrowserListTabsAction(BrowserBridgeAction):
    """List the tabs open in the user's browser."""


class BrowserBridgeObservation(Observation):
    """What the browser reported, or why it could not."""

    ok: bool = Field(description='Whether the browser answered.')
    detail: str = Field(default='', description='Result text, or the reason.')

    @property
    def agent_observation(self) -> Sequence[TextContent]:
        return [TextContent(text=self.detail)]


def _explain(status_code: int, body: str) -> str:
    """Turn a relay failure into something the user can act on."""
    if status_code == 409:
        return (
            'That browser is paired but not connected right now. Ask the user to '
            'open the browser where they installed the Nimbus extension.'
        )
    if status_code == 504:
        return (
            'The browser did not answer in time. The tab may be busy or a dialog '
            'may be open; ask the user to check it.'
        )
    if status_code == 404:
        return (
            'No browser is paired with this account. Ask the user to install the '
            'Nimbus extension and enter the pairing code shown in settings.'
        )
    return f'The browser bridge failed ({status_code}): {body[:200]}'


class BrowserBridgeExecutor(
    ToolExecutor[BrowserBridgeAction, BrowserBridgeObservation]
):
    def __init__(self, tool: str, user_id: str) -> None:
        self._tool = tool
        self._user_id = user_id

    def __call__(
        self, action: BrowserBridgeAction, conversation: Any = None
    ) -> BrowserBridgeObservation:
        params: dict[str, Any] = {}
        if isinstance(action, BrowserNavigateAction):
            params['url'] = action.url

        try:
            response = httpx.post(
                f'{APP_SERVER_URL}/bridge/call',
                json={
                    'user_id': self._user_id,
                    'device_id': action.device_id or '',
                    'tool': self._tool,
                    'params': params,
                },
                timeout=BRIDGE_TIMEOUT,
            )
        except httpx.RequestError as e:
            return BrowserBridgeObservation(
                ok=False,
                detail=f'Could not reach the browser bridge: {e}',
            )

        if response.status_code != 200:
            return BrowserBridgeObservation(
                ok=False, detail=_explain(response.status_code, response.text)
            )

        payload = response.json()
        # The extension answers failures rather than dropping them, so an
        # `error` here is the browser reporting a problem, not a transport fault.
        if isinstance(payload, dict) and payload.get('error'):
            return BrowserBridgeObservation(
                ok=False, detail=f'The browser reported: {payload["error"]}'
            )

        return BrowserBridgeObservation(ok=True, detail=str(payload))


def _make_tool(
    tool_name: str, action_type: type[Action], description: str, read_only: bool
) -> type[ToolDefinition]:
    # `tool_name`, not `name`: inside a class body the right-hand side of
    # `name = name` resolves in the class namespace rather than the enclosing
    # function, so the obvious spelling raises NameError at import.
    class _Tool(ToolDefinition):
        name: ClassVar[str] = tool_name

        @classmethod
        def create(cls, conv_state: Any = None, **params: Any) -> Sequence['_Tool']:
            user_id = os.getenv('NIMBUS_USER_ID', '')
            return [
                cls(
                    description=description,
                    action_type=action_type,
                    observation_type=BrowserBridgeObservation,
                    annotations=ToolAnnotations(
                        title=tool_name,
                        readOnlyHint=read_only,
                        openWorldHint=True,
                    ),
                    executor=BrowserBridgeExecutor(tool_name, user_id),
                )
            ]

    _Tool.__name__ = f'{tool_name}_tool'
    return _Tool


BrowserReadPageTool = _make_tool(
    'browser_read_page',
    BrowserReadPageAction,
    (
        "Read the visible text of the page in the user's own browser. Use this "
        'when the task needs something only they are signed into — their orders, '
        'their dashboard, a ticket behind a login. The sandbox browser is signed '
        'into nothing and cannot see any of it.'
    ),
    read_only=True,
)

BrowserNavigateTool = _make_tool(
    'browser_navigate',
    BrowserNavigateAction,
    (
        "Open a URL in the user's own browser. This changes what they are "
        'looking at, so prefer reading the current page unless they asked to go '
        'somewhere.'
    ),
    read_only=False,
)

BrowserListTabsTool = _make_tool(
    'browser_list_tabs',
    BrowserListTabsAction,
    "List the tabs open in the user's own browser.",
    read_only=True,
)

_TOOLS = (BrowserReadPageTool, BrowserNavigateTool, BrowserListTabsTool)


def register_nimbus_browser_tools() -> list[str]:
    """Register the bridge tools, skipping any name already taken.

    Same contract as the media tools: module-scope registration, and
    sitecustomize calls this by name so the child's startup log says what it got.
    """
    registered = set(list_registered_tools())
    for tool_cls in _TOOLS:
        if tool_cls.name not in registered:
            register_tool(tool_cls.name, tool_cls)
    return [tool_cls.name for tool_cls in _TOOLS]


register_nimbus_browser_tools()
