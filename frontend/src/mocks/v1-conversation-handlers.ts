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

  http.get("/api/v1/app-conversations/search", async () => {
    await delay();
    return HttpResponse.json(page(CONVERSATIONS));
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
];
