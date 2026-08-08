# Parity roadmap

What a mature competitor's desktop assistant ships, what we ship, and the order
to close the distance.

## Where this came from, and how much to trust it

Two independent audits, run 2026-08-06:

1. **Competitor feature inventory** — derived from documentation tooling the
   owner ran over a licensed local install. The load-bearing artifact is
   `electron/reports/ipc-methods.json`: **780 named IPC methods across 68
   interfaces**. A method name is strong evidence a capability is wired into the
   UI layer. It is **not** proof of the UX around it. Everything below that
   cites an IPC name is "this capability exists", not "it looks like this".
2. **Our own gap audit** — read directly from `frontend/src`, every claim
   carrying a `path:line`.

Rules this document keeps:

- Competitor features are described **generically**. Their product names are
  trademarks and must not appear in Nimbus chrome, code, or UI strings.
- We copy **behaviour**, never their source, assets, or icons.
- Where the source notes were ambiguous, it says so instead of guessing. Those
  live in "Unresolved" at the bottom — they are research tasks, not features.

## The one thing to understand first

**Roughly 75 of ~110 features are web-implementable.** The overwhelming majority
of that product is not desktop-dependent. A desktop shell buys a specific,
enumerable list (§8) — not "parity" in general. That reframes the desktop
question from *blocking* to *optional*.

---

## 1. Already at parity or ahead

Verified in our own code, not assumed.

| Capability | Ours |
|---|---|
| One row per tool call, expandable | `components/v1/chat/tool-call-row.tsx` |
| Model + reasoning effort in one composer pill | `components/features/chat/components/composer-model-chip.tsx` |
| Context-usage ring | `components/features/chat/context-usage-ring.tsx` |
| Copy a message | `chat-message.tsx:30-33,102-107` |
| Drag-drop / paste attachments | `hooks/chat/use-file-handling.ts:70-110`, `use-chat-input-events.ts:39-50` |
| Draft persistence across reloads | `hooks/chat/use-draft-persistence.ts:20-28` |
| Composer resize grip | `components/features/chat/components/chat-input-grip.tsx` |
| Escape interrupts a run | `chat-stop-button.tsx` (fixed 2026-08-06) |
| Sub-agent delegation on by default | `openhands/app_server/settings/nimbus_settings_store.py` |

**Ahead of them:** voice input and read-aloud. Their inventory has **no**
speech-to-text or TTS anywhere in 780 methods — searched `voice`, `dictat`,
`speech`, `audio`, `mic`, all zero. We ship `voice-input-button.tsx` and
`read-aloud-button.tsx`. Worth protecting; it is a real differentiator.

**Also absent from theirs:** per-message cost display (`cost`/`token`/`billing`
→ 0 hits; only plan-period usage summaries). For a metered reseller that is an
open lane, not a gap.

---

## 2. Ordered plan

Sequenced by value ÷ cost, with our own audit's bug findings pulled forward
because they are cheap and customer-visible.

### Tier 0 — bugs that read as missing features

| # | Item | Size | Where |
|---|---|---|---|
| 1 | ~~Escape never interrupted a run~~ **DONE** | S | `chat-stop-button.tsx` |
| 2 | **Queued messages render nothing.** `chat-interface.tsx:201-203` reads `result.queued` then draws nothing — the user's message silently vanishes until delivered | S | `chat-interface.tsx` |
| 3 | **Output is amputated, not collapsed.** `MAX_CONTENT_LENGTH = 1000` (`event-content-helpers/shared.ts:3`) does `slice(0,1000) + "..."` at 7 call sites with no "show more" and no full copy | M | `shared.ts` + 7 sites |
| 4 | `modal-backdrop.tsx:21` has `}, [])` while closing over the `onClose` prop — permanently captures the first-render handler | S | `modal-backdrop.tsx` |
| 5 | `expandable-message.tsx` exported, imported nowhere — dead | S | delete |

