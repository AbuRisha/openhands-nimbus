import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";
import { V1_GIT_HANDLERS } from "#/mocks/v1-git-handlers";

/**
 * The dev harness answering at all is the thing under test.
 *
 * `/api/git/changes` and `/api/git/diff` were unmocked, so the Changes tab 500'd
 * in every `dev:mock` session — which hid the diff viewer entirely and made the
 * tab's error path the only state anyone ever saw. Adding handlers is not
 * self-verifying: my first attempt registered them with a leading wildcard segment,
 * which matched nothing, fell through to Vite, and produced the identical 500.
 * The mock looked present and was not.
 *
 * So this asserts the handler RESPONDS, not that the fixture is pretty. A mock
 * that silently fails to match is worse than a missing one, because the file
 * exists and reads as coverage.
 */
const server = setupServer(...V1_GIT_HANDLERS);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = "http://localhost:3015";

describe("v1 git mock handlers", () => {
  it("answers the changes endpoint the Changes tab actually calls", async () => {
    // The real caller appends ?path=..., which must not stop the match.
    const res = await fetch(
      `${BASE}/api/git/changes?path=%2Fworkspace%2Fproject`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; path: string }[];
    // Three DISTINCT statuses on purpose: an all-UPDATED fixture would never
    // exercise the added/deleted rendering paths.
    expect(body.map((c) => c.status).sort()).toEqual([
      "ADDED",
      "DELETED",
      "UPDATED",
    ]);
  });

  it("returns a real before/after for a modified file", async () => {
    const res = await fetch(`${BASE}/api/git/diff?path=src%2Fcart.ts`);

    expect(res.status).toBe(200);
    const diff = (await res.json()) as { original: string; modified: string };
    expect(diff.original).toContain("for (const item of items)");
    expect(diff.modified).toContain("reduce");
    // Both sides non-empty is what makes the viewer render deletions as well
    // as additions.
    expect(diff.original.length).toBeGreaterThan(0);
    expect(diff.modified.length).toBeGreaterThan(0);
  });

  it("gives an added file an empty original, and a deleted file an empty modified", async () => {
    const added = await (
      await fetch(`${BASE}/api/git/diff?path=src%2F__tests__%2Fcart.test.ts`)
    ).json();
    const deleted = await (
      await fetch(`${BASE}/api/git/diff?path=src%2Flegacy%2Ftotal.ts`)
    ).json();

    expect(added.original).toBe("");
    expect(added.modified.length).toBeGreaterThan(0);
    expect(deleted.modified).toBe("");
    expect(deleted.original.length).toBeGreaterThan(0);
  });

  it("404s an unknown path rather than inventing an empty diff", async () => {
    // An empty diff would render as a legitimately unchanged file and hide a
    // caller bug.
    const res = await fetch(`${BASE}/api/git/diff?path=nope.ts`);
    expect(res.status).toBe(404);
  });
});
