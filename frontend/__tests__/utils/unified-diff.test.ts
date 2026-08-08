import { describe, it, expect } from "vitest";
import { buildUnifiedDiff } from "#/utils/unified-diff";

/**
 * The contract: show what changed, stay fast on real files, and never render an
 * empty box.
 *
 * The bug this replaces printed the entire new file for a two-line edit — the
 * one thing a reader wants was the one thing it did not say.
 */

describe("buildUnifiedDiff", () => {
  it("returns null when nothing changed, rather than an empty diff", () => {
    // An empty ```diff block renders as an empty grey box, which reads as a bug.
    expect(buildUnifiedDiff("same\ntext", "same\ntext")).toBeNull();
  });

  it("marks removed and added lines", () => {
    const diff = buildUnifiedDiff("a\nb\nc", "a\nB\nc");

    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
    expect(diff).toContain(" a");
    expect(diff).toContain(" c");
  });

  it("shows a pure addition without inventing a deletion", () => {
    const diff = buildUnifiedDiff("a\nc", "a\nb\nc")!;

    expect(diff).toContain("+b");
    expect(diff.split("\n").some((l) => l.startsWith("-"))).toBe(false);
  });

  it("shows a pure deletion without inventing an addition", () => {
    const diff = buildUnifiedDiff("a\nb\nc", "a\nc")!;

    expect(diff).toContain("-b");
    expect(
      diff.split("\n").some((l) => l.startsWith("+") && !l.startsWith("+++")),
    ).toBe(false);
  });

  it("keeps the diff about the change, not the file", () => {
    // A one-line edit in a 400-line file must not print 400 lines. This is the
    // entire reason the feature exists.
    const before = Array.from({ length: 400 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const after = before.replace("line 200", "line 200 CHANGED");

    const diff = buildUnifiedDiff(before, after)!;
    const lines = diff.split("\n");

    expect(diff).toContain("+line 200 CHANGED");
    expect(diff).toContain("-line 200");
    // 3 lines of context either side, the two changed lines, and an elision
    // marker — nowhere near 400.
    expect(lines.length).toBeLessThan(20);
  });

  it("elides a long unchanged run once, not once per line", () => {
    const before = `head\n${"x\n".repeat(50)}tail`;
    const after = `HEAD\n${"x\n".repeat(50)}TAIL`;

    const diff = buildUnifiedDiff(before, after)!;
    const markers = diff.split("\n").filter((l) => l === "@@ ... @@");

    expect(markers).toHaveLength(1);
  });

  it("includes the path in the header when given one", () => {
    const diff = buildUnifiedDiff("a", "b", { path: "src/foo.ts" })!;

    expect(diff).toContain("--- a/src/foo.ts");
    expect(diff).toContain("+++ b/src/foo.ts");
  });

  it("summarises instead of grinding when both sides are rewritten", () => {
    // The one case where a line-level diff is both expensive AND useless.
    const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join(
      "\n",
    );
    const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join("\n");

    const started = performance.now();
    const diff = buildUnifiedDiff(before, after)!;
    const elapsed = performance.now() - started;

    expect(diff).toContain("rewritten");
    expect(diff).toContain("3000 lines replaced");
    // A naive LCS over 3000x3000 would allocate nine million cells.
    expect(elapsed).toBeLessThan(500);
  });

  it("stays fast on a small edit inside a very large file", () => {
    // Trimming the common head and tail is what makes this possible: the
    // quadratic step only ever sees the region that actually differs.
    const before = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const after = before.replace("line 10000", "line 10000 CHANGED");

    const started = performance.now();
    const diff = buildUnifiedDiff(before, after)!;
    const elapsed = performance.now() - started;

    expect(diff).toContain("+line 10000 CHANGED");
    expect(elapsed).toBeLessThan(500);
  });

  it("handles an empty before (file created)", () => {
    const diff = buildUnifiedDiff("", "a\nb")!;

    expect(diff).toContain("+a");
    expect(diff).toContain("+b");
  });

  it("handles an empty after (file emptied)", () => {
    const diff = buildUnifiedDiff("a\nb", "")!;

    expect(diff).toContain("-a");
    expect(diff).toContain("-b");
  });
});
