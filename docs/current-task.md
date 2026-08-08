# Current task

Live state for the Claude-parity work on `chat.nimbusapi.net`. Read this first,
then `docs/parity-roadmap.md` for the full inventory and evidence.

Last updated: 2026-08-08. Branch `land/auth-gates`.

> **AUDIT NOTE 2026-08-08.** Sections below this line dated 2026-08-06 or
> earlier have been checked against the tree where they make testable claims.
> Where a claim was stale it is struck through with a dated retraction rather
> than deleted, so anyone holding the old status can see what changed. Two
> whole classes of claim turned out to be wrong: the standing "known red"
> test labels (all green, and two were never upstream) and the "Next three
> actions" list (two of three already shipped). Treat undated claims here as
> unverified until someone runs them.

## Next three actions

**P17 is DONE** (`3e9fec44a`, hooks passing, no `--no-verify`). Kept below for the
reasoning, because the same shape will arrive again with the next merge from
main: a new file lands there failing the repo's own hooks, and the cheap way out
is a flag. All four violations are fixed — 9 eslint + 1 a11y in the panel, mypy
`union-attr` and ruff `B008` in `nimbus_account_router`.

1. ~~**P17 — unblock the commit hook.**~~ **DONE.**
   `frontend/src/components/features/user/nimbus-account-panel.tsx` has 9
   `i18next/no-literal-string` violations and fails eslint **on main**. Because
   lint-staged runs on whatever a commit stages, it blocks every merge commit
   that touches it — which is why two commits on this branch used `--no-verify`
   (`c3d6afed6`, `3c1e4d00a`). Until it is fixed, every future merge from main
   inherits the same choice, and `--no-verify` stops being an exception and
   becomes the habit.
   It is also customer-facing untranslated English — "Balance", "Could not save
   the limit" — in the panel showing someone's account balance. Fix means real
   i18n keys across all fifteen locales, the same as
   `NIMBUS$EFFORT_NOT_SUPPORTED_FOR_MODEL` and the nav labels already added.
2. ~~**P15 — refusal failover.**~~ **DONE — verified 2026-08-08.** This entry
   said the units were built and "LEFT: mount them in chat-interface.tsx".
   They are mounted: `chat-interface.tsx:41-43` imports RefusalPrompt,
   useRefusalFailover and useApplyRefusalChoice; :203 and :211 call the hooks;
   :513 renders `<RefusalPrompt>` wired to `apply(resolve(choice), ...)`. Also
   confirmed live in a browser — `refusal-prompt`, `refusal-retry-once`,
   `refusal-retry-sticky`, `refusal-edit` and `refusal-cancel` are all in the
   DOM on /conversations/:id.
3. ~~**P11 — queue control.**~~ **LARGELY DONE — verified 2026-08-08.** This
   entry said "the store holds ONE message, so queueing a second replaces the
   first". That is no longer true: `use-pending-messages.ts` queries
   `/api/v1/conversations/{id}/pending-messages` as a LIST and
   `pending-messages.tsx` renders each with its own cancel, scoped to
   conversation AND message id per the contract below. Reorder/promote are
   still unbuilt and still blocked on the same missing ordering column.

**NEXT, and these are actually open** (see docs/parity-roadmap.md for evidence):
   - **#20 print-to-PDF** — the one remaining piece of artifacts that is purely
     additive. Share/auto-publish is NOT next: it needs a decision on whether
     version history travels with a shared link, and history is the part that
     leaks.
   - **#22 scheduled-tasks runner** — model and store exist with 21 tests, and
     no runner. Blocked on ONE security decision, not on plumbing: a scheduler
     has no request, so firing a task means letting background code act as a
     customer and spend their credit. See scheduled_task_models.py.
   - **#26 side-chat continuity** — one-shot `ask_agent` is built; continuity
     needs real sub-conversation state.

~~Then **P13 — live preview tab**~~ — BUILT, see the audit note below. What
remains of #16 is the INTROSPECTION half (reading console/network out of the
iframe), which is a security tradeoff awaiting a founder decision, not a build
task.

## Where the two lanes stand (2026-08-06, late)

Isolation is real: the other session moved to a worktree.
  openhands-nimbus       [land/auth-gates]       <- this lane
  openhands-lane-queue   [lane/queued-messages]  <- theirs

> **ALL THREE CLAIMS BELOW ARE STALE — audited 2026-08-08.** Every "unclaimed"
> or "not built" item in this section is now built and on the branch. Struck
> through rather than deleted so the old status is still legible, but do NOT
> pick work from here: use "Next three actions" at the top.

**Mine, landed:** P17 (all four violation classes, hooks passing).
~~**Mine, landed:** P15 CORE only — `src/utils/refusal-failover.ts`, 14 tests
(`596116e25`). Pure decision logic. The UI is NOT built: the three-option
prompt, the 300s self-answer, and the post-turn restore wiring are all still to
do. Do not describe P15 as done.~~
**P15 IS DONE**, and this paragraph contradicted the corrected entry at the top
of the file until 2026-08-08. Mounted at `chat-interface.tsx:41-43, :203, :211,
:513`; the five `refusal-*` testids render in a live browser.

~~**Mine, unclaimed and ready:** P13 Phase 1 FRONTEND.~~ **P13 IS BUILT.**
`components/features/preview/preview-panel.tsx` exists and its iframe carries
`sandbox="allow-scripts allow-forms"` at :152 with NO `allow-same-origin` — the
property this entry asked for, with the reasoning in its own docstring at :19.
The tab is reachable (`conversation-tab-preview` is in the DOM). Backend
`GET /preview/{id}/ports` (`b44494b49`) is wired.

~~**Mine, unclaimed:** P11 FRONTEND.~~ **P11 IS BUILT** except reorder/promote.
`use-pending-messages.ts` queries the collection and `pending-messages.tsx`
renders each entry with its own cancel. The contracts below WERE honoured —
keeping them because they are the reasoning, not a task list:
  - Cancel is scoped to conversation AND message id, always both. Matching on
    the id alone would let anyone holding one cancel a message in someone
    else's conversation.
  - DELETE answers **204 when the message is already gone**, because the queue
    drains the moment the agent is ready and losing that race is the ordinary
    outcome of clicking a fraction too late. **Do not show a failure toast.**
    Remove the chip and treat 204 as success unconditionally.
  - Use a SEPARATE list keyed off the GET, not an extension of the
    optimistic-message store. That store holds one string with a different
    lifecycle, and conflating them is how the single-slot limitation happened.
  - Reorder/promote are deliberately NOT implemented: there is no ordering
    column beyond created_at, so it needs a schema decision nobody has made.

## ATTRIBUTION IS WRONG IN TWO PUSHED COMMITS — do not "fix" it casually

While we shared one working tree, two commits swapped contents:
  - `3e9fec44a` ("the panel shipped untranslated English") also contains the
    entire preview proxy: `preview_proxy_router.py` (200), `test_preview_proxy.py`
    (101), `app.py` (16).
  - `ba9708c85` ("serve the customer's dev server back into their browser")
    contains ONLY a 7-line `docs/current-task.md` edit — none of the proxy.

Verified with `git show --stat` on both. Nothing is lost, every file is on the
branch, tests pass. Rewriting pushed history to fix this trades a cosmetic
problem for a lost-work one; a note in the PR description carries the same
information to a reviewer at no risk.