### Tier 1 — highest value ÷ cost

| # | Item | Size | Note |
|---|---|---|---|
| 6 | **Inline diffs in the transcript** | L | Biggest visual gap. `FileDiffViewer` already exists but is used only by `routes/changes-tab.tsx`. Reviewing agent output *is* the core loop |
| 7 | **Queued-message control** — cancel, reorder, promote | S–M | Builds on Tier 0 #2 |
| 8 | **Cross-session transcript search** | S–M | They built a dedicated worker for it, which says hot path |
| 9 | **Find-in-conversation (Ctrl/Cmd+F)** | M | Native Ctrl+F is free; a real overlay with next/prev is M |
| 10 | **@-mention picker over indexed repo files, with content search** | M | Content search, not just filename match, is what makes it feel smart |
| 11 | **Tool-permission prompts + permission modes + folder trust** | M | The trust substrate for everything unattended later |
| 12 | **Session fork + rewind/checkpoint** | L | Agentic coding is speculative; getting *back* is the difference between trusting a 40-turn task and babysitting it |
| 13 | **Server-side PTY terminal** (xterm.js over WebSocket) | M | They ship *two*: the agent's, and a user shell with retained scrollback |
| 14 | **`/help` and a real built-in command set** | M | We have exactly 3 built-ins (`/new`, `/btw`, `/model`) vs ~20. No `/help` at all |
| 15 | **Central shortcut registry + `Cmd+K` + `↑` recall** | M | 7 ad-hoc `document` keydown listeners today, no registry, three owners claim Cmd+Enter |

### 12a. Item 19 was wrong on both halves — read this before building it

Two sessions built a wrong answer off the old wording on 2026-08-07, in the same
hour, independently. A third is the default outcome if it is left as it was.

**"No render site reads it" — false.**
`components/v1/chat/subagent/subagent-observation-content.tsx` is a rich card
showing the sub-agent, the task id, the paired query and the result, dispatched
from `get-event-content.tsx:214/278`. Sub-agent observations DO render.

**"`TaskObservation.status` exists" — true but useless.** It is vestigial and
cannot disagree with `is_error`. `tools/task/impl.py:38-66` is the only
constructor:

    case TaskStatus.COMPLETED -> status=task.status,  is_error unset (False)
    case TaskStatus.ERROR     -> status=task.status,  is_error=True
    except Exception          -> status="error",      is_error=True
    case _                    -> raise RuntimeError   # never constructs one

So `get-observation-result.ts` resolving on `is_error` alone is CORRECT, and a
failed sub-agent cannot render as success. `status` is only useful if you want
to DISPLAY "completed"/"error" as text, which is cosmetic.

**And a RUNNING observation cannot exist.** `manager.py:283` sets
`TaskStatus.RUNNING` on an internal `Task`, NOT on a `TaskObservation` — and the
`case _` above refuses to build an observation for any non-terminal status. A
"still running" indicator was built on that field and reverted (`8fc03de2f`),
because ten green tests asserting an unreachable state are worse than no tests:
the next reader takes them as a specification.

**THE ACTUAL GAP, which no frontend work reaches:** there is no in-progress
event for a sub-agent at all. The observation arrives exactly once, at the end.
Live progress requires the SDK to emit something mid-task. Until it does, this
item is not a rendering problem and there is nothing to build here.

---

### Tier 2 — high ceiling, honestly large

