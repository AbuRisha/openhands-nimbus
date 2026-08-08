import React from "react";
import { useLocation, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useForkConversation } from "#/hooks/mutation/use-fork-conversation";
import { I18nKey } from "#/i18n/declaration";

export interface RetryFromHereAction {
  /** Opens the confirmation. Does NOT fire the request. */
  onClick: () => void;
  tooltip: string;
  isDisabled: boolean;
  keepVisible: boolean;
  isPending: boolean;
  /** Warning text for the confirmation, or null when it is not open. */
  confirmationText: string | null;
  confirm: () => void;
  cancel: () => void;
}

/**
 * The per-message "retry from here" action, or null where it must not exist.
 *
 * NAMED "RETRY", NOT "FORK" OR "BRANCH". The API keeps the accurate internal
 * name; the UI cannot use it. This operation rewinds the CONVERSATION and not
 * the WORKING TREE — the sandbox's files stay exactly as the parent left them,
 * and only event history truncates. "Fork" and "branch" both promise a copy of
 * the whole world, files included, and someone holding that expectation reads
 * the unchanged files as a bug rather than as the design.
 *
 * THE CONFIRMATION EXISTS FOR THAT GAP, not as ceremony. `FORK$FILES_UNCHANGED_
 * WARNING` is the one thing a customer cannot infer from the button, and this
 * is the last moment telling them is cheap: afterwards they are in a new
 * conversation whose files disagree with its transcript, with no prompt to
 * explain why. It also guards a real cost — the request starts a sandbox and
 * creates a conversation, which is billable, so a mis-click should not spend
 * money.
 *
 * RETURNS NULL ON THE SHARED ROUTE. `shared/conversations/:conversationId` is
 * served WITHOUT authentication (routes.ts — it sits outside the authed block,
 * under a comment saying so). Offering this to a visitor with no account would
 * either 401 or act against somebody else's conversation. Absence is the
 * correct affordance for a read-only view.
 *
 * `useParams` rather than `useConversationId`, deliberately: that hook THROWS
 * when the param is missing, which would take out the entire transcript render
 * instead of omitting one button. Missing id means "no action", not "crash".
 */
export const useRetryFromHereAction = (
  eventId: string | undefined,
): RetryFromHereAction | null => {
  const { t } = useTranslation();
  const { conversationId } = useParams<{ conversationId: string }>();
  const { pathname } = useLocation();
  const { mutate: fork, isPending } = useForkConversation();

  const [isConfirming, setIsConfirming] = React.useState(false);

  const isSharedView = pathname.startsWith("/shared/");

  const confirm = React.useCallback(() => {
    setIsConfirming(false);
    if (!conversationId || !eventId) return;
    fork({ conversationId, upToEventId: eventId });
  }, [conversationId, eventId, fork]);

  if (!conversationId || !eventId || isSharedView) return null;

  return {
    onClick: () => setIsConfirming(true),
    // The pending label states the DURATION, because the honest answer is
    // "longer than you expect": the request holds until a fresh sandbox is
    // running. A bare "Retrying…" invites a second click at ten seconds.
    tooltip: isPending
      ? t(I18nKey.FORK$RETRYING)
      : t(I18nKey.FORK$RETRY_FROM_HERE),
    isDisabled: isPending,
    keepVisible: isPending,
    isPending,
    confirmationText: isConfirming
      ? t(I18nKey.FORK$FILES_UNCHANGED_WARNING)
      : null,
    confirm,
    cancel: () => setIsConfirming(false),
  };
};
