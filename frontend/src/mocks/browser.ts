import { setupWorker } from "msw/browser";
import { handlers as wsHandlers } from "./handlers.ws";
import { handlers, resetTestHandlersMockSettings } from "./handlers";
import { seedDevOnlySettings } from "./settings-handlers";
import { V1_CONVERSATION_HANDLERS } from "./v1-conversation-handlers";
import { V1_EVENTS_WS_HANDLERS } from "./v1-events-ws";

/**
 * Seed the browser mock as a CONFIGURED user.
 *
 * Without this, `npm run dev:mock` could not reach the product's main screen at
 * all. The settings store starts empty, `GET /api/v1/settings` answers 404, and
 * the sidebar reads that 404 as "this user has never set up an LLM" and opens
 * the AI Provider Configuration modal over everything. Saving from that modal
 * does not help either — the POST persists, but the gate had already decided.
 *
 * So the only mocked view of the app was its onboarding screen: no chat, no
 * composer, no transcript. Anyone wanting to look at the thing they were
 * building had to stand up the full Python backend, which is exactly the cost
 * the mock exists to remove.
 *
 * Seeding here rather than in the shared default is deliberate: the default has
 * to stay empty because tests assert on the unconfigured path, and
 * `resetTestHandlersMockSettings` is their way of opting into a configured one.
 * This file only runs in the browser worker, so dev gets a usable app and the
 * suite keeps its 404.
 */
resetTestHandlersMockSettings();

/*
 * Dev-only, for the same reason as the seed above: the shared default has to
 * stay minimal because the suite asserts on it.
 *
 * enable_sub_agents is TRUE here because that is what production does —
 * nimbus_settings_store.py:180 turns it on for every new account, while the SDK
 * default is off. A dev harness showing it disabled displays the opposite of
 * what every real customer sees on first login, and gates the whole sub-agent
 * surface out of review.
 *
 * mcp_config carries two servers of DIFFERENT transports because
 * mcp-settings.tsx concatenates sse/stdio/shttp with per-type field mapping; a
 * single-transport fixture leaves two of the three branches unexercised. Empty
 * meant the Extensions page rendered "No servers configured" in every session.
 */
seedDevOnlySettings({
  agent_settings: {
    enable_sub_agents: true,
    mcp_config: {
      sse_servers: [],
      stdio_servers: [
        {
          name: "filesystem",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
          env: {},
        },
      ],
      shttp_servers: [
        { url: "https://mcp.example.com/shttp", api_key: null, timeout: 30 },
      ],
    },
  },
} as never);

/*
 * The V1 conversation handlers are wired in HERE and not into the shared
 * `handlers` array, for the same reason the seed above is: that array backs the
 * vitest server too, and adding routes to it changed the behaviour of settings
 * tests that had nothing to do with conversations. Dev needs a browsable app;
 * the suite needs the fixtures it already asserts against.
 *
 * First in the list so they win over the V0 conversation handlers, which MSW
 * would otherwise match first for overlapping paths.
 */
export const worker = setupWorker(
  ...V1_CONVERSATION_HANDLERS,
  ...V1_EVENTS_WS_HANDLERS,
  ...handlers,
  ...wsHandlers,
);
