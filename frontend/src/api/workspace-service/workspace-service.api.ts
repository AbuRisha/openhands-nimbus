import { openHands } from "#/api/open-hands-axios";

/**
 * Workspace file listing, for the @-mention picker.
 *
 * A SEPARATE module rather than another method on
 * `v1-conversation-service.api.ts`: that file is concurrently held by another
 * lane, and a new endpoint does not need to be in the middle of it. Same
 * axios instance, so auth and interceptors are unchanged.
 */

export interface WorkspaceFile {
  path: string;
  name: string;
}

export interface WorkspaceFilePage {
  items: WorkspaceFile[];
  /** Matches were dropped to fit the limit. Say so; do not imply the list is all. */
  truncated: boolean;
}

class WorkspaceService {
  /**
   * The browser has no other way to enumerate workspace files — the agent
   * proxy exposes upload, download-by-known-path and whole-tree archive, and
   * nothing that lists. See the endpoint's module docstring.
   */
  static async searchFiles(
    conversationId: string,
    query: string,
    limit = 50,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilePage> {
    const { data } = await openHands.get<WorkspaceFilePage>(
      `/api/v1/app-conversations/${conversationId}/workspace/files`,
      { params: { q: query, limit }, signal },
    );
    return data;
  }
}

export default WorkspaceService;
