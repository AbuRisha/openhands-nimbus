import { describe, it, expect } from "vitest";
import {
  planToolCalls,
  isToolMachineryEvent,
} from "#/components/v1/chat/event-content-helpers/tool-call-plan";
import { summarizeToolCall } from "#/components/v1/chat/event-content-helpers/tool-call-summary";
import { OpenHandsEvent } from "#/types/v1/core";

/**
 * The contract is narrow and load-bearing: summarise the machinery, never
 * summarise away anything the user is meant to read, and never lose an event.
 *
 * The narration cases carry over from the grouping implementation this
 * replaced, because that is where they were learned. ActionEvent carries a
 * `thought` that renders as an ordinary assistant message, so treating actions
 * wholesale as machinery hid the assistant's own explanation — reported as "it
 * says used tools but hides informative text from the user".
 */

// Fixtures must satisfy the REAL type guards, which are structural rather than
// kind-based: isActionEvent additionally requires string tool_name and
// tool_call_id, and isObservationEvent requires action_id. Omitting them made
// every fixture fall through to "not a tool event", which silently turned an
// earlier version of this suite green in the wrong places.
const action = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    kind: "ActionEvent",
    source: "agent",
    tool_name: "bash",
    tool_call_id: `call_${id}`,
    thought: [],
    action: { kind: "ExecuteBashAction", command: "npm test" },
    ...extra,
  }) as unknown as OpenHandsEvent;

/** `forId` names the ACTION this observation answers, as the real events do. */
const observation = (id: string, forId: string) =>
  ({
    id,
    kind: "ObservationEvent",
    source: "environment",
    tool_name: "bash",
    tool_call_id: `call_${forId}`,
    action_id: forId,
    observation: { kind: "ExecuteBashObservation" },
  }) as unknown as OpenHandsEvent;

const message = (id: string) =>
  ({
    id,
    kind: "MessageEvent",
    source: "user",
    llm_message: { role: "user", content: [] },
  }) as unknown as OpenHandsEvent;

const agentError = (id: string) =>
  ({
    id,
    kind: "AgentErrorEvent",
    source: "agent",
    tool_name: "bash",
    tool_call_id: `call_${id}`,
    error: "command failed",
  }) as unknown as OpenHandsEvent;

/** Flatten a plan back to events, to assert nothing was dropped or reordered. */
const flatten = (plan: ReturnType<typeof planToolCalls>) =>
  plan.flatMap((item) =>
    item.type === "single"
      ? [item.event]
      : [item.action, ...(item.observation ? [item.observation] : [])],
  );

describe("planToolCalls", () => {
  it("never drops or reorders an event", () => {
    const events = [
      message("m1"),
      action("a1"),
      observation("o1", "a1"),
      action("a2"),
      observation("o2", "a2"),
      message("m2"),
    ];

    expect(flatten(planToolCalls(events)).map((e) => e.id)).toEqual(
      events.map((e) => e.id),
    );
  });

  it("pairs each observation with the action it answers", () => {
    const plan = planToolCalls([
      action("a1"),
      observation("o1", "a1"),
      action("a2"),
      observation("o2", "a2"),
    ]);

    // Two calls, not four rows — the whole point of the change.
    expect(plan).toHaveLength(2);
    expect(plan.every((i) => i.type === "toolCall")).toBe(true);
    const [first, second] = plan;
    expect(first.type === "toolCall" && first.observation?.id).toBe("o1");
    expect(second.type === "toolCall" && second.observation?.id).toBe("o2");
  });

  it("pairs correctly when results come back out of order", () => {
    // Two calls in flight, second one answers first. Pairing by id rather than
    // by adjacency is the only thing that gets this right.
    const plan = planToolCalls([
      action("a1"),
      action("a2"),
      observation("o2", "a2"),
      observation("o1", "a1"),
    ]);

    expect(plan).toHaveLength(2);
    const byAction = new Map(
      plan.map((i) => [
        i.type === "toolCall" ? i.action.id : "",
        i.type === "toolCall" ? i.observation?.id : undefined,
      ]),
    );
    expect(byAction.get("a1")).toBe("o1");
    expect(byAction.get("a2")).toBe("o2");
  });

  it("leaves a call with no result yet unpaired, so the row can open itself", () => {
    const plan = planToolCalls([action("a1")]);

    expect(plan).toHaveLength(1);
    expect(plan[0].type === "toolCall" && plan[0].observation).toBeUndefined();
  });

  it("shows an observation that matches no action rather than dropping it", () => {
    const orphan = observation("o1", "nothing");
    const plan = planToolCalls([orphan]);

    expect(plan).toHaveLength(1);
    expect(plan[0].type).toBe("single");
  });

  it("does not attach a second observation to a call that already has one", () => {
    const plan = planToolCalls([
      action("a1"),
      observation("o1", "a1"),
      observation("o1b", "a1"),
    ]);

    // The duplicate has to remain visible; silently swallowing it would hide a
    // real protocol violation.
    expect(flatten(plan).map((e) => e.id)).toEqual(["a1", "o1", "o1b"]);
  });

  it("keeps a message on its own row", () => {
    const plan = planToolCalls([action("a1"), message("m1"), action("a2")]);

    expect(plan.map((i) => i.type)).toEqual([
      "toolCall",
      "single",
      "toolCall",
    ]);
  });

  it("never summarises a failure into a row", () => {
    const plan = planToolCalls([
      action("a1"),
      observation("o1", "a1"),
      agentError("e1"),
    ]);
    const err = plan.find((i) => i.type === "single" && i.event.id === "e1");

    expect(err).toBeDefined();
  });
});

