import React from "react";
import {
  useFolderHandle,
  useProjectForConversation,
} from "#/hooks/projects/use-projects";
import {
  listDirectory,
  readFile,
  writeFile,
} from "#/utils/projects/folder-fs";
import { verifyReadWritePermission } from "#/utils/projects/folder-picker";

interface BridgeRequest {
  type: "nimbus:fs";
  id: string;
  op: "list" | "read" | "write";
  path?: string;
  contents?: string;
}

interface BridgeReply {
  type: "nimbus:fs:reply";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Client-side bridge that fulfils an "auto fs MCP mount" contract for a
 * conversation bound to a local-folder project.
 *
 * The FileSystemDirectoryHandle lives in the browser and cannot cross to the
 * server, so the agent-side MCP server (once wired) will proxy every fs call
 * back to the browser via the existing WebSocket. Until that server hop lands
 * we accept `window.postMessage({type: "nimbus:fs", ...})` requests from any
 * in-page consumer and reply on the same channel. The message shape is
 * intentionally small and stable so the server proxy can adopt it verbatim.
 *
 * The bridge also announces its presence on mount by dispatching a
 * `nimbus:workspace-ready` window event carrying the project id and root
 * folder name — the future MCP loader listens for this to know a workspace
 * is auto-mountable without any user config.
 */
export function NimbusLocalFolderBridge({
  conversationId,
}: {
  conversationId: string;
}) {
  const { data: project } = useProjectForConversation(conversationId);
  const key =
    project?.workspaceMode === "local" ? project.folderHandleKey : undefined;
  const { data: handle } = useFolderHandle(key);

  React.useEffect(() => {
    if (!project || project.workspaceMode !== "local" || !handle) return;
    let disposed = false;

    // Ensure the browser still has read+write permission after a page reload.
    // This is a no-op the first time (permission was granted when picked) but
    // required on subsequent sessions.
    verifyReadWritePermission(handle).then((granted) => {
      if (disposed) return;
      if (!granted) {
        // eslint-disable-next-line no-console
        console.warn(
          "[nimbus] local folder permission not granted; fs bridge disabled",
        );
        return;
      }
      window.dispatchEvent(
        new CustomEvent("nimbus:workspace-ready", {
          detail: {
            projectId: project.id,
            conversationId,
            folderName: project.folderDisplayName ?? handle.name,
          },
        }),
      );
    });

    const onMessage = async (event: MessageEvent) => {
      const req = event.data as BridgeRequest | undefined;
      if (!req || req.type !== "nimbus:fs") return;
      const reply: BridgeReply = {
        type: "nimbus:fs:reply",
        id: req.id,
        ok: false,
      };
      try {
        if (req.op === "list") {
          reply.data = await listDirectory(handle, req.path ?? "");
          reply.ok = true;
        } else if (req.op === "read") {
          if (!req.path) throw new Error("read requires path");
          reply.data = await readFile(handle, req.path);
          reply.ok = true;
        } else if (req.op === "write") {
          if (!req.path) throw new Error("write requires path");
          await writeFile(handle, req.path, req.contents ?? "");
          reply.ok = true;
        }
      } catch (err) {
        reply.error = err instanceof Error ? err.message : String(err);
      }
      window.postMessage(reply, window.location.origin);
    };
    window.addEventListener("message", onMessage);
    return () => {
      disposed = true;
      window.removeEventListener("message", onMessage);
    };
  }, [project, handle, conversationId]);

  return null;
}