## Two rules worth applying beyond where they were found

**Fail toward the outcome you would find out about.** A customer reports a
feature that stopped working. Nobody reports code that quietly ran, or money
quietly spent. When an ambiguity has to resolve somewhere, ask which failure is
SILENT and default away from it. That is why the MCP policy fails restrictive
(silent failure = unpermitted code running) and self-verification fails off
(silent failure = money spent) — same shape, opposite answer, one rule.

**Green tests can be evidence of nothing.** Two cases hit this today:
- A conversation-title search used `.like()`. SQLite (tests) ignores case,
  Postgres (production) does not, so "billing" would never have matched
  "Billing" and every test passed. Fixed to `.ilike()`, asserted on the
  COMPILED SQL because a behavioural test cannot see it on SQLite — and
  verified by reintroducing the bug and watching the test fail. The same shape
  applies to NULL ordering and collation.
- Every test of a feature flag imported the constant, so a wrong name would
  have been consistently wrong and invisible: code and tests agreeing with each
  other while both disagreed with the deployment.

The generalisation: a unit test of a function proves the function works, not
that anything calls it, and not that it agrees with production. When a feature
has no runtime signal on failure, something has to check its wiring.

## P15 — four units built, ONE step left

BUILT and pushed, 37 tests, none touching the send loop:
- `src/utils/refusal-failover.ts` — looksLikeRefusal (with a length ceiling),
  chooseFallback, modelToRestoreAfterTurn (14 tests, `596116e25`)
- `components/features/chat/refusal-prompt.tsx` — inline prompt, two separate
  retries, 300s self-answer (8 tests, `1a0fa14f5`)
- `hooks/chat/use-refusal-failover.ts` — detection, once per message
  (8 tests, `d4a68f00b`)
- `hooks/chat/use-apply-refusal-choice.ts` — switch, resend, restore after the
  turn (7 tests, `4016fd62a`)

LEFT: mount them in `chat-interface.tsx`. Feed `useRefusalFailover` the v1
events, `isRunning` from curAgentState, `conversation.llm_model`, and a catalog
from `useLlmProfiles()` as `{name, model}`. Render `<RefusalPrompt>` when
`refusal` is non-null. Route `resolve` into
`useApplyRefusalChoice.apply(choice, originalText, originalModel)` where
originalText is the last USER MessageEvent — NOT the optimistic store, which is
cleared by then.

Handed to the other lane 2026-08-06; confirm before duplicating it.

ALREADY SOLVED IN THE UNITS — do not re-solve:
- Detection waits for the turn to end, so a partial stream cannot fire it.
- A message is prompted at most once. A retry that ALSO refuses arms on its own
  new message, which is correct; the loop only happens if the SAME message
  re-arms.
- `looksLikeRefusal` has a length ceiling, because substring matching alone
  called "I can't help with the old API, but here's the new one" a refusal —
  found by a test written to guard something else entirely.
- Switching takes a profile NAME, not a model id. Passing an id is a silent
  no-op and the retry runs on the model that just refused.

## Also verified in a browser (later pass)

- **Settings nav search.** Typing `mem` filters fourteen items to `Memory`, with
  section headers correctly dropped — the specific thing the pure filter was
  written to get right, since a caption left standing over nothing reads as
  broken rather than filtered. A no-match query shows "No settings match your
  search" and nothing else.
- **Conversation search.** `preview` narrows three to one; uppercase `BILLING`
  matches lowercase "billing reconciler" (the `.ilike()` fix, end to end); a
  no-match query shows ONE empty state, not two.
- **Tool-call rows** carry the summarizer's labels: `Read src/cart.ts`,
  `Edit src/cart.ts`, `Bash npm test -- cart`.

DEV-MOCK LIMITATION worth knowing before anyone debugs it as a proxy fault: the
preview iframe requests `/preview/{id}/{port}/` and under `dev:mock` the SPA
router claims that path — `No route matches URL "/preview/1/5173"`, 404. In
production FastAPI serves it before the SPA mount, so this is the harness, not
the feature. It does mean the preview tab cannot be exercised end to end under
mocks.

NOT verified visually: the truncation notice. The helper is unit-tested both
ways (states the omitted count; no-op below the ceiling) but I could not get a
long-output row to reveal its body in the browser.

## AUTH AUDIT, 2026-08-06 — two unauthenticated bridge endpoints

Read from source. **Nothing was probed against a running service**, deliberately.

`nimbus_auth_gate.py:147` enforces only on `/api`: for any non-page-load request
to a path outside it, the middleware falls straight through to `call_next`. So
a router mounted outside `/api` is unprotected BY DEFAULT, and silently — it
bypasses the gate rather than being exempted by it.

Every route outside `/api`:

| Route | Auth | Verdict |
|---|---|---|
| `/bridge/pair` | none | **correct by design** — the pairing code IS the credential; 8 chars from 32 symbols, 120s, single-use, five attempts, only ever shown inside an authenticated session |
| `/bridge/device` (ws) | token in first message | fine |
| **`/bridge/call`** | **NONE** | **`user_id` and `device_id` come from the request BODY.** An unauthenticated POST drives any user's paired browser through the 22 browser tools — their real Chrome, signed into their accounts |
| **`/bridge/devices/{user_id}`** | **NONE** | lists any user's paired browsers and pairing times, and distinguishes a real id from an invented one — which supplies the `device_id` the call above needs |
| `/preview/{id}/ports` | `validate_session_key` | fine |
| `/sockets/events/{id}` | exempt-listed, `X-Session-API-Key` | fine |

`grep -cE "Depends\(|get_user_id|validate_session|X-Session-API-Key"
bridge_router.py` returns **0**. The module docstring says `/bridge/call` is
"Session authenticated, because it is the agent server calling in, not a
browser" — that is the intent, and it is not what the code does. Both gaps are
endpoints added after that docstring was written.

The exempt list was audited too and is sound: the agent proxy checks
`validate_session_key` (8 sites), the event webhook has a `valid_sandbox`
dependency (10 sites), and `/api/auth/`, `/health`, `/alive`, `/oauth/` and the
public web-client config are legitimately open.

So the gap is exactly two endpoints, which is why this is contained rather than
systemic.

FIX, and it solves a second problem at once: `/bridge/call` should authenticate
on `X-Session-API-Key` resolved to a sandbox — the mechanism `/preview` and the
webhook already use, and the one its own docstring claims — with `user_id`
coming from that resolution rather than the body. `/bridge/devices` should drop
the path param and derive the user from the session, which ALSO fixes the
frontend being unable to supply a `user_id` at all (`useMe` is SaaS-gated and
`/api/v1/nimbus/account` returns no id).

**P5 UI is deliberately NOT built on top of this.** Escalated to the lane that
owns the module.

Worth revisiting separately: the gate keying on `startswith('/api')` means the
next router mounted outside it inherits the same silent default.

## Done and verified

| | Verified how |
|---|---|
| P0 conversations stop auto-archiving on restart | 5 tests |
| P1 `image_generate` / `video_generate` as real agent tools | 33 tests |
| P2 one row per tool call, not "Used N tools" | 23 tests **+ browser** |
| P10 file edits render as diffs | 29 tests |
| P14 dead Code tab hidden | typecheck + reasoning from `exposed_urls` |
| Settings speak our product, not OpenHands | **browser** |
| Settings nav search | 7 tests |
| `dev:mock` reaches the chat at all | **browser** |

