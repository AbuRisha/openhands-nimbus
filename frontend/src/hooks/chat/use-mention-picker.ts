import React from "react";
import { useWorkspaceFiles } from "#/hooks/query/use-workspace-files";
import { WorkspaceFile } from "#/api/workspace-service/workspace-service.api";
import { findTriggerWord, replaceTriggerWord } from "#/utils/trigger-word";

const TRIGGER = "@";

/** Cursor offset within a contentEditable, in plain-text characters. */
function getCursorOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return -1;
  const range = selection.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(element);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

/**
 * `@`-mention picker for workspace files.
 *
 * The matching and range arithmetic live in `utils/trigger-word.ts` and are
 * tested without a DOM; what is left here is state, the query, and the
 * keyboard contract.
 *
 * KEYBOARD OWNERSHIP: while open, this owns Up/Down/Enter/Tab/Escape and
 * returns true so the composer stops. That mirrors the slash menu, and it is
 * why `handleMentionKeyDown` must run BEFORE prompt recall — recall also
 * claims Up, and an open menu has the stronger claim.
 */
export const useMentionPicker = (
  chatInputRef: React.RefObject<HTMLDivElement | null>,
) => {
  const [isMenuOpen, setIsMenuOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const rangeRef = React.useRef<{ start: number; end: number } | null>(null);

  const { data, isLoading, isError } = useWorkspaceFiles(query, isMenuOpen);
  const items: WorkspaceFile[] = React.useMemo(
    () => data?.items ?? [],
    [data?.items],
  );

  // Refs so the keydown handler never reads a batched-stale value.
  const isMenuOpenRef = React.useRef(isMenuOpen);
  isMenuOpenRef.current = isMenuOpen;
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  const selectedIndexRef = React.useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;

  React.useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const closeMenu = React.useCallback(() => {
    setIsMenuOpen(false);
    setQuery("");
    setSelectedIndex(0);
    rangeRef.current = null;
  }, []);

  const updateMenu = React.useCallback(() => {
    const element = chatInputRef.current;
    if (!element) return;
    const text = (element.innerText || "").replace(/[\n\r]+$/, "");
    const cursor = getCursorOffset(element);
    const word = findTriggerWord(text, cursor, TRIGGER);

    if (!word) {
      closeMenu();
      return;
    }
    setQuery(word.query);
    rangeRef.current = { start: word.start, end: word.end };
    setIsMenuOpen(true);
  }, [chatInputRef, closeMenu]);

  const selectItem = React.useCallback(
    (file: WorkspaceFile) => {
      const element = chatInputRef.current;
      if (!element) return;
      const range = rangeRef.current;
      if (!range) return;

      const current = (element.innerText || "").replace(/[\n\r]+$/, "");
      const next = replaceTriggerWord(
        current,
        { ...range, query },
        `${TRIGGER}${file.path} `,
      );

      element.textContent = next.text;
      const textNode = element.firstChild;
      if (textNode) {
        const domRange = document.createRange();
        const sel = window.getSelection();
        domRange.setStart(
          textNode,
          Math.min(next.cursor, textNode.textContent?.length ?? 0),
        );
        domRange.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(domRange);
      }

      closeMenu();
      // A native InputEvent so the composer's own onInput runs — autosize,
      // draft saving, and recall reset all hang off it.
      element.dispatchEvent(new Event("input", { bubbles: true }));
    },
    [chatInputRef, closeMenu, query],
  );

  const handleMentionKeyDown = React.useCallback(
    (event: React.KeyboardEvent): boolean => {
      if (!isMenuOpenRef.current) return false;
      const list = itemsRef.current;

      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu();
        return true;
      }
      // Nothing to move through or accept. Escape still closes, above.
      if (list.length === 0) return false;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((i) => (i + 1) % list.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((i) => (i - 1 + list.length) % list.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        // Enter must not send the message while a menu is open.
        event.preventDefault();
        const file = list[selectedIndexRef.current];
        if (file) selectItem(file);
        return true;
      }
      return false;
    },
    [closeMenu, selectItem],
  );

  return {
    isMenuOpen,
    items,
    selectedIndex,
    isLoading,
    isError,
    truncated: data?.truncated ?? false,
    updateMenu,
    selectItem,
    handleMentionKeyDown,
    closeMenu,
  };
};
