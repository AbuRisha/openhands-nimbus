import { http, HttpResponse, delay } from "msw";
import type {
  V1AppConversation,
  V1AppConversationPage,
} from "#/api/conversation-service/v1-conversation-service.types";
import { V1ExecutionStatus } from "#/types/v1/core/base/common";

/**
 * V1 conversation mocks, so `dev:mock` can reach the actual product.
 *
 * conversation-handlers.ts only ever covered the V0 routes (`/api/conversations`),
 * and the app has since moved to `/api/v1/app-conversations`. Nothing served
 * those, so Vite proxied them to a backend that is not running in mock mode,
 * every conversation query failed, and `/conversations/:id` bounced straight
 * back to the home screen. The chat — the composer, the transcript, the thing
 * this product IS — could not be looked at without standing up the full Python
 * stack, which is the exact cost the mock exists to remove.
 *
 * These are deliberately thin. They exist to make the UI mount and render, not
 * to simulate the backend: enough shape for the queries to resolve, a RUNNING
 * sandbox so nothing reads as archived, and a stable id so a reload lands in
 * the same place.
 *
 * NOT covered, and worth knowing before trusting a screenshot: the event stream
 * is a websocket, so a mocked conversation opens EMPTY. Composer chrome renders
 * — model chip, tools, context ring, send — and transcript rendering (tool-call
 * rows, diffs) still needs either real events or a websocket fixture.
 */

const NOW = "2026-08-06T00:00:00Z";

const conversation = (
  id: string,
  title: string,
  overrides: Partial<V1AppConversation> = {},
): V1AppConversation => ({
  id,
  created_by_user_id: "mock-user",
  sandbox_id: `sandbox-${id}`,
  selected_repository: null,
  selected_branch: null,
  git_provider: null,
  title,
  trigger: null,
  pr_number: [],
  llm_model: "anthropic/claude-sonnet-5",
  agent_kind: "openhands",
  acp_server: null,
  tags: {},
  metrics: null,
  created_at: NOW,
  updated_at: NOW,
  // RUNNING on purpose: MISSING is what the UI reads as "archived", and a
  // mock that opens every conversation in the archived state would make the
  // resume path the default experience instead of the exception.
  sandbox_status: "RUNNING",
  execution_status: V1ExecutionStatus.IDLE,
  // Derived from the page, not hardcoded. buildWebSocketUrl takes its host
  // from this field, so a hardcoded port meant the app could be served on 3011
  // and still open its event socket against 3010 — silently, with an empty
  // transcript as the only symptom.
  conversation_url: `${window.location.origin}/conversations/${id}`,
  session_api_key: "mock-session-key",
  public: false,
  sub_conversation_ids: [],
  ...overrides,
});

const CONVERSATIONS: V1AppConversation[] = [
  conversation("1", "Refactor the billing reconciler"),
  conversation("2", "Add a preview tab"),
  conversation("3", "Investigate the archiving bug"),
];

const page = (items: V1AppConversation[]): V1AppConversationPage => ({
  items,
  next_page_id: null,
});

