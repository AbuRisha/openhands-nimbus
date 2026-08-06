"""The preview proxy's contract, minus the actual proxying.

What is worth pinning here is not "does httpx forward bytes" — it does — but the
handful of decisions that are silently wrong if nobody checks: which headers get
stripped, whether the session key leaks onward, and whether a port outside the
sane range is refused.
"""

from __future__ import annotations

import httpx
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
