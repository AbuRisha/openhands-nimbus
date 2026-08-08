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
