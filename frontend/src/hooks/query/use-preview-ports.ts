import { useQuery } from "@tanstack/react-query";
import { openHands } from "#/api/open-hands-axios";

/**
 * Which ports this conversation currently has something listening on.
 *
 * The backend reports what is ACTUALLY bound rather than parsing package.json,
 * which is the right call for our runtime: the sandbox is a child of the app
 * container, so we can look instead of guess. A dev server that failed to start
 * simply is not in the list, which is the truth.
 *
 * `supported` is not decoration. An empty list means "nothing is listening —
 * start your dev server"; `supported: false` means "this deployment cannot
 * look", which happens on a remote runtime with no local process tree. Those
 * need different words on screen, and collapsing them into one empty state
 * would tell someone their server is down when we simply never checked.
 */

export interface PreviewPorts {
  ports: number[];
  supported: boolean;
}

export const PREVIEW_PORTS_QUERY_KEY = "preview-ports";

export function usePreviewPorts(conversationId: string | undefined) {
  return useQuery({
    queryKey: [PREVIEW_PORTS_QUERY_KEY, conversationId],
    queryFn: async (): Promise<PreviewPorts> => {
      const { data } = await openHands.get<PreviewPorts>(
        `/preview/${conversationId}/ports`,
      );
      return data;
    },
    enabled: !!conversationId,
    // A dev server starts and stops mid-conversation, and nothing pushes that
    // over the event socket. Polling is the honest way to notice; five seconds
    // is slow enough to be free and fast enough that the picker is not stale
    // by the time someone looks at it.
    refetchInterval: 5_000,
    // Not retried: a failure here means the endpoint is unreachable, and
    // hammering it changes nothing while the poll above already covers the
    // transient case.
    retry: false,
  });
}