| # | Item | Size |
|---|---|---|
| 16 | **Live preview loop**: preview pane, click-to-select an element, screenshot back to the model, console logs to the model, model-driven navigation | L |
| 17 | **Git review surface**: diff, per-file patch, dirty-tree warning, commit/stash | M–L |
| 18 | **Full PR console**: checks, annotations, rerun, review comments, merge (~20 methods on their side) | L |
| 19 | **Live sub-agent progress + nested tool calls.** ENTRY WAS WRONG ON BOTH HALVES — see §12a below before touching this | L |
| 20 | **Artifacts**: gallery, versions, restore, share, auto-publish, print-to-PDF; artifacts that can call tools and query the model | L |
| 21 | **Workspaces**: group folders/projects/links, auto-summary, auto-classify sessions, per-workspace memory | M–L |
| 22 | **Scheduled tasks** with editable task files, trigger history, standing permissions | M |
| 23 | **Memory**: global + per-account files, editable, resettable | S–M |
| 24 | **Plugin marketplaces**: multiple sources, paged catalogs, OAuth, env vars, per-shim permissions, org-private catalogs | L |
| 25 | **MCP management UI**: live status, per-server logs, probe-before-add, in-app OAuth, per-session tool enablement | M |
| 26 | **Side chat** — scratch sub-conversation beside the main thread | M |
| 27 | **Session summarize / compact** with a user trigger. Condensation events exist backend-side but `should-render-event.ts:15-80` has no branch, so they never render | M |

### Tier 3 — cheap wins, do when passing

Archive/unarchive, share a session, session pre-warm, theme mode, locale
switching, incognito-as-ephemeral-session, web notifications, support bundle,
feedback with screenshot, repo/code stats, project auto-detection, config health
check.

---

## 3. Requires a desktop shell

Not achievable in a browser. Each is a *product decision*, not a bug.

1. Browser control of the user's real logged-in browser — 22 tools, extension + native messaging host
2. Computer use / desktop control, including the teach overlay
3. Local micro-VM sandbox (web equivalent: server-side containers — same UX, different substrate)
4. Mobile simulator control (install, launch, gesture, screenshot, record)
5. Reading documents currently open in local office apps
6. Global hotkey, quick-entry window, launch-at-login, menu-bar residency
7. Multi-window management and session tear-off
8. Open-in-local-editor (web can only fire a `vscode://` deep link)
9. Locally packaged extensions that execute local processes
10. CLI session import, CLI installation, WSL targets, hardware device attestation, wake scheduler
11. SSH with local key material (server-side is possible, but the trust model changes materially)

---

## 4. Security positions we deliberately do NOT copy

Their extension signature verifier **pins no vendor trust anchor**, so any
certificate the OS already trusts for code-signing satisfies "signed" — and
`extensions.signatureRequired` **defaults to false**. Copying that ships our
customers a package-install path any signed publisher can walk through, off by
default.

We ship the identical *feature* — drag a package in, it installs, it appears in
the list with Configure — pinned to our own key. Same UX, correct from day one.

Worth adopting from them: their managed-policy layer is **fail-closed** — an
invalid MCP allowlist becomes *empty*, an invalid managed-only flag becomes
*true*. That is the right default and we should match it.

---

## 5a. Resolved (2026-08-06, second pass)

The first pass read a derived method index. The second read the **actual bundles**
plus 1421 extracted react-intl messages, whose `description` fields are written
for translators and state intent plainly. That settled nearly everything below.

**A caveat that explains every remaining gap:** the desktop app is a *shell*. Its
main window loads the vendor's web app remotely and exposes all 68 IPC
interfaces to it. So this material proves contracts, state machines, gating and
model-facing prompts — but **not button labels**, because the UI is served
remotely and is not in the bundles.

