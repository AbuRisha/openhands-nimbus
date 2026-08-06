import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openHands } from "#/api/open-hands-axios";

/**
 * Messages typed while the agent was busy, and not yet delivered.
 *
 * Queuing shipped with a POST and nothing else — no way to read the queue and
 * no way to cancel anything in it. So a message typed during a long turn simply
 * disappeared until it was delivered, and the only mitigation was an optimistic
 * bubble that could show exactly one.
 *
 * This is a SEPARATE list from the optimistic-message store on purpose. That
 * store holds a single string cleared when the real message echoes back, which
 * is a different lifecycle; conflating the two is how the one-message
 * limitation happened in the first place.
 */

export interface PendingMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: { type: string; text?: string }[];
  created_at: string;
}

export const PENDING_MESSAGES_QUERY_KEY = "pending-messages";

export function usePendingMessages(conversationId: string | undefined) {
  return useQuery({
    queryKey: [PENDING_MESSAGES_QUERY_KEY, conversationId],
    queryFn: async (): Promise<PendingMessage[]> => {
      const { data } = await openHands.get<PendingMessage[]>(
        `/api/v1/conversations/${conversationId}/pending-messages`,
      );
      return data;
    },
    enabled: !!conversationId,
    // The queue drains itself the moment the agent becomes ready, and nothing
    // pushes that over the event socket. Polling is how the chips disappear on
    // their own instead of lingering after delivery.
    refetchInterval: 3_000,
    retry: false,
  });
}

export function useCancelPendingMessage(conversationId: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (messageId: string) => {
      await openHands.delete(
        `/api/v1/conversations/${conversationId}/pending-messages/${messageId}`,
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: [PENDING_MESSAGES_QUERY_KEY, conversationId],
      });
    },
    /*
     * No error toast, and that is a decision rather than an omission.
     *
     * The backend answers 204 even when the message is already gone, because
     * the queue drains the instant the agent is ready — so losing that race is
     * the ORDINARY outcome of clicking cancel a fraction too late, not a
     * failure. "This must not be sent" is satisfied either way. Surfacing it as
     * an error would tell someone their cancel failed when the only thing that
     * happened is that they were slightly slow.
     */
    meta: { disableToast: true },
  });
}
