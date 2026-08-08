import { OpenHandsEvent } from "#/types/v1/core";

/**
 * Reduce a tool call to the one line a reader can scan.
 *
 * The unit is `verb + the single argument that identifies this call`:
 *
 *   Bash    npm test
 *   Read    src/hooks/use-resume-then-send.ts
 *   Grep    useResumeThenSend
 *
 * Not a serialisation of the arguments. A row exists to answer "which call was
 * that?" at a glance; everything else is one click away in the expanded body,
 * which already renders today and is not duplicated here.
 *
 * WHY THE VERB IS NOT THE TOOL NAME
 * ---------------------------------
 * One tool covers several distinct operations, and the operation is what the
 * reader cares about. `file_editor` with command=view is a read and with
 * command=str_replace is an edit; labelling both "FileEditor" would make a
 * column of identical rows, which is the failure this replaces.
 *
 * UNKNOWN KINDS MUST STILL READ WELL
 * ----------------------------------
 * MCP servers and Nimbus tools add action kinds this file has never heard of,
 * and they must not render as blank or as "ActionEvent". The fallback turns
 * `SomeNewThingAction` into "Some new thing", so a tool added tomorrow gets a
 * sensible row today without anyone editing this map.
 */

export interface ToolCallSummary {
  /** The operation, e.g. "Bash", "Read", "Edit". */
  label: string;
  /** The argument that identifies this call. Absent when there isn't one. */
  target?: string;
}

/** Longer than this and a row stops being scannable. */
const MAX_TARGET = 120;

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_TARGET) return flat;
  // Trailing ellipsis rather than a middle elision: commands and patterns are
  // identified by how they START, and paths get their own treatment below.
  return `${flat.slice(0, MAX_TARGET - 1)}…`;
}

/**
 * Shorten a path from the left.
 *
 * Paths are identified by their END — the filename — so when one is too long
 * the leading directories are what to drop. This is the opposite of the rule
 * for commands, which is why it is a separate function rather than a flag.
 */
function shortenPath(path: string): string {
  const flat = path.trim();
  if (flat.length <= MAX_TARGET) return flat;
  const parts = flat.split(/[\\/]/);
  const tail = parts[parts.length - 1] ?? flat;
  return `…/${tail.length <= MAX_TARGET ? tail : tail.slice(-MAX_TARGET)}`;
}

/** "StrReplaceEditorAction" -> "Str replace editor" */
function humanizeKind(kind: string): string {
  const bare = kind.replace(/Action$/, "");
  const spaced = bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  if (!spaced) return "Tool";
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * The file-editor family maps a `command` field onto real operations. A missing
 * or unrecognised command is a read, because `view` is the default and treating
 * an unknown as a write would overstate what happened.
 */
const EDITOR_COMMANDS: Record<string, string> = {
  view: "Read",
  create: "Create",
  str_replace: "Edit",
  insert: "Edit",
  undo_edit: "Undo edit",
};

export function summarizeToolCall(event: OpenHandsEvent): ToolCallSummary {
  const { action } = event as { action?: Record<string, unknown> };
  const kind = typeof action?.kind === "string" ? action.kind : "";

  const str = (key: string): string | undefined => {
    const v = action?.[key];
    return typeof v === "string" && v.trim() ? v : undefined;
  };

  switch (kind) {
    case "ExecuteBashAction":
    case "TerminalAction": {
      const command = str("command");
      return { label: "Bash", target: command && truncate(command) };
    }

    case "FileEditorAction":
    case "StrReplaceEditorAction":
    case "PlanningFileEditorAction": {
      const command = str("command") ?? "view";
      const path = str("path");
      return {
        label: EDITOR_COMMANDS[command] ?? "Read",
        target: path && shortenPath(path),
      };
    }

    case "GrepAction": {
      const pattern = str("pattern");
      return { label: "Grep", target: pattern && truncate(pattern) };
    }

    case "GlobAction": {
      const pattern = str("pattern");
      return { label: "Glob", target: pattern && truncate(pattern) };
    }

    case "TaskAction":
      return { label: "Task", target: str("description") };

    case "TaskTrackerAction":
      return { label: "Tasks", target: str("command") };

    case "ThinkAction":
      return { label: "Think" };

    case "FinishAction":
      return { label: "Finish" };

    case "ImageGenerateAction": {
      const prompt = str("prompt");
      return { label: "Generate image", target: prompt && truncate(prompt) };
    }

    case "VideoGenerateAction": {
      const prompt = str("prompt");
      return { label: "Generate video", target: prompt && truncate(prompt) };
    }

    case "MCPToolAction": {
      // The tool NAME is the identity here; the server exposes many behind one
      // action kind, so "MCP tool" alone would collapse them all into one row.
      const name = str("name") ?? str("tool_name");
      return { label: name ? `MCP ${name}` : "MCP tool" };
    }

    case "BrowserNavigateAction":
      return { label: "Browse", target: str("url") };

    case "BrowserClickAction":
    case "BrowserTypeAction":
    case "BrowserScrollAction":
    case "BrowserGetStateAction":
    case "BrowserGetContentAction":
    case "BrowserGoBackAction":
    case "BrowserListTabsAction":
    case "BrowserSwitchTabAction":
    case "BrowserCloseTabAction":
      return { label: "Browser", target: humanizeKind(kind) };

    default:
      break;
  }

  if (kind) return { label: humanizeKind(kind) };

  // No action kind at all. tool_name is the last thing that still identifies it.
  const toolName = (event as { tool_name?: unknown }).tool_name;
  return {
    label: typeof toolName === "string" && toolName ? toolName : "Tool",
  };
}