| Subsystem | What it actually is | Verdict for us |
|---|---|---|
| `GrandPrix` | **Password-manager / credential autofill partner integration.** Partners are locally installed macOS apps reached over attested Mach XPC keyed by Apple Team ID; partner list is server-delivered and HMAC-signed. macOS-only by construction. | **Skip** — not web-implementable. But copy the *pattern*: partner integrations exposed as dynamic MCP tools injected into the agent's toolset. |
| `Buddy` | A **DIY Bluetooth-LE desk pet** — hobbyist hardware that shows permission prompts and lets you approve with a physical button. The app itself says it "isn't an officially supported product feature". | **Skip the hardware.** Take the portable idea: **approve pending tool prompts from your phone** — websocket + mobile browser, S–M, no hardware. |
| `launchUltrareview` | **Not** "a deeper review pass". It spawns a **separate cloud agent session with its own URL**, behind two-phase consent showing a `billingNote`, and can be `blocked` behind an entitlement. The only feature in the bundle carrying a billing note. | Backend product (L). But its sibling `reviewDiff` — one model call over a raw diff, "HIGH SIGNAL issues only", posted as inline comments — is **S and worth copying**. |
| `Clarkdown` | **Document round-trip.** In: `.docx/.md/.txt/.cd`. Out: those plus **PDF (export only)**. A doc is converted to an editable plain-text working copy the model edits in place, then re-rendered **against hash-verified original bytes** so untouched formatting survives. | **M, web-implementable.** Three ideas worth stealing: never let the model touch the binary; keep the original bytes as a verified baseline; export via an opaque single-use handle, never a caller-supplied path. |
| Auto mode | A **permission mode** peer to ask/acceptEdits/plan. A safety classifier judges each action and only prompts on risky ones. The "proposal file" is a proposed **permission policy**, not a plan or a diff. | L overall. **Take the 20% now:** destructive tools re-prompt *even when always-allowed*. That inversion is the real insight and needs no classifier. |
| Refusal fallback | **Automatic model failover when a model refuses.** Exactly three outcomes — retry on a fallback model, edit the prompt, cancel — auto-cancelling after 300s, with `retry` / `revert` / `sticky` directions. | **S–M, fully web-implementable. Best effort-to-value in the whole inventory.** Copy `revert-after-turn` so one refusal doesn't silently downgrade the rest of the session. |
| `getAutoVerify` | Neither a build check nor a gate. A **prompt-injection nudge**: when on, the agent must open the preview itself, exercise it, fix what it finds, and post proof. Enforced by a once-per-turn hook on source-file edits. | **S if you have browser-side agent tools, which we do.** Highest perceived-quality jump per line of code here, and *easier* on web than desktop because the preview is an iframe we control. |
| `Epitaxy` | The route name for their **entire Code surface** (`/code` → `/epitaxy` on desktop). `isEpitaxyPreviewEnabled` is an in-app file viewer within it. | Naming only. |
| `YukonSilver` | The **local Linux micro-VM** their sessions run in. | Our equivalent is the server-side sandbox. |
| `ForgeState` | A live **pull-request tracker** (state, refs, draft, mergeable, review decision, check counts). Its `setVisibleKeys` is a neat backpressure trick — the renderer tells the main process which PRs are on screen so only those refresh. | **M, web-implementable.** This is the "CI monitoring with checkboxes" ask. |
| `NestDev` | Dev-only, and a **hardcoded stub in the shipped build**. | No value. |
| Two scheduled-task interfaces | **One shared class, two runners**: one runs in the micro-VM, one runs natively via the CLI against a real `cwd`. Watchers are fully designed and **inert in this build** for both. Remote dispatch provably merges them into one list. | **M, and easier for us** — with no desktop there is no VM/host split and no wake problem. Steal: task-as-versioned-markdown, cron XOR one-shot with auto-disable, **deterministic per-task jitter** (stops a thundering herd at `0 9 * * *`), and approvals granted during a run persisting to later runs. |

## 5. Unresolved — research, not features

The source notes name these without defining them. Do not build against a guess.

- `GrandPrix` — a verification-code pairing flow with an external peer. Adjacent
  error strings (`unknownPartner`, `fillFailed`, `autosubmitFailed`,
  `multipleItemsMatched`) read like partner credential-filling; other evidence
  ties the name to browser-bridge teardown. **Strategically relevant if it is a
  partner integration.** Worth a targeted follow-up.
- `Buddy` / `BuddyBleTransport` / `BuddyRemoteFeed` — pair a Bluetooth-LE device
  by PIN, pick a folder, preview, install. **What the device is, and what
  "install" installs, is stated nowhere.**
