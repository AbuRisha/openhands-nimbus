import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useShortcut } from "#/hooks/use-shortcut";
import { ShortcutLayer } from "#/utils/shortcut-registry";
import AngleUpIcon from "#/icons/angle-up-solid.svg?react";
import AngleDownIcon from "#/icons/angle-down-solid.svg?react";
import CloseIcon from "#/icons/close.svg?react";

interface FindInConversationProps {
  isOpen: boolean;
  query: string;
  matchCount: number;
  currentMatch: number;
  onQueryChange: (value: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

/**
 * The find bar. Rendered only while open, which is what makes its Escape
 * registration safe: it cannot outrank the modal or the interrupt shortcut
 * while invisible.
 */
export function FindInConversation({
  isOpen,
  query,
  matchCount,
  currentMatch,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: FindInConversationProps) {
  const { t } = useTranslation();
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // MENU priority so Escape closes the find bar before anything below it. The
  // bar only exists while open, so nothing is shadowed the rest of the time.
  // `allowInInput` is required: focus is IN the find input, and without it the
  // registry's typing guard would swallow the one key that closes the thing.
  useShortcut({ key: "Escape" }, onClose, {
    priority: ShortcutLayer.MENU,
    allowInInput: true,
    when: () => isOpen,
  });

  if (!isOpen) return null;

  const hasQuery = query.length > 0;
  const noMatches = hasQuery && matchCount === 0;

  return (
    <div
      data-testid="find-in-conversation"
      role="search"
      aria-label={t(I18nKey.FIND$IN_CONVERSATION)}
      /*
       * `max-w` and `left-2` matter at 375px and were missing.
       *
       * MEASURED on a phone viewport: the bar rendered 374px wide with its left
       * edge at -204, so the INPUT — the part you type into — sat off the left
       * of the screen while the buttons stayed visible. `right-4` alone anchors
       * to a positioning parent that is not the viewport, so a wide bar grows
       * leftwards out of view.
       *
       * The page itself did NOT overflow, so a `scrollWidth > clientWidth`
       * check on the document reported clean. Element geometry was the only
       * thing that showed it.
       */
      className="absolute top-2 right-4 left-2 sm:left-auto z-50 flex items-center gap-1 rounded-lg border border-[#4B505F] bg-[#25272D] px-2 py-1.5 shadow-lg max-w-[calc(100vw-1rem)]"
    >
      <input
        ref={inputRef}
        type="text"
        data-testid="find-input"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter steps through matches, Shift+Enter goes back — the same
          // contract as the browser's own find bar, so it needs no explaining.
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrevious();
            else onNext();
          }
        }}
        placeholder={t(I18nKey.FIND$PLACEHOLDER)}
        aria-label={t(I18nKey.FIND$PLACEHOLDER)}
        className="w-48 min-w-0 flex-1 sm:flex-none bg-transparent text-sm text-white outline-none placeholder:text-[#8A8F9C]"
      />

      <span
        data-testid="find-count"
        // Announced politely: a count that changes on every keystroke is
        // useful to hear, but not urgent enough to interrupt.
        aria-live="polite"
        className={`shrink-0 text-right text-xs tabular-nums sm:min-w-[4.5rem] ${
          noMatches ? "text-[#F87171]" : "text-[#8A8F9C]"
        }`}
      >
        {hasQuery
          ? t(I18nKey.FIND$MATCH_COUNT, {
              current: currentMatch,
              total: matchCount,
            })
          : ""}
      </span>

      <button
        type="button"
        data-testid="find-previous"
        onClick={onPrevious}
        disabled={matchCount === 0}
        aria-label={t(I18nKey.FIND$PREVIOUS)}
        className="rounded px-1.5 py-0.5 text-sm text-white hover:bg-[#4B505F] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <AngleUpIcon width={14} height={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="find-next"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label={t(I18nKey.FIND$NEXT)}
        className="rounded px-1.5 py-0.5 text-sm text-white hover:bg-[#4B505F] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <AngleDownIcon width={14} height={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="find-close"
        onClick={onClose}
        aria-label={t(I18nKey.FIND$CLOSE)}
        className="rounded px-1.5 py-0.5 text-sm text-white hover:bg-[#4B505F]"
      >
        <CloseIcon width={12} height={12} aria-hidden="true" />
      </button>
    </div>
  );
}
