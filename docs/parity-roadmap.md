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

**STATUS IS RECORDED HERE. Keep it current.** This table read as if nothing had
shipped for a full day after six of its items landed, and two sessions
independently rebuilt #19 off a stale entry. A wrong size costs an estimate; a
stale DONE costs the whole implementation.

| # | Item | Status | Note |
|---|---|---|---|
| 6 | **Inline diffs in the transcript** | **DONE** | `unified-diff.ts` + the diff render path; edits render as diffs, not whole files |
| 7 | **Queued-message control** | **DONE** | real queue store, cancel/reorder/promote |
| 8 | **Cross-session transcript search** | **DONE** | `8f555ac2f` |
| 9 | **Find-in-conversation (Cmd+F)** | **DONE** | `284849fc4`. CSS Custom Highlight API — see the collapsed-rows limitation recorded there |
| 10 | **@-mention picker with content search** | not started, **and blocked on a backend endpoint that does not exist** | Nothing reachable from the browser can list or search FILES. Needs a new app_server route before any UI. See "Item 10, scoped" |
| 11 | **Tool-permission prompts + permission modes** | backend DONE, browser-reachable | See "Item 11, inventoried" below. Modes are S–M and purely frontend. Folder trust is separate and unbacked |
| 12 | **Session fork + rewind** | **fix now IN the deployed image; behaviour still unverified** | `routing2-20260808` / rev `0000097` carries all three `/api`-prefixed callsites, confirmed by image inspection. Nobody has yet driven a fork against it. See "Item 12" below before touching it |
| 13 | **Server-side PTY terminal** | **half done, half blocked upstream** | Read-only agent terminal ships. Interactive shell impossible on this API: no stdin, no TTY, no session. See "Item 13, answered" |
| 14 | **`/help` + built-in command set** | **DONE** | `0357cd459`. Help reads `BUILT_IN_COMMANDS` at render, so it cannot go stale |
| 15 | **Shortcut registry + `Cmd+K` + `↑` recall** | **DONE** | Registry `35e333cdb`, recall `590286ea9`, palette `3c797261a`. Palette actions derive from `useSettingsNavItems`, so they cannot drift from the real nav |

#### Item 10, scoped 2026-08-08 — the blocker is not the schema

This row said "needs a schema decision first — content search, not filename
match". That is not the blocker. **There is no way for the browser to enumerate
files at all**, by name or content, so the schema question never arises.

**Every route the browser-facing proxy exposes** (`agent_proxy_router.py`
153-175):

    /api/conversations/{rest:path}
    /api/git/{rest:path}
    /api/vscode/{rest:path}
    /api/file/{rest:path}

**Every file route behind it** (SDK `agent_server/file_router.py`):

    POST /file/upload         one file, in
    GET  /file/download       one file, out, path must already be known
    GET  /file/archive        the WHOLE tree as tar.gz
    GET  /file/home           home dir + top-level DIRECTORIES + fs roots
    GET  /file/search_subdirs immediate subdirectories

`search_subdirs` is the GUI's workspace picker and its docstring is explicit:
*"Symlinks and files are skipped."* It is the same directory-picker that item 21
was once mistaken for. `/file/home` returns `FileBrowserEntry` values that are
also directories. So the file surface is: put one, get one by known path, or
download everything.

**`/api/bash/*` is NOT proxied.** The obvious workaround — have the client run
`git ls-files` or `rg --files` through `POST /api/bash/execute_bash_command` —
is unavailable, and should stay that way: exposing arbitrary command execution
to the browser is a security change, not a convenience, and the auth gate's
exempt list (`nimbus_auth_gate.py:80`) would have to grow to match.

**So item 10 needs a new app_server endpoint** — something like
`GET /api/v1/app-conversations/{id}/workspace/search?q=` — that runs server-side
and reaches the sandbox the way `fork_state_transport.py` already does
(server-to-server, via `sandbox.api_base`). That is backend work and it comes
before any picker UI. Sizing this as a frontend task will be wrong.

What is genuinely undecided, once the endpoint exists, is whether it matches
filenames or content, and what it returns per hit. That decision was never the
thing standing in the way.

#### Item 12, 2026-08-08 — merged, deployed, and never once functional