export const V1_CONVERSATION_HANDLERS = [
  // Batch fetch. The app calls this with ?ids=a&ids=b to hydrate the
  // conversation it is about to render, and an empty result reads as "gone".
  http.get("/api/v1/app-conversations", async ({ request }) => {
    await delay();
    const ids = new URL(request.url).searchParams.getAll("ids");
    if (ids.length === 0) return HttpResponse.json(page(CONVERSATIONS));
    // A bare ARRAY when ids are supplied, not a page: batchGetAppConversations
    // is typed `(V1AppConversation | null)[]` and reads data[0] directly.
    // Returning {items} here left every lookup undefined, which the
    // conversation route reads as "does not exist" and redirects home — the
    // exact symptom that made the chat unreachable under mocks.
    return HttpResponse.json(
      ids.map(
        (id) =>
          CONVERSATIONS.find((c) => c.id === id) ??
          conversation(id, "Mock conversation"),
      ),
    );
  }),

  http.get("/api/v1/app-conversations/search", async ({ request }) => {
    await delay();
    // Honour title__contains, so searching can actually be checked rather than
    // merely rendered. Case-insensitive on purpose: production is Postgres and
    // the real query uses ilike, so a case-SENSITIVE mock would let a
    // case-sensitivity bug pass here and fail there.
    const q = new URL(request.url).searchParams.get("title__contains");
    if (!q) return HttpResponse.json(page(CONVERSATIONS));
    const needle = q.toLowerCase();
    return HttpResponse.json(
      page(
        CONVERSATIONS.filter((c) =>
          (c.title ?? "").toLowerCase().includes(needle),
        ),
      ),
    );
  }),

  // Start tasks: the sandbox provisioning queue. Reporting an empty list keeps
  // the "still starting…" chrome out of the way of whatever is being looked at.
  http.get("/api/v1/app-conversations/start-tasks/search", async () => {
    await delay();
    return HttpResponse.json({ items: [], next_page_id: null });
  }),

  http.get("/api/v1/app-conversations/:conversationId", async ({ params }) => {
    await delay();
    const found = CONVERSATIONS.find((c) => c.id === params.conversationId);
    // An unknown id gets a conversation rather than a 404, so typing any id
    // into the URL bar lands somewhere useful instead of redirecting home.
    return HttpResponse.json(
      found ?? conversation(String(params.conversationId), "Mock conversation"),
    );
  }),

  http.post("/api/v1/app-conversations", async () => {
    await delay();
    return HttpResponse.json(conversation("1", "New conversation"));
  }),

  // Sandbox specs: unmocked, this 500s and takes the settings screens with it.
  http.get("/api/v1/sandbox-specs/search", async () => {
    await delay();
    return HttpResponse.json({ items: [], next_page_id: null });
  }),

  /*
   * Preview ports and the pending-message queue.
   *
   * Both are served by routers that only exist when the Python app is running,
   * so without these the preview tab can only ever show its "could not check"
   * state and the queue chips can never appear at all — meaning neither piece
   * of UI could be looked at under dev:mock.
   */
  http.get("/preview/:conversationId/ports", async () => {
    await delay();
    return HttpResponse.json({ ports: [5173, 3000], supported: true });
  }),

  http.get(
    "/api/v1/conversations/:conversationId/pending-messages",
    async () => {
      await delay();
      return HttpResponse.json([
        {
          id: "pm-1",
          conversation_id: "1",
          role: "user",
          content: [
            { type: "text", text: "also add a test for the empty cart" },
          ],
          created_at: NOW,
        },
      ]);
    },
  ),

  http.delete(
    "/api/v1/conversations/:conversationId/pending-messages/:messageId",
    async () => {
      await delay();
      // 204 whether or not it was still there: the queue drains the instant the
      // agent is ready, so losing that race is ordinary, not an error.
      return new HttpResponse(null, { status: 204 });
    },
  ),

  /*
   * The catalog, as the deployment seeds it: one profile per Nimbus model,
   * named after the model. Unmocked, the model picker is empty AND the refusal
   * prompt can only ever say "no other model is available" — which is exactly
   * what it said before this existed, and looked like a bug in the feature
   * rather than a gap in the fixture.
   */
  http.get("/api/v1/settings/profiles", async () => {
    await delay();
    const base = "https://api.nimbusapi.net/v1";
    return HttpResponse.json({
      active_profile: "Claude Sonnet 5",
      profiles: [
        {
          name: "Claude Opus 5",
          model: "anthropic/claude-opus-5",
          base_url: base,
          api_key_set: false,
        },
        {
          name: "Claude Sonnet 5",
          model: "anthropic/claude-sonnet-5",
          base_url: base,
          api_key_set: false,
        },
        {
          name: "GPT 5.6 Sol",
          model: "openai/gpt-5.6-sol",
          base_url: base,
          api_key_set: false,
        },
        {
          name: "Gemini 3.5 Flash",
          model: "google/gemini-3.5-flash",
          base_url: base,
          api_key_set: false,
        },
      ],
    });
  }),

  // The browser bridge, so the Paired browsers panel can be LOOKED at.
  //
  // Both states on purpose: one connected browser and one paired-but-closed.
  // Those render different sentences and the whole risk in that component is
  // collapsing them into "pair a browser", which is only correct when the list
  // is empty. A mock with a single connected device would hide that.
  http.get("/bridge/devices", async () =>
    HttpResponse.json({
      devices: [
        {
          device_id: "dev-desktop",
          name: "Chrome on this Mac",
          connected: true,
          paired_at: "2026-08-06T09:15:00Z",
        },
        {
          device_id: "dev-laptop",
          name: "Chrome on the laptop",
          connected: false,
          paired_at: "2026-08-01T18:40:00Z",
        },
      ],
    }),
  ),

  // A code shaped like a real one: 8 chars from the 32-symbol alphabet that
  // excludes 0/1/O/I/L, because this gets read off one screen and typed into
  // another.
  http.post("/bridge/pair/code", async () =>
    HttpResponse.json({ code: "H7K2M9QR", expires_in_seconds: 120 }),
  ),
];
