import React from "react";
import { Project } from "#/types/project";
import { cn } from "#/utils/utils";

interface ProjectWorkspaceChipProps {
  project: Project;
  className?: string;
}

/**
 * A compact identity chip shown near the model chip in the chat header. It
 * makes the current project + workspace binding visible at a glance — the
 * user should never have to guess whether the agent has folder access.
 *
 * The chip is intentionally subtle (border + tinted background, not a solid
 * pill) so it reads as an ambient status marker, not a call to action.
 */
export function ProjectWorkspaceChip({
  project,
  className,
}: ProjectWorkspaceChipProps) {
  const label = describe(project);
  const tone = toneFor(project.workspaceMode);
  return (
    <div
      data-testid="project-workspace-chip"
      title={`Project: ${project.name}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap max-w-[220px]",
        tone,
        className,
      )}
    >
      <Dot mode={project.workspaceMode} />
      <span className="truncate">{project.name}</span>
      <span className="text-neutral-400">/</span>
      <span className="truncate text-neutral-300">{label}</span>
    </div>
  );
}

function describe(p: Project): string {
  if (p.workspaceMode === "local") return p.folderDisplayName ?? "local folder";
  if (p.workspaceMode === "git") {
    const short = shortGit(p.gitUrl);
    return p.gitBranch ? `${short}@${p.gitBranch}` : short;
  }
  return "web only";
}

function shortGit(url?: string): string {
  if (!url) return "git";
  const clean = url.replace(/\.git$/, "").replace(/\/$/, "");
  const parts = clean.split("/");
  return parts.slice(-2).join("/") || clean;
}

function toneFor(mode: Project["workspaceMode"]): string {
  if (mode === "local") return "border-cyan-500/40 bg-cyan-500/10 text-cyan-100";
  if (mode === "git") return "border-violet-500/40 bg-violet-500/10 text-violet-100";
  return "border-neutral-600 bg-neutral-700/40 text-neutral-200";
}

function Dot({ mode }: { mode: Project["workspaceMode"] }) {
  const color =
    mode === "local"
      ? "bg-cyan-400"
      : mode === "git"
        ? "bg-violet-400"
        : "bg-neutral-400";
  return <span className={cn("h-1.5 w-1.5 rounded-full", color)} />;
}
