import { setupWorker } from "msw/browser";
import { handlers as wsHandlers } from "./handlers.ws";
import { handlers, resetTestHandlersMockSettings } from "./handlers";
import { V1_CONVERSATION_HANDLERS } from "./v1-conversation-handlers";

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
  ...handlers,
  ...wsHandlers,
);
