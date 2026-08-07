import React from "react";
import { useTranslation } from "react-i18next";
import PauseIcon from "#/icons/pause.svg?react";
import { I18nKey } from "#/i18n/declaration";
import { useShortcut } from "#/hooks/use-shortcut";
import { ShortcutLayer } from "#/utils/shortcut-registry";

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

  // Escape interrupts the run, at GLOBAL priority — the lowest — so any menu or
  // modal that registers Escape takes it first and this never fires underneath
  // them. That ordering used to be approximated by scanning the DOM for
  // `[role='dialog'], [role='menu']`; the scan is kept below because it also
  // covers surfaces that never registered a shortcut at all, which priority
  // alone cannot see.
  //
  // `allowInInput` is required, not incidental: the composer is a
  // contentEditable that holds focus for the whole time an agent runs, so the
  // registry's default typing guard would suppress the one shortcut whose
  // entire purpose is to fire while you are typing. The narrower "is this some
  // OTHER text field" test stays in `when`.
  useShortcut({ key: "Escape" }, () => handleStop(), {
    priority: ShortcutLayer.GLOBAL,
    allowInInput: true,
    when: (event) => {
      // Something closer to the user already acted on this Escape. The slash
      // menu is a React onKeyDown, not a registry entry, so priority cannot
      // order it — it calls preventDefault without stopping propagation, and
      // without this one press would both close the menu and kill the run.
      if (event.defaultPrevented) return false;

      const active = document.activeElement;

      // The composer is exempt from the is-editing bail below, and that
      // exemption is the entire point of this handler.
      //
      // The composer is a contentEditable div, and it holds focus for
      // essentially the whole time an agent is running — you type, you send,
      // focus stays. So treating "contentEditable" as "a text field the user
      // is editing, leave it alone" meant Escape never once reached
      // handleStop: interrupting by keyboard was silently impossible in the
      // only state where anyone would ever want it.
      const isChatComposer =
        active instanceof HTMLElement &&
        active.closest('[data-testid="chat-input"]') !== null;

      // Any OTHER text field still keeps its Escape.
      const isEditing =
        active instanceof HTMLElement &&
        !isChatComposer &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable);
      if (isEditing) return false;

      return !document.querySelector("[role='dialog'], [role='menu']");
    },
  });

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