describe("narration is never summarised away", () => {
  it("an action carrying thought text is not machinery", () => {
    const narrating = action("a1", {
      thought: [{ type: "text", text: "Let me check the config first." }],
    });

    expect(isToolMachineryEvent(narrating)).toBe(false);
  });

  it("a ThinkAction is not machinery", () => {
    const thinking = action("a1", {
      action: { kind: "ThinkAction", thought: "weighing options" },
    });

    expect(isToolMachineryEvent(thinking)).toBe(false);
  });

  it("empty or whitespace-only thought stays machinery", () => {
    expect(isToolMachineryEvent(action("a1", { thought: [] }))).toBe(true);
    expect(
      isToolMachineryEvent(
        action("a2", { thought: [{ type: "text", text: "   " }] }),
      ),
    ).toBe(true);
  });

  it("a narrating action keeps its full row", () => {
    const events = [
      action("a1"),
      action("narr", {
        thought: [{ type: "text", text: "Now I will run the tests." }],
      }),
      action("a2"),
    ];
    const plan = planToolCalls(events);

    expect(plan.map((i) => i.type)).toEqual([
      "toolCall",
      "single",
      "toolCall",
    ]);
    const solo = plan[1];
    expect(solo.type === "single" && solo.event.id).toBe("narr");
  });

  it("still drops no event when narration interrupts", () => {
    const events = [
      action("a1"),
      action("narr", { thought: [{ type: "text", text: "explaining" }] }),
      action("a2"),
    ];

    expect(flatten(planToolCalls(events)).map((e) => e.id)).toEqual([
      "a1",
      "narr",
      "a2",
    ]);
  });
});

describe("summarizeToolCall", () => {
  const of = (kind: string, rest: Record<string, unknown> = {}) =>
    action("x", { action: { kind, ...rest } });

  it("names the operation, not the tool, for the editor family", () => {
    // One tool, several operations. Labelling all of them "FileEditor" would
    // produce a column of identical rows, which is the failure being replaced.
    expect(summarizeToolCall(of("FileEditorAction", { command: "view", path: "/a/b.ts" })).label).toBe("Read");
    expect(summarizeToolCall(of("FileEditorAction", { command: "str_replace", path: "/a/b.ts" })).label).toBe("Edit");
    expect(summarizeToolCall(of("FileEditorAction", { command: "create", path: "/a/b.ts" })).label).toBe("Create");
  });

  it("treats an unknown editor command as a read rather than a write", () => {
    expect(
      summarizeToolCall(of("FileEditorAction", { command: "wat", path: "/a" }))
        .label,
    ).toBe("Read");
  });

  it("carries the identifying argument", () => {
    expect(summarizeToolCall(of("ExecuteBashAction", { command: "npm test" })).target).toBe("npm test");
    expect(summarizeToolCall(of("GrepAction", { pattern: "useResume" })).target).toBe("useResume");
  });

  it("keeps the filename when a path is too long to show", () => {
    const long = `/${"nested/".repeat(40)}target.ts`;
    const { target } = summarizeToolCall(
      of("FileEditorAction", { command: "view", path: long }),
    );

    // A path is identified by its END, so that is the part that must survive.
    expect(target?.endsWith("target.ts")).toBe(true);
    expect(target!.length).toBeLessThanOrEqual(122);
  });

  it("keeps the start when a command is too long to show", () => {
    const long = `echo ${"x".repeat(500)}`;
    const { target } = summarizeToolCall(
      of("ExecuteBashAction", { command: long }),
    );

    // A command is identified by how it STARTS.
    expect(target?.startsWith("echo ")).toBe(true);
    expect(target!.length).toBeLessThanOrEqual(120);
  });

  it("collapses whitespace so a multi-line command stays one line", () => {
    const { target } = summarizeToolCall(
      of("ExecuteBashAction", { command: "npm run build\n  && npm test" }),
    );

    expect(target).toBe("npm run build && npm test");
  });

  it("names the Nimbus media tools", () => {
    expect(summarizeToolCall(of("ImageGenerateAction", { prompt: "a cat" }))).toEqual({
      label: "Generate image",
      target: "a cat",
    });
    expect(summarizeToolCall(of("VideoGenerateAction", { prompt: "a dog" })).label).toBe("Generate video");
  });

  it("distinguishes MCP tools by name, since one kind covers them all", () => {
    expect(summarizeToolCall(of("MCPToolAction", { name: "search_docs" })).label).toBe("MCP search_docs");
  });

  it("reads sensibly for an action kind it has never seen", () => {
    // A tool added tomorrow must not render blank or as "ActionEvent".
    expect(summarizeToolCall(of("SomeBrandNewThingAction")).label).toBe(
      "Some brand new thing",
    );
  });

  it("falls back to the tool name when there is no action at all", () => {
    const bare = {
      id: "x",
      kind: "ActionEvent",
      tool_name: "mystery",
    } as unknown as OpenHandsEvent;

    expect(summarizeToolCall(bare).label).toBe("mystery");
  });
});
