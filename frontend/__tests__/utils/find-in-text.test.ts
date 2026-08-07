import { describe, it, expect, beforeEach } from "vitest";
import { findRanges } from "#/utils/find-in-text";

const mount = (html: string): HTMLElement => {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  // jsdom leaves offsetParent null for everything, which the visibility filter
  // treats as hidden. Force it truthy so these tests exercise the SEARCH rather
  // than jsdom's lack of layout.
  root.querySelectorAll("*").forEach((el) => {
    Object.defineProperty(el, "offsetParent", {
      value: document.body,
      configurable: true,
    });
  });
  return root;
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("findRanges", () => {
  it("finds a simple match", () => {
    const root = mount("<p>the total helper</p>");
    const ranges = findRanges(root, "total");

    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe("total");
  });

  it("finds every occurrence", () => {
    const root = mount("<p>run the tests, then run them again</p>");
    expect(findRanges(root, "run")).toHaveLength(2);
  });

  it("is case-insensitive", () => {
    const root = mount("<p>Refactor The Billing Reconciler</p>");
    const ranges = findRanges(root, "billing");

    expect(ranges).toHaveLength(1);
    // The RANGE covers the original casing, not the lowercased haystack.
    expect(ranges[0].toString()).toBe("Billing");
  });

  /**
   * The case a per-text-node search silently fails. Inline formatting splits
   * this into three text nodes, so "the total helper" only matches if the
   * search flattens first.
   */
  it("matches across inline element boundaries", () => {
    const root = mount("<p>the <code>total</code> helper</p>");
    const ranges = findRanges(root, "the total helper");

    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe("the total helper");
  });

  it("spans the correct nodes for a cross-node match", () => {
    const root = mount("<p>abc<b>def</b></p>");
    const ranges = findRanges(root, "cd");

    expect(ranges).toHaveLength(1);
    expect(ranges[0].startContainer.textContent).toBe("abc");
    expect(ranges[0].endContainer.textContent).toBe("def");
    expect(ranges[0].toString()).toBe("cd");
  });

  /**
   * A match ending exactly on a node boundary. The end offset is exclusive, so
   * resolving it without the -1 lands in the NEXT node and builds a range that
   * starts after it ends.
   */
  it("handles a match ending on a node boundary", () => {
    const root = mount("<p>abc<b>def</b></p>");
    const ranges = findRanges(root, "abc");

    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe("abc");
  });

  it("counts overlapping occurrences separately", () => {
    const root = mount("<p>aaa</p>");
    // "aa" occurs at 0 and at 1. Both are matches a reader would step through.
    expect(findRanges(root, "aa")).toHaveLength(2);
  });

  it("ignores script and style text", () => {
    const root = mount(
      "<p>visible total</p><script>var total = 1;</script><style>.total{}</style>",
    );
    expect(findRanges(root, "total")).toHaveLength(1);
  });

  it("returns nothing for an empty query", () => {
    const root = mount("<p>anything</p>");
    expect(findRanges(root, "")).toHaveLength(0);
  });

  it("returns nothing for a null root", () => {
    expect(findRanges(null, "x")).toHaveLength(0);
  });

  it("returns nothing when there is no match", () => {
    const root = mount("<p>nothing here</p>");
    expect(findRanges(root, "absent")).toHaveLength(0);
  });

  it("finds matches across sibling blocks", () => {
    const root = mount("<p>first total</p><p>second total</p>");
    expect(findRanges(root, "total")).toHaveLength(2);
  });

  it("preserves document order", () => {
    const root = mount("<p>alpha</p><p>beta</p><p>alpha</p>");
    const ranges = findRanges(root, "alpha");

    expect(ranges).toHaveLength(2);
    // Range 0 must precede range 1 — next/prev navigation depends on it.
    expect(
      ranges[0].compareBoundaryPoints(Range.START_TO_START, ranges[1]),
    ).toBe(-1);
  });
});
