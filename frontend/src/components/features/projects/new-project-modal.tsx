import React from "react";
import { useNavigate } from "react-router";
import { ModalBackdrop } from "#/components/shared/modals/modal-backdrop";
import { ModalBody } from "#/components/shared/modals/modal-body";
import { BrandButton } from "#/components/features/settings/brand-button";
import {
  isFsAccessSupported,
  pickDirectory,
} from "#/utils/projects/folder-picker";
import {
  useAttachConversationToProject,
  useCreateProject,
} from "#/hooks/projects/use-projects";
import { useCreateConversation } from "#/hooks/mutation/use-create-conversation";
import { displayErrorToast } from "#/utils/custom-toast-handlers";
import { cn } from "#/utils/utils";

type Mode = "chooser" | "local" | "web" | "git";

interface NewProjectModalProps {
  onClose: () => void;
}

/**
 * "New Project" modal — three workspace bindings, Claude-Code style.
 *
 * The workspace binding is picked up front (before a chat exists) so the
 * project can drive both the initial conversation and every future chat
 * created inside it. Local-folder mode uses the File System Access API and
 * stores the handle in IndexedDB; we feature-detect and disable the option
 * with an inline explanation on browsers that don't support it (Safari,
 * older Firefox).
 */
export function NewProjectModal({ onClose }: NewProjectModalProps) {
  const [mode, setMode] = React.useState<Mode>("chooser");
  const [name, setName] = React.useState("");
  const [pickedHandle, setPickedHandle] =
    React.useState<FileSystemDirectoryHandle | null>(null);
  const [gitUrl, setGitUrl] = React.useState("");
  const [gitBranch, setGitBranch] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const supported = isFsAccessSupported();

  const navigate = useNavigate();
  const { mutateAsync: createProject } = useCreateProject();
  const { mutateAsync: createConversation } = useCreateConversation();
  const { mutateAsync: attachConversation } =
    useAttachConversationToProject();

  const handlePickFolder = async () => {
    const result = await pickDirectory();
    if (result.ok) {
      setPickedHandle(result.handle);
      if (!name) setName(result.handle.name);
    } else if (result.reason === "error") {
      displayErrorToast(
        result.error?.message ?? "Could not access the folder",
      );
    }
    // "cancelled" and "unsupported" fall through silently — UI reflects state.
  };

  const canSubmit = () => {
    if (busy) return false;
    if (mode === "local") return !!pickedHandle;
    if (mode === "git") return /^(https?:\/\/|git@)/.test(gitUrl.trim());
    if (mode === "web") return true;
    return false;
  };

  const handleCreate = async () => {
    if (!canSubmit()) return;
    setBusy(true);
    try {
      const project = await createProject({
        name,
        workspaceMode: mode as "local" | "web" | "git",
        folderHandle: pickedHandle ?? undefined,
        gitUrl: gitUrl.trim() || undefined,
        gitBranch: gitBranch.trim() || undefined,
      });

      // Kick off the first conversation for this project. For git mode we
      // hand the URL to the sandbox via the existing repo-selection field so
      // it clones on start; local & web modes create a bare conversation.
      const convo = await createConversation(
        mode === "git"
          ? {
              repository: {
                name: gitUrl.trim(),
                gitProvider: "github",
                branch: gitBranch.trim() || undefined,
              },
            }
          : {},
      );
      await attachConversation({
        projectId: project.id,
        conversationId: convo.conversation_id,
      });
      onClose();
      navigate(`/conversations/${convo.conversation_id}`);
    } catch (err) {
      displayErrorToast(
        err instanceof Error ? err.message : "Failed to create project",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalBackdrop onClose={onClose}>
      <ModalBody className="items-start border border-tertiary w-[520px] max-w-[92vw]">
        <div className="flex flex-col gap-1 w-full">
          <h2 className="text-white text-lg font-semibold tracking-tight">
            New project
          </h2>
          <p className="text-neutral-400 text-sm">
            {mode === "chooser"
              ? "Pick how this project's workspace is bound. You can add chats to it afterward."
              : "Give it a name and confirm the workspace."}
          </p>
        </div>

        {mode === "chooser" && (
          <div className="flex flex-col gap-2 w-full mt-1">
            <ChooserRow
              testId="option-local"
              disabled={!supported}
              title="Bind a local folder"
              subtitle={
                supported
                  ? "Read and write files on your machine. The folder handle stays in your browser."
                  : "Requires a Chromium-based browser (Chrome, Edge, Arc, Brave). Not available in Safari or Firefox."
              }
              onClick={() => setMode("local")}
            />
            <ChooserRow
              testId="option-web"
              title="Web-only project"
              subtitle="No folder. Chats and files live in Nimbus."
              onClick={() => setMode("web")}
            />
            <ChooserRow
              testId="option-git"
              title="Import from git URL"
              subtitle="Clone a repository into an ephemeral sandbox on start."
              onClick={() => setMode("git")}
            />
          </div>
        )}

        {mode !== "chooser" && (
          <div className="flex flex-col gap-3 w-full mt-1">
            <label className="flex flex-col gap-1 text-sm text-white">
              Project name
              <input
                data-testid="project-name-input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Loader-EDU refactor"
                className="bg-tertiary border border-neutral-700 rounded-sm px-2 py-1.5 text-white outline-none focus:border-primary"
              />
            </label>

            {mode === "local" && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <BrandButton
                    testId="pick-folder-button"
                    variant="secondary"
                    type="button"
                    onClick={handlePickFolder}
                    isDisabled={!supported || busy}
                  >
                    {pickedHandle ? "Change folder" : "Choose folder"}
                  </BrandButton>
                  {pickedHandle && (
                    <span
                      className="text-sm text-neutral-300 truncate"
                      data-testid="picked-folder-name"
                    >
                      {pickedHandle.name}
                    </span>
                  )}
                </div>
                {!supported && (
                  <p className="text-xs text-amber-400">
                    Your browser doesn't support the File System Access API.
                    Use a Chromium-based browser, or pick "Web-only" instead.
                  </p>
                )}
              </div>
            )}

            {mode === "git" && (
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-1 text-sm text-white">
                  Git URL
                  <input
                    data-testid="git-url-input"
                    type="text"
                    value={gitUrl}
                    onChange={(e) => setGitUrl(e.target.value)}
                    placeholder="https://github.com/owner/repo.git"
                    className="bg-tertiary border border-neutral-700 rounded-sm px-2 py-1.5 text-white outline-none focus:border-primary"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm text-white">
                  Branch (optional)
                  <input
                    data-testid="git-branch-input"
                    type="text"
                    value={gitBranch}
                    onChange={(e) => setGitBranch(e.target.value)}
                    placeholder="main"
                    className="bg-tertiary border border-neutral-700 rounded-sm px-2 py-1.5 text-white outline-none focus:border-primary"
                  />
                </label>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-between w-full mt-2">
          {mode === "chooser" ? (
            <BrandButton
              type="button"
              variant="secondary"
              onClick={onClose}
              testId="cancel-project-button"
            >
              Cancel
            </BrandButton>
          ) : (
            <BrandButton
              type="button"
              variant="secondary"
              onClick={() => setMode("chooser")}
              testId="back-project-button"
            >
              Back
            </BrandButton>
          )}
          {mode !== "chooser" && (
            <BrandButton
              type="button"
              variant="primary"
              onClick={handleCreate}
              isDisabled={!canSubmit()}
              testId="create-project-button"
            >
              {busy ? "Creating..." : "Create project"}
            </BrandButton>
          )}
        </div>
      </ModalBody>
    </ModalBackdrop>
  );
}

function ChooserRow({
  title,
  subtitle,
  onClick,
  disabled,
  testId,
}: {
  title: string;
  subtitle: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full text-left rounded-md border border-neutral-700 bg-tertiary p-3 transition-colors",
        !disabled && "hover:border-primary hover:bg-neutral-800 cursor-pointer",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <div className="text-white font-medium text-sm">{title}</div>
      <div className="text-neutral-400 text-xs mt-0.5">{subtitle}</div>
    </button>
  );
}