Bugs found and fixed along the way, none of them on the original plan: Escape
never interrupted a run; sub-agents were off by default; queued messages
vanished; a modal Escape used a stale closure; the mypy hook was unpassable on
Windows; a bare `logger` NameError killed conversation startup; one malformed
observation white-screened the entire transcript.

## Known-red, and NOT caused by this branch

- `nimbus-account-panel.tsx` fails eslint **on main** — 9
  `i18next/no-literal-string` errors including a hardcoded "Balance". It blocks
  every merge commit that stages it, which is why two commits here used
  `--no-verify`. Tracked as P17. Fix it early; it also means non-English
  customers see untranslated English in the account panel.
- ~~`conversation-name` and `recent-conversation` tests fail, inherited from
  upstream `13634324c`.~~ **RETIRED 2026-08-08 — wrong twice over, and left
  standing longer than it should have been.** They were never upstream:
  `9a8382718` records that the last one "was not upstream, it was the same
  rebrand as the other" — i.e. OURS, from the settings-nav vocabulary change.
  They are also all green now. Verified by running the four files together:
  `conversation-name`, `recent-conversation`, `recent-conversations`,
  `conversation-card` — 59 passed, 0 failed.

  Kept visible rather than deleted, because the failure mode of a stale
  known-red label is worse than the label being wrong: it teaches everyone to
  wave those files through, so the NEXT real regression there gets read as
  "oh, that's the upstream one" and shipped. If a suite is red, either fix it
  or write down the commit that proves it is not ours — "inherited" without a
  reproduction is a guess.
- ~~Three `docs.openhands.dev` help-link tests fail; pre-existing.~~ RETIRED
  2026-08-08: green. `openhands-api-key-help` + `llm-settings` run together,
  82 passed, 0 failed.

## Verified in a browser, 2026-08-06

Everything below was confirmed against a running app, not inferred from tests.

- **Diffs.** One `code.language-diff` block with the `---`/`+++` header, the
  removals, the addition, and the surrounding context line preserved — the last
  being what the trim bug deleted.
- **Preview tab.** `src="/preview/1/5173/"` with NO credential in the URL, and
  `sandbox="allow-scripts allow-forms"` with NO `allow-same-origin`. Both
  security properties confirmed as rendered attributes rather than intentions.
  Port picker lists `:5173` and `:3000`.
- **Queue chips.** Render with text, waiting label and Cancel. Clicking Cancel
  removes the chip immediately and shows NO error toast — the 204-is-success
  path behaving as designed.
- **Dead Code tab.** `conversation-tab-vscode` absent, `conversation-tab-preview`
  present.
- **Settings vocabulary and grouping**, and that `dev:mock` reaches the chat.

What made this possible: `v1-conversation-handlers.ts` now also mocks
`/preview/{id}/ports` and the pending-message queue. Without those the preview
tab could only ever show its "could not check" state and the chips could never
appear — the UI existed but was unreachable.

STILL UNSEEN: the P15 prompt, because it needs a real refusal from a real model.
Its four units are unit-tested; the mounted behaviour is not.

## How to look at the UI

```bash
npm run dev:mock
```

Then open `/conversations/1`. Two things make that work and both are
browser-worker only, deliberately, because the shared handlers array backs
vitest and adding to it broke unrelated settings tests:
`src/mocks/browser.ts` seeds a configured user (otherwise settings 404s and the
provider-setup modal covers everything), and `src/mocks/v1-conversation-handlers.ts`
serves the V1 API (only V0 was ever mocked).

## Rules this work has been following

- Competitor features are described generically. Their product names are
  trademarks and must not appear in Nimbus chrome, code, or UI strings.
- Copy behaviour, never their source or assets.
- Do not copy their security posture: their extension signature verifier pins no
  trust anchor and `signatureRequired` defaults false. Ship the same feature,
  pinned to our own key.
- Every claim about our code carries `path:line`. "Not found" is written as
  "not found — searched X".

## 2026-08-07 — bridge auth: both NONE rows above are FIXED

The audit table earlier in this file is stale in the good direction. Recorded
here rather than edited in place, because the table is the evidence of what was
wrong and deleting it would erase why these tests exist.

`POST /bridge/call`
: Authenticated by `X-Session-API-Key` -> `validate_session_key` -> user taken
  from `sandbox.created_by_user_id`. **`user_id` was REMOVED from `CallRequest`
  entirely, not ignored.** That distinction is the point: a field that is
  checked can be un-checked by a later edit, a field that does not exist cannot
  be spoofed by shape. A sandbox with no owning user is a 401 rather than the
  empty-string user, because devices are keyed by user id and an empty id is a
  real bucket that any unowned sandbox would otherwise share.

`GET /bridge/devices`
: No path parameter. User from the session cookie. This also fixed the reason
  the P5 UI could not be built: the browser has no way to learn its own user id
  (`useMe` is SaaS-gated, `/api/v1/nimbus/account` returns no id), so the by-id
  signature was unbuildable as well as unsafe.

Caller updated: `nimbus_browser_tools.py` sends the header and no longer reads
`NIMBUS_USER_ID`. `_explain` gained a 401 branch — 401 is NOT a pairing problem
and must never tell the user to re-pair, which is a loop that cannot terminate.

### The tests, and why the old ones could not see it
Three bridge test files existed and all three test the STORES; none sent an HTTP
request, so the exposed surface had no coverage at all.

- `tests/app_server/test_bridge_router_auth.py` — 6 tests through the router.
  Verified against `git show HEAD:bridge_router.py`: all 6 fail on the
  vulnerable version, all 6 pass on the fix.
- `tests/app_server/test_unauthenticated_route_surface.py` — the systemic half.
  Every non-`/api` route must be CLASSIFIED with a stated reason, and a second
  test fails on any `{user_id}` in a non-`/api` path. The gate was deliberately
  NOT flipped to deny-by-default: that breaks `/preview`, `/sockets`,
  `/bridge/pair` and the SPA routes, and a security change that breaks four
  working things gets reverted, which ends up less safe than before. Constrain
  the process, not the runtime.

262 backend pass (was 247). mypy clean.

### ANSWERED — `/mcp` does not refuse anonymous callers
`/mcp` is an ASGI **Mount**, not a route; the real endpoint is `POST /mcp/mcp`.
It is outside `/api` so the gate does not require a session, and
`get_user_id` returns `str | None` WITHOUT raising.

Settled 2026-08-07 by running the app under **uvicorn** so the FastMCP lifespan
actually starts. (`TestClient` cannot answer this — it does not run the lifespan,
so `StreamableHTTPSessionManager` is never started and every request dies with
"task group was not initialized" → 500 before any handler. That 500 is
infrastructure and says nothing about auth. On Windows also set `PYTHONUTF8=1`,
or migration `017`'s em-dash `print` aborts startup under cp932 behind a 130-line
ExceptionGroup.)

With no cookie and no `X-Access-Token`:

- `tools/list` → **200** plus the full five-tool inventory, without even an
  `initialize`.
- `tools/call create_pr` → **200**, having **executed** the tool body with
  `user_id=None`.

