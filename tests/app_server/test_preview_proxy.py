"""The preview proxy's contract, minus the actual proxying.

What is worth pinning here is not "does httpx forward bytes" — it does — but the
handful of decisions that are silently wrong if nobody checks: which headers get
stripped, whether the session key leaks onward, and whether a port outside the
sane range is refused.
"""

from __future__ import annotations

import httpx
import psutil
import pytest
from fastapi import HTTPException

from openhands.app_server.sandbox import preview_proxy_router as mod


def _response(headers: dict[str, str]) -> httpx.Response:
    return httpx.Response(200, headers=headers)


class TestFrameHeaders:
    def test_strips_x_frame_options(self):
        """A default helmet install sets SAMEORIGIN and would blank the iframe."""
        out = mod._clean_response_headers(
            _response({'x-frame-options': 'SAMEORIGIN', 'content-type': 'text/html'})
        )

        assert 'x-frame-options' not in {k.lower() for k in out}
        assert out['content-type'] == 'text/html'

    def test_strips_only_frame_ancestors_from_csp(self):
        """The rest of the customer's CSP is theirs and stays."""
        out = mod._clean_response_headers(
            _response(
                {
                    'content-security-policy': (
                        "default-src 'self'; frame-ancestors 'none'; script-src 'self'"
                    )
                }
            )
        )

        csp = out['content-security-policy']
        assert 'frame-ancestors' not in csp
        assert "default-src 'self'" in csp
        assert "script-src 'self'" in csp

    def test_drops_a_csp_that_was_only_frame_ancestors(self):
        """An empty CSP header is worse than none: some agents treat it as deny-all."""
        out = mod._clean_response_headers(
            _response({'content-security-policy': "frame-ancestors 'none'"})
        )

        assert 'content-security-policy' not in {k.lower() for k in out}

    def test_strips_hop_by_hop_headers(self):
        """Forwarding content-length corrupts anything httpx re-encodes."""
        out = mod._clean_response_headers(
            _response({'content-length': '12', 'connection': 'keep-alive'})
        )

        assert out == {}


class TestPortGuard:
    @pytest.mark.parametrize('port', [1024, 3000, 5173, 65535])
    def test_allows_ordinary_dev_server_ports(self, port):
        mod._check_port(port)

    @pytest.mark.parametrize('port', [0, 22, 80, 443, 1023, 65536, 99999])
    def test_refuses_privileged_and_out_of_range_ports(self, port):
        """A dev server does not live below 1024, and refusing them keeps this
        from becoming a way to reach whatever else binds low in the container."""
        with pytest.raises(HTTPException) as excinfo:
            mod._check_port(port)

        assert excinfo.value.status_code == 400


class TestSessionKeyResolution:
    class _Req:
        def __init__(self, query: dict, cookies: dict):
            self.query_params = query
            self.cookies = cookies

    def test_prefers_the_query_over_a_stale_cookie(self):
        """A fresh iframe navigation must be able to replace the previous
        conversation's cookie rather than losing to it."""
        req = self._Req({'session_api_key': 'new'}, {mod._COOKIE: 'old'})

        assert mod._session_key(req) == 'new'

    def test_falls_back_to_the_cookie_for_subresources(self):
        """Stylesheets and scripts carry no query string of ours."""
        req = self._Req({}, {mod._COOKIE: 'from-cookie'})

        assert mod._session_key(req) == 'from-cookie'

    def test_none_when_neither_is_present(self):
        assert mod._session_key(self._Req({}, {})) is None