- `launchUltrareview` — distinct from ordinary diff review, so a deeper mode.
  Scope undetermined.
- `runClarkdownConvert` — a named document-conversion engine. Input/output
  formats not stated.
- Auto mode (`writeAutoModeProposalFile`) — writes proposals to a file for
  review. UX not described.
- `respondToRefusalFallbackPrompt` — a user-facing prompt when the model
  refuses. What it offers is not stated.
- `NestDev`, `ForgeState`, `setYukonSilverConfig`, `isEpitaxyPreviewEnabled` —
  internal codenames, no descriptions.
- Preview `getAutoVerify` — plausibly "auto-screenshot and check after each
  change", but that is inference.
- Watch-recording (screen + microphone) — the renderer methods exist but the
  four raw handlers are **hardcoded-false and dead in the audited build**. A
  roadmap signal on their side, not a shipped feature.
- Two parallel scheduled-task interfaces with near-identical method sets.
  Whether users see one surface or two is not stated.

---

## 6. Method

Anything added here cites evidence. A claim about our code carries `path:line`.
A claim about theirs carries the artifact it came from. "Not found" is written
as "not found — searched X" so the next person knows the search was run and
where it stopped. An inventory that quietly mixes observation with inference is
worse than a shorter honest one, because nobody can tell which rows to trust.

---

## 7. Live preview loop — design summary

Designed 2026-08-06 against this codebase. Full detail in the P13 task.

**Why it ranks high:** it is the one capability where a browser product is at
*no* disadvantage to a desktop app, because the customer's app already runs in a
browser.

**The asset we already own.** `sandbox/agent_proxy_router.py` reverse-proxies
HTTP **and** WebSocket from the public origin into the sandbox, and already
solves streaming, hop-by-hop headers and WS pumping in exactly this
architecture. The preview proxy is a sibling of it, not a new subsystem.

**The constraint that decides the design.** Azure Container Apps publishes
exactly one port per app (`agent_proxy_router.py:21-23`). Direct port exposure
is therefore impossible; everything enters through the app server. Phase 1 is a
path-based proxy, Phase 3 upgrades to a wildcard subdomain.

**Two limits to state to customers rather than discover:**
- Apps that emit absolute asset paths (`/assets/main.js`) break under a path
  prefix. Do **not** attempt HTML rewriting — that is a tarpit. The subdomain
  migration is the real fix.
- The iframe runs `sandbox="allow-scripts allow-forms"` **without**
  `allow-same-origin`, giving agent-written JS an opaque origin so it cannot
  reach our storage or cookies. The cost is that the previewed app cannot use
  its own cookies, localStorage or service workers.

**Already built, do not rebuild:** screenshot-to-model (`include_screenshot`);
screenshot content-hashing, so "only if changed" is a prompt rule not new
machinery; CDP pre-page script injection in the SDK browser server; DOM snapshot
via `browser_get_content` / `browser_get_state`.

**Real gap found:** the SDK captures **no console logs** — searched
`browser_use/*.py` for "console", zero hits. Console capture has to come from
our own injected bridge script.

**Do not build:** a pixel/screencast pane (the existing screenshot feed already
covers unembeddable apps), multi-tab preview with history, a separate
model-driven-navigation UI (the agent already has the full browser tool set),
or dev-server config detection — an endpoint reporting *actually listening*
ports is strictly more truthful than parsing `package.json`. The competitor
needs detection because their runtime is detached from the agent. Ours is not.

**Unverified, flagged:** ACA wildcard custom-domain + certificate binding for
`*.preview.<domain>` is assumed, not confirmed. Verify before committing to
Phase 3.

## 8. Live bug found during that design

The **VSCode tab cannot work on this deployment**. It resolves its iframe URL
from `sandbox.exposed_urls` where `name === "VSCODE"`
(`hooks/query/use-unified-vscode-url.ts:51-63`), but under `RUNTIME=process`
the sandbox publishes only an `AGENT_SERVER` entry
(`sandbox/process_sandbox_service.py:529-535`). The lookup always misses and
the tab renders "URL not available". Tracked as P14 — offering a permanently
broken tab is the one option to rule out.

