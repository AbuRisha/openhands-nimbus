import React from "react";
import { useTranslation } from "react-i18next";
import PauseIcon from "#/icons/pause.svg?react";
import { I18nKey } from "#/i18n/declaration";

export interface ChatStopButtonProps {
  handleStop: () => void;
}

/**
 * Stop the running agent.
 *
 * Was a bare pause glyph: no label, no tooltip, no keyboard shortcut, no
 * accessible name. Interrupting a run that is spending money should not be a
 * guess about what an unlabelled icon does — reported as the composer looking
 * unfinished next to Claude Code, which shows "Stop" with Esc beside it.
 *
 * Escape is bound while the button is mounted, and it is only mounted while the
 * agent is actually stoppable (agent-status renders it behind
 * shouldShownAgentStop), so the shortcut cannot fire when there is nothing to
 * interrupt. The listener is removed on unmount, so Escape goes back to the
 * modal/dropdown handlers the moment the run ends.
 */
export function ChatStopButton({ handleStop }: ChatStopButtonProps) {
  const { t } = useTranslation();

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Don't steal Escape from a text field the user is editing, or from an
      // open overlay that needs to close first.
      const active = document.activeElement;
      const isEditing =
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable);
      if (isEditing) return;
      if (document.querySelector("[role='dialog'], [role='menu']")) return;

      event.preventDefault();
      handleStop();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleStop]);

  return (
    <button
      type="button"
      onClick={handleStop}
      data-testid="stop-button"
      aria-label={t(I18nKey.BUTTON$STOP)}
      title={`${t(I18nKey.BUTTON$STOP)} (Esc)`}
      className="cursor-pointer"
    >
      <PauseIcon className="block max-w-none w-4 h-4" />
    </button>
  );
}
