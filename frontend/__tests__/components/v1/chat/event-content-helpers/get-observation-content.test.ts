import { describe, it, expect } from "vitest";
import { getObservationContent } from "#/components/v1/chat/event-content-helpers/get-observation-content";
import { ObservationEvent } from "#/types/v1/core";
import {
  BrowserObservation,
  GlobObservation,
  GrepObservation,
} from "#/types/v1/core/base/observation";

describe("getObservationContent - BrowserObservation", () => {
  it("should return output content when available", () => {
    const mockEvent: ObservationEvent<BrowserObservation> = {
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "browser_navigate",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "BrowserObservation",
        output: "Browser action completed",
        error: null,
        screenshot_data: "base64data",
      },
    };

    const result = getObservationContent(mockEvent);

    expect(result).toContain("**Output:**");
    expect(result).toContain("Browser action completed");
  });

  it("should handle error cases properly", () => {
    const mockEvent: ObservationEvent<BrowserObservation> = {
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "browser_navigate",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "BrowserObservation",
        output: "",
        error: "Browser action failed",
        screenshot_data: null,
      },
    };

    const result = getObservationContent(mockEvent);

    expect(result).toContain("**Error:**");
    expect(result).toContain("Browser action failed");
  });

  it("should provide default message when no output or error", () => {
    const mockEvent: ObservationEvent<BrowserObservation> = {
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "browser_navigate",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "BrowserObservation",
        output: "",
        error: null,
        screenshot_data: "base64data",
      },
    };

    const result = getObservationContent(mockEvent);

    expect(result).toBe("Browser action completed successfully.");
  });

  it("should return output when screenshot_data is null", () => {
    const mockEvent: ObservationEvent<BrowserObservation> = {
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "browser_navigate",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "BrowserObservation",
        output: "Page loaded successfully",
        error: null,
        screenshot_data: null,
      },
    };

    const result = getObservationContent(mockEvent);

    expect(result).toBe("**Output:**\nPage loaded successfully");
  });
});

describe("getObservationContent - GlobObservation", () => {
  it("should display files found when glob matches files", () => {
    // Arrange
    const mockEvent: ObservationEvent<GlobObservation> = {
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "glob",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "GlobObservation",
        content: [{ type: "text", text: "Found 2 files", cache_prompt: false }],
        is_error: false,
        files: ["/workspace/src/index.ts", "/workspace/src/app.ts"],
        pattern: "**/*.ts",
        search_path: "/workspace",
        truncated: false,
      },
    };

    // Act
    const result = getObservationContent(mockEvent);

    // Assert
    expect(result).toContain("**Pattern:** `**/*.ts`");
    expect(result).toContain("**Search Path:** `/workspace`");
    expect(result).toContain("**Files Found (2):**");
    expect(result).toContain("- `/workspace/src/index.ts`");
    expect(result).toContain("- `/workspace/src/app.ts`");
  });

  it("should display no files found message when glob matches nothing", () => {
    // Arrange
    const mockEvent: ObservationEvent<GlobObservation> = {
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "glob",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "GlobObservation",
        content: [
          { type: "text", text: "No files found", cache_prompt: false },
        ],
        is_error: false,
        files: [],
        pattern: "**/*.xyz",
        search_path: "/workspace",
        truncated: false,
      },
    };

    // Act
    const result = getObservationContent(mockEvent);

    // Assert
    expect(result).toContain("**Pattern:** `**/*.xyz`");
    expect(result).toContain("**Result:** No files found.");
  });

  it("should display error when glob operation fails", () => {
    // Arrange
    const mockEvent: ObservationEvent<GlobObservation> = {
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "glob",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "GlobObservation",
        content: [
          { type: "text", text: "Permission denied", cache_prompt: false },
        ],
        is_error: true,
        files: [],
        pattern: "**/*",
        search_path: "/restricted",
        truncated: false,
      },
    };

    // Act
    const result = getObservationContent(mockEvent);

    // Assert
    expect(result).toContain("**Error:**");
    expect(result).toContain("Permission denied");
  });

  it("should indicate truncation when results exceed limit", () => {
    // Arrange
    const mockEvent: ObservationEvent<GlobObservation> = {
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "glob",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "GlobObservation",
        content: [{ type: "text", text: "Found files", cache_prompt: false }],
        is_error: false,
        files: ["/workspace/file1.ts"],
        pattern: "**/*.ts",
        search_path: "/workspace",
        truncated: true,
      },
    };

    // Act
    const result = getObservationContent(mockEvent);

    // Assert
    expect(result).toContain("**Files Found (1+, truncated):**");
  });
});

