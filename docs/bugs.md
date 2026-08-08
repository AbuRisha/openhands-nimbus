# Bugs — open and recently fixed

Newest first. A bug leaves this file only when something proves it is gone,
not when it stops being reproduced.

## 2026-08-08 — conversation-panel "should render the conversations" flakes under full-suite load

NOT A REAL FAILURE, and not the i18n merge. Symptom: `findAllByTestId(
"conversation-card")` times out in `__tests__/components/features/
conversation-panel/conversation-panel.test.tsx` during `vitest run` with no
filter. The SAME FILE ON THE SAME TREE passes 22/22 when run alone.

The variable is machine load, not code. The failing run reported 2381s of
environment time against 293s wall clock — several sessions were building
concurrently. `findAllByTestId` waits 1000ms by default, and that is what
expires.

How to check it is still this and not something real: run the file alone. If
it passes alone and fails in the suite, it is this. If it fails alone, it is
not — start looking at the conversation-service mocks.

Worth raising the timeout on that assertion if it keeps costing people time,
but a bare timeout bump hides real regressions too, so it is left alone.

## 2026-08-08 — 1001 as a terminal close code is a regression, and it is in the deployed build

`6bc22a182` (deployed) contains `85be8484e`, which set

    const TERMINAL_CLOSE_CODES = new Set([1000, 1001, 1008]);

1001 is "going away" — what a server sends while shutting down for a restart,
i.e. the RECOVERABLE case. Treating it as terminal means an agent-server
restart permanently stops reconnection, where the previous unbounded-retry
behaviour recovered.

NOTHING ELSE PICKS IT UP. `useSandboxRecovery` is gated on the SANDBOX being
paused/stopped and its own docstring says "WebSocket disconnect: Does NOT
automatically resume". A socket that stopped retrying is never re-opened.

Mine, and I should not have shipped it — 1001 came along with 1000 rather than
being reasoned about. Found by the backend session asking whether it was
deliberate.

FIXED ON THE TIP, not by a patch but by replacement: `classifyCloseCode`'s
`PERMANENT_CLOSE_CODES` is {1008, 4401, 4403} and does not include 1001 or
1000. Deploying anything at or after `4d43a8a3b` resolves it.

## 2026-08-08 — every websocket rejection reaches the browser as 1006, not 1008

Independently reached by two sessions. The accept-then-close change that lets a
1008 close code survive to a browser is on `lane/backend` and in NO build. The
deployed server rejects BEFORE `accept()`, so uvicorn answers the upgrade with
an HTTP status, the handshake never completes, and the browser synthesises
1006 — which is also exactly what an unreachable server looks like.

CONSEQUENCE FOR ANYONE TESTING RECONNECT AGAINST PRODUCTION: expect 1006. Every
client-side 1008 check is dead code until the backend deploys.

Handled on the tip by `everOpenedRef`: a socket that never reached `onopen` is
classified `handshake-refused` after 3 attempts. That reason deliberately does
NOT claim the session expired, because 1006 cannot distinguish a refused
upgrade from a dropped network, and the banner must not tell someone whose wifi
died a specific untrue thing about their account.

Three pre-accept paths remain that no client change can fix, enumerated by the
backend session: `proxy_events_socket` catching only `HTTPException`; the SPA
catch-all, where `StaticFiles.__call__` asserts `scope["type"] == "http"` and
so kills any websocket to an unmatched path; and anything in front of the app
server, which cannot be verified from source.