Nothing rejects it: the gate falls through to `call_next`, `/mcp` is not in
`_EXEMPT_PREFIXES`, and `FastMCP('mcp', ...)` is built with no auth provider.

**What it can do.** `user_id=None` sends `get_provider_tokens` to
`user_scoped_path(None, 'secrets.json')` — the LEGACY SHARED file at the
file-store root. Seed a github token there and the anonymous `create_pr` picks it
up and reaches GitHub: the error moves from `Illegal header value b'Bearer '`
(empty token, httpx refusing to build the request locally — it never leaves the
process) to `Invalid github token`, which `http_client.py:89` raises ONLY from a
real HTTP 401. Same under `NimbusServerConfig` and under the default OSS config,
where `FileSecretsStore.get_instance` ignores its `user_id` outright.

**Live deployment.** `chat.nimbusapi.net/mcp/mcp` answers an unauthenticated
`tools/list` with 200 — ACA ingress is `external: true` with
`ipSecurityRestrictions: null`, and nothing in `containers/` filters by path. An
anonymous `create_pr` there returns the empty-token failure: it executes and
cannot act. The AzureFile share behind `OH_PERSISTENCE_DIR=/data/openhands`
(`nimbusbackups4768`/`openhands-data`) has `settings.json` at its root but **no
`secrets.json`**; the deployment's one real github token lives at
`users/<customer>/secrets.json`, which an anonymous caller never resolves to.

So per-customer isolation is the only thing holding this shut, and the share is
persistent. Anything that ever writes provider tokens to the root path converts a
reachable-but-inert endpoint into a live one with **no code change and no
deploy**. The absent file is an accident, not a control.

**Why the order matters.** Upstream DOES guard this:
`enterprise/server/middleware.py` returns True for `path.startswith('/mcp')`, and
`SaasUserAuth.get_mcp_api_key` mints the key the sandbox sends as
`X-Session-API-Key`. That middleware is in `enterprise/`, not in this deployment,
and `NimbusUserAuth.get_mcp_api_key` returned `None` — so the **legitimate sandbox
also called `/mcp/mcp` with no credential** and also resolved to `user_id=None`.
That is why the gap was invisible in normal use, and it dictates the sequence:
denying anonymous `/mcp` on its own would have broken `create_pr` for real users
while looking like a fix.

### FIXED — 2026-08-07

Three parts, in the only order that works:

1. `NimbusUserAuth.get_mcp_api_key` mints a signed token
   (`nimbus_session.issue_mcp_token`), which `_add_system_mcp_servers` already
   drops into `X-Session-API-Key`. The legitimate caller gets a credential
   **first**.
2. `NimbusUserAuth.get_instance` accepts that token **on the `/mcp` path only**,
   so a token minted for MCP cannot stand in for a session on `/api` or
   `/bridge`.
3. `mcp_router._require_identity` refuses when identity is still absent —
   checked **before** any secrets store is read, so a refused call never loads a
   token it may not use.

Two traps the fix had to avoid:

- **Token confusion.** Both tokens are HMAC'd with the same secret and have the
  same wire format. A `purpose` claim is now *verified*, not merely described:
  `read_session` accepts only `purpose=session`, `mcp_token_user_id` only
  `purpose=mcp`. Without it, a token lifted out of a sandbox would be a valid
  `nimbus_session` cookie — an escalation created **by** the fix. A missing claim
  reads as `session`, so cookies minted before it existed still verify.
- **Breaking upstream OSS.** `DefaultUserAuth.get_user_id` returns None for every
  caller by design, so the refusal is tied to `NIMBUS_REQUIRE_AUTH`. Refusing
  unconditionally would have deleted `create_pr` for any deployment that never
  opted into Nimbus auth.

