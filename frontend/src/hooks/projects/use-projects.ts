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
    queryFn: () => (id ? getProject(id) : undefined),
    enabled: !!id,
  });
}

export function useProjectForConversation(conversationId: string | undefined) {
  return useQuery({
    queryKey: [...PROJECTS_KEY, "by-conversation", conversationId],
    queryFn: () =>
      conversationId ? findProjectForConversation(conversationId) : undefined,
    enabled: !!conversationId,
    staleTime: 30_000,
  });
}

export function useFolderHandle(key: string | undefined) {
  return useQuery({
    queryKey: [...PROJECTS_KEY, "folder-handle", key],
    queryFn: () => (key ? getFolderHandle(key) : undefined),
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
