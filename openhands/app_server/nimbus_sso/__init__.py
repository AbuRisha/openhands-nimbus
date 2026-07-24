"""Nimbus SSO handoff — HS256 JWT verification from nimbusapi.net dashboard.

Exposes GET /api/auth/nimbus-sso?token=<jwt>. Verifies the token with
NIMBUS_SSO_SHARED_SECRET (shared with nimbusapi.net's /api/auth/chat-token
mint), sets a session cookie identifying the Nimbus customer, and redirects
to the chat root. Any verification failure short-circuits to /?error=<code>.
"""
