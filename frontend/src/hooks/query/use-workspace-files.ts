import { useQuery, keepPreviousData } from "@tanstack/react-query";
import WorkspaceService from "#/api/workspace-service/workspace-service.api";
import { useConversationId } from "../use-conversation-id";

/**
 * Files in the conversation's workspace, filtered server-side.
 *
 * Server-side rather than fetching once and filtering in the browser: a
 * monorepo's path list is large enough that shipping it to filter three
 * characters is the wrong trade, and the endpoint already caps the listing
 * inside the sandbox for the same reason.
 */
export const useWorkspaceFiles = (query: string, enabled: boolean) => {
  const { conversationId } = useConversationId();

  return useQuery({
    queryKey: ["conversation", conversationId, "workspace-files", query],
    queryFn: ({ signal }) => {
      if (!conversationId) throw new Error("No conversation ID provided");
      return WorkspaceService.searchFiles(conversationId, query, 50, signal);
    },
    enabled: enabled && !!conversationId,
    // Keep the previous matches visible while the next query resolves.
    // Without it the menu empties between keystrokes, which reads as "no
    // such file" at exactly the moment the user is still typing its name.
    placeholderData: keepPreviousData,
    staleTime: 1000 * 30,
    // A workspace listing is not worth retrying into a picker: by the time a
    // retry lands the user has typed something else.
    retry: false,
  });
};
