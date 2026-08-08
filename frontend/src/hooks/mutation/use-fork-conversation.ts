import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { AxiosError } from "axios";
import {
  forkConversation,
  ForkConversationResponse,
} from "#/api/fork-conversation";
import { forkErrorKey } from "#/utils/fork-error-message";
import { displayErrorToast } from "#/utils/custom-toast-handlers";
import i18n from "#/i18n";

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
       * `halves_agree` IS NOT SHOWN TO THE CUSTOMER, and this is deliberate
       * after shipping the opposite and being wrong.
       *
       * I originally surfaced `halves_agree === false` as an error toast
       * reading "do not trust this conversation", reasoning that a 200 can
       * describe a broken outcome. Another session then ran forks against
       * production and reported the toast on EVERY SUCCESSFUL FORK. They were
       * right, and the reason is that the flag compares two counts that are
       * not comparable:
       *
       *   events_in_agent_state  counts FILES copied out of the sandbox's
       *                          SDK EventLog directory
       *                          (fork_conversation_state.py:194-200)
       *   events_in_transcript   counts events yielded by the app server's
       *                          own mirror, iter_events_for_export
       *                          (event_service.py:38-41)
       *
       * Those are different stores holding different things. There is no
       * reason for the counts to be equal even when BOTH copies are complete
       * and correct, so `in_state == in_transcript` is false almost always and
       * carries no information about whether this particular fork is sound.
       *
       * A warning that fires on every success is worse than no warning: it
       * trains people to dismiss it, so the day it means something nobody
       * reads it. Removed rather than softened.
       *
       * TO MAKE IT MEAN SOMETHING the server has to compare like with like —
       * either count the same store twice, or resolve the cutoff in both id
       * spaces and report whether the cutoff was FOUND on each side. The
       * second is the useful signal, because "the cutoff id did not match any
       * agent event" is exactly the failure that silently copies full memory
       * against a truncated transcript. `shouldWarnAboutHalves` is left in
       * fork-error-message.ts, unused, until that lands.
       */
      navigate(`/conversations/${result.conversation_id}`);
    },

    onError: (error) => {
      const status = (error as AxiosError)?.response?.status;
      displayErrorToast(i18n.t(forkErrorKey(status)));
    },
  });
};
