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

/**
 * A REAL 400x260 PNG, inlined.
 *
 * The Browser tab reads `screenshotSrc` from the browser store, which
 * `conversation-websocket-context` sets from `observation.screenshot_data`.
 * A placeholder string like "base64-screenshot-data" satisfies the store and
 * then renders a BROKEN IMAGE — which is worse than the empty state, because
 * it reads as a bug in the panel rather than as an absent fixture. So this is
 * decodable bytes: a chrome bar, a heading block, three text lines and a
 * button, recognisable as a rendered page at a glance.
 */
const SCREENSHOT_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAZAAAAEECAIAAACJKvXOAAADR0lEQVR42u3bvQ1AYBSGUcuIyiI0ao3SFHZS6XTGMAjRSPQ6fzdOciZ483kqN0mzHCCExASAYAEIFiBYAIIFIFiAYAEIFoBgAYIFIFgAggUIFoBgAQgWIFgAggUgWIBgAQgWgGABggUgWACCBQgWgGABCBYQLlhl1QCEIFhAnGAt6wYQgmABggUgWIBgAQgWgGABggUgWACCBQgWgGABCBYgWACCBSBYgGABCBbAk8Gquxle55MWLMFCsBAsECwEC8FCsAQLwUKwQLAQLAQLwRIsBAvBAsFCsBAsBEuwECwECwQLwUKwECzBQrAQLBAsBAvBQrBAsBAsECzBEiwEC8ECwUKwQLAES7AQLP4SLADBAhAsQLAABAsQLCsAggUgWIBgAQgWgGABggUgWACCBQgWgGABCBYgWACCBSBYgGABCBbAc8Hqhwn4FMESLBAswQIES7BAsARLsECwBAsQLMECwRIswQLB8uMogGABggUgWACCBQgWgGABggUgWACCBQgWgGABfClYDk3BibJggWAhWCBYggUIlmCBYAmWYIFgCRYgWIIFgiVYAIIFIFiAYAEIFoBgAYIFIFgAggUIFoBgAQgWIFjnnLDizBjBAsFCsBAsBAsEC8ECwRIswUKwECwQLAQLBEuwAAQLQLAAwQIQLADBAgQLQLAABAsQLADBAhAsQLAABAtAsADBAhAsAMECBAtAsAAECxAsAMECECxAsAAECxAsKwCCBSBYgGAB/CNYRTtyE88UBEuwQLAQLBAswQLBEizBAsFCsECwBAsES7AECwQLwQLBEiwQLMESLBAsBAsES7BAsARLsECwECwQLMECwRIswQLBQrBAsAQLBEuwBAsEC8ECwRIsECzBEiwQLAQLBEuwQLAES7BAsBAsECzBAsFSFsECwRIsLxWuDRaAYAEIFiBYAIIFCJYVAMECECxAsAAEC0CwAMECECwAwQIEC0CwAAQLECwAwQIQLECwAAQLQLAAwQIQLADBAgQLQLAABAsQLADBAhAsQLAABAsQLCsAggUgWIBgAQgWgGABggUgWACCBQgWgGABCBYgWACCBSBYgGABCBaAYAGCBSBYAIIFCBaAYAEIFiBYAIIFcNgBwy7lXoHaUcYAAAAASUVORK5CYII=";

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

  /*
   * A browse, so the Browser TAB can be looked at.
   *
   * KNOWN NOT TO WORK YET — the tab is still empty and this is a partial. What
   * is established, so the next person does not redo it:
   *
   *   1. The event SHAPES are right. Running the real guards
   *      (`isBrowserNavigateActionEvent`, `isBrowserObservationEvent`) against
   *      these exact objects in the browser returns true for both.
   *   2. The context handler DOES run for this fixture. `command-store` ends up
   *      holding "npm test -- cart" and its output, written by branches a few
   *      lines ABOVE the browser branches in the same block of
   *      conversation-websocket-context.
   *   3. The browser setters are NEVER called. Patching
   *      `setUrl`/`setScreenshotSrc` and forcing a fresh socket connection
   *      records zero calls.
   *   4. These events DO reach the app — the transcript renders a
   *      "Browse http://localhost:5173/cart" row.
   *
   * So earlier events in the same burst reach the context handler and later
   * ones reach the event store but not the handler. That is the gap to chase;
   * it is not the fixture shape and not the guards.
   *
   * It rendered EmptyBrowserMessage in every dev session because nothing here
   * ever populated the store, and the store is fed from exactly two event
   * shapes -- see conversation-websocket-context. Both are needed: the
   * navigate action sets the url, the observation sets the screenshot, and
   * with only one of them the panel is still half empty.
   *
   * Same class as the transcript being empty before this file existed: a
   * surface that is correct, and permanently shows its EMPTY state in the one
   * environment anyone reviews UI in.
   */
  action("e9a", "call_browse", {
    kind: "BrowserNavigateAction",
    url: "http://localhost:5173/cart",
  }),
  observation("e9b", "call_browse", "e9a", {
    kind: "BrowserObservation",
    url: "http://localhost:5173/cart",
    screenshot_data: SCREENSHOT_B64,
    output: "Navigated to http://localhost:5173/cart",
    error: null,
    content: [{ type: "text", text: "Navigated to /cart" }],
  }),

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
