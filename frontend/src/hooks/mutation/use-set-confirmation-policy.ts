import { useMutation, useQueryClient } from "@tanstack/react-query";
import { setV1ConfirmationPolicy } from "./conversation-mutation-utils";
import { displayErrorToast } from "#/utils/custom-toast-handlers";
import { extractErrorMessage } from "#/utils/extract-error-message";
import i18n from "#/i18n";
import { I18nKey } from "#/i18n/declaration";

/** The SDK's policy class names. See the service method for why these are not
 *  friendlier strings. */
export type ConfirmationPolicyKind =
  | "AlwaysConfirm"
  | "NeverConfirm"
  | "ConfirmRisky";

/**
 * Set how often the agent stops to ask before acting.
 *
 * Applies to the RUNNING conversation, immediately — this is not a setting that
 * takes effect next time. That is the whole point of putting it in the
 * composer: the moment you want to change it is the moment the agent is about
 * to do something you are not sure about.
 *
 * Failure is surfaced as a toast rather than swallowed. A permission control
 * that silently fails to apply is worse than one that is missing, because the
 * user believes the agent is now asking first when it is not.
 */
export const useSetConfirmationPolicy = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (variables: {
      conversationId: string;
      kind: ConfirmationPolicyKind;
    }) => setV1ConfirmationPolicy(variables.conversationId, variables.kind),
    onError: (error) => {
      displayErrorToast(
        extractErrorMessage(
          error,
          i18n.t(I18nKey.PERMISSION_MODE$UPDATE_FAILED),
        ),
      );
    },
    onSettled: (_, __, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["user", "conversation", variables.conversationId],
      });
    },
  });
};
