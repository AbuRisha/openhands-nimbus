import { openHands } from "./open-hands-axios";

export interface ForkConversationResponse {
  conversation_id: string;
  sandbox_id: string | null;
  events_in_agent_state: number;
  events_in_transcript: number;
  /**
   * False means the agent state and the transcript were cut at DIFFERENT
   * points. The backend calls this impossible and surfaces it rather than
   * hiding it, so the UI must too — a fork whose agent remembers a different
   * amount than the transcript shows is the exact failure the two-halves design
   * exists to prevent, and it would otherwise look like a working fork.
   */
  halves_agree: boolean;
}

/**
 * Retry a conversation from a chosen message.
 *
 * NOT CALLED "FORK" IN THE UI, deliberately. The operation rewinds the
 * CONVERSATION and NOT the working tree: the sandbox's files stay exactly as
 * the parent left them, and only event history truncates. Someone reading
 * "fork" expects a branch of the whole world, files included, and would read
 * the unchanged files as a bug. The API keeps the accurate internal name.
 *
 * `up_to_event_id` is INCLUSIVE — the last event KEPT, matching both
 * `copy_events_until` and `fork_conversation_state`.
 */
export const forkConversation = async (
  conversationId: string,
  upToEventId: string | null,
): Promise<ForkConversationResponse> => {
  const { data } = await openHands.post<ForkConversationResponse>(
    `/api/v1/app-conversations/${conversationId}/fork`,
    { up_to_event_id: upToEventId },
  );
  return data;
};
