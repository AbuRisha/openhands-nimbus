# Forking a conversation (#12) — the constraint, and why it is not a blocker

Status: **design settled, not implemented.** Every claim below was read out of the
installed SDK or this repo, not inferred. File:line references are to
`.venv/Lib/site-packages/openhands/` unless the path starts with `openhands/`.

## The thing that kills the obvious design

The roadmap sketch was: start a conversation, `copy_events_until` into it, return
it. That produces a fork whose **transcript renders and whose agent remembers
nothing** — the exact outcome the feature exists to prevent, since the point of
forking is recovering trust after the agent went wrong.

Restoring events into the app-server store is sufficient for display and
insufficient for reasoning, because they are two different stores:

- The **agent's** memory is an `EventLog` rebuilt from a file store on the
  **sandbox's own filesystem**. `agent_server/event_service.py:827` passes
  `persistence_dir=str(self.conversations_dir)`;
  `sdk/conversation/impl/local_conversation.py:321` feeds that to
  `ConversationState.create` as `get_persistence_dir(persistence_dir, desired_id)`,
  with a `LocalWorkspace` assertion above it. Per conversation, local disk.
- The **app-server** store is a downstream display mirror. `save_event` is reached
  in normal operation from exactly one place — the webhook at
  `openhands/app_server/event_callback/webhook_router.py:546`, fed by the agent
  POSTing its event stream. Nothing writes back toward the agent.

So the agent cannot be handed history through the app-server store, and there is
no event-injection endpoint on the agent server to hand it through either
(`conversation_router` exposes start, pause, interrupt, run, goal, goal/stop,
goal/resume, secrets, confirmation_policy, security_analyzer, switch_profile,
switch_llm — that is the whole list). `StartConversationRequest` has no `events`
field.

## Why it is still doable

`ConversationState.create` has a **resume** path. `state.py` 517-529: if
`base_state.json` exists it is loaded, and then

    if state.id != id:
        raise ValueError(f"Conversation ID mismatch: provided {id}, "
                         f"but persisted state has {state.id}")

...after which `EventLog(file_store, dir_path=EVENTS_DIR)` is attached. That id
check is the only thing standing between "point a new conversation at copied
state" and a working fork. It is a one-field JSON edit, not a redesign.

Constants (`sdk/conversation/persistence_const.py`): `BASE_STATE =
"base_state.json"`, `EVENTS_DIR = "events"`.

**And the sandbox filesystem is already reachable.** The agent server ships two
routers the conversation-endpoint inventory above does not include:

    agent_server/bash_router.py   prefix /bash   POST /bash/execute_bash_command
                                                 POST /bash/start_bash_command
    agent_server/file_router.py   prefix /file   POST /file/upload
                                                 GET  /file/download
                                                 GET  /file/archive

The app server already proxies `/api/file` — it is in
`nimbus_auth_gate._EXEMPT_PREFIXES` and authenticates on `X-Session-API-Key` ->
`validate_session_key`, which is a narrower credential than the session cookie,
not a weaker one. So the reach exists and is already classified.

## The sandbox question is answered by the default, not by preference

`SandboxGroupingStrategy` (`openhands/app_server/settings/settings_models.py:608`)
defaults to **`NO_GROUPING` — "each conversation gets its own sandbox."** So a
forked conversation lands on a *different* filesystem from its parent. The
persistence directory must therefore be **transferred**, not shared:
`GET /file/archive` on the source sandbox, `POST /file/upload` into the target.

Same-sandbox copying (a single `cp -r` via `/bash/execute_bash_command`) is only
reachable when the customer has set a grouping strategy, and even then is not
guaranteed to co-locate the parent and the fork. Treat it as an optimisation to
detect, never as the design.

## Sequence

1. Create the fork conversation; obtain `new_id` and its sandbox.
2. Archive `<conversations_dir>/<src_id>/` from the **source** sandbox.
3. Upload it into the **target** sandbox as `<conversations_dir>/<new_id>/`.
4. Rewrite `base_state.json`'s `id` to `new_id`. Skipping this is the
   `ValueError` at `state.py:525`.
5. Truncate `events/` past the fork cutoff.
6. Resume. The resume path now finds a matching id and rebuilds the `EventLog`,
   so the agent genuinely remembers.
7. `copy_events_until` (`openhands/app_server/event/event_service.py:64`) stays
   as the app-server transcript mirror. It was always correct and is still the
   load-bearing half for display.

## Things that will bite

- **`validate_session_key` refuses non-RUNNING sandboxes.** Forking a stopped or
  paused conversation requires starting the parent's sandbox first, purely to
  read its persistence directory. There is no path that reads it cold.
