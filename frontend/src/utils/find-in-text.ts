/**
 * Find every occurrence of a query inside a subtree, as DOM Ranges.
 *
 * WHY RANGES AND NOT `<mark>` WRAPPING. The obvious implementation walks text
 * nodes and wraps hits in an element. That mutates a subtree React owns: the
 * next render reconciles against a DOM it did not produce, and the damage lands
 * in exactly the content worth searching — rendered markdown, code blocks, diff
 * tables. Ranges are inert. Paired with the CSS Custom Highlight API the browser
 * paints them without a single node being added, so a highlight cannot corrupt
 * the transcript and cannot be undone by a re-render.
 *
 * WHY A FLATTENED STRING. Inline formatting splits text across nodes: "the
 * `total` helper" is three text nodes, so a per-node search silently fails to
 * match "the total helper". Concatenating first, searching once, then mapping
 * offsets back to (node, offset) pairs makes cross-node matches work — which is
 * most of them in rendered markdown.
 */

interface TextPiece {
  node: Text;
  start: number;
  end: number;
}

/** Elements whose text is real content. SCRIPT/STYLE text is not, and matching
 *  inside them produces highlights the user cannot see and cannot scroll to. */
const SKIPPED = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);

const collectPieces = (root: Node): { text: string; pieces: TextPiece[] } => {
  const pieces: TextPiece[] = [];
  let text = "";

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent || SKIPPED.has(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      // A hidden element's text still lives in the tree. Counting it inflates
      // the match count with hits the user can never be scrolled to.
      if (parent.offsetParent === null && parent.tagName !== "BODY") {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    const value = node.data;
    if (value.length > 0) {
      pieces.push({
        node,
        start: text.length,
        end: text.length + value.length,
      });
      text += value;
    }
    current = walker.nextNode();
  }

  return { text, pieces };
};

/** The piece containing a flattened-string offset. Linear is fine: a
 *  transcript's text nodes number in the thousands, and this runs per match. */
const locate = (pieces: TextPiece[], offset: number): TextPiece | null =>
  pieces.find((piece) => offset >= piece.start && offset < piece.end) ?? null;

export const findRanges = (root: Node | null, query: string): Range[] => {
  if (!root || !query) return [];

  const { text, pieces } = collectPieces(root);
  if (!text) return [];

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const ranges: Range[] = [];

  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;

    const startPiece = locate(pieces, at);
    // `end - 1`, because the end offset is exclusive and a match ending exactly
    // on a node boundary would otherwise resolve to the NEXT node and produce a
    // range that starts after it ends.
    const endPiece = locate(pieces, at + needle.length - 1);

    if (startPiece && endPiece) {
      const range = document.createRange();
      range.setStart(startPiece.node, at - startPiece.start);
      range.setEnd(endPiece.node, at + needle.length - endPiece.start);
      ranges.push(range);
    }

    // Advance by one, not by the match length: overlapping occurrences of a
    // self-overlapping query ("aa" in "aaa") are still two matches to a reader.
    from = at + 1;
  }

  return ranges;
};

/** Feature-detects the CSS Custom Highlight API. Callers fall back to
 *  scroll-only navigation, which is degraded but not broken. */
export const supportsHighlightApi = (): boolean =>
  typeof CSS !== "undefined" &&
  "highlights" in CSS &&
  typeof Highlight !== "undefined";
