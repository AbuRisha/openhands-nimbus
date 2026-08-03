import { describe, it, expect } from "vitest";
import {
  groupToolEvents,
  isGroupableToolEvent,
  groupLabel,
  MIN_GROUP_SIZE,
} from "#/components/v1/chat/event-content-helpers/group-tool-events";
import { OpenHandsEvent } from "#/types/v1/core";

/**
 * The contract here is narrow and load-bearing: fold the machinery away, never
 * fold away anything the user is meant to read.
 *
 * The narration cases exist because the first version of this got it wrong.
 * ActionEvent carries a `thought` that renders as an ordinary assistant
 * message, so grouping actions wholesale hid the assistant's own explanation
 * behind a collapsed chip — reported as "it says used tools but hides
 * informative text from the user".
 */

// Fixtures must satisfy the REAL type guards, which are structural rather than
// kind-based: isActionEvent additionally requires string tool_name and
// tool_call_id, and isObservationEvent requires action_id. Omitting them made
// every fixture fall through to "not a tool event", which silently turned the
// first version of this suite green in the wrong places.
const action = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    kind: "ActionEvent",
    source: "agent",
    tool_name: "bash",
    tool_call_id: `call_${id}`,
    thought: [],
    action: { kind: "BashAction" },
    ...extra,
  }) as unknown as OpenHandsEvent;

const observation = (id: string) =>
  ({
    id,
    kind: "ObservationEvent",
    source: "environment",
    action_id: `call_${id}`,
    observation: { kind: "BashObservation" },
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
const flatten = (plan: ReturnType<typeof groupToolEvents>) =>
  plan.flatMap((item) =>
    item.type === "group" ? item.events : [item.event],
  );

describe("groupToolEvents", () => {
  it("never drops or reorders an event", () => {
    const events = [
      message("m1"),
      action("a1"),
      observation("o1"),
      action("a2"),
      observation("o2"),
      message("m2"),
    ];

    expect(flatten(groupToolEvents(events)).map((e) => e.id)).toEqual(
      events.map((e) => e.id),
    );
  });

  it("collapses a run at or above the threshold", () => {
    const events = [action("a1"), observation("o1"), action("a2")];
    const plan = groupToolEvents(events);

    expect(plan).toHaveLength(1);
    expect(plan[0].type).toBe("group");
  });

  it("leaves a short run expanded, since a chip would cost a click for nothing", () => {
    const events = [action("a1"), observation("o1")];
    const plan = groupToolEvents(events);

    expect(plan.every((i) => i.type === "single")).toBe(true);
    expect(plan).toHaveLength(2);
  });

  it("breaks a run on a user or assistant message", () => {
    const events = [
      action("a1"),
      observation("o1"),
      action("a2"),
      message("m1"),
      action("a3"),
      observation("o2"),
      action("a4"),
    ];
    const plan = groupToolEvents(events);

    expect(plan.map((i) => i.type)).toEqual(["group", "single", "group"]);
  });

  it("never hides a failure inside a group", () => {
    const events = [
      action("a1"),
      observation("o1"),
      agentError("e1"),
      action("a2"),
      observation("o2"),
    ];
    const plan = groupToolEvents(events);
    const err = plan.find(
      (i) => i.type === "single" && i.event.id === "e1",
    );

    expect(err).toBeDefined();
  });

  it("counts actions, not events, so a chip does not inflate the number", () => {
    // Four actions and four observations is "Used 4 tools", not 8.
    const events = [
      action("a1"),
      observation("o1"),
      action("a2"),
      observation("o2"),
      action("a3"),
      observation("o3"),
      action("a4"),
      observation("o4"),
    ];

    expect(groupLabel(events)).toBe("Used 4 tools");
  });

  it("says tool, singular, for one", () => {
    expect(groupLabel([action("a1"), observation("o1")])).toBe("Used 1 tool");
  });

  it("MIN_GROUP_SIZE is honoured as the boundary", () => {
    const run = Array.from({ length: MIN_GROUP_SIZE }, (_, i) =>
      action(`a${i}`),
    );
    expect(groupToolEvents(run)[0].type).toBe("group");

    const shorter = run.slice(0, MIN_GROUP_SIZE - 1);
    expect(groupToolEvents(shorter).every((i) => i.type === "single")).toBe(
      true,
    );
  });
});

describe("narration is never collapsed", () => {
  it("an action carrying thought text is not groupable", () => {
    const narrating = action("a1", {
      thought: [{ type: "text", text: "Let me check the config first." }],
    });

    expect(isGroupableToolEvent(narrating)).toBe(false);
  });

  it("a ThinkAction is not groupable", () => {
    const thinking = action("a1", {
      action: { kind: "ThinkAction", thought: "weighing options" },
    });

    expect(isGroupableToolEvent(thinking)).toBe(false);
  });

  it("empty or whitespace-only thought stays groupable", () => {
    expect(isGroupableToolEvent(action("a1", { thought: [] }))).toBe(true);
    expect(
      isGroupableToolEvent(action("a2", { thought: [{ type: "text", text: "   " }] })),
    ).toBe(true);
  });

  it("a narrating action breaks the run around it", () => {
    const events = [
      action("a1"),
      observation("o1"),
      action("a2"),
      action("narr", {
        thought: [{ type: "text", text: "Now I will run the tests." }],
      }),
      action("a3"),
      observation("o2"),
      action("a4"),
    ];
    const plan = groupToolEvents(events);

    expect(plan.map((i) => i.type)).toEqual(["group", "single", "group"]);
    const solo = plan[1];
    expect(solo.type === "single" && solo.event.id).toBe("narr");
  });

  it("still drops no event when narration interrupts", () => {
    const events = [
      action("a1"),
      action("narr", { thought: [{ type: "text", text: "explaining" }] }),
      action("a2"),
    ];

    expect(flatten(groupToolEvents(events)).map((e) => e.id)).toEqual([
      "a1",
      "narr",
      "a2",
    ]);
  });
});