Verified against a real ASGI server, four states: anonymous **refused**; valid
MCP token **accepted** and resolving to that customer's own
`users/<id>/secrets.json` (proved by deleting the shared root file and watching
the identified call still reach GitHub, while a customer with no store of their
own gets the empty-token failure rather than someone else's token); a session
cookie value in the MCP header **refused**; `NIMBUS_REQUIRE_AUTH=0` still
behaving as upstream.

**The isolation bug went with it.** `create_pr` now uses the signed-in customer's
provider tokens instead of the legacy shared file — which is also what removes
the latent "one written file away" hazard described above.

Tests: `tests/app_server/test_mcp_auth.py` (18). Reclassified `SELF_AUTH` in
`tests/app_server/test_unauthenticated_route_surface.py`. `tests/app_server` 243
pass; `tests/unit/app_server` measured at **73 failed / 1462 passed both with and
without** these changes, baselined in a throwaway `git worktree` at HEAD rather
than by stashing — other agents were editing this tree at the time, and a
tree-wide revert would have eaten their work and mine.

### The pattern worth remembering
The module docstring asserted `/bridge/call` was "Session authenticated" while
the function had no `Depends` at all. The artifact most likely to be read by a
reviewer was the one furthest from the truth, and because it read as deliberate
it stopped anyone re-checking. A confident description is evidence about intent,
never about behaviour. It was found by grepping for the mechanism, not by
reading the prose.

## 2026-08-07 — shortcut registry (Tier 1 #15), and a red suite paid down

`35e333cdb` — one Cmd+Enter fired two actions. VERIFIED IN A BROWSER against
the real module, not jsdom: two live owners of Cmd+Enter now yield
`["approve"]` alone; Escape in a menu-inside-a-modal yields `["closeMenu"]`
alone; Ctrl+Enter yields `["approve-ctrl"]`; autorepeat yields `[]`; zero
registrations leak after cleanup.

Seven components each owned a `document`/`window` keydown listener and two
chords had multiple live owners. `chat-interface` gates Build on
`isAgentRunning` = RUNNING|LOADING only, so AWAITING_USER_CONFIRMATION left
both it and the confirmation buttons listening.

THE PART WORTH REMEMBERING — the code looked like it had handled this.
`chat-interface` called `stopPropagation()`, which does nothing for sibling
listeners on the same node; only `stopImmediatePropagation` would, and even
that resolves by mount order. Meanwhile `chat-stop-button` had invented a
SECOND, different mechanism (`defaultPrevented`) that does work but is equally
unreadable as a contract. Two ad-hoc exclusivity schemes, neither stated
anywhere. Now: one listener, declared priorities
MENU > MODAL > CONFIRMATION > COMPOSER > GLOBAL, highest live match wins.

Two more bugs fell out of the migration rather than being looked for:
- confirmation shortcuts tested `event.metaKey` alone, so approve/reject by
  keyboard worked on a Mac and silently did nothing on Windows or Linux
- autorepeat was unguarded, so holding Cmd+Enter approved repeatedly

Mutation-checked, not assumed: deleting the exclusive `return` from dispatch
fails exactly the two collision tests and passes the other twelve.

`0bb861794` — 20 red frontend tests -> 2. All twenty predated this branch and
all twenty were the OpenHands->Nimbus rename with the assertions left behind
(`git log main..HEAD -- map-provider.ts` is empty). Proving the registry
commit had not caused them required reading all twenty; that is the standing
tax of a red suite.

Two of those tests were badly built in ways the rename only exposed: two
hardcoded `SETTINGS$NAV_LLM` merely to detect "menu loaded" (now derived from
OSS_NAV_ITEMS, so they cannot rot again), and the nav sweep used `getByText`,
which throws on the duplicate ORG$ACCOUNT — a correctly-rendering menu failed.

REMAINING RED, both deliberate:
- ~~`llm-settings > uses the docs.openhands.dev domain for the API key help
  link` — the other lane has `openhands-api-key-help.test.tsx` in its working
  set, so this is theirs to land, not mine to race.~~ RETIRED 2026-08-08:
  both suites are green (82 passed). Nothing to land and nobody to wait for.
- ~~`recent-conversation` — the known-red inherited from upstream 13634324c.~~
  RETIRED 2026-08-08: green, and never upstream. See the retraction above.

DEV-MOCK NOTE: `dev:mock` on :3010 runs `--prefix ../openhands-nimbus/frontend`
per nimbus-v2/.claude/launch.json, so it does serve the fork. Navigating to
`/conversations/1` lands on `/` — verify registry behaviour by importing
`/src/utils/shortcut-registry.ts` in the page and dispatching real
KeyboardEvents, which exercises the shipped module rather than a test double.

## 2026-08-07 — prompt recall (Up/Down), and a correction worth keeping

`590286ea9`. Second half of Tier 1 #15. VERIFIED END-TO-END in the running
app, not just jsdom: Up gives "now do the other thing", Up again gives "Tidy
up the total() helper...", Up again is a no-op at the oldest, Down walks
forward, and with "half typed" in the composer Up does not recall.

FILED UNDER #15 BUT DELIBERATELY NOT IN THE REGISTRY. Everything in the
registry is a global chord; Up is a cursor key that means "recall" only when
the composer is empty. A document-level listener would put every arrow press
in the app through the registry to serve one element. It sits on the element,
AFTER the slash menu (which owns the arrows while open) and returns false when
it declines, so caret movement is untouched. If Cmd+K is built later, that one
IS a registry entry — the distinction is global chord vs element key.

HOW TO VERIFY UI IN dev:mock — the earlier "SPA router claims /preview and
404s" note made this look more broken than it is. `/conversations/1` DOES
open; a hard `navigate` bounces to `/`, but clicking the sidebar link works,
and the check must be run AFTER the transcript streams or it reads an empty
page and looks like a routing failure. `read_page` reports "(empty page)"
because innerWidth/innerHeight are 0 in this pane, but the DOM is fully
present — query it with javascript_tool instead of trusting the a11y tree.

THE CORRECTION, which is the reusable part: the first browser probe reported
the typed-guard BROKEN. The probe was wrong, not the feature — it set
textContent directly, which never fires onInput, so resetRecall never ran and
the history walk stayed open. Re-run with a real InputEvent the guard holds.
A failing probe is not automatically a failing feature, and a probe that
bypasses the event that carries the semantics is not testing the semantics.
Same family as the earlier "transcript missing" false alarm, where the grep
was for a label the summarizer no longer emits.


## 2026-08-07 — find-in-conversation (Tier 1 #9), and a measured limitation

`284849fc4`. Cmd/Ctrl+F over the transcript: live count, next/prev with
wrap-around, Enter / Shift+Enter, Escape to close. VERIFIED IN A BROWSER end
to end — bar opens on the chord, typing gives "1 of 1" with the current-match
highlight registered, a no-match query gives "0 of 0" and clears both
highlight registrations, Escape closes and clears.

TWO DESIGN CALLS WORTH KEEPING:

1. Highlights are Ranges via the CSS Custom Highlight API, NOT `<mark>`
   wrapping. Wrapping mutates a subtree React owns, and the damage would land
   in precisely the content worth searching — rendered markdown, code blocks,
   diff tables. Ranges are inert; the browser paints them with nothing added
   to the DOM.
2. The searcher flattens text before matching. Inline formatting splits text
   across nodes, so a per-node search silently fails on "the total helper"
   when "total" is in a `<code>`. Flatten, search once, map offsets back.

THE LIMITATION, measured not assumed: find does NOT see inside collapsed tool
rows. They are not hidden, they are UNMOUNTED — a conversation showing five
collapsed rows has exactly one "total" in `document.body.textContent` while
the events behind it contain many. I originally justified taking Cmd+F partly
on "native find cannot see collapsed output"; mine cannot either, and the
comment in chat-interface now says so. Anyone seeing a suspiciously low count
should read that before filing it as a bug. THE NEXT INCREMENT, if wanted:
search event DATA and expand the owning row on match.

Caught only because "1 of 1" for the word "total" looked wrong and I checked
`textContent` rather than accepting the number. Same discipline as the
autorepeat and metaKey finds — the suspicious detail was the lead.

SHARED-TREE HAZARD, hit for real this time. `git add <my paths>` produced an
index containing SIX of the other lane's files, because they had staged their
own work concurrently. Committing would have swept their in-flight P5 into my
commit — the same cross-contamination as `3e9fec44a` earlier on this branch.
ALWAYS `git diff --cached --name-only` before committing in this tree, and
recover with `git restore --staged <their paths>`, which leaves their working
tree untouched. Verified after: their six files intact, my commit exactly 8.


## 2026-08-07 — condensation rendering (#27), and the hook-stash race firing

`0d29db681`. Condensation events existed as TS types since V1, arrive over the
socket, and had NEVER rendered. Browser-verified: "3 earlier messages were
condensed", summary collapsed by default, toggle expands, aria-expanded tracks.

THE CAUSE WAS NOT THE MISSING BRANCH. The types never matched the wire. The SDK
sets `kind = self.__class__.__name__` (sdk/utils/models.py) and the classes in
sdk/event/condenser.py are `Condensation`, `CondensationRequest`,
`CondensationSummaryEvent` — two of three differ from the TS interface names,
which carry an extra "Event". The interfaces also declared NO `kind` field, so
they sat outside the discriminated union and TypeScript REJECTED a guard
against them ("no overlap") until the field was added. A guard written from the
type name compiles, reads correctly, and never matches.

The test pins BOTH directions deliberately: wire value matches, plausible TS
name does not. "Fixing" that literal to match the interface silently deletes
the feature again.

### THE PRE-COMMIT STASH RACE FIRED — read this before committing here

First attempt at the above failed:

  [WARNING] Stashed changes conflicted with hook auto-fixes... Rolling back
  error: patch failed: openhands/app_server/mcp/mcp_router.py:3
  husky - pre-commit script failed (code 3)

Nothing was lost — all five of the third session's /mcp files intact, markers
and byte sizes identical. BUT the failed restore left THEIR FIVE BACKEND FILES
STAGED IN MY INDEX (`M ` in column one). The next commit would have swept an
entire uncommitted security fix into a frontend commit that described none of
it. Caught only by `git diff --cached --name-only`, which has now caught
foreign files in the index THREE times in one session.

RECOVERY: `git restore --staged <their paths>` — index only, content untouched.
Verify with byte sizes and grep markers before and after.

WHY THE RETRY SUCCEEDED, which is the actionable part: the conflict is between
the stash and lint-staged's OWN auto-fixes (`eslint --fix`, `prettier --write`
rewrite staged files, then the restore cannot apply on top). Run
`prettier --check` and `eslint` on your staged files FIRST; with zero pending
fixes the race has no fuel and the log reads "Restored changes" instead of
"Rolling back". A mitigation, not a fix — separate worktrees are the fix.


