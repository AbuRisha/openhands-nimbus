import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { WorkspaceFile } from "#/api/workspace-service/workspace-service.api";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

interface MentionFileMenuProps {
  items: WorkspaceFile[];
  selectedIndex: number;
  isLoading: boolean;
  isError: boolean;
  truncated: boolean;
  onSelect?: (file: WorkspaceFile) => void;
}

/**
 * Workspace files offered for an `@` mention.
 *
 * Three states are deliberately distinct, because collapsing them is how a
 * picker lies: LOADING (still asking), ERROR (could not ask — the sandbox may
 * be stopped), and EMPTY (asked, nothing matched). Showing "no files" while a
 * request is in flight tells the user their file does not exist.
 */
export function MentionFileMenu({
  items,
  selectedIndex,
  isLoading,
  isError,
  truncated,
  onSelect,
}: MentionFileMenuProps) {
  const { t } = useTranslation();
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  // Keep the highlighted row in view when arrowing past the fold.
  // Called optionally: jsdom does not implement scrollIntoView, and this is
  // a nicety rather than behaviour — the alternative was adding another
  // global stub to the shared vitest setup, which this repo has already been
  // bitten by (it broke unrelated settings tests).
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <div
      data-testid="mention-file-menu"
      role="listbox"
      aria-label={t(I18nKey.WORKSPACE$FILES)}
      className="absolute bottom-full left-0 mb-2 w-full max-h-64 overflow-y-auto rounded-lg border border-[rgba(139,92,246,0.28)] bg-[#111318] shadow-lg z-20"
    >
      {isError && (
        <div
          className="px-3 py-2 text-sm text-[#ff8a8f]"
          data-testid="mention-file-menu-error"
        >
          {t(I18nKey.WORKSPACE$FILES_UNAVAILABLE)}
        </div>
      )}

      {!isError && isLoading && items.length === 0 && (
        <div
          className="px-3 py-2 text-sm opacity-70"
          data-testid="mention-file-menu-loading"
        >
          {t(I18nKey.WORKSPACE$FILES_LOADING)}
        </div>
      )}

      {!isError && !isLoading && items.length === 0 && (
        <div
          className="px-3 py-2 text-sm opacity-70"
          data-testid="mention-file-menu-empty"
        >
          {t(I18nKey.WORKSPACE$FILES_NO_MATCH)}
        </div>
      )}

      {items.map((file, index) => (
        <button
          key={file.path}
          type="button"
          ref={index === selectedIndex ? selectedRef : undefined}
          role="option"
          aria-selected={index === selectedIndex}
          // Pointer-down rather than click: the composer's blur handler closes
          // this menu, and blur lands first on a click.
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect?.(file);
          }}
          className={cn(
            "w-full text-left px-3 py-2 flex flex-col gap-0.5 cursor-pointer",
            index === selectedIndex ? "bg-[#2a2f3a]" : "hover:bg-[#1c202a]",
          )}
        >
          <span className="text-sm truncate">{file.name}</span>
          <span className="text-xs opacity-60 truncate">{file.path}</span>
        </button>
      ))}

      {truncated && (
        <div
          className="px-3 py-1.5 text-xs opacity-60 border-t border-[rgba(139,92,246,0.18)]"
          data-testid="mention-file-menu-truncated"
        >
          {t(I18nKey.WORKSPACE$FILES_TRUNCATED)}
        </div>
      )}
    </div>
  );
}