**Do not record this as shipped again until a fork is driven against a DEPLOYED
image.** It has been called done twice and was wrong both times.

**Round one:** the endpoint merged (PR #17) and deployed as revision `0000090`
with a green suite. The transport counted events from the SOURCE copier's
stdout and checked nothing on the target after `tar xzf` — and tar exits 0 even
when the archive unpacks at a different depth. A fork could report success with
an agent that had no memory. Fixed in `577579f14`.

**Round two, and this one predates every image:** the transport calls
`{base_url}/bash/execute_bash_command`, `/file/upload`, `/file/archive`. But
`agent_server/api.py:343` mounts bash, file, git, vscode and the rest inside
`APIRouter(prefix="/api")`. Only `server_details_router` (`/alive`,
`/server_info`) and the sockets router sit at the root — **which is precisely
why the health check passes while every functional call 404s.** All three paths
were missing `/api`. `fork12-20260808`, `fork12v2-20260808`,
`forkverify-20260808` and `bridgefix-20260808` all contain a fork that cannot
fork.

**Round three, 2026-08-08 14:14 — the fix is in the live image.** Verified by
executing the deployed artifact rather than by reading the branch it was
supposedly built from:

    az acr run --registry nimbusacr4768 --file fc3.yaml .
    # grep -rn 'execute_bash_command|api_base' inside
    # nimbusacr4768.azurecr.io/openhands-nimbus:routing2-20260808

`fork_state_transport.py` defines `api_base` at line 116, and all three real
callsites use it — `{sandbox.api_base}/file/upload` (230),
`/bash/execute_bash_command` (250), `/file/archive` (278). Live revision is
`0000097`, and `/server_info` now reports
`git_sha: 21873ce21624e2de5237a01763b16012f10a877e`, corroborated by the image
containing that commit's source.

**A first pass at this said three bare callsites remained. That was wrong, and
wrong in the way this document keeps warning about.** The probe counted
occurrences of `'/bash/execute_bash_command'` — which is a SUBSTRING of
`'/api/bash/execute_bash_command'`, so every fixed callsite also scored as
broken, and the leftovers were prose in docstrings. Same defect as the
`path.endswith(...)` assertion that let 43 green tests sit on a dead feature,
and as the containment check that once matched an author's own docstring and
reported production broken. Counting substrings is not reading code; when the
answer matters, print the lines.

**What is still NOT established: that it works.** Contents are not behaviour —
see `status_router.py` on why a matching sha proves the fix is present and never
that it runs. The remaining step is one fork driven end-to-end against
`0000097`, checking `halves_agree` and that the target's agent actually
remembers. Until someone does that, this row says "unverified", not "done".

**WHY 43 GREEN TESTS COULD NOT SEE IT.** Every assertion was

    request.url.path.endswith('/bash/execute_bash_command')

which is equally true of the broken `/bash/...` and the correct `/api/bash/...`.
**A suffix cannot observe a missing prefix.** The suite measured the tail; the
defect was in the head. This is the same shape as counting events from the
source's stdout, and as a `"'browser_navigate'" in source` check that matched a
docstring and nearly caused a false production alarm — three cases in one day of
an assertion made somewhere it structurally could not see what it was meant to
catch.

**The fix (PR #19)** adds `SandboxEndpoint.api_base` so a bare `base_url` cannot
be used by accident, compares FULL paths, and asserts over every request rather
than the three known call sites. Mutation-checked: reverting it fails 18 tests
where before it failed none. 6/6 live checks against a real agent server.

**What "shipped" must mean for this item:** a fork driven against the DEPLOYED
image, not a test double and not a locally-booted agent server. Both previous
claims rested on merged code plus a green suite, and both were false.

Client side is unaffected and correct: the transport is state-first, so a
routing failure raises before any conversation record is written — the user gets
a hard failure with no orphan conversation rather than a half-made one.

#### Items 20-26, inventoried 2026-08-08 — three are largely built, two unserved

Backend surfaces enumerated per item rather than sized from the frontend.

| # | Backend | Frontend | Real state |
|---|---|---|---|
| 20 Artifacts | **BUILT** — store + 8 routes | **BUILT** — `/artifacts` | gallery, versions, restore, delete DONE. Share / auto-publish / print-to-PDF deliberately not built; see below |
| 21 Workspaces | NOT what it looks like | none | unbuilt — see correction |
| 22 Scheduled tasks | model+store BUILT (21 tests) | none | **blocked on one security decision** — a scheduler has no request, so firing needs a way for background code to act as a customer. See scheduled_task_models.py |
| 23 Memory | see below | `/settings/condenser` | **label promises more than the page does** |
| 24 Plugin marketplaces | `skills_router` | `skills-settings.tsx` | **ALREADY BUILT** |
| 25 MCP management | `mcp_router` (4) | `mcp-settings.tsx` | largely built |
| 26 Side chat | `ask_agent` (stateless) | `/btw` + btw-store | **one-shot BUILT; continuity is the gap** — see below |

**CORRECTED 2026-08-08. Both items this table called "shovel-ready" were wrong,
and the error was mine in both directions.**

**#24 is ALREADY BUILT.** `skills-settings.tsx:233-250` maps
`preview.plugins` into `type: "plugin"` rows and `skills-table.tsx:155` renders
them with their own branch. Plugins are read-only there by design — enablement
is governed by the parent marketplace — and the app-server endpoint that feeds
them is `user/skills_router.py`, not the agent server's `plugins_router`. I
concluded "no UI" from the absence of a `plugins-settings.tsx` route and a grep
for "plugin" in `marketplace-modal.tsx` that returned nothing. Both were true;
neither answered the question, because the feature lives inside the skills page.

**#21's backend is a DIFFERENT FEATURE that shares a word.** The agent server's
`workspaces_router` is, in its own docstring, "local directories the GUI
surfaces in its workspace picker" — persisted so several clients of one
agent-server see the same list. That is a directory picker. Roadmap #21 is
Claude's Workspaces: grouped folders and links, auto-summary, session
auto-classification, per-workspace memory. Nothing of that exists, and citing
those five endpoints as its backend was name-matching.

**The lesson, since it defeated the remedy for the previous one:** "read the
backend before quoting a size" is not enough if you match on ROUTER NAMES. A
`plugins_router` existing did not mean plugins were unserved; a
`workspaces_router` existing did not mean Workspaces was served. Read what the
code DOES. This is the same accurate-answer-to-a-narrower-question failure the
rest of this document catalogues, committed while applying its own fix.

Also: `skills_router` (9) is served and `skills-settings.tsx` exists.

**#23 IS THE ONE TO LOOK AT, and it is a naming problem rather than a gap.**
The settings nav maps "Memory" to `/settings/condenser`, and the comment there
is honest about why: a condenser compacts conversation context so a long
session survives, which is what memory means to the person using it.

That rename is good for the eleven other items it sits beside. But Claude's
"Memory" is a different feature — global and per-account memory FILES that the
user reads, edits and resets. A customer who clicks "Memory" expecting to edit
what the assistant remembers about them finds a context-compaction setting.

Same shape as "do not call the fork a fork": the label promises state the page
does not hold. Two ways out, and it should be a deliberate pick —
either build the editable memory files behind that nav entry, or name the
current page for what it is. What should not happen is the entry quietly
staying where it is because it reads well in a sidebar.

**#21 and #24 are the cheapest remaining wins:** both have a live backend and
no UI at all, which is the inverse of most of this roadmap and the only place
where a pure frontend estimate would have been RIGHT.

#### Item 16, inventoried 2026-08-08 — the pane is built and the rest is a security decision

**BUILT:** `components/features/preview/preview-panel.tsx` plus
`sandbox/preview_proxy_router.py` (`/preview/{id}/ports` and the
`/preview/{id}/{port}/{path}` proxy). The pane works.

**ALSO ALREADY THERE:** the agent has its own browser — `tools/browser_use/` in
the SDK — so "screenshot back to the model" and "model-driven navigation" are
served for the AGENT'S browser today. That is most of what the item asks for,
just not through the user's pane.

**THE REST IS BLOCKED BY A DELIBERATE SECURITY CHOICE, not by missing work.**
The preview iframe is `sandbox="allow-scripts allow-forms"` with NO
`allow-same-origin` (preview-panel.tsx:152). That is what stops a previewed app
— which is arbitrary code the agent just wrote — from reaching the parent page,
its cookies, or the session. It also makes cross-frame introspection impossible
by design:

  * click-to-select an element   — needs DOM access into the frame
  * console logs to the model    — needs to hook the frame's console

Both require `allow-same-origin`, and granting it to a frame serving
agent-authored code from the same origin as the app is precisely what the
attribute exists to prevent.

**So #16 is a decision, not an estimate.** Three honest options:

  1. Leave it. The agent's own browser already gives the model screenshots,
     navigation and console access — the model does not need the user's pane to
     see the page.
  2. Serve the preview from a SEPARATE ORIGIN and grant `allow-same-origin`
     there. Cross-origin then blocks parent access structurally rather than by
     attribute. This is the real fix and it is deployment work, not frontend.
  3. Add a small opt-in agent shim injected into the previewed page that posts
     selections and console lines out via `postMessage`. No `allow-same-origin`
     needed, works with the sandbox as-is, but only for pages the agent
     instruments.

Option 1 is free and probably right until someone asks for click-to-select by
name. Do NOT quietly add `allow-same-origin` to make the feature work — that
converts a contained preview into a same-origin frame running agent-written
code.

#### Items 17 and 18, inventoried 2026-08-08 — sizes were quoted without checking the backend

Both were sized from the frontend's side. The backend serves one half of each.

**GIT, READ — served.** Agent server `git_router`: `/changes`, `/diff`,
`/commits`, `/commits/{sha}/changes`. The app server proxies the first two at
`app_conversation_router.py:1336,1363`. So diff and per-file patch are
buildable today, and `FileDiffViewer` already exists (Tier 1 #6 used it).

**GIT, WRITE — no endpoint anywhere.** Enumerated both routers rather than one:
the agent server's git router is entirely GET, and the app server's
`git/git_router.py` is four GETs (`installations/search`,
`repositories/search`, `branches/search`, `suggested-tasks/search`). There is
no commit, no stash, no push, no branch-create. The "commit/stash" half of #17
cannot be built without an upstream change — the same shape as #13.

A dirty-tree WARNING is buildable from `/changes` alone, and is the useful part
of #17 that needs nothing new.

**PR CREATION — already exists, and not where anyone would look for it.** It is
MCP tools, not REST: `create_pr`, `create_mr`, `create_bitbucket_pr`,
`create_bitbucket_data_center_pr` in `mcp/mcp_router.py`, plus
`save_pr_metadata` and `get_conversation_link`. That is the surface the
anonymous-auth fix was protecting. So "open a PR from the chat" is served today
by a path the roadmap never mentions.

**PR CONSOLE — not served.** Checks, annotations, rerun, review comments and
merge have no endpoint on either server. Those are per-provider REST calls that
would live in `integrations/{github,gitlab,bitbucket,azure_devops}`, so #18 is
FOUR implementations, not one — which is the part that makes L optimistic
rather than the method count.

#### Item 26, inventoried 2026-08-08 — the one-shot exists; a THREAD does not

**BUILT:** `/btw <question>` routes through `askV1Agent` -> the SDK's
`ask_agent`, with `btw-store` holding pending/resolved answers and
`BtwMessages` rendering them inline. That is the core of a side chat: ask
something without derailing the main task.

**THE GAP IS CONTINUITY, and it is a backend property rather than a missing
component.** `ask_agent`'s own docstring (sdk/conversation/base.py:334) is
explicit:

    "a simple, STATELESS question ... does not modify, persist, or become part
     of the conversation state. The request is not remembered by the main
     agent, no events are recorded"

So every `/btw` is independent. There is no follow-up, because there is nothing
for a follow-up to attach to. A side chat in the Claude sense is a THREAD —
you ask, read, and ask again about the answer.

**Two ways forward, and they are not equivalent:**

  1. Approximate it — keep the Q&A locally and re-send prior turns inside the
     next question. Works today with no backend change. Costs tokens linearly,
     and drifts, because the agent is not actually remembering; it is being
     re-told. Honest only if the UI does not promise a conversation.
  2. Give it real state — a genuine sub-conversation. That is `TaskToolSet` /
     sub-agent territory, not `ask_agent`, and is a backend piece.

**Do not label option 1 a side chat.** Same rule as the fork: a name that
promises state the thing does not hold gets discovered by the user, at the
point they rely on it. "Ask a one-off question" is what `/btw` does and what it
should keep being called until option 2 exists.

#### Item 11, inventoried 2026-08-08 — the backend is done and the browser can already reach it

**Three permission modes exist in the SDK** as real policies
(`sdk/security/confirmation_policy.py`): `AlwaysConfirm`, `NeverConfirm`,
`ConfirmRisky` — exactly Claude's always-ask / never-ask / ask-on-risky.

**The endpoint is reachable from the browser TODAY.** Verified link by link:

    browser  POST /api/conversations/{id}/confirmation_policy
       |     `/api/conversations` is in _EXEMPT_PREFIXES, authenticated by
       |     X-Session-API-Key
    proxy    agent_proxy_router.py:152  `/api/conversations/{rest:path}`
       |
    agent    api.py `/api` + conversation_router prefix `/conversations`
             + `/{conversation_id}/confirmation_policy`

No backend work required. Sized M and "not started"; the modes half is S–M and
purely frontend.

**WHAT IS MISSING is that the modes are not expressible as a CHOICE.**
`_select_confirmation_policy` (app_conversation_service_base.py:676) derives
the policy from TWO settings:

    confirmation_mode = False               -> NeverConfirm
    confirmation_mode = True  + llm         -> ConfirmRisky
    confirmation_mode = True  + no analyzer -> AlwaysConfirm

Surfaced as a boolean and an analyzer string on a schema-driven page called
"Verification". Someone who wants "ask me before risky actions" has to know
that means confirmation_mode ON *and* analyzer set to llm. The capability is
complete; the affordance is a puzzle.

Parity is a mode selector where the work happens — the composer's control row,
beside the model and Code/Plan controls — writing straight to that endpoint.
The confirmation PROMPTS already exist (`confirmation-buttons.tsx` /
`v1-confirmation-buttons.tsx`).

**Folder trust is a different item**, has no backing here, and should not be
bundled into this one.

#### Item 13, answered 2026-08-07 — there is no PTY, and no stdin at all

**What already exists:** `components/features/terminal/terminal.tsx` +
`hooks/use-terminal.ts`, xterm.js with `@xterm/addon-fit`, wired and rendering.
It is `disableStdin: true` — a read-only mirror of the agent's bash output. That
is the FIRST of the two terminals Claude ships, and it is done.

**What is missing is the interactive user shell, and the API cannot serve it.**
Enumerated ALL 22 agent-server routers, not one:

    agent_profiles auth bash conversation desktop event file git hooks init
    llm mcp plugins profiles server_details settings skills sub_agents tool
    vscode workspace workspaces

No WebSocket endpoint. No PTY. The only shell surface is `bash_router`:
`/start_bash_command`, `/execute_bash_command`, `/bash_events/`,
`/bash_events/search`.

And `bash_service.start_bash_command` forecloses it (bash_service.py:214-230):

    process = await asyncio.create_subprocess_shell(
        command.command, cwd=command.cwd,
        stdout=PIPE, stderr=PIPE, shell=True,
        env=sanitized_env(), start_new_session=True,
    )

Three separate blockers, each fatal on its own:

  * **No stdin.** stdout and stderr are piped; stdin is not wired at all. There
    is no channel to type INTO. A terminal you cannot type into is the one we
    already have.
  * **No TTY.** PIPEs, not a pty pair. No line discipline, no job control, no
    Ctrl-C into a running process, and any program that checks `isatty()`
    behaves differently.
  * **No session.** A fresh `create_subprocess_shell` per command with
    `start_new_session=True`, and `cwd` supplied per request — so `cd`,
    `export`, shell functions and history do not carry between commands. There
    is no shell to retain scrollback FOR.

**What IS buildable today, and what it must not be called:** a command runner —
type a command, POST `/execute_bash_command`, append output to the existing
xterm view. Genuinely useful for one-shot commands. It is NOT a terminal, and
labelling it one would be the same error as calling a summary-seeded
conversation a fork: the name promises state that is not there, and the user
discovers the gap by typing `cd` and watching it not take.

A real PTY needs an upstream agent-server change — a WebSocket carrying a pty
pair. Sized L and blocked upstream rather than M, because M invited an estimate
against an API that cannot do it.

---

### Tier 2 — high ceiling, honestly large

| # | Item | Size |
|---|---|---|
| 16 | **Live preview loop** — pane BUILT; the introspection half is a SECURITY TRADEOFF, not a build task; see below | M, needs a decision |
| 17 | **Git review surface** — READ half is served, WRITE half has no endpoint at all; see "Items 17 and 18, inventoried" | M for read, blocked upstream for write |
| 18 | **PR console** — CREATION already exists via MCP; checks/annotations/rerun/merge do not; see below | L |
| 19 | **Live sub-agent progress + nested tool calls.** NOT a rendering gap — see "Item 19, answered" below. Needs the SDK to emit a mid-task event; no frontend work reaches it | L, blocked upstream |
| 20 | **Artifacts**: gallery, versions, restore, share, auto-publish, print-to-PDF; artifacts that can call tools and query the model | L |
| 21 | **Workspaces**: group folders/projects/links, auto-summary, auto-classify sessions, per-workspace memory | M–L |
| 22 | **Scheduled tasks** with editable task files, trigger history, standing permissions | M |
| 23 | **Memory**: global + per-account files, editable, resettable | S–M |
| 24 | **Plugin marketplaces**: multiple sources, paged catalogs, OAuth, env vars, per-shim permissions, org-private catalogs | L |
| 25 | **MCP management UI**: live status, per-server logs, probe-before-add, in-app OAuth, per-session tool enablement | M |
| 26 | **Side chat** — scratch sub-conversation beside the main thread | M |
| 27 | **Session summarize / compact** with a user trigger. Condensation events exist backend-side but `should-render-event.ts:15-80` has no branch, so they never render | M |

#### Item 19, answered 2026-08-07 — and TWO wrong answers were built off the old wording first

The original entry said `TaskObservation.status` exists and no render site reads
it. Both halves misled, and both misleading readings were acted on within an hour
of each other by different sessions. Recording the mechanism, because a third
attempt is the default outcome otherwise.

**The render site does exist.** `components/v1/chat/subagent/subagent-observation-content.tsx`
is a rich card — subagent, task id, the paired query, the result — wired at
`get-event-content.tsx:214`. The "no render site" clause was simply stale.

**`status` is unread because it is redundant, not because it was forgotten.**
`openhands/tools/task/impl.py:38-66` is the only constructor and every branch
sets both fields together:

    TaskStatus.COMPLETED  status=task.status, is_error unset (False)  -> success
    TaskStatus.ERROR      status=task.status, is_error=True           -> error
    except Exception      status="error",     is_error=True           -> error
    case _                raise RuntimeError — never builds one

`case _` is the SDK stating outright that a non-terminal `TaskObservation` is not
a thing. So `status: "failed"` with a falsy `is_error` is unreachable, and
`get-observation-result.ts` resolving on `is_error` alone is CORRECT.

**The two wrong answers:**

1. A "still running" indicator was built on `status`, reasoning that
   `manager.py:283` emits `TaskStatus.RUNNING`. It does — but it constructs an
   internal `Task`, not a `TaskObservation`. Shipped, then reverted in
   `8fc03de2f`, along with ten green tests asserting behaviour the system cannot
   produce. Tests documenting an unreachable state are worse than no tests: the
   next reader takes them as a specification.
2. The same field was flagged as a possible defect — a failed sub-agent rendering
   with a green check. Correctly NOT called a bug without checking reachability,
   and reachability came back clean.

**What item 19 actually needs:** there is no in-progress event for a sub-agent at
all. The observation arrives once, at the end. Live progress requires the SDK to
emit something mid-task. No amount of frontend work reaches it, which is why this
is marked blocked upstream rather than L.

### Tier 3 — cheap wins, do when passing

**SIZES HERE ARE UNVERIFIED FRONTEND GUESSES.** Eleven of eleven Tier 2 sizes
were wrong once checked against the backend, in the same direction each time.
Assume the same of everything below until someone reads the backend for it.
"Cheap" is a hypothesis, not a finding.


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

**That question is ANSWERED BY THE CODE, not by preference.**
`SandboxGroupingStrategy.NO_GROUPING` is the default —
"each conversation gets its own sandbox" (settings_models.py:611). So a fork
already gets its own sandbox and the persistence dir must be TRANSFERRED
(archive + upload, or a bash copy), never shared. I previously recorded this as
a founder decision; it is not one.

**THE GOTCHA THAT AFFECTS THE UI, and it is the sharpest thing about this
feature: a fork rewinds the CONVERSATION but NOT the WORKING TREE.** The
sandbox's files stay exactly as the parent left them; only event history
truncates. Unsaid, that reads as a bug — the user rewinds to before a bad edit
and the bad edit is still on disk. Whatever affordance ships has to say so.

Full design, sequence and four gotchas: `docs/fork-conversation-design.md`.
Not implemented; not scheduled.

**`fork_conversation_state` is a LOCAL primitive and the transport is the
caller's job.** Two sandboxes are two containers whose filesystems are not both
mounted anywhere, so it can never be called with a source in sandbox A and a
target in sandbox B. The wrapper is `GET /file/archive` on the source →
extract to a temp tree → the function against two temp trees → archive →
`POST /file/upload` on the target. Note `validate_session_key` refuses a
non-RUNNING sandbox, so the parent's must be started purely to be read from.

**DECIDED 2026-08-08: the UI verb is "Retry from here".**

What other providers do, and why none of their words fit unchanged:

  * ChatGPT and Claude both surface this as EDITING a message, which silently
    creates a branch, with `< 2/3 >` arrows to move between them. The verb is
    "Edit". That works for them because editing is the only way to reach it —
    but our operation does NOT require changing the message, so "Edit" would
    describe the wrong thing.
  * Cursor calls the neighbouring idea "Restore checkpoint". That implies the
    FILES come back, which is exactly what does not happen here.
  * "Fork" and "Branch" are the accurate computer-science words and are both
    wrong IN THIS PRODUCT, because it is a coding agent: a developer reading
    "branch" in a tool that manages git will read it as a git branch. Being
    right about the general concept and wrong about the local one is the worst
    kind of correct.

So: **"Retry from here"**, and where an arrow-pair is needed to move between
attempts, follow ChatGPT's `< 2/3 >` — that pattern is near-universal and
carries no promise about files.

The affordance must ALSO say that files do not rewind. The working tree stays
as the parent left it, so someone who retries past a bad edit still has the bad
edit on disk. One line under the action is enough; unsaid, it reads as a bug.

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

#### Item 20, built 2026-08-08 — and what was deliberately left out

Storage, versions and restore are done and verified end to end. What is NOT
built, and why each was a decision rather than a shortfall:

**Share / auto-publish.** Sharing an artifact means answering three questions
that storage does not depend on: what an unauthenticated reader sees, how a
link is revoked, and whether the HISTORY travels with the document. The third
is the one that bites — history holds every draft the customer thought better
of, so a share that carries it leaks more than the thing being shared. This is
the same class of question as the /mcp identity finding, and adding a `public`
flag now would settle it by accident.

**Print-to-PDF.** Real work, not a decision: needs a rendering path per kind
(markdown, code, html) and it is the only one of the three that is purely
additive. Best next.

**Artifacts that call tools / query the model.** Not attempted. This is the
item's real ceiling and it needs the agent to be able to CREATE artifacts in
the first place — see below.

**THE GAP THAT MATTERS MOST.** Nothing creates artifacts except a customer
using the API directly. There is no "save this as an artifact" affordance in
chat and no way for the agent to emit one. The gallery therefore works and
will be empty for every real account, which is the same failure shape as
scheduled tasks having a model and no runner: a feature that exists and never
fires. The next piece of #20 is a creation path, not more gallery.

Two candidate creation paths, and the tradeoff between them:
  - a chat affordance ("keep this") on an agent message containing a code or
    markdown block. Cheap, needs no agent change, and the customer decides
    what is worth keeping.
  - an agent tool. Better product, but it lets the agent spend the account's
    artifact quota unprompted, and it needs the same "what bounds this" answer
    that memory needed before it could be made agent-writable.

The first does not block the second and is the honest starting point, for the
same reason `nimbus_memory` shipped read/write before it was ever exposed to
the agent: get the storage and the cap right while a human is still the only
writer.
