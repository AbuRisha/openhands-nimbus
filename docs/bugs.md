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

## 2026-08-08 — model routing: create-with-llm_model and switch_profile are EQUIVALENT

Investigated because another session's raw-API tests failed on models the
founder said work, and the working theory was that API-created conversations
skip profile/key resolution the UI does. Traced both paths to the LLM object;
they converge. Recorded because two of my own intermediate conclusions were
wrong and someone will otherwise re-derive them.

    create   _configure_llm (live_status_app_conversation_service.py:1538)
             model    = request.llm_model
             base_url = resolve_provider_llm_base_url(...)  -> saved base_url
             api_key  = user.agent_settings.llm.api_key
             stream   = True

    switch   resolve_profile_llm (settings/llm_profiles.py)
             model    = catalog model string (IDENTICAL — see below)
             base_url = resolve_llm_base_url(...) -> pinned gateway
             api_key  = profile key, else fallback to the same settings key
             stream   = True

WHAT I GOT WRONG FIRST, both worth knowing:

1. "create leaves base_url unpinned, so a Nimbus key could reach a third
   party." FALSE. `nimbus_settings_store._repair_base_url` (:228) forces
   `llm.base_url = os.getenv('LLM_BASE_URL')` on EVERY settings load for EVERY
   user, overwriting whatever was stored. base_url is always the current
   gateway. There is no third-party exposure here.

2. "the catalog pins a base_url the raw POST bypasses, and that explains the
   failures." The pinning is real (nimbus_catalog_profiles.py:200) and changes
   nothing, because the catalog seeds THE SAME MODEL STRINGS a raw caller
   would send — 'openai/gpt-5.5', 'anthropic/claude-sonnet-5' etc., from
   nimbus_llm_model_service. Same string, same gateway.

RULED OUT, so nobody re-tests it: the agent-server LLM registry is
first-write-wins by `usage_id`, but the switch handler already derives
`profile:{name}:{sha1(payload)[:12]}` so a changed model always gets a fresh
slot; and `LocalConversation.switch_llm` (sdk .../local_conversation.py:1458)
genuinely rebinds — `update = {"llm": new_llm}` applied to the agent — rather
than merely registering. A switch is not silently dropped.

CONSEQUENCE: the /responses failure is NOT explained by conversation-creation
path. `LLM.uses_responses_api` matches "gpt-5" by case-insensitive SUBSTRING
against the SDK's own RESPONSES_API_MODELS, so it matches every gpt-5.x on
BOTH paths, and the gateway does not implement /responses. Anyone testing this
should expect a UI switch to GPT-5.5 to fail identically to a raw POST.

ONE SOFT SPOT, not a bug today: the conversation record's `llm_model` is
persisted from what we ASKED for, after `raise_for_status()` on the switch. So
it is honest as long as a 2xx means the swap landed. If switch_llm ever starts
returning 2xx on a partial swap, the model chip becomes a claim rather than a
fact.

## 2026-08-08 — `npm run build` EPERM on build/locales is a LOCAL dev-server lock, not a build break

Symptom, on Windows, in a tree that also has a Vite dev server running:

    ✓ built in 10.24s
    Error: EPERM: operation not permitted, rename
      'frontend\build\client\locales' -> 'frontend\build\locales'
      at Object.unpackClientDirectory (react-router.config.ts:19)

NOTE THE ORDERING: the Vite build SUCCEEDS. The failure is the post-build
unpack step renaming directories out of `build/client/`, and only `locales`
fails — the one directory holding ~15 JSON files the build has just written.

CAUSE: a `npm run dev:mock` server running in the SAME tree holds a handle on
those files. On Windows a directory rename fails with EPERM while any handle
inside it is open. Verified by experiment rather than assumed:

  - clean `rm -rf build` then build, dev server RUNNING  -> EPERM, every time
  - stop the dev server, `rm -rf build`, build           -> clean, and
    build/locales + build/index.html present, 180 assets

NOT a stale-artifact problem (it reproduces from an empty build/) and NOT a
code or merge problem. It does not affect CI or the deploy, both of which
build on Linux in a tree with no dev server.

IF YOU HIT IT: stop your preview/dev server and rebuild. Do not go looking for
it in react-router.config.ts.

RELEVANT TO THIS REPO SPECIFICALLY because several sessions run dev servers
out of the shared `openhands-nimbus` tree at once, so one session building
while another previews will produce this for the builder.

VERIFIED SEPARATELY, and the thing people actually want to know: the merged
`land/auth-gates` tip BUILDS CLEAN.
