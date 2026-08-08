import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";
import { ContextMenu } from "#/ui/context-menu";
import { ContextMenuListItem } from "../context-menu/context-menu-list-item";
import { useClickOutsideElement } from "#/hooks/use-click-outside-element";
import { useConversationId } from "#/hooks/use-conversation-id";
import { useSettings } from "#/hooks/query/use-settings";
import { usePermissionModeStore } from "#/stores/permission-mode-store";
import {
  useSetConfirmationPolicy,
  type ConfirmationPolicyKind,
} from "#/hooks/mutation/use-set-confirmation-policy";
import { useShortcut } from "#/hooks/use-shortcut";
import { ShortcutLayer } from "#/utils/shortcut-registry";
import LockIcon from "#/icons/lock.svg?react";
import ChevronDownSmallIcon from "#/icons/chevron-down-small.svg?react";
import CheckIcon from "#/icons/checkmark.svg?react";

const MODES: {
  kind: ConfirmationPolicyKind;
  label: I18nKey;
  description: I18nKey;
}[] = [
  {
    kind: "NeverConfirm",
    label: I18nKey.PERMISSION_MODE$NEVER,
    description: I18nKey.PERMISSION_MODE$NEVER_DESC,
  },
  {
    kind: "ConfirmRisky",
    label: I18nKey.PERMISSION_MODE$RISKY,
    description: I18nKey.PERMISSION_MODE$RISKY_DESC,
  },
  {
    kind: "AlwaysConfirm",
    label: I18nKey.PERMISSION_MODE$ALWAYS,
    description: I18nKey.PERMISSION_MODE$ALWAYS_DESC,
  },
];

/**
 * Derive the mode the conversation STARTED with, the same way the server does.
 *
 * `_select_confirmation_policy` (app_conversation_service_base.py:676) maps a
 * boolean and an analyzer string onto the three policies. Mirroring it here is
 * what lets the button show the truth before the user has chosen anything —
 * inventing a default instead would show "never ask" to someone whose
 * conversation actually confirms every action.
 */
export const deriveModeFromSettings = (
  confirmationMode: boolean | undefined,
  securityAnalyzer: string | null | undefined,
): ConfirmationPolicyKind => {
  if (!confirmationMode) return "NeverConfirm";
  if ((securityAnalyzer || "").toLowerCase() === "llm") return "ConfirmRisky";
  return "AlwaysConfirm";
};

/**
 * How often the agent stops to ask before acting.
 *
 * The three modes are real SDK policies (AlwaysConfirm / NeverConfirm /
 * ConfirmRisky) and the endpoint has always been reachable from the browser.
 * What was missing was any way to CHOOSE one: the policy was derived from a
 * boolean plus an analyzer string on a settings page called "Verification", so
 * "ask me before risky actions" required knowing it meant two coupled fields.
 *
 * It belongs in the composer because the moment you want to change it is the
 * moment the agent is about to do something you are unsure about — not a
 * moment you would go to settings for.
 */
export function PermissionModeButton() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = React.useState(false);
  const { conversationId } = useConversationId();
  const { data: settings } = useSettings();
  const { mutate: setPolicy, isPending } = useSetConfirmationPolicy();

  const chosen = usePermissionModeStore((s) =>
    conversationId ? s.chosenByConversation[conversationId] : undefined,
  );
  const setChosen = usePermissionModeStore((s) => s.setChosen);

  const active =
    chosen ??
    deriveModeFromSettings(
      settings?.confirmation_mode,
      settings?.security_analyzer,
    );

  const menuRef = useClickOutsideElement<HTMLUListElement>(() =>
    setIsOpen(false),
  );

  // MENU priority, so Escape closes this before any modal behind it. Only
  // registered while open — see the shortcut registry.
  useShortcut({ key: "Escape" }, () => setIsOpen(false), {
    priority: ShortcutLayer.MENU,
    allowInInput: true,
    when: () => isOpen,
  });

  if (!conversationId) return null;

  const activeMode = MODES.find((m) => m.kind === active) ?? MODES[0];

  const choose = (kind: ConfirmationPolicyKind) => {
    setIsOpen(false);
    if (kind === active) return;
    // Optimistic: the pill reflects the choice immediately, and a failure
    // toasts rather than silently reverting. A permission control that lies
    // about its own state is worse than one that is missing.
    setChosen(conversationId, kind);
    setPolicy({ conversationId, kind });
  };

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="permission-mode-button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsOpen((o) => !o);
        }}
        disabled={isPending}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={t(I18nKey.PERMISSION_MODE$LABEL)}
        className="flex items-center gap-1 border border-[#4B505F] rounded-[100px] transition-opacity cursor-pointer hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed pl-2"
      >
        <LockIcon width={16} height={16} color="#ffffff" />
        <span className="text-white text-2.75 not-italic font-normal leading-5 whitespace-nowrap">
          {t(activeMode.label)}
        </span>
        <ChevronDownSmallIcon width={24} height={24} color="#ffffff" />
      </button>

      {isOpen && (
        <ContextMenu
          ref={menuRef}
          testId="permission-mode-menu"
          position="top"
          alignment="left"
          className="left-0 mb-2 bottom-full min-w-[280px]"
        >
          {MODES.map((mode) => {
            const isActive = mode.kind === active;
            return (
              <ContextMenuListItem
                key={mode.kind}
                testId={`permission-mode-option-${mode.kind}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  choose(mode.kind);
                }}
                className="cursor-pointer p-0 h-auto hover:bg-transparent"
              >
                <div
                  className={cn(
                    "flex items-start justify-between gap-2 p-2 rounded w-full",
                    isActive ? "bg-[#5C5D62]" : "hover:bg-[#5C5D62]",
                  )}
                >
                  <div className="flex flex-col gap-0.5 text-left">
                    <span className="text-sm text-white">{t(mode.label)}</span>
                    <span className="text-xs text-[#A9B0C0]">
                      {t(mode.description)}
                    </span>
                  </div>
                  {isActive && (
                    <CheckIcon
                      width={14}
                      height={14}
                      className="shrink-0 mt-1"
                    />
                  )}
                </div>
              </ContextMenuListItem>
            );
          })}
        </ContextMenu>
      )}
    </div>
  );
}