---

## 9. Fork a conversation — what is built, and the decision that is not mine

`EventService.copy_events_until(source, target, up_to_event_id)` is built and
tested (9 tests). It is the load-bearing half: copy a conversation's history
into another, inclusive of the chosen event, without touching the source.

**Copy, not truncate — deliberately.** The obvious alternative is deleting
everything after a point in place, and the interface has no delete for good
reason: it would have to exist in every implementation, including the ones
backed by object storage where a delete is not obviously reversible. Copying
means a cutoff bug costs a wrong-sized fork rather than someone's history, and
a fork that turns out to be a bad idea costs nothing.

**Two behaviours chosen against the obvious reading**, both because the
alternative is indistinguishable from a bug:

- the cutoff is **inclusive** — a user forks *from* a message they can see, and
  excluding it silently drops the event they were reasoning about
- an **unknown id copies everything**, because an empty fork looks exactly like
  a broken feature, whereas a complete copy is at worst more than was asked for

### What is NOT built, and why it needs a decision rather than code

A forked conversation gets its **own sandbox**, and it is not established
whether the agent server also needs the replayed events or whether restoring
them into the app-server event store is sufficient for the transcript to render
and the agent to reason. That is a semantics question about the SDK's
conversation state, not a wiring question, and guessing it produces a fork that
looks right and behaves subtly wrong — the worst possible outcome for a feature
whose entire purpose is recovering trust after the agent went wrong.

Settle it before wiring the endpoint: start a conversation, restore events into
it, and check whether the agent's own context reflects them. If it does not, the
fork needs to replay through the agent server rather than the event store, and
that is a different endpoint.

### ANSWERED 2026-08-07, from source — and the answer invalidates the endpoint below

**Restoring events into the app-server event store is NOT sufficient for the
agent to reason.** It is sufficient for the transcript to RENDER, which is
exactly what makes this dangerous: the proposed endpoint would have produced a
fork that looks complete and whose agent remembers none of it.

Four links, each read rather than inferred:

1. **The agent's context lives in its own EventLog, inside the sandbox.**
   `ConversationState.create` (sdk/conversation/state.py:446) has a resume path:
   it reads `BASE_STATE` from a `LocalFileStore` rooted at `persistence_dir` and
   rebuilds `EventLog(file_store, dir_path=EVENTS_DIR)`. That store is the
   agent's memory.

2. **Events flow agent → app-server, one way only.** `save_event` is called
   from exactly one place in normal operation: the webhook at
   `event_callback/webhook_router.py:546`, fed by the agent server POSTing.
   `process_sandbox_service.py:311` states it outright — "Events reach durable
   storage exactly one way in this runtime". The app-server store is a
   downstream DISPLAY MIRROR. Nothing writes back.

3. **The agent server has no event-injection endpoint.** Its CONVERSATION
   router offers start, pause, interrupt, run, goal, goal/stop, goal/resume,
   secrets, confirmation_policy, security_analyzer, switch_profile, switch_llm.
   There is no import, no replay, no set-history.

   **SCOPE CORRECTION, and it changes the conclusion below.** That list is the
   conversation router ONLY. The agent server also exposes
   `bash_router.py` (`POST /bash/execute_bash_command`) and `file_router.py`
   (`POST /file/upload`, `GET /file/download`, `GET /file/archive`) — and
   `/api/file` is already reachable and already classified, sitting in
   `_EXEMPT_PREFIXES` at `nimbus_auth_gate.py:80` authenticated by
   X-Session-API-Key. A fork does not need event INJECTION; it needs FILESYSTEM
   access, and that exists over the network today.

