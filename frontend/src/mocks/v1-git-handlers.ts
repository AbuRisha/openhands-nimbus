import { http, HttpResponse } from "msw";

/**
 * Git changes and diffs for `dev:mock`, over the V1 agent-server endpoints.
 *
 * Neither `/api/git/changes` nor `/api/git/diff` was mocked, so the Changes tab
 * 500'd in every dev session. That did two things: it hid the diff viewer —
 * the single largest piece of transcript UI — behind an error state, and it
 * made the tab's error path the only thing anyone ever saw there. The raw
 * "Request failed with status code 500" that used to render was found this way.
 *
 * The file set is chosen to exercise the viewer rather than to look tidy:
 *
 * - UPDATED with a real before/after, so the diff renders additions AND
 *   deletions rather than a wall of green.
 * - ADDED, whose `original` is empty — the case that renders as all-additions
 *   and where an off-by-one in the hunk builder shows up.
 * - DELETED, whose `modified` is empty, which is the mirror case and the one
 *   most likely to divide by zero somewhere.
 *
 * Paths deliberately sit in different directories so the file tree has to group
 * rather than list.
 */

const BEFORE = `export function total(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price;
  }
  return sum;
}
`;

const AFTER = `export function total(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
`;

const NEW_TEST = `import { total } from "./cart";

test("an empty cart costs nothing", () => {
  expect(total([])).toBe(0);
});
`;

const REMOVED = `// Superseded by cart.ts — kept only until the migration landed.
export const legacyTotal = (items) => items.map((i) => i.price).reduce((a, b) => a + b, 0);
`;

const DIFFS: Record<string, { original: string; modified: string }> = {
  "src/cart.ts": { original: BEFORE, modified: AFTER },
  "src/__tests__/cart.test.ts": { original: "", modified: NEW_TEST },
  "src/legacy/total.ts": { original: REMOVED, modified: "" },
};

export const V1_GIT_HANDLERS = [
  http.get("*/api/git/changes", async () =>
    HttpResponse.json([
      { status: "UPDATED", path: "src/cart.ts" },
      { status: "ADDED", path: "src/__tests__/cart.test.ts" },
      { status: "DELETED", path: "src/legacy/total.ts" },
    ]),
  ),

  http.get("*/api/git/diff", async ({ request }) => {
    const path = new URL(request.url).searchParams.get("path") ?? "";
    const diff = DIFFS[path];
    if (!diff) {
      // A 404 rather than an empty diff: an unknown path is a bug in the
      // caller, and returning {original:"",modified:""} would render as a
      // legitimate empty file and hide it.
      return new HttpResponse(null, { status: 404 });
    }
    return HttpResponse.json(diff);
  }),
];
