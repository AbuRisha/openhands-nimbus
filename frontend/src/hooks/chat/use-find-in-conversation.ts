import React from "react";
import { findRanges, supportsHighlightApi } from "#/utils/find-in-text";

const ALL = "nimbus-find";
const CURRENT = "nimbus-find-current";

/**
 * Find-in-conversation state: the query, the matches, and which one is active.
 *
 * Highlighting goes through the CSS Custom Highlight API, so NOTHING is added
 * to the DOM — see `find-in-text.ts` for why that matters in a subtree React
 * owns. Two highlight registrations rather than one, because "all matches" and
 * "the one you are looking at" have to be visually distinct or next/prev gives
 * no feedback.
 */
export function useFindInConversation(
  scrollRef: React.RefObject<HTMLElement | null>,
  deps: readonly unknown[] = [],
) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [matches, setMatches] = React.useState<Range[]>([]);
  const [index, setIndex] = React.useState(0);

  // Recompute when the query changes OR when the transcript does — a match
  // found before new events arrived can point at a detached node.
  React.useEffect(() => {
    if (!isOpen || !query) {
      setMatches([]);
      setIndex(0);
      return;
    }
    const found = findRanges(scrollRef.current, query);
    setMatches(found);
    // Clamp rather than reset: typing another character usually keeps you near
    // the same place, and jumping back to match 1 on every keystroke makes the
    // box unusable.
    setIndex((prev) =>
      found.length === 0 ? 0 : Math.min(prev, found.length - 1),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, query, scrollRef, ...deps]);

  // Paint. Runs on every match/index change, and clears on close.
  React.useEffect(() => {
    if (!supportsHighlightApi()) return undefined;

    const { highlights } = CSS as unknown as {
      highlights: Map<string, unknown>;
    };

    if (!isOpen || matches.length === 0) {
      highlights.delete(ALL);
      highlights.delete(CURRENT);
      return undefined;
    }

    const current = matches[index];
    // The active match is excluded from the "all" set. Registering it in both
    // makes the two ::highlight rules fight, and which one wins is a paint
    // detail rather than something the CSS states.
    const rest = matches.filter((_, i) => i !== index);

    highlights.set(ALL, new Highlight(...rest));
    if (current) highlights.set(CURRENT, new Highlight(current));

    return () => {
      highlights.delete(ALL);
      highlights.delete(CURRENT);
    };
  }, [isOpen, matches, index]);

  // Scroll the active match into view.
  React.useEffect(() => {
    const current = matches[index];
    if (!isOpen || !current) return;

    // A Range has no scrollIntoView. Its container's ELEMENT does, and for a
    // text node that means the parent — scrolling the text node itself is a
    // no-op that looks like broken navigation.
    const node = current.startContainer;
    const element =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [isOpen, matches, index]);

  const open = React.useCallback(() => setIsOpen(true), []);

  const close = React.useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setMatches([]);
    setIndex(0);
  }, []);

  // Wrapping rather than stopping at the ends: a find box that goes dead at the
  // last match reads as broken, and wrap-around is what every other find does.
  const next = React.useCallback(() => {
    setIndex((prev) =>
      matches.length === 0 ? 0 : (prev + 1) % matches.length,
    );
  }, [matches.length]);

  const previous = React.useCallback(() => {
    setIndex((prev) =>
      matches.length === 0 ? 0 : (prev - 1 + matches.length) % matches.length,
    );
  }, [matches.length]);

  return {
    isOpen,
    open,
    close,
    query,
    setQuery,
    matchCount: matches.length,
    // 1-based for display. "0 of 0" for no matches reads correctly; "1 of 0"
    // does not.
    currentMatch: matches.length === 0 ? 0 : index + 1,
    next,
    previous,
  };
}
