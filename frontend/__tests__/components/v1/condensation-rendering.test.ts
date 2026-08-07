import { describe, it, expect } from "vitest";
import { shouldRenderEvent } from "#/components/v1/chat/event-content-helpers/should-render-event";
import {
  isCondensationEvent,
  isCondensationSummaryEvent,
  isCondensationRequestEvent,
} from "#/types/v1/type-guards";
import { OpenHandsEvent } from "#/types/v1/core";

const base = {
  id: "e1",
  timestamp: "2026-08-07T00:00:00Z",
  source: "environment" as const,
};

/**
 * The wire values, taken from the SDK rather than the TypeScript names:
 * `kind` is `self.__class__.__name__` and the Python classes are
 * `Condensation`, `CondensationRequest`, `CondensationSummaryEvent`. Two of the
 * three differ from the interface they are typed as, so these literals are the
 * contract — if someone "fixes" them to match the TS names, the guards stop
 * matching anything and condensation silently disappears again.
 */
const condensation = (over: Record<string, unknown> = {}) =>
  ({
    ...base,
    kind: "Condensation",
    forgotten_event_ids: ["a", "b", "c"],
    ...over,
  }) as unknown as OpenHandsEvent;

const summary = (over: Record<string, unknown> = {}) =>
  ({
    ...base,
    kind: "CondensationSummaryEvent",
    summary: "The user asked for a refactor; tests pass.",
    ...over,
  }) as unknown as OpenHandsEvent;

const request = () =>
  ({ ...base, kind: "CondensationRequest" }) as unknown as OpenHandsEvent;

describe("condensation type guards", () => {
  it("matches the SDK wire kind, not the TypeScript interface name", () => {
    expect(isCondensationEvent(condensation())).toBe(true);
    // The name a reader would guess from the TS type. If this ever starts
    // matching, the guard has been rewritten against the wrong contract.
    expect(
      isCondensationEvent({
        ...base,
        kind: "CondensationEvent",
      } as unknown as OpenHandsEvent),
    ).toBe(false);
  });

  it("distinguishes the three condensation kinds", () => {
    expect(isCondensationEvent(condensation())).toBe(true);
    expect(isCondensationEvent(summary())).toBe(false);
    expect(isCondensationSummaryEvent(summary())).toBe(true);
    expect(isCondensationSummaryEvent(condensation())).toBe(false);
    expect(isCondensationRequestEvent(request())).toBe(true);
    expect(isCondensationRequestEvent(condensation())).toBe(false);
  });
});

describe("shouldRenderEvent", () => {
  /** The regression this whole change exists for. */
  it("renders condensation events, which used to fall through to false", () => {
    expect(shouldRenderEvent(condensation())).toBe(true);
    expect(shouldRenderEvent(summary())).toBe(true);
  });

  it("does NOT render a condensation request", () => {
    // An internal trigger with no payload. Rendering it would add a divider
    // that tells the reader nothing.
    expect(shouldRenderEvent(request())).toBe(false);
  });

  it("still refuses genuinely unrenderable system events", () => {
    expect(
      shouldRenderEvent({
        ...base,
        kind: "ConversationStateUpdateEvent",
      } as unknown as OpenHandsEvent),
    ).toBe(false);
    // An unknown kind must stay unrendered — the branch added here is
    // deliberately narrow, not a general "render anything" loosening.
    expect(
      shouldRenderEvent({
        ...base,
        kind: "SomeFutureInternalEvent",
      } as unknown as OpenHandsEvent),
    ).toBe(false);
  });
});