- **A fork does not restore the working tree to the cutoff.** The sandbox's files
  are whatever the parent left them as; only the agent's *event history* is
  truncated. A fork rewinds the conversation, not the filesystem. Say so in the
  UI or it will be read as a bug.
- **Do not ship the frontend affordance before this lands.** An amnesiac fork is
  worse than no fork button, because the failure is silent and only shows up as
  an agent that has inexplicably forgotten the thing you forked to preserve.
- Truncation must cut the `EventLog` on an event boundary consistent with what
  `copy_events_until` used for the mirror, or the transcript and the agent's
  memory will disagree about where the fork happened.

## Transport: the verified API contract

The state copier (`fork_conversation_state`, merged) is a **local filesystem
primitive** — `Path` in, `Path` out. Its `target_conversations_path` parameter
handles a fork landing elsewhere, but only when both paths are visible to one
process, and two sandboxes are two containers whose filesystems are not both
mounted anywhere. So the app server cannot hand it a source in sandbox A and a
target in sandbox B. What is missing is transport around it, not a change to it.

Signatures read out of `agent_server/`, not assumed:

    GET  /file/archive   ?path=<abs dir>&format=tar.gz
                         &use_default_excludes=false
    POST /file/upload    ?path=<abs FILE path>   multipart field: file
    POST /bash/execute_bash_command   body: ExecuteBashRequest -> BashOutput
                                      (runs and waits for the result)

**Two things here will cost you a day if you assume instead of reading.**

1. **`/file/archive` defaults to `format=git-delta`**, which is a *git patch of
   working-tree changes* and requires a git repository. A conversations
   directory is not one. `ArchiveFormat = Literal["git-delta", "tar.gz"]`
   (`file_router.py:153`) — you must pass `format=tar.gz` explicitly. The
   default silently means something completely different, and on a non-git
   directory it fails rather than degrading.
2. **`/file/upload` takes a single FILE, not a directory or an archive to
   expand.** There is no upload-and-extract endpoint. Uploading a forked
   persistence dir file-by-file is hundreds of round trips for a long
   conversation, so upload the tarball as one file and expand it in the target
   with `/bash/execute_bash_command`.

Also pass `use_default_excludes=false`. The built-in excludes target
`node_modules/`, `.venv/`, caches and build outputs — none of which should match
event JSON, but a persistence dir is exactly the wrong place to accept a silent
filter you did not choose.

### Sequence

    1. GET  {source}/file/archive?path=<conversations_dir>/<src_id>
                                 &format=tar.gz&use_default_excludes=false
    2. extract the tarball into a local temp tree            -> temp_src
    3. fork_conversation_state(temp_src, src_id, new_id, cutoff, temp_tgt)
    4. tar.gz temp_tgt/<new_id> locally
    5. POST {target}/file/upload?path=/tmp/fork-<new_id>.tar.gz   (the tarball)
    6. POST {target}/bash/execute_bash_command
            mkdir -p <conversations_dir>
            && tar xzf /tmp/fork-<new_id>.tar.gz -C <conversations_dir>
            && rm /tmp/fork-<new_id>.tar.gz

Step 3 is the merged copier, unchanged, running against two temp trees — the
shape it already supports.

Both calls authenticate the way every other sandbox-scoped call does:
`X-Session-API-Key` resolved through `validate_session_key`, which **refuses
non-RUNNING sandboxes**. So forking a stopped or paused conversation has to start
the parent's sandbox first, purely to read from it. There is no cold path, and
that is a product-visible constraint, not an implementation detail.

## An open decision the sequence above hides

Steps 2-4 have the **app server** pull a customer's conversation state onto its
own host, expand it, and re-archive it. That is a new data-handling surface: on a
multi-tenant deployment, customer conversation content — including whatever the
agent wrote into its own event log — would transit and be briefly materialised on
shared app-server disk, in a temp directory, for every fork. Nothing does that
today. The app-server event store is a mirror of *events*, not of the agent's
private state directory.

That should be a deliberate decision, not a side effect of the easiest wiring.

**The variant that avoids it entirely:** never expand the archive on the app
server. Relay the bytes, and do the mutation inside the target sandbox.

    1. GET  {source}/file/archive?...&format=tar.gz     -> bytes (never expanded)
    2. POST {target}/file/upload?path=/tmp/fork.tar.gz  -> the same bytes
    3. POST {target}/bash/execute_bash_command
           extract, rename the dir to <new_id>, rewrite base_state.json's id,
           delete event files past the cutoff

The app server then handles an opaque blob it never reads. The cost is that the
mutation logic has to be expressed as a shell/one-liner in the sandbox rather
than as the tested Python of `fork_conversation_state`, which trades a
correctness asset for a privacy one — and that function's 13 tests, including the
100,000-event ordering case, are not a small thing to give up.

