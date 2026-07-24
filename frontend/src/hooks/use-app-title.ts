import { useParams } from "react-router";
import { useUserConversation } from "#/hooks/query/use-user-conversation";

const APP_TITLE = "Nimbus Chat";

/**
 * Document title hook — Nimbus-branded shell.
 * - Conversation pages: "Conversation Title | Nimbus Chat"
 * - Everything else: "Nimbus Chat"
 *
 * Historical OpenHands / OpenHands Cloud variants have been dropped;
 * app_mode is no longer surfaced in customer chrome.
 */
export const useAppTitle = () => {
  const { conversationId } = useParams<{ conversationId: string }>();
  const { data: conversation } = useUserConversation(conversationId ?? null);
  const conversationTitle = conversation?.title;

  if (conversationId && conversationTitle) {
    return `${conversationTitle} | ${APP_TITLE}`;
  }

  return APP_TITLE;
};
