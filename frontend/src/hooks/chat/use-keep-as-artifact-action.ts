import React from "react";
import { useLocation, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useCreateArtifact } from "#/hooks/mutation/use-artifact-mutations";
import { deriveArtifactFromMessage } from "#/utils/artifact-from-message";
import { displaySuccessToast } from "#/utils/custom-toast-handlers";
import { I18nKey } from "#/i18n/declaration";

export interface KeepAsArtifactAction {
  onClick: () => void;
  tooltip: string;
  isDisabled: boolean;
  keepVisible: boolean;
  isPending: boolean;
  isKept: boolean;
}

/**
 * "Keep this" — turn an agent reply into an artifact.
 *
 * THIS IS THE CREATION PATH THE GALLERY WAS MISSING. Storage, versions and
 * restore all shipped before anything could produce an artifact, which left a
 * feature that works and is empty for every real account — the same shape as a
 * scheduled task with no runner. A customer-driven affordance is the honest
 * starting point: the same order `nimbus_memory` took, where a human was the
 * only writer until the storage and the cap had been proven.
 *
 * AGENT MESSAGES ONLY. Keeping your own prompt as a document is not a thing
 * anyone wants — the value is in what came back. Offering it on both would
 * double the controls on every row to serve a case nobody has.
 *
 * NULL ON THE SHARED ROUTE, for the same reason as retry-from-here:
 * `shared/conversations/:id` is served without authentication, so the button
 * would either 401 or write into whichever account happened to be signed in.
 */
export const useKeepAsArtifactAction = (
  message: string,
  source: string,
): KeepAsArtifactAction | null => {
  const { t } = useTranslation();
  const { conversationId } = useParams<{ conversationId: string }>();
  const { pathname } = useLocation();
  const { mutate: create, isPending } = useCreateArtifact();

  // Local rather than derived from the gallery: the artifact is a COPY, so
  // there is nothing to compare a message against afterwards. This says "you
  // pressed this", which is the only claim that is actually true.
  const [isKept, setIsKept] = React.useState(false);

  const isSharedView = pathname.startsWith("/shared/");

  const handleClick = React.useCallback(() => {
    const derived = deriveArtifactFromMessage(
      message,
      t(I18nKey.ARTIFACTS$UNTITLED),
    );
    create(
      { ...derived, conversation_id: conversationId ?? null },
      {
        onSuccess: () => {
          setIsKept(true);
          displaySuccessToast(t(I18nKey.ARTIFACTS$KEPT));
        },
      },
    );
  }, [message, conversationId, create, t]);

  if (source !== "agent" || !message.trim() || isSharedView) return null;

  return {
    onClick: handleClick,
    tooltip: isKept
      ? t(I18nKey.ARTIFACTS$KEPT)
      : t(I18nKey.ARTIFACTS$KEEP_THIS),
    // Disabled once kept, so a second press cannot make a duplicate the
    // customer then has to find and delete.
    isDisabled: isPending || isKept,
    keepVisible: isPending,
    isPending,
    isKept,
  };
};