A third option keeps both: run the archive relay as above, but have the target
sandbox do the mutation by invoking the same logic, if there is ever a supported
way to execute app-server code in a sandbox. There is not one today.

Recommendation: decide this before writing the transport, because it determines
where the tested code runs and it is not a refactor afterwards. If the answer is
"expand on the app server", the temp directory needs an explicit lifetime, a
per-customer path, and cleanup on failure — none of which are implied by the
six-step sequence as written.

## Resolved: the copier runs in the sandbox, so the trade above is void

`fork_state_cli.py` (merged) makes the open decision in the previous section
moot. `fork_conversation_state` imports nothing outside the standard library
except `openhands.sdk.conversation.persistence_const`, and that module is core
SDK — `sdk/conversation/event_store.py` imports it — so it is present in any
sandbox running the agent server. The copier can be uploaded and executed IN the
sandbox, unmodified.

So: the app server never expands customer state, AND the code that runs is the
code that is tested. Neither the shared-disk exposure nor the loss of the
copier's tests is necessary. The temp-directory lifetime question in the previous
section also disappears, because there is no app-server temp directory.

The CLI is proved in its deployment mode, not just imported: its test runs it as a
subprocess from a bare directory holding only the two modules, with `cwd`
deliberately elsewhere.

## What remains, and the honest state of it

The orchestration. Every primitive it needs already exists:

    validate_session_key(key)        -> SandboxInfo         (sandbox/session_auth.py)
    _agent_base_url(sandbox)         -> agent server URL    (sandbox/agent_proxy_router.py:82)

...so for source and target it is base URL plus `X-Session-API-Key` per sandbox,
resolved the same way every other sandbox-scoped call resolves them.

    1. POST {src}/file/upload   fork_conversation_state.py -> /tmp/oh-fork/
    2. POST {src}/file/upload   fork_state_cli.py          -> /tmp/oh-fork/
    3. POST {src}/bash/execute_bash_command
           python /tmp/oh-fork/fork_state_cli.py \
             --conversations-path <conversations_dir> \
             --source-id <src> --target-id <new> \
             [--up-to-event-id <cutoff>] \
             --target-conversations-path /tmp/oh-fork/out
           -> parse {"copied": N} from stdout; non-zero exit is a real failure
    4. GET  {src}/file/archive?path=/tmp/oh-fork/out/<new>
                              &format=tar.gz&use_default_excludes=false
    5. POST {tgt}/file/upload?path=/tmp/oh-fork-in.tar.gz   (the archive bytes)
    6. POST {tgt}/bash/execute_bash_command
           mkdir -p <conversations_dir>
           && tar xzf /tmp/oh-fork-in.tar.gz -C <conversations_dir>
           && rm /tmp/oh-fork-in.tar.gz
    7. POST {src}/bash/execute_bash_command   rm -rf /tmp/oh-fork

**Deliberately not written yet, and the reason matters.** This is HTTP glue whose
correctness depends on how three live endpoints actually behave — multipart field
naming, archive framing, what `BashOutput` carries on a non-zero exit. None of
that can be verified without a RUNNING sandbox, and a running sandbox needs an
authenticated conversation. Tests for it would necessarily be all-mocked, which
proves the shape of the wiring and nothing about whether it works.

An all-mocked transport that passes CI and fails on first contact is worse than
no transport, because it looks finished. Whoever picks this up should write it
against a live sandbox and verify step 3's stdout parsing and step 6's extraction
by hand at least once. The steps above are contract-verified; their composition
is not.

## A tempting shortcut that does not exist

The obvious question is: the app server has an AzureFile share mounted at
`OH_PERSISTENCE_DIR=/data/openhands`, and it contains per-conversation
directories — so can the transport be skipped and the agent's state read straight
off the share?

**No.** Checked on the live share (`nimbusbackups4768`/`openhands-data`).
`<user>/v1_conversations/<conversation_id>/` contains files named
`<event_id>.json`, one per event:

    3823874a59564a98ac102aa7dd6938f7.json      303 bytes
    3d98ba6b5c1840498fe01a1e1ba84a77.json   402249 bytes
    ...

That is the **app-server event mirror** — the same store `copy_events_until`
writes to — keyed by event id. It is not the agent's persistence directory, which
has an entirely different shape: `base_state.json` plus
`events/event-{idx:05d}-{event_id}.json`. Neither of those names appears anywhere
on the share, at any level.

Which also answers the same question from the other side: sandboxes do not mount
this share, because if they did their persistence directories would be visible on
it. They are not.

So the two stores really are distinct and really are on different filesystems, and
the transport is load-bearing rather than incidental. This is worth having written
down because "just read it off the mounted volume" is the first thing anyone will
try, the share genuinely does contain per-conversation directories, and the
directory names are conversation ids in both stores — so a quick look is
misleading rather than merely unhelpful.
