"""The browser socket's session key must not travel in the URL.

It used to be `?session_api_key=...`, which Azure ingress and Log Analytics
record verbatim. A replayed key reaches `/api/file/*` on a sandbox where an
agent executes code, so a file written into that workspace is a path to
execution even though `/api/bash/*` is not proxied.

These tests cover the two things that could go wrong in opposite directions:
the key still leaking into a URL, and the fallback being dropped — which would
disconnect every already-open tab at the moment of the deploy.
"""

import base64
from urllib.parse import parse_qs

import pytest

from openhands.app_server.sandbox.agent_proxy_router import (
    SESSION_KEY_SUBPROTOCOL,
    _key_from_subprotocol,
    _upstream_query,
)


class _FakeWebSocket:
    """Only the two attributes the helpers read."""

    def __init__(self, headers=None, query_params=None):
        self.headers = headers or {}
        self._query = query_params or []

    @property
    def query_params(self):
        items = self._query

        class _QP:
            def multi_items(self):
                return list(items)

            def get(self, name, default=None):
                for k, v in items:
                    if k == name:
                        return v
                return default

        return _QP()


def _encode(key: str) -> str:
    """Mirror of the frontend's encodeSessionKey: base64url, padding stripped."""
    return base64.urlsafe_b64encode(key.encode()).decode().rstrip('=')


class TestKeyFromSubprotocol:
    def test_reads_the_key_the_browser_sent(self):
        key = 'sk-live-9f8e7d6c5b4a'
        ws = _FakeWebSocket(
            headers={
                'sec-websocket-protocol': f'{SESSION_KEY_SUBPROTOCOL}, {_encode(key)}'
            }
        )
        assert _key_from_subprotocol(ws) == key

    @pytest.mark.parametrize('length', [1, 2, 3, 4, 5])
    def test_decodes_every_padding_case(self, length):
        """Padding is stripped on the wire because '=' is not a legal token
        character, so the server has to re-add it. Off-by-one here fails auth
        for whichever key lengths land on that residue -- an intermittent
        failure that would look like a flaky network."""
        key = 'k' * length
        ws = _FakeWebSocket(
            headers={
                'sec-websocket-protocol': f'{SESSION_KEY_SUBPROTOCOL}, {_encode(key)}'
            }
        )
        assert _key_from_subprotocol(ws) == key

    def test_ignores_a_header_that_is_not_ours(self):
        ws = _FakeWebSocket(headers={'sec-websocket-protocol': 'graphql-ws, foo'})
        assert _key_from_subprotocol(ws) is None

    def test_absent_header_is_none_not_an_error(self):
        assert _key_from_subprotocol(_FakeWebSocket()) is None

    def test_marker_without_a_value_is_none(self):
        ws = _FakeWebSocket(
            headers={'sec-websocket-protocol': SESSION_KEY_SUBPROTOCOL}
        )
        assert _key_from_subprotocol(ws) is None

    def test_garbage_value_is_treated_as_absent_rather_than_raising(self):
        """A raise here would 500 the handshake. Returning None lets it fall
        through to the query parameter, and failing that to _resolve, which
        already closes the socket with a code the client can act on."""
        ws = _FakeWebSocket(
            headers={'sec-websocket-protocol': f'{SESSION_KEY_SUBPROTOCOL}, !!!not-b64!!!'}
        )
        assert _key_from_subprotocol(ws) is None


class TestUpstreamQuery:
    """THE SANDBOX ONLY TAKES THE KEY AS A QUERY PARAMETER.

    Its socket signature is `session_api_key: Annotated[str | None, Query(...)]`
    with no header alternative, so this leg cannot follow the browser leg onto a
    header. Stripping it here would authenticate nothing.
    """

    def test_puts_the_key_back_for_the_sandbox(self):
        ws = _FakeWebSocket(query_params=[('resend_all', 'true')])
        parsed = parse_qs(_upstream_query(ws, 'sk-live-1'))
        assert parsed['session_api_key'] == ['sk-live-1']
        assert parsed['resend_all'] == ['true']

    def test_does_not_duplicate_a_key_that_came_in_the_query(self):
        """An old client sends it in the query AND we append it. Two values for
        one parameter is exactly the kind of thing a framework resolves
        arbitrarily."""
        ws = _FakeWebSocket(
            query_params=[('session_api_key', 'old'), ('resend_all', 'true')]
        )
        query = _upstream_query(ws, 'resolved')
        assert query.count('session_api_key') == 1
        assert parse_qs(query)['session_api_key'] == ['resolved']

    def test_preserves_other_parameters_including_repeats(self):
        ws = _FakeWebSocket(
            query_params=[('resend_mode', 'since'), ('tag', 'a'), ('tag', 'b')]
        )
        parsed = parse_qs(_upstream_query(ws, 'k'))
        assert parsed['resend_mode'] == ['since']
        assert parsed['tag'] == ['a', 'b']

    def test_omits_the_parameter_entirely_when_there_is_no_key(self):
        ws = _FakeWebSocket(query_params=[('resend_all', 'true')])
        assert 'session_api_key' not in _upstream_query(ws, None)


class TestBackwardCompatibility:
    """The fallback is the difference between a deploy and an outage.

    This is every chat session's auth on a hot path. A tab that is already open,
    or one running a cached copy of the previous bundle, still sends the key the
    old way -- and would be disconnected at the moment of the revision swap if
    the query parameter stopped being read.
    """

    def test_an_old_client_still_authenticates(self):
        ws = _FakeWebSocket(query_params=[('session_api_key', 'from-old-bundle')])
        assert _key_from_subprotocol(ws) is None
        assert ws.query_params.get('session_api_key') == 'from-old-bundle'

    def test_the_subprotocol_wins_when_a_client_sends_both(self):
        """Only one can be authoritative. The header is the one that is not in
        the log, so a client shedding the old parameter mid-rollout is
        authenticated by the new path."""
        key = 'from-header'
        ws = _FakeWebSocket(
            headers={
                'sec-websocket-protocol': f'{SESSION_KEY_SUBPROTOCOL}, {_encode(key)}'
            },
            query_params=[('session_api_key', 'from-query')],
        )
        resolved = _key_from_subprotocol(ws) or ws.query_params.get('session_api_key')
        assert resolved == 'from-header'
