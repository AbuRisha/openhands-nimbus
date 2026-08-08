import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { AxiosError } from "axios";
import {
  forkConversation,
  ForkConversationResponse,
} from "#/api/fork-conversation";
import {
  forkErrorKey,
  shouldWarnAboutHalves,
} from "#/utils/fork-error-message";
import { displayErrorToast } from "#/utils/custom-toast-handlers";
import i18n from "#/i18n";
import { I18nKey } from "#/i18n/declaration";

interface RetryFromHereVariables {
  conversationId: string;
  upToEventId: string | null;
}

/**
 * Retry a conversation from a chosen message, and go to the result.
 *
 * THE NAVIGATION IS PART OF THE MUTATION rather than something the caller adds.
 * A new conversation the customer has to go and find in the sidebar reads as
 * "nothing happened" — the point of the action is to continue from an earlier
 * point, which means arriving there.
 *
 * NO OPTIMISTIC ANYTHING, deliberately. This request does not return until the
 * new sandbox is RUNNING and its persistence directory has been written, which
 * is tens of seconds. An optimistic row would put a conversation in the sidebar
 * that does not work yet. The honest UI is a disabled control that says what it
 * is waiting for.
 *
 * ERRORS GO THROUGH `forkErrorKey`, NOT a generic extractor. 404, 409 and 502
 * mean genuinely different things here and only one of them is worth retrying;
 * telling someone whose sandbox is stopped to "try again" produces a loop. The
 * 502 case is the one that matters most — a conversation EXISTS and is
 * incomplete, so the advice is "do not trust it", not "try again".
 */
export const useForkConversation = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation<ForkConversationResponse, Error, RetryFromHereVariables>({
    mutationFn: ({ conversationId, upToEventId }) =>
      forkConversation(conversationId, upToEventId),

    onSuccess: (result) => {
      // The list is paginated and keyed by page and filter, so refetch the
      // family rather than splicing a row into one page.
      queryClient.invalidateQueries({ queryKey: ["user", "conversations"] });

      /*
       * A 200 that describes a broken outcome. Nothing in the error path fires,
       * which is exactly why this needs its own check: the agent's memory and
       * the visible transcript were cut at different points, so the agent will
       * eventually contradict the transcript sitting above it. Unattributable
       * later, cheap to say now.
       *
       * Not fatal — the conversation exists and is navigable — so this warns
       * and still navigates.
       */
      if (shouldWarnAboutHalves(result)) {
        displayErrorToast(i18n.t(I18nKey.FORK$HALVES_DISAGREE));
      }

      navigate(`/conversations/${result.conversation_id}`);
    },

    onError: (error) => {
      const status = (error as AxiosError)?.response?.status;
      displayErrorToast(i18n.t(forkErrorKey(status)));
    },
  });
};