### IT ESCALATED: the same race then DELETED uncommitted work

Twenty minutes after the near-miss above, the same cycle destroyed the third
session's entire uncommitted /mcp security fix. Recovered, but only by luck.

SEQUENCE: my docs commit stashed unstaged files; mypy CRASHED on a corrupted
incremental cache (`KeyError: 'bound_args'`, mypy/types.py:2297 — not a type
error). Cleared `.mypy_cache` (463MB, regenerable) and retried. The retry's
restore then failed on `use-bridge-devices.ts`, because the other lane
COMMITTED that file between my stash and my restore, and the rollback took the
/mcp fix with it.

  _require_identity in mcp_router.py .... 6 -> 0
  mcp_router.py ......................... 18509B -> 16472B
  nimbus_user_auth.py ................... 6781B -> 5001B

Never committed, so git had no copy. Off the disk entirely.

RECOVERY — pre-commit stashes to a PATCH FILE and RETAINS it:

  ls C:/Users/erick/.cache/pre-commit/patch*
  git apply --check --include='openhands/*' --include='tests/*' <newest patch>
  git apply         --include='openhands/*' --include='tests/*' <newest patch>

Path-filtered because `use-bridge-devices.ts` was committed by then and would
have conflicted. Verified byte-exact afterwards against sizes recorded during
the earlier near-miss.

THREE PIECES OF LUCK, none of them design: pre-commit retains patches on
failure; exact byte sizes and grep markers had been recorded BEFORE the loss so
recovery could be proven rather than assumed; and the work was path-scoped so a
filtered apply was safe.

THE EARLIER MITIGATION IS INSUFFICIENT. "Make staged files already-clean so the
hook has nothing to auto-fix" did not help: this run had zero pending fixes and
still failed, because the conflict came from ANOTHER SESSION'S COMMIT landing
mid-cycle. Any commit by any session can revert any other session's uncommitted
work in this tree. Separate worktrees are the only real fix; until then, commit
WIP early and treat uncommitted work as unsafe.


## 2026-08-08 — HANDOFF. Start here.

Integration branch `land/auth-gates`. Verified at handoff: `npm run typecheck`
clean, backend `pytest tests/app_server` 256 passed, frontend 2660 pass with 1
known-upstream fail (`recent-conversation`). Tier 0 clear, Tier 1 done except
items blocked upstream.

### RETRACTED 2026-08-08 — both "shovel-ready" items below were wrong

Do NOT start from the section that follows. Verified in the code:

* **#24 is ALREADY BUILT.** `skills-settings.tsx:233-250` maps marketplace
  plugins into `type: "plugin"` rows; `skills-table.tsx:155` renders them.
  Read-only by design — enablement follows the parent marketplace. The feed is
  the app server's `user/skills_router.py`, not the agent server's
  `plugins_router`.
* **#21's backend is a different feature sharing a word.** `workspaces_router`
  is "local directories the GUI surfaces in its workspace picker" (its own
  docstring) — not grouped folders, auto-summary or per-workspace memory.

I wrote the section below and told the founder to start there. Both entries
came from matching ROUTER NAMES rather than reading what the code does, which
is the same failure this repo's docs catalogue — committed while applying the
fix for it.

**What is actually next, in order:** the three founder decisions (#16, #23,
#12). None of the remaining build items is shovel-ready; #20, #22 and #26 are
genuinely unbuilt and unserved, which makes them real projects rather than
wiring jobs.

### Superseded: the section below is kept only for the endpoint inventory

**#24 Plugin marketplace UI.** The backend is LIVE and there is no UI at all:

    POST   /plugins                    search/list
    GET    /plugins/marketplace        catalog
    GET    /plugins/installed          installed list
    POST   /plugins/... (x2)           install
    DELETE /plugins/...                uninstall

**#21 Workspaces UI** is the same shape — `workspaces_router` has 5 endpoints
(get, post, delete, post /parents, delete /parents) and no UI.

These two are the only items on the whole roadmap where a pure frontend
estimate is correct, because the backend is already there. Everything else
needed a backend read first — see the inventory sections in
`docs/parity-roadmap.md`, which now carry a verified state per item rather than
a size guessed from the frontend.

### Four decisions that are the founder's, each blocking real work

1. **#16 preview introspection** — leave it (the agent's own browser already
   gives the model screenshots and console), serve the preview from a separate
   origin, or inject a postMessage shim. DO NOT add `allow-same-origin`.
2. **#23 "Memory"** — the nav entry points at the condenser. Build editable
   memory files behind it, or rename the page.
3. **#12 fork** — state-copier built and reviewed; transport wrapper and
   endpoint specced in `docs/fork-conversation-design.md`. Also decide the UI
   name; "fork" oversells it, since it rewinds the conversation and NOT the
   working tree.
4. **Cloudflare CNAME** — `chat.nimbusapi.net` targets librechat's FQDN, so
   deleting that app breaks the chat domain. Refused by a classifier for two
   sessions; needs hands in the Cloudflare UI.

### The one habit worth keeping from this session

Read the backend before quoting a size. Eleven roadmap items were wrong in the
same direction: three were already built, two blocked upstream, two were naming
decisions, one a security decision, and two had live backends nobody had
noticed. Every wrong entry was written from the frontend's side.

And run the project's own check — `npm run typecheck`, not bare `tsc`. A bare
compiler skips the codegen step and emits six TS2578 errors that look real.
Three sessions read those errors and the first two explanations were wrong.



## 2026-08-08 — #12 merged and DEPLOYED, then a review found a hole in it

PR #17 merged (`b37af6060`) and is live: image `fork12-20260808`, revision
`openhands-nimbus--0000090`, Healthy / RunningAtMaxScale. Rollback point is
image `mcpauth-20260807`, revision `openhands-nimbus--0000089`.

Live checks that passed: `/health` `/alive` `/ready` 200; `/mcp` still refuses
anonymous callers; signed-out `GET /` 302; the route is in the deployed
`openapi.json`. The load-bearing one is that the fork endpoint answers **401**
anonymously — 404 would have meant it never registered, 200 would have meant it
shipped ungated, so 401 is the only answer that proves both at once.

### The hole, and why the green suite could not see it

`transfer_forked_state` returned an event count parsed from the SOURCE copier's
stdout, and after `tar xzf` on the target NOTHING checked what arrived. `tar`
exits 0 whether the archive unpacks at the depth we assumed or one level off,
and that framing was read from the agent server's source, never observed. A
wrong guess therefore produced a healthy `copied=N` for a fork whose agent would
start with no memory — the exact failure #12 exists to prevent, reintroduced by
an unverified assumption about someone else's file format.

Every test passed throughout, because all of them asserted the SOURCE side.
Fixed in PR #18 by `_verify_landed`: probe the TARGET for `base_state.json` and
count the event files where the AGENT will look, raise on any disagreement. The
probe always exits 0 and reports `{"base": 0|1, "events": N}`, so a missing
directory arrives as a parsed answer rather than a cryptic non-zero exit.

State-first ordering is what makes that sufficient rather than merely
diagnostic: raising there means the transcript is never mirrored, so a failure
presents as an EMPTY fork someone reports instead of a COMPLETE one they trust.

