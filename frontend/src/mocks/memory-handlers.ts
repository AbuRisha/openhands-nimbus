import { http, HttpResponse } from "msw";

/**
 * The durable per-customer memory document.
 *
 * Mutable module state on purpose: a PUT followed by a GET must return what
 * was stored, or the settings page cannot be reviewed end to end in dev.
 */
export const MOCK_MEMORY = {
  text: "",
  max_chars: 8000,
  used_chars: 0,
};

export const MEMORY_HANDLERS = [
  // The wildcard prefix is load-bearing. A RELATIVE path matches in
  // `setupWorker` -- where it resolves against the page origin -- and matches
  // NOTHING in `setupServer`. The handler then falls through to the real
  // network and the failure looks like a broken endpoint rather than a mock
  // that never matched.
  //
  // Line comments rather than a block: the pattern contains a star followed by
  // a slash, which closes a block comment early.
  http.get("*/api/v1/memory", () => HttpResponse.json(MOCK_MEMORY)),

  http.put("*/api/v1/memory", async ({ request }) => {
    const body = (await request.json()) as { text?: string };
    // Truncate exactly as the server does, and return the STORED value. A mock
    // that echoed the submitted text would hide the one behaviour worth
    // reviewing: that going over the cap silently loses the excess.
    const text = (body?.text ?? "").slice(0, MOCK_MEMORY.max_chars);
    MOCK_MEMORY.text = text;
    MOCK_MEMORY.used_chars = text.length;
    return HttpResponse.json({ ...MOCK_MEMORY });
  }),
];
