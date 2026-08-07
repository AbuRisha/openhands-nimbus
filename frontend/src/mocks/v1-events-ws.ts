import { ws, WebSocketHandler } from "msw";

/**
 * A transcript for `dev:mock`, over the V1 event socket.
 *
 * The existing websocket fixture speaks socket.io on `/socket.io`, which is the
 * V0 transport. V1 opens a RAW WebSocket at `/sockets/events/{conversationId}`
 * (see utils/websocket-url.ts), so nothing was ever mocked there and a
 * conversation opened empty no matter what the REST handlers returned.
 *
 * The events below are chosen to exercise the parts of the transcript that are
 * easy to get wrong and impossible to check from a unit test: an action paired
 * with its observation (one collapsed row, not two), a file edit (which must
 * render as a diff rather than as the whole file), and prose either side of the
 * machinery (which must stay visible rather than being folded away).
 *
 * Not a backend simulation. Nothing here responds to what the user types; it is
 * a fixture for looking at rendering.
 */

const AT = "2026-08-06T00:00:00Z";

const userMessage = (id: string, text: string) => ({
  id,
  timestamp: AT,
  source: "user",
  kind: "MessageEvent",
  llm_message: { role: "user", content: [{ type: "text", text }] },
  activated_microagents: [],
  extended_content: [],
});

const assistantMessage = (id: string, text: string) => ({
  id,
  timestamp: AT,
  source: "agent",
  kind: "MessageEvent",
  llm_message: { role: "assistant", content: [{ type: "text", text }] },
  activated_microagents: [],
  extended_content: [],
});

/** An action and its observation share a tool_call_id — that is the pairing key. */
const action = (id: string, callId: string, act: Record<string, unknown>) => ({
  id,
  timestamp: AT,
  source: "agent",
  kind: "ActionEvent",
  thought: [],
  reasoning_content: null,
  thinking_blocks: [],
  action: act,
  tool_name: String(act.kind ?? "tool"),
  tool_call_id: callId,
  llm_response_id: `resp-${id}`,
});

const observation = (
  id: string,
  callId: string,
  actionId: string,
  obs: Record<string, unknown>,
) => ({
  id,
  timestamp: AT,
  source: "environment",
  kind: "ObservationEvent",
  observation: obs,
  action_id: actionId,
  tool_name: String(obs.kind ?? "tool"),
  tool_call_id: callId,
});

const BEFORE = `export function total(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}`;

const AFTER = `export function total(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}`;

const TRANSCRIPT: unknown[] = [
  userMessage("e1", "Tidy up the total() helper and run the tests."),
  assistantMessage(
    "e2",
    "I'll read the file first, then simplify the loop into a reduce.",
  ),

  // A read: one row, "Read src/cart.ts".
  action("e3", "call_read", {
    kind: "FileEditorAction",
    command: "view",
    path: "src/cart.ts",
  }),
  observation("e4", "call_read", "e3", {
    kind: "FileEditorObservation",
    command: "view",
    path: "src/cart.ts",
    output: BEFORE,
    error: null,
    content: [{ type: "text", text: BEFORE }],
  }),

  // An edit: must render as a DIFF, not as the whole new file.
  action("e5", "call_edit", {
    kind: "StrReplaceEditorAction",
    command: "str_replace",
    path: "src/cart.ts",
  }),
  observation("e6", "call_edit", "e5", {
    kind: "StrReplaceEditorObservation",
    command: "str_replace",
    path: "src/cart.ts",
    old_content: BEFORE,
    new_content: AFTER,
    output: "edited",
    error: null,
    content: [],
  }),

  // A command, so the row summary shows the command rather than the tool name.
  action("e7", "call_bash", {
    kind: "ExecuteBashAction",
    command: "npm test -- cart",
  }),
  observation("e8", "call_bash", "e7", {
    kind: "ExecuteBashObservation",
    command: "npm test -- cart",
    output: "PASS  src/cart.test.ts\n\nTests: 4 passed, 4 total",
    error: null,
    exit_code: 0,
    // getObservationResult reads observation.metadata.exit_code unconditionally
    // once exit_code is absent from the top level, so a bash observation
    // without metadata crashes the whole transcript rather than that one row.
    metadata: {
      exit_code: 0,
      working_dir: "/workspace",
      py_interpreter_path: null,
      prefix: "",
      suffix: "",
    },
    content: [
      { type: "text", text: "PASS  src/cart.test.ts\n\n4 passed, 4 total" },
    ],
  }),

  assistantMessage(
    "e9",
    "Replaced the loop with `reduce` and the four cart tests still pass.",
  ),

  // A refusal, so the failover prompt can actually be looked at. Short on
  // purpose: looksLikeRefusal has a length ceiling, because a long message
  // containing the same phrase is an answer that happens to open with one.
  // A condensation, so the divider can be looked at. Until this branch existed
  // these events arrived over the socket and were dropped one line from being
  // rendered, so nothing in the app could show one.
  {
    id: "e9b",
    timestamp: AT,
    source: "environment",
    // The SDK WIRE value: `kind` is the Python class name, and the class is
    // `Condensation` -- NOT the TS interface name `CondensationEvent`.
    kind: "Condensation",
    forgotten_event_ids: ["e1", "e2", "e3"],
    summary:
      "The user asked to tidy total(); the loop became a reduce and four cart tests passed.",
  },

  userMessage("e10", "now do the other thing"),
  assistantMessage("e11", "I can't help with that."),
];

/**
 * MSW matches the socket URL, and the app derives it from the mocked
 * conversation's `conversation_url` — so this has to track the host the dev
 * server actually runs on rather than a hardcoded one.
 */
const events = ws.link(`ws://${window?.location.host}/sockets/events/*`);

export const V1_EVENTS_WS_HANDLERS: WebSocketHandler[] = [
  events.addEventListener("connection", ({ client }) => {
    /*
     * Deferred a tick, and replayed on EVERY connection.
     *
     * Sending synchronously inside the connection handler raced the app: the
     * frames went out before it had finished attaching its own onmessage
     * listener, so the transcript rendered once and then came back empty after
     * any reconnect — which made the diff rendering impossible to look at,
     * because expanding a row takes longer than the next reconnect.
     *
     * The handler already fires per connection, so replay was never the missing
     * part. The ordering was.
     */
    setTimeout(() => {
      /*
       * MEASURED, so the timing question is closed: instrumenting this to log
       * `readyState` at fire time reported OPEN (1), twice — once per
       * connection. The deferral is sufficient and replay does happen.
       *
       * The probe is removed rather than left in place: it answered its
       * question, MSW's client type does not expose `.socket`, and keeping a
       * cast in a fixture to re-answer something already known is worse than
       * the comment. If the transcript is empty, it is NOT this — see
       * docs/current-task.md, which points at the app's connection state
       * machine instead.
       */
      // Individual frames, which is what the real socket does: the reducer
      // appends per event, and delivering one array would exercise a path
      // production never takes.
      TRANSCRIPT.forEach((event) => client.send(JSON.stringify(event)));
    }, 0);
  }),
];