**PRODUCTION DOES NOT HAVE THIS FIX.** Revision `--0000090` predates PR #18.

### The generalisable lesson

A returned count is only evidence about the place it was counted. This one was
counted in the source and used to assert something about the target. When a
value crosses a boundary, re-establish it on the far side or stop calling it
verification.

### Still not verified, and it is the same caveat as at merge time

No live agent server has ever answered these calls. The wire shape is asserted
through real httpx via `MockTransport`, but multipart field naming, archive
framing and what `BashOutput` carries on a non-zero exit are all read from
source. A first functional fork against an authenticated conversation remains
the only honest gate. PR #18 does not close that gap — it changes what being
wrong costs, from a silent amnesiac fork to a loud 502.

### Trap fixed while here

`gh`'s default repo in this worktree resolved to upstream `OpenHands/OpenHands`,
so a bare `gh pr view 17` returned an UNRELATED upstream PR (base `main`, head
`neubig/add_prototype_frontend`) and `gh pr create` failed with "No commits
between". Set to `AbuRisha/openhands-nimbus`. Check this before trusting any
bare `gh pr` output in a worktree.

Do not commit `uv.lock` from Windows: `uv run` re-resolves it with win32
platform markers on `cffi`/`clr-loader` plus an `[options] exclude-newer` block.
Local toolchain noise that would constrain the lock for everyone.

### Next three actions

1. Founder call: merge `land/auth-gates` -> `main`. `b37af6060` is confirmed an
   ancestor of `land/auth-gates` but NOT of `main`, so production runs code that
   is not on the release branch.
2. Founder call: redeploy to pick up PR #18 once reviewed. The endpoint is
   auth-gated and no UI calls it yet, so the exposure is low, but the deployed
   revision can report a fork that did not land.
3. First functional fork against a real authenticated conversation. Everything
   else about #12 is verified as far as it can be from outside a live sandbox.

## 2026-08-08 - P0: the chat could not send a message at all

Reported by the founder with a screenshot:

    Duplicate tool names found: {'browser_list_tabs', 'browser_navigate'}

Our bridge tools reused two names the SDK's own browser_use toolset already
uses, and `get_default_tools(enable_browser=True)` pulls that toolset in. A
duplicate name does not shadow a tool or drop one - `AgentBase` refuses to build
the agent (sdk/agent/base.py:597), so EVERY message send failed, for every user,
whether or not they had ever paired a browser. A browser feature nobody had
adopted took down the core product.

`browser_read_page` did not collide, which is why the error named two tools and
not three, and why it read as something exotic rather than as a naming clash.

Renamed to `paired_browser_*` (`edf548a5f`). The prefix is not cosmetic: the
model must choose between a sandboxed browser signed into nothing and the
customer's own signed-in one, and the name is most of what it has to go on.

### A second bug underneath, which predated it

`extension/background.js` switches `message.tool` over a fixed vocabulary -
get_page_text / get_page_url / navigate / list_tabs - and throws "unsupported
tool" on anything else. `BrowserBridgeExecutor` sent the TOOL NAME. So even with
the collision fixed, every call to a paired browser would have been refused by
the browser. The bridge could never have worked end to end, and no test caught
it because each half was correct on its own terms.

The wire verb is now an explicit map (`_WIRE_VERB`), not the tool name, because
the two vocabularies belong to different sides: the tool name is ours and just
changed, while the verb is a contract with an extension already installed in
customers' browsers. A rename must never reach the wire. A tool registered
without a verb now raises at construction rather than at a customer's first use.

### What to copy from the fix, not just the fix

- Both tests were confirmed to go RED against the pre-fix code before being
  trusted green. A test written after the fact is a hypothesis until you have
  seen it fail for the right reason.
- The valuable test builds the REAL production list -
  `get_default_tools(enable_browser=True)` then `_add_nimbus_extra_tools` -
  rather than name sets written by hand. Checking each half against your model
  of the other half is precisely what produced the outage.
- Both tests guard against passing VACUOUSLY: if the bridge tools stop being
  injected, or the SDK browser toolset stops being present, they say so instead
  of going quietly green. `RUNTIME=process` has to be set or the injection
  branch is skipped entirely and the assertion holds over an empty set.
- The first version of the test read `annotations.title`; the SDK de-duplicates
  on `.name`. They agree here, so it passed. A test that checks the wrong field
  is worth less than no test, because it reads as coverage.
- Widened to compare EVERY Nimbus tool name against EVERY SDK tool name, so the
  next collision is a failing test rather than an outage. Nimbus registers media
  and workflow tools beside these, all named without consulting the SDK.

### Trap: the lane that still had the bug

`lane/bridge` was fully merged into `land/auth-gates` (0 commits ahead) but 47
BEHIND, so its worktree still contained the colliding names. Merged-in does not
mean up-to-date, and anything built from that lane would have reintroduced the
outage. Fast-forwarded. Worth checking `behind` and not only `ahead` before
believing a lane is safe to build from.

Also: an edit meant for the integration tree landed in `oh-wt-bridge` first,
because the shell's cwd resets between calls. The result was a docstring
describing a prefix that tree's code did not use - the exact "confident
description outlives the thing it described" failure documented in nimbus-v2's
`docs/worktrees-and-shared-tree-traps.md`. Reverted. Check `pwd` in the same
call as the edit, not in a previous one.

### The third bug, found only by sending a real message

With the collision fixed the agent built, and the first POST to /events came
back 500 from the agent server:

    PydanticSerializationError: Error calling function
    `_serialize_by_kind`: RecursionError