class TestListeningPorts:
    """What is ACTUALLY bound, rather than what package.json claims.

    A product whose runtime is detached from the agent has to guess from a dev
    script. Ours is not detached, so guessing would be a worse answer we chose
    on purpose.
    """

    class _Conn:
        def __init__(self, port, status=psutil.CONN_LISTEN):
            self.laddr = type('A', (), {'port': port})()
            self.status = status

    class _Proc:
        def __init__(self, conns, children=None, raises=None):
            self._conns = conns
            self._children = children or []
            self._raises = raises

        def children(self, recursive=False):  # noqa: ARG002
            return self._children

        def net_connections(self, kind='tcp'):  # noqa: ARG002
            if self._raises:
                raise self._raises
            return self._conns

    def _patch(self, monkeypatch, root):
        monkeypatch.setattr(mod.psutil, 'Process', lambda _pid: root)

    def test_reports_a_listening_port(self, monkeypatch):
        self._patch(monkeypatch, self._Proc([self._Conn(5173)]))

        assert mod.listening_ports_for(1) == [5173]

    def test_includes_ports_bound_by_children(self, monkeypatch):
        # Nobody starts a server directly: `npm run dev` forks node, and node is
        # the process that actually binds.
        child = self._Proc([self._Conn(3000)])
        self._patch(monkeypatch, self._Proc([], children=[child]))

        assert mod.listening_ports_for(1) == [3000]

    def test_ignores_connections_that_are_not_listening(self, monkeypatch):
        # An outbound connection to npm is not something to offer as a preview.
        self._patch(
            monkeypatch,
            self._Proc([self._Conn(51234, status=psutil.CONN_ESTABLISHED)]),
        )

        assert mod.listening_ports_for(1) == []

    def test_excludes_the_agent_server_port(self, monkeypatch):
        self._patch(monkeypatch, self._Proc([self._Conn(8001), self._Conn(5173)]))

        assert mod.listening_ports_for(1, exclude={8001}) == [5173]

    def test_excludes_privileged_ports(self, monkeypatch):
        self._patch(monkeypatch, self._Proc([self._Conn(80), self._Conn(5173)]))

        assert mod.listening_ports_for(1) == [5173]

    def test_deduplicates_and_sorts(self, monkeypatch):
        # A server bound on both v4 and v6 shows up twice and is one port.
        child = self._Proc([self._Conn(5173)])
        self._patch(
            monkeypatch,
            self._Proc([self._Conn(5173), self._Conn(3000)], children=[child]),
        )

        assert mod.listening_ports_for(1) == [3000, 5173]

    def test_a_child_exiting_mid_scan_does_not_fail_the_listing(self, monkeypatch):
        # Ordinary, not an error worth losing every other port over.
        dying = self._Proc([], raises=psutil.NoSuchProcess(pid=2))
        self._patch(monkeypatch, self._Proc([self._Conn(5173)], children=[dying]))

        assert mod.listening_ports_for(1) == [5173]

    def test_a_dead_root_reports_nothing_rather_than_raising(self, monkeypatch):
        def _boom(_pid):
            raise psutil.NoSuchProcess(pid=1)

        monkeypatch.setattr(mod.psutil, 'Process', _boom)

        assert mod.listening_ports_for(1) == []


class TestCookieBootstrap:
    """The cookie exists so the iframe src never has to carry a credential.

    If a client authenticated the iframe by putting the session key in `src`,
    that key would persist in the DOM, in any screenshot of the page, and in
    browser history. Setting the cookie on the ports call — which a client makes
    before it can show a preview anyway — means the src can be the bare
    /preview/{id}/{port}/ with no credential in it at all.
    """

    def test_sets_a_cookie_scoped_to_this_conversation(self):
        from fastapi import Response

        response = Response()
        mod._set_preview_cookie(response, 'conv-1', 'sk-key')

        cookie = response.headers['set-cookie']
        assert 'nimbus_preview_key=sk-key' in cookie
        # Path-scoped: a key for one conversation must not ride along on
        # requests for another.
        assert 'Path=/preview/conv-1/' in cookie

    def test_cookie_is_httponly(self):
        """Script in the previewed page must not be able to read it."""
        from fastapi import Response

        response = Response()
        mod._set_preview_cookie(response, 'conv-1', 'sk-key')

        assert 'HttpOnly' in response.headers['set-cookie']

    def test_sets_nothing_without_a_key(self):
        """An unauthenticated request must not plant an empty cookie that then
        wins over a real one on the next call."""
        from fastapi import Response

        response = Response()
        mod._set_preview_cookie(response, 'conv-1', None)

        assert 'set-cookie' not in response.headers
