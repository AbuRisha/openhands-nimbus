import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Project, ProjectDraft } from "#/types/project";
import {
  attachConversation,
  deleteProject as dbDeleteProject,
  findProjectForConversation,
  getFolderHandle,
  getProject,
  listProjects,
  putFolderHandle,
  putProject,
} from "#/utils/projects/projects-db";

const PROJECTS_KEY = ["nimbus", "projects"] as const;

// React Query v5 rejects a queryFn that resolves to `undefined` — it throws
// "Query data cannot be undefined" and puts the query into an error state.
// Every lookup below can legitimately find nothing (a brand-new conversation
// has no project yet), and Array.find / an absent IndexedDB row both yield
// undefined, so the normal empty case was being reported as a failure.
//
// That surfaced as the error toast
//   ["nimbus","projects","by-conversation","task-…"] data is undefined
// with the conversation stuck on "Loading…", because the query never
// resolved. It fired on every new conversation, which is why it read as
// "the chat does not work at all" rather than as one failing lookup.
//
// `null` is the value v5 wants for "looked, found nothing".

export function useProjects() {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: () => listProjects(),
    staleTime: 60_000,
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: [...PROJECTS_KEY, id],
    queryFn: async () => (id ? ((await getProject(id)) ?? null) : null),
    enabled: !!id,
  });
}

export function useProjectForConversation(conversationId: string | undefined) {
  return useQuery({
    queryKey: [...PROJECTS_KEY, "by-conversation", conversationId],
    queryFn: async () =>
      conversationId
        ? ((await findProjectForConversation(conversationId)) ?? null)
        : null,
    enabled: !!conversationId,
    staleTime: 30_000,
  });
}

export function useFolderHandle(key: string | undefined) {
  return useQuery({
    queryKey: [...PROJECTS_KEY, "folder-handle", key],
    queryFn: async () => (key ? ((await getFolderHandle(key)) ?? null) : null),
    enabled: !!key,
    staleTime: Number.POSITIVE_INFINITY, // handle identity only changes via re-bind
  });
}

function makeId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${rand}`;
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["nimbus", "projects", "create"],
    mutationFn: async (draft: ProjectDraft): Promise<Project> => {
      const id = makeId("prj");
      let folderHandleKey: string | undefined;
      let folderDisplayName: string | undefined;
      if (draft.workspaceMode === "local" && draft.folderHandle) {
        folderHandleKey = makeId("fh");
        folderDisplayName = draft.folderHandle.name;
        await putFolderHandle(folderHandleKey, draft.folderHandle);
      }
      const project: Project = {
        id,
        name: draft.name.trim() || folderDisplayName || "Untitled project",
        workspaceMode: draft.workspaceMode,
        folderHandleKey,
        folderDisplayName,
        gitUrl: draft.workspaceMode === "git" ? draft.gitUrl : undefined,
        gitBranch: draft.workspaceMode === "git" ? draft.gitBranch : undefined,
        createdAt: new Date().toISOString(),
        chats: [],
      };
      await putProject(project);
      return project;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["nimbus", "projects", "delete"],
    mutationFn: async (id: string) => {
      await dbDeleteProject(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
    },
  });
}

export function useAttachConversationToProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: ["nimbus", "projects", "attach-conversation"],
    mutationFn: async (args: {
      projectId: string;
      conversationId: string;
    }) => {
      await attachConversation(args.projectId, args.conversationId);
    },
    onSuccess: (_data, args) => {
      queryClient.invalidateQueries({ queryKey: PROJECTS_KEY });
      queryClient.invalidateQueries({
        queryKey: [...PROJECTS_KEY, "by-conversation", args.conversationId],
      });
    },
  });
}