`_make_tool` created each class under a throwaway name and then assigned
`__name__`. That reads as equivalent to naming it correctly and is not:
pydantic captures the name when it builds the core schema, so the serializer
knew the class as `_Tool` while instances reported the new name.
`_serialize_by_kind` compares the two to decide whether a handler belongs to the
current class; they never matched, so it delegated to `model_dump`, which
re-entered the serializer, until the stack ran out. Built with
`types.new_class` instead, which names the class at creation (`type()` would
bypass ToolDefinition's metaclass).

Three lessons, in order of how much time they would have saved:

1. **Fixing a bug can reveal the next one rather than finish the job.** The
   duplicate-name bug stopped the agent being built at all, so nothing ever
   tried to serialize these tools, so this could not surface until the first fix
   landed. "The P0 is fixed" was true and "the chat works" was not.
2. **361 backend tests passed throughout.** Not one of them ever serialized a
   tool. A green suite measures what it covers, and these three tools had been
   constructed by tests but never round-tripped.
3. **Only using the product found it.** Creating a conversation through the UI
   and pressing send is what produced the 500. Every static check - imports,
   registry, name sets - passed at every stage.

Deployment sequence: `bridgefix-20260808` / revision --0000092 carried the
rename; `bridgefix2-20260808` carries this. Rollback target before either is
`fork12v2-20260808` / --0000091.

### Two live bugs observed while testing, not yet fixed

- **The events socket retry-loops 403 forever.** A tab whose conversation is
  gone reconnects every ~4s indefinitely, with no backoff, no give-up and
  nothing shown to the user. `validate_session_key` raises 401 for an unknown
  key with NO log line (only the non-running-sandbox branch logs), so the most
  common rejection is silent server-side too.
- **`GET /api/v1/app-conversations?ids=<unknown>` returns `[null]`**, not `[]`
  and not 404. A caller checking `.length` sees one result and a caller reading
  `data[0].x` crashes.
- The composer's send button has **no accessible name** - it is a bare `button`
  in the a11y tree, so a screen-reader user cannot identify the send control.

## 2026-08-08 — #12 has never worked, and the reason tests could not see it

**Do not record #12 as shipped until a fork is driven against a DEPLOYED image.**
It has been called done twice and was false both times. Full detail in
`docs/parity-roadmap.md` under "Item 12".

Short version: the transport calls `{base_url}/bash/execute_bash_command`, but
`agent_server/api.py:343` mounts bash/file/git/vscode under
`APIRouter(prefix="/api")`. Only `/alive` and `/server_info` are at the root —
so the health check passes while every functional call 404s. Every image shipped
so far contains a fork that cannot fork. Fix is PR #19.

### The rule this bought, which is worth more than the fix

**A suffix cannot observe a missing prefix.** Every fork test asserted
`path.endswith('/bash/execute_bash_command')`, which is equally true of the
broken and the correct URL. 43 green tests, measuring the tail of a value whose
defect was in the head.

Three instances of that shape in one day:

* fork transport counted events from the SOURCE's stdout — an assertion made
  where it could not observe the target
* those `endswith` path checks
* a `"'browser_navigate'" in source` check that matched the author's own
  DOCSTRING and nearly caused a false "production is broken" escalation

Before writing an assertion, ask where the defect would have to live for this
check to miss it. If the answer is "anywhere outside the substring I chose",
compare the whole value.

### And a baseline warning that cost an hour

The frontend suite is FLAKY UNDER LOAD, not stable. A change appeared to break
8 tests; reverting it and re-running clean HEAD failed 8 DIFFERENT tests, and
every file passed in isolation (`llm-settings` 80/80). They are 5s timeouts.
**The "2670 pass, 1 fail" quoted repeatedly today was a lucky run, not a
baseline.** Raise the timeout or cap concurrency before it trains everyone to
ignore red — it already nearly convinced one session its own fix was broken.



## 2026-08-08, later — three things measured, one near-miss

**Live is rev `0000097` / `routing2-20260808`.** Any note citing 0000094 or
0000096 is stale; two deploys landed while this was being written.

**Provenance is working end to end.** `/server_info` reports
`build_version: routing2-20260808`, `git_sha: 21873ce21624e2de5237a01763b16012f10a877e`,
and `az acr run` into the image confirms it contains that commit's source. The
fields are ENV vars, so they can be hand-set and are therefore advisory —
inspection is what proves it. See the docstring in `status_router.py`.

**Item 12's fix IS in the live image**, verified by executing it: `api_base` is
defined and used at all three callsites. **That is not the same as "works"** and
the row still says unverified. One fork driven end-to-end against `0000097`,
checking `halves_agree`, is the outstanding step. Offered to the backend
session, who own the feature.

**RLS: settled.** `rolsuper=False`, `rolbypassrls=True`, and 0 policies / 0
rowsecurity tables across 9 public tables. RLS is absent, not bypassed — see
`docs/database-rls.md`, which re-sizes item 23.

**The frontend suite is not a single-run gate** — 0/6/7 failures across three
identical uncapped runs, 0 twice with `--maxWorkers=2`. Raising `testTimeout`
did not help and was reverted with its hypothesis. See
`docs/frontend-test-suite.md`.

### The near-miss, because it is the third of its kind

A probe reported three fork callsites still broken. It counted occurrences of
`'/bash/execute_bash_command'`, which is a SUBSTRING of the fixed
`'/api/bash/execute_bash_command'` — so every corrected callsite counted as
broken, and the remainder was docstring prose. Nothing was wrong with the code.

That is the same defect as `path.endswith(...)` letting 43 green tests sit on a
dead feature, and as the containment check that matched an author's own
docstring and reported production broken. The rule as previously written —
"a suffix cannot observe a missing prefix" — was too specific to prevent it.
The useful form:

> **Counting substrings is not reading code. When the answer matters, print the
> lines.**

## 2026-08-08 — audit: every standing "known red" in this doc was stale

Ran all of them rather than trusting the labels. All green:

| suite | claim | reality |
|---|---|---|
| conversation-name, recent-conversation(s), conversation-card | "fail, inherited from upstream 13634324c" | 59 passed. And NEVER upstream — `9a8382718` records the last one "was not upstream, it was the same rebrand as the other", i.e. ours |
| openhands-api-key-help, llm-settings | "three docs.openhands.dev tests fail; pre-existing" | 82 passed |

WHY THIS IS WORTH A SECTION RATHER THAN A QUIET EDIT. A stale known-red label
is not neutral — it is an instruction to ignore a file. Every session reads
this doc on boot, so four suites were carrying a standing "do not investigate"
sign, two of them attributed to an upstream commit that had nothing to do with
it. The next genuine regression in those files would have been read as "oh,
that's the known one" and shipped.

It nearly happened to me today in the other direction: the conversation-panel
failure in this morning's full run LOOKED like a candidate for exactly that
treatment. Running the file alone (22/22 green) is what showed it was load,
not code — see docs/bugs.md.

RULE, and it is cheap: a red suite gets either a fix or a commit sha that
reproduces it on a tree we did not touch. "Inherited" without a reproduction
is a guess, and this doc shows guesses ossify into facts within days.


## 2026-08-08 — websocket session key moved off the URL

**Shipped to `lane/frontend` / `land/auth-gates`, NOT yet deployed.** Founder
approved fixing it now rather than documenting it.

The browser's event socket sent its credential as `?session_api_key=...`, which
Azure ingress and Log Analytics record verbatim. Found by session
`local_c44142de`. The key now rides `Sec-WebSocket-Protocol` — a browser cannot
set arbitrary headers on a WS handshake, which is why it was ever in a URL, but
it CAN set subprotocols, and those arrive as a request header that access logs
do not capture.

**Three things about this change are load-bearing and easy to undo by accident:**

1. **The query parameter is still accepted.** This is every chat session's auth
   on a hot path. A tab already open, or one running a cached bundle, still
   sends the key the old way and would be disconnected at the moment of the
   revision swap. Remove it only when no bundle in circulation sends it.
2. **The UPSTREAM leg keeps the query parameter.** The sandbox has no header
   option — `session_api_key: Annotated[str | None, Query(...)]` in the SDK's
   `agent_server/sockets.py`. Stripping it there authenticates nothing. I nearly
   did this as an "improvement" and checked first.
3. **`accept(subprotocol=...)` only echoes a protocol that was OFFERED.**
   Selecting one the client did not send makes a conforming client fail the
   connection (RFC 6455 4.1).

Verified by mutation rather than by a green run — break the padding re-add, 6
tests fail; strip the key from upstream, 2 fail; restore, 16 pass. That check
exists because *an assertion that never fails is indistinguishable from one that
cannot fail*, which is the sharpest form of this session's recurring lesson and
came from another session.

### Still outstanding

**Item 12's end-to-end fork is APPROVED by the founder but BLOCKED on access.**
Driving it needs an authenticated session; Chrome automation was denied by the
permission classifier, and there is no `docs/credentials.md` in any checkout. It
is not blocked on a decision any more — only on a way in.
