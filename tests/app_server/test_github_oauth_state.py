"""The ``state`` parameter is the only thing standing between this flow and
login-CSRF.

Without a verified state, anyone can hand our callback an authorization code
they obtained for THEIR GitHub account and we will store THEIR token against
whoever happens to be signed in — silently attaching an attacker-controlled
repo source to a victim's agent. That is why these tests exist and why the
signature comparison is constant-time.
"""

from __future__ import annotations

import time

import pytest

from openhands.app_server.nimbus_github_oauth import github_oauth_router as mod


@pytest.fixture(autouse=True)
def _signing_key(monkeypatch):
    monkeypatch.setenv('NIMBUS_SSO_SHARED_SECRET', 'test-signing-key')


def test_a_freshly_minted_state_verifies():
    assert mod._verify_state(mod._make_state()) is True


def test_a_tampered_signature_is_rejected():
    state = mod._make_state()
    nonce, issued, signature = state.rsplit('.', 2)
    forged = f'{nonce}.{issued}.{"0" * len(signature)}'

    assert mod._verify_state(forged) is False


def test_a_tampered_payload_is_rejected():
    """Changing the nonce must invalidate the signature over it."""
    state = mod._make_state()
    nonce, issued, signature = state.rsplit('.', 2)

    assert mod._verify_state(f'attacker.{issued}.{signature}') is False


def test_an_unsigned_state_is_rejected():
    assert mod._verify_state('just-some-string') is False
    assert mod._verify_state('') is False
    assert mod._verify_state('a.b') is False


def test_an_expired_state_is_rejected():
    """A consent screen takes minutes; anything older is a replay."""
    stale_issued = int(time.time()) - (mod._STATE_TTL_SECONDS + 60)
    import hashlib
    import hmac

    payload = f'nonce.{stale_issued}'
    signature = hmac.new(
        mod._signing_key(), payload.encode(), hashlib.sha256
    ).hexdigest()

    assert mod._verify_state(f'{payload}.{signature}') is False


def test_a_state_signed_with_a_different_key_is_rejected(monkeypatch):
    """Signed by someone else is not signed by us."""
    state = mod._make_state()
    monkeypatch.setenv('NIMBUS_SSO_SHARED_SECRET', 'a-completely-different-key')

    assert mod._verify_state(state) is False


def test_states_are_unique_per_request():
    """A fixed state would be replayable even while valid."""
    assert mod._make_state() != mod._make_state()


def test_redirect_uri_comes_from_configuration_not_the_request(monkeypatch):
    """Deriving it from the inbound Host header would let a spoofed request
    send the authorization code somewhere we do not control."""
    monkeypatch.setenv('OH_PUBLIC_BASE_URL', 'https://chat.nimbusapi.net')

    assert (
        mod._redirect_uri()
        == 'https://chat.nimbusapi.net/api/v1/auth/github/callback'
    )


def test_scopes_do_not_include_destructive_permissions():
    """An agent should not be able to delete a repository because a prompt
    told it to."""
    assert 'delete_repo' not in mod._SCOPES
    assert 'admin:org' not in mod._SCOPES
    assert 'repo' in mod._SCOPES