4. **`StartConversationRequest` cannot carry prior events.** Its fields are
   workspace, worktree, conversation_id, confirmation_policy,
   security_analyzer, initial_message (sdk/conversation/request.py:77). A grep
   for an events field returns zero.

So there is no path that gives a forked conversation the original's memory by
INJECTING EVENTS — but that was the wrong thing to look for. The file and bash
routers give the filesystem access the copy actually needs, over the network,
for remote sandboxes too.

**This corrects an earlier claim in this section that said no API path exists at
all.** That conclusion came from enumerating one router and generalising. A
negative finding is only as strong as the set it searched, and the set was not
stated — which is the same failure as a path-filtered recovery that does not
say what it filtered out.

**What a correct fork actually requires.** The resume path keys on the
conversation id and raises `ValueError` on mismatch (state.py:524), so the fork
cannot simply point at the source's persistence_dir. It needs the sandbox's
persistence directory COPIED — the agent's own EventLog plus base_state.json —
with the conversation id rewritten and the log truncated at the cutoff. That is
filesystem work inside the sandbox, not an app-server API call, and it is a
materially bigger job than the endpoint sketched below.

### The endpoint as originally sketched — DO NOT BUILD THIS AS-IS

`POST /app-conversations/{id}/fork` with `{ "up_to_event_id": "..." }` →
start a conversation, `copy_events_until` into it, return the new conversation.

Kept because the shape is still right and `copy_events_until` is still the
load-bearing half for the TRANSCRIPT. But on its own it ships the
looks-right-behaves-wrong fork this section was written to prevent. Pair it
with the sandbox persistence copy, or do not ship a fork action at all.

An honest smaller feature, if the full fork is too large: "start a new
conversation seeded with a summary of this one" is buildable today with no
sandbox work, and is not the same thing — so it must not be labelled fork.

### BUILT 2026-08-07: the missing half

`app_conversation/fork_conversation_state.py` (13 tests, mypy clean) copies the
agent's OWN state — `base_state.json` with the id rewritten, plus the EventLog
truncated at the cutoff. Same cutoff semantics as `copy_events_until`, stated
identically in both places so the two halves of one fork cannot disagree about
where the cut falls.

### The endpoint, now fully specified — sequencing is the load-bearing part

The order is not arbitrary and is what makes this work at all:

1. `sandbox_service.start_sandbox(...)` — a separate call from the conversation
   POST (`live_status_app_conversation_service.py:1174`), which is what makes
   step 2 possible.
2. `fork_conversation_state(...)` into the NEW sandbox's conversations dir,
   at `<sandbox_dir>/workspace/conversations/<new_id.hex>/`.
3. POST start_conversation with `conversation_id = <new_id>`. The agent's
   `ConversationState.create` finds `base_state.json` already present and takes
   its RESUME path — so it comes up with the forked history as its memory.
   This is the whole trick: nothing is injected, the agent resumes state that
   was placed there first.
4. `copy_events_until` into the app-server store, so the transcript renders.

Steps 2 and 4 are both required. Either alone is a broken fork.

**Remote sandboxes are NOT a blocker.** Direct filesystem access holds only
for `RUNTIME=process`, where the sandbox is a child of the app container
(`OH_PERSISTENCE_DIR` is in the inherited-env allowlist). For a remote sandbox
the same copy runs over `/file/archive` + `/file/upload`, or a single
`/bash/execute_bash_command`. Both are already authenticated. So the runtime
split is an implementation detail, not a capability gap.

**The one thing still to decide is a PRODUCT question, and it is the founder's.**
Does a fork SHARE the parent's sandbox, or get its own?

  * Shared — one bash call, cheap, and the fork can mutate the parent's files.
    A fork exists to try a different path; letting it damage the thing you
    forked from defeats the purpose.
  * Own sandbox — archive + upload, isolated, more moving parts.

Nobody should implement this unprompted, because the two answers produce
different endpoints.

Frontend affordance stays unbuilt until the endpoint exists. A fork action
that produces an amnesiac fork is worse than no fork action.

