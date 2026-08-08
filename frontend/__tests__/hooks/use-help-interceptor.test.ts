import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useHelpInterceptor } from "#/hooks/chat/use-help-interceptor";
import { useHelpStore } from "#/stores/help-store";
import { useEventStore } from "#/stores/use-event-store";
import { BUILT_IN_COMMANDS, HELP_COMMAND } from "#/utils/constants";

const userMessage = (id: string, text: string) => ({
  id,
  timestamp: "2026-08-07T00:00:00Z",
  source: "user",
  kind: "MessageEvent",
  llm_message: { role: "user", content: [{ type: "text", text }] },
  activated_microagents: [],
  extended_content: [],
});

const seedEvents = (events: unknown[]) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useEventStore.setState({ events: events as any, uiEvents: events as any });
};

beforeEach(() => {
  useHelpStore.setState({ entriesByConversation: {} });
  seedEvents([]);
});

const render = (conversationId: string | null, onSubmit: () => void) =>
  renderHook(() => useHelpInterceptor(conversationId, onSubmit)).result;

describe("useHelpInterceptor", () => {
  it("consumes /help instead of sending it to the model", () => {
    const onSubmit = vi.fn();
    const { current: handle } = render("c1", onSubmit);

    handle(HELP_COMMAND);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(useHelpStore.getState().entriesByConversation.c1).toHaveLength(1);
  });

  it("tolerates surrounding whitespace", () => {
    const onSubmit = vi.fn();
    const { current: handle } = render("c1", onSubmit);

    handle("  /help  ");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(useHelpStore.getState().entriesByConversation.c1).toHaveLength(1);
  });

  /**
   * The judgement call worth pinning. "/help me fix this test" is a SENTENCE,
   * and swallowing it to show a command list would be the most annoying
   * possible response — the user would have to rephrase to say the thing they
   * already said. Exact match only.
   */
  it("passes /help WITH AN ARGUMENT through to the model", () => {
    const onSubmit = vi.fn();
    const { current: handle } = render("c1", onSubmit);

    handle("/help me fix this failing test");

    expect(onSubmit).toHaveBeenCalledWith("/help me fix this failing test");
    expect(useHelpStore.getState().entriesByConversation.c1).toBeUndefined();
  });

  it("passes ordinary messages through untouched", () => {
    const onSubmit = vi.fn();
    const { current: handle } = render("c1", onSubmit);

    handle("what does this function do?");

    expect(onSubmit).toHaveBeenCalledWith("what does this function do?");
  });

  it("does not swallow a command that merely starts with the same letters", () => {
    const onSubmit = vi.fn();
    const { current: handle } = render("c1", onSubmit);

    handle("/helpful");

    expect(onSubmit).toHaveBeenCalledWith("/helpful");
  });

  it("falls through when there is no conversation", () => {
    const onSubmit = vi.fn();
    const { current: handle } = render(null, onSubmit);

    handle(HELP_COMMAND);

    expect(onSubmit).toHaveBeenCalledWith(HELP_COMMAND);
  });

  it("anchors to the last rendered event", () => {
    seedEvents([userMessage("e1", "first"), userMessage("e2", "second")]);
    const { current: handle } = render("c1", vi.fn());

    handle(HELP_COMMAND);

    expect(
      useHelpStore.getState().entriesByConversation.c1[0].anchorEventId,
    ).toBe("e2");
  });

  it("anchors to null in an empty conversation", () => {
    const { current: handle } = render("c1", vi.fn());

    handle(HELP_COMMAND);

    expect(
      useHelpStore.getState().entriesByConversation.c1[0].anchorEventId,
    ).toBe(null);
  });

  it("gives repeated /help entries distinct ids", () => {
    const { current: handle } = render("c1", vi.fn());

    handle(HELP_COMMAND);
    handle(HELP_COMMAND);

    const entries = useHelpStore.getState().entriesByConversation.c1;
    expect(entries).toHaveLength(2);
    // Distinct React keys. Two entries sharing a key silently drops one.
    expect(entries[0].id).not.toBe(entries[1].id);
  });
});

describe("the command registry /help documents", () => {
  /**
   * `help-messages` renders BUILT_IN_COMMANDS directly rather than a stored
   * snapshot, so help cannot document a command set the build does not have.
   * These pin the properties that rendering depends on.
   */
  it("includes /help itself", () => {
    expect(BUILT_IN_COMMANDS.map((c) => c.command)).toContain(HELP_COMMAND);
  });

  it("gives every command a description to render", () => {
    for (const item of BUILT_IN_COMMANDS) {
      expect(item.skill.content.trim()).not.toBe("");
    }
  });

  it("has no duplicate commands", () => {
    const commands = BUILT_IN_COMMANDS.map((c) => c.command);
    expect(new Set(commands).size).toBe(commands.length);
  });
});
