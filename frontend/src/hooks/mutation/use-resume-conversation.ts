import { useMutation, useQueryClient } from "@tanstack/react-query";
import V1ConversationService from "#/api/conversation-service/v1-conversation-service.api";

/**
 * Bring an archived conversation back to life.
 *
 * A conversation reads as "archived and read-only" purely because its sandbox
 * is MISSING, and under RUNTIME=process the sandbox dies with the app
 * container — so an ordinary deploy or replica recycle ended every live
 * conversation permanently. The transcript survived the whole time; only the
 * compute was gone, and nothing in the UI offered to bring it back.
 *
 * Posting the existing conversation id attaches a fresh sandbox to it, so the
 * history stays and the user carries on in the same thread.
 *
 * The invalidations matter as much as the call: agent state, the conversation
 * record and the recents list are all derived from the sandbox, so without
 * clearing them the UI keeps rendering the archived banner over a conversation
 * that is now running.
 */
export const useResumeConversation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["resume-conversation"],
    mutationFn: (conversationId: string) =>
      V1ConversationService.resumeConversation(conversationId),
    onSuccess: async (_data, conversationId) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["user", "conversation", conversationId],
        }),
        queryClient.invalidateQueries({ queryKey: ["user", "conversations"] }),
      ]);
    },
  });
};