---

## 10. Which way an unreadable setting should fail

Two features landed on the same day with the same shape of ambiguity — a config
value nobody can parse — and the correct default is **opposite** in each. It is
worth stating once, because copying either one into the other is a plausible
mistake that produces a real bug.

**MCP server policy → fail RESTRICTIVE.** An unreadable `managed-only` flag
becomes `true`. An allowlist that parses to nothing stays an *empty allowlist*
rather than becoming *no allowlist*.

**Agent self-verification → fail OFF.** An unreadable
`NIMBUS_AGENT_SELF_VERIFY` leaves verification disabled.

Both are "we could not tell what the operator meant". The difference is what
being wrong costs:

| | Wrong in the restrictive direction | Wrong in the permissive direction |
|---|---|---|
| MCP policy | a customer says their server stopped working | arbitrary code you did not intend to permit runs in your sandbox, and nobody tells you |
| Self-verify | tokens spent nobody agreed to spend — on a metered product, the customer's money | an agent claims it checked something it never rendered |

**The rule: fail toward the outcome you would find out about.** A customer
reports a feature that stopped working. Nobody reports code that quietly ran, or
money quietly spent. Ask which failure is *silent*, and default away from it —
"be more restrictive" is a heuristic that happens to be right in the first case
and wrong in the second.

Both module docstrings state their own reasoning rather than pointing here, so
neither reads as a copy of the other with the sign flipped.

### The same principle, applied to a silent feature

Self-verification is prompt text behind an env flag, which means a wrong flag
name or a missed injection point fails **completely silently** — nothing raises
and the agent simply never verifies. Two tests exist purely for that:
`ENV_SELF_VERIFICATION` is pinned to its literal string in exactly one place
(every other test imports the constant, so a rename would be consistently wrong
and invisible), and the injector is asserted to appear at the same call sites as
two long-established siblings, since there are two conversation start paths and
appearing in fewer means one silently skips it.

If a feature has no runtime signal when it fails, something has to check its
wiring structurally. A unit test of the function proves the function works, not
that anything calls it.

---

## 11. Search — what exists, and why content search needs infrastructure

**Searching conversations by title already works, end to end.**
`GET /api/v1/app-conversations/search?title__contains=` is exposed, threaded
through the service, and applied as a SQL predicate. The gap is purely frontend:
`conversation-panel.tsx` has no search state and never calls it.

That covers the most common reason people go back — "how did I fix this last
month" is usually a hunt for the *conversation*, and titles are generated
summaries.

It was case-SENSITIVE until now, and the way that hid is worth remembering:
production is Postgres, whose `LIKE` respects case, while the test suite runs
SQLite, whose `LIKE` does not. So `.like()` passed every test and would have
failed to match "Billing" for a user typing "billing". Fixed to `.ilike()`, and
pinned by asserting on the **compiled SQL** rather than on behaviour — a
behavioural test cannot see the difference on SQLite, which is exactly why it
survived.

### Content search is a different problem

Searching what was *said* — not what a conversation is called — cannot be built
the same way, because **events are not in the database**. The event services are
filesystem, S3 and Google Cloud (`event/filesystem_event_service.py`,
`aws_event_service.py`, `google_cloud_event_service.py`), and `search_events` is
scoped to one conversation with no text filter.

So there is no table to add an index to. The options are:

1. **Scan on demand** — read every conversation's events per query. Honest, and
   unusable past a few dozen conversations.
2. **A search index written on save** — a new table populated wherever events
   are persisted, queried with Postgres full-text. Correct, and it is a schema
   plus a backfill for existing history.
3. **Index only messages** — the same, but skipping tool actions and
   observations. Far smaller, and matches what people search for: their own
   words and the assistant's replies, not the contents of a grep result.

Option 3 is the recommendation. Start there, and note that it is a migration and
a backfill rather than a query — nobody should promise this as a small change.