describe("getObservationContent - GrepObservation", () => {
  it("should display matches found when grep finds results", () => {
    // Arrange
    const mockEvent: ObservationEvent<GrepObservation> = {
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "grep",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "GrepObservation",
        content: [
          { type: "text", text: "Found 2 matches", cache_prompt: false },
        ],
        is_error: false,
        matches: ["/workspace/src/api.ts", "/workspace/src/routes.ts"],
        pattern: "fetchData",
        search_path: "/workspace",
        include_pattern: "*.ts",
        truncated: false,
      },
    };

    // Act
    const result = getObservationContent(mockEvent);

    // Assert
    expect(result).toContain("**Pattern:** `fetchData`");
    expect(result).toContain("**Search Path:** `/workspace`");
    expect(result).toContain("**Include:** `*.ts`");
    expect(result).toContain("**Matches (2):**");
    expect(result).toContain("- `/workspace/src/api.ts`");
  });

  it("should display no matches found when grep finds nothing", () => {
    // Arrange
    const mockEvent: ObservationEvent<GrepObservation> = {
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "grep",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "GrepObservation",
        content: [{ type: "text", text: "No matches", cache_prompt: false }],
        is_error: false,
        matches: [],
        pattern: "nonExistentFunction",
        search_path: "/workspace",
        include_pattern: null,
        truncated: false,
      },
    };

    // Act
    const result = getObservationContent(mockEvent);

    // Assert
    expect(result).toContain("**Pattern:** `nonExistentFunction`");
    expect(result).toContain("**Result:** No matches found.");
    expect(result).not.toContain("**Include:**");
  });

  it("should display error when grep operation fails", () => {
    // Arrange
    const mockEvent: ObservationEvent<GrepObservation> = {
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "grep",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "GrepObservation",
        content: [
          { type: "text", text: "Invalid regex pattern", cache_prompt: false },
        ],
        is_error: true,
        matches: [],
        pattern: "[invalid",
        search_path: "/workspace",
        include_pattern: null,
        truncated: false,
      },
    };

    // Act
    const result = getObservationContent(mockEvent);

    // Assert
    expect(result).toContain("**Error:**");
    expect(result).toContain("Invalid regex pattern");
  });
});

/**
 * A file edit renders as a diff, not as the whole new file.
 *
 * The previous behaviour printed the entire post-edit file in an untagged code
 * block, so a two-line change to a four-hundred-line file printed four hundred
 * lines to hide it. Reviewing the agent's work is the whole point of the
 * transcript, and that made it the one thing it could not support.
 */
describe("getObservationContent - file edits render as a diff", () => {
  const editEvent = (
    old_content: string,
    new_content: string,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "str_replace_editor",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "StrReplaceEditorObservation",
        command: "str_replace",
        path: "src/app.ts",
        old_content,
        new_content,
        output: "edited",
        error: null,
        content: [],
        ...extra,
      },
    }) as unknown as ObservationEvent;

  it("emits a diff-tagged block so it renders coloured", () => {
    const result = getObservationContent(
      editEvent("const a = 1;", "const a = 2;"),
    );

    // ```diff, not ``` — the tag is what makes Prism colour +/- lines.
    expect(result).toContain("```diff");
  });

  it("shows the change rather than the file", () => {
    const result = getObservationContent(
      editEvent("const a = 1;", "const a = 2;"),
    );

    expect(result).toContain("-const a = 1;");
    expect(result).toContain("+const a = 2;");
  });

  it("names the file in the diff header", () => {
    const result = getObservationContent(
      editEvent("const a = 1;", "const a = 2;"),
    );

    expect(result).toContain("--- a/src/app.ts");
  });

  it("does not print the whole file for a one-line change", () => {
    const before = Array.from({ length: 300 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const after = before.replace("line 150", "line 150 CHANGED");

    const result = getObservationContent(editEvent(before, after));

    expect(result).toContain("+line 150 CHANGED");
    expect(result.split("\n").length).toBeLessThan(25);
  });

  it("says so plainly when the edit changed nothing", () => {
    // An empty diff block renders as an empty grey box, which reads as failure.
    const result = getObservationContent(editEvent("same", "same"));

    expect(result).not.toContain("```diff");
    expect(result.toLowerCase()).toContain("no changes");
  });

  it("still shows a view command as the file, not as a diff", () => {
    const viewEvent = {
      id: "test-id",
      timestamp: "2024-01-01T00:00:00Z",
      source: "environment",
      tool_name: "str_replace_editor",
      tool_call_id: "call-id",
      action_id: "action-id",
      observation: {
        kind: "StrReplaceEditorObservation",
        command: "view",
        path: "src/app.ts",
        output: "const a = 1;",
        error: null,
        content: [],
      },
    } as unknown as ObservationEvent;

    const result = getObservationContent(viewEvent);

    expect(result).not.toContain("```diff");
    expect(result).toContain("const a = 1;");
  });

  it("surfaces an error instead of diffing", () => {
    const result = getObservationContent(
      editEvent("a", "b", { error: "permission denied" }),
    );

    expect(result).toContain("permission denied");
    expect(result).not.toContain("```diff");
  });
});
