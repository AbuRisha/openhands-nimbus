/**
 * Nimbus Projects — workspace binding for chats.
 *
 * A Project groups one or more conversations under a single workspace binding.
 * Three workspace modes are supported (parity with Claude Code's project story):
 *
 *   - "local": bound to a folder on the user's disk via the File System Access
 *     API. The folder handle lives in IndexedDB (it isn't JSON-serializable and
 *     never leaves the browser).
 *   - "web":  no folder. Chats live entirely in the DB.
 *   - "git":  bound to a git URL. The sandbox clones it on conversation start.
 */

export type ProjectWorkspaceMode = "local" | "web" | "git";

export interface Project {
  id: string;
  name: string;
  workspaceMode: ProjectWorkspaceMode;
  /** Key into the `folderHandles` IndexedDB store. Only set for mode="local". */
  folderHandleKey?: string;
  /** Human-readable folder name captured at bind time (for chip display). */
  folderDisplayName?: string;
  /** Only set for mode="git". */
  gitUrl?: string;
  /** Only set for mode="git". */
  gitBranch?: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Conversation IDs (or task-{id} placeholders) attached to this project. */
  chats: string[];
}

export interface ProjectDraft {
  name: string;
  workspaceMode: ProjectWorkspaceMode;
  folderHandle?: FileSystemDirectoryHandle;
  gitUrl?: string;
  gitBranch?: string;
}
