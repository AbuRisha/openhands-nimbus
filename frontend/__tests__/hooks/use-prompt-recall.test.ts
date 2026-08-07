import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePromptRecall } from "#/hooks/chat/use-prompt-recall";
import { useEventStore } from "#/stores/use-event-store";

const userMessage = (id: string, text: string) => ({
  id,
  timestamp: "2026-08-07T00:00:00Z",
  source: "user",
  kind: "MessageEvent",
  llm_message: { role: "user", content: [{ type: "text", text }] },
  activated_microagents: [],
  extended_content: [],
});

const agentMessage = (id: string, text: string) => ({
  id,
  timestamp: "2026-08-07T00:00:00Z",
  source: "agent",
  kind: "MessageEvent",
  llm_message: { role: "assistant", content: [{ type: "text", text }] },
  activated_microagents: [],
  extended_content: [],
});

const seed = (events: unknown[]) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useEventStore.setState({ events: events as any });
};

beforeEach(() => {
  seed([]);
});

describe("usePromptRecall", () => {
  it("recalls the most recent prompt first, then walks back", () => {
    seed([
      userMessage("1", "first"),
      agentMessage("2", "ok"),
      userMessage("3", "second"),
      agentMessage("4", "ok"),
      userMessage("5", "third"),
    ]);

    const { result } = renderHook(() => usePromptRecall());

    act(() => {
      expect(result.current.recallPrevious("")).toBe("third");
      expect(result.current.recallPrevious("third")).toBe("second");
      expect(result.current.recallPrevious("second")).toBe("first");
    });
  });

  it("does not recall past the oldest prompt", () => {
    seed([userMessage("1", "only")]);
    const { result } = renderHook(() => usePromptRecall());

    act(() => {
      expect(result.current.recallPrevious("")).toBe("only");
      // Swallowed rather than returning "only" again — repeating the same
      // string reads as the key being broken.
      expect(result.current.recallPrevious("only")).toBeNull();
    });
  });

  it("ignores agent messages", () => {
    seed([
      userMessage("1", "mine"),
      agentMessage("2", "the agent said something much later"),
    ]);
    const { result } = renderHook(() => usePromptRecall());

    act(() => {
      expect(result.current.recallPrevious("")).toBe("mine");
    });
  });

  /**
   * The rule the whole feature depends on. Up is a cursor key first: in a
   * multi-line prompt it MUST still move the caret, or recall has broken
   * ordinary editing to add a convenience.
   */
  it("does not recall when the composer already has text", () => {
    seed([userMessage("1", "history")]);
    const { result } = renderHook(() => usePromptRecall());

    act(() => {
      expect(result.current.recallPrevious("half-typed thought")).toBeNull();
    });
  });

  it("keeps walking once started, even though the composer is now non-empty", () => {
    seed([userMessage("1", "older"), userMessage("2", "newer")]);
    const { result } = renderHook(() => usePromptRecall());

    act(() => {
      expect(result.current.recallPrevious("")).toBe("newer");
      // The composer now holds "newer" — recall must not stop here, or Up
      // would only ever reach one entry deep.
      expect(result.current.recallPrevious("newer")).toBe("older");
    });
  });

  it("walks forward and returns to an empty composer", () => {
    seed([userMessage("1", "older"), userMessage("2", "newer")]);
    const { result } = renderHook(() => usePromptRecall());

    act(() => {
      result.current.recallPrevious("");
      result.current.recallPrevious("newer");
      expect(result.current.recallNext("older")).toBe("newer");
      // Past the newest entry is the empty composer you started from.
      expect(result.current.recallNext("newer")).toBe("");
    });
  });

  it("does nothing on ArrowDown when not walking history", () => {
    seed([userMessage("1", "x")]);
    const { result } = renderHook(() => usePromptRecall());

    act(() => {
      expect(result.current.recallNext("")).toBeNull();
    });
  });

  it("collapses a prompt repeated back-to-back into one entry", () => {
    seed([
      userMessage("1", "run the tests"),
      userMessage("2", "run the tests"),
    ]);
    const { result } = renderHook(() => usePromptRecall());

    act(() => {
      expect(result.current.recallPrevious("")).toBe("run the tests");
      expect(result.current.recallPrevious("run the tests")).toBeNull();
    });
  });

  it("skips empty and whitespace-only prompts", () => {
    seed([
      userMessage("1", "real"),
      userMessage("2", "   "),
      userMessage("3", ""),
    ]);
    const { result } = renderHook(() => usePromptRecall());

    act(() => {
      expect(result.current.recallPrevious("")).toBe("real");
    });
  });

  it("reset returns to a fresh walk", () => {
    seed([userMessage("1", "older"), userMessage("2", "newer")]);
    const { result } = renderHook(() => usePromptRecall());

    act(() => {
      result.current.recallPrevious("");
      result.current.recallPrevious("newer");
      result.current.reset();
      // Fresh walk starts at the most recent again.
      expect(result.current.recallPrevious("")).toBe("newer");
    });
  });

  it("returns null with no history at all", () => {
    const { result } = renderHook(() => usePromptRecall());

    act(() => {
      expect(result.current.recallPrevious("")).toBeNull();
    });
  });
});
