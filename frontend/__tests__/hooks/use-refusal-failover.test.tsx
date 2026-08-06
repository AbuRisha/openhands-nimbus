import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRefusalFailover } from "#/hooks/chat/use-refusal-failover";
import { OpenHandsEvent } from "#/types/v1/core";

/**
 * The failure modes here are both expensive and both silent.
 *
 * Firing mid-stream offers a retry for an answer that was about to arrive, and
 * charges for it. Re-arming on a retry that also refuses turns a fallback into
 * a paid loop nobody asked for.
 */

const CATALOG = [
  { name: "Claude Opus 5", model: "anthropic/claude-opus-5" },
  { name: "GPT 5.6 Sol", model: "openai/gpt-5.6-sol" },
];

const assistant = (id: string, text: string) =>
  ({
    id,
    kind: "MessageEvent",
    source: "agent",
    llm_message: { role: "assistant", content: [{ type: "text", text }] },
  }) as unknown as OpenHandsEvent;

const user = (id: string, text: string) =>
  ({
    id,
    kind: "MessageEvent",
    source: "user",
    llm_message: { role: "user", content: [{ type: "text", text }] },
  }) as unknown as OpenHandsEvent;

interface Props {
  events: OpenHandsEvent[];
  isRunning: boolean;
}

const setup = (events: OpenHandsEvent[], isRunning = false) =>
  renderHook(
    (props: Props) =>
      useRefusalFailover({
        events: props.events,
        isRunning: props.isRunning,
        currentModel: "anthropic/claude-opus-5",
        currentModelName: "Claude Opus 5",
        catalog: CATALOG,
      }),
    { initialProps: { events, isRunning } },
  );

describe("useRefusalFailover", () => {
  it("offers a prompt when the finished answer is a refusal", () => {
    const { result } = setup([
      user("u1", "do the thing"),
      assistant("a1", "I can't help with that."),
    ]);

    expect(result.current.refusal?.eventId).toBe("a1");
    expect(result.current.refusal?.fallback?.model).toBe("openai/gpt-5.6-sol");
  });

  it("stays silent while the turn is still streaming", () => {
    // "I can't help with the old API, but here's the new one" is a phrase that
    // appears mid-sentence in answers that go on to help. Firing per delta
    // would offer a retry for an answer about to arrive — and bill for it.
    const { result, rerender } = setup(
      [user("u1", "x"), assistant("a1", "I can't help with the old API")],
      true,
    );

    expect(result.current.refusal).toBeNull();

    rerender({
      events: [
        user("u1", "x"),
        assistant(
          "a1",
          `I can't help with the old API, but here's the new one. ${"It is a drop-in replacement and the migration is mechanical. ".repeat(8)}`,
        ),
      ],
      isRunning: false,
    });

    // The finished text is not a refusal, so nothing is offered.
    expect(result.current.refusal).toBeNull();
  });

  it("does not fire on an ordinary answer", () => {
    const { result } = setup([
      user("u1", "x"),
      assistant("a1", "Here is the refactored function."),
    ]);

    expect(result.current.refusal).toBeNull();
  });

  it("never re-arms for a message already answered", () => {
    // Cancelling has to be permanent: a dismissed prompt that reappears on the
    // next render is not dismissable.
    const { result, rerender } = setup([
      user("u1", "x"),
      assistant("a1", "I must decline."),
    ]);

    expect(result.current.refusal).not.toBeNull();
    act(() => {
      result.current.resolve({ kind: "cancel" });
    });
    expect(result.current.refusal).toBeNull();

    rerender({
      events: [user("u1", "x"), assistant("a1", "I must decline.")],
      isRunning: false,
    });

    expect(result.current.refusal).toBeNull();
  });

  it("arms again for a NEW refusal, so a fallback that also refuses is seen once", () => {
    // Once per message, not once per session: the retry's own refusal is a
    // different message and deserves its own prompt. What must not happen is
    // the SAME message re-arming, which is what turns this into a loop.
    const { result, rerender } = setup([
      user("u1", "x"),
      assistant("a1", "I must decline."),
    ]);

    act(() => {
      result.current.resolve({ kind: "cancel" });
    });

    rerender({
      events: [
        user("u1", "x"),
        assistant("a1", "I must decline."),
        assistant("a2", "I cannot assist with that either."),
      ],
      isRunning: false,
    });

    expect(result.current.refusal?.eventId).toBe("a2");
  });

  it("does not resurrect an older refusal once superseded", () => {
    // Scanning past the newest assistant message would re-offer a refusal the
    // conversation has already moved on from.
    const { result } = setup([
      assistant("a1", "I can't help with that."),
      assistant("a2", "Here you go."),
    ]);

    expect(result.current.refusal).toBeNull();
  });

  it("still offers the prompt when nothing different is available", () => {
    // The component renders a no-fallback variant; the hook must not suppress
    // the prompt entirely, or a refusal would pass in silence.
    const { result } = renderHook(() =>
      useRefusalFailover({
        events: [assistant("a1", "I must decline.")],
        isRunning: false,
        currentModel: "anthropic/claude-opus-5",
        currentModelName: "Claude Opus 5",
        catalog: [{ name: "Claude Opus 5", model: "anthropic/claude-opus-5" }],
      }),
    );

    expect(result.current.refusal).not.toBeNull();
    expect(result.current.refusal?.fallback).toBeNull();
  });

  it("hands the choice back so the caller owns the side effects", () => {
    const { result } = setup([assistant("a1", "I must decline.")]);

    let returned;
    act(() => {
      returned = result.current.resolve({
        kind: "retry",
        model: "openai/gpt-5.6-sol",
        direction: "revert",
      });
    });

    expect(returned).toEqual({
      kind: "retry",
      model: "openai/gpt-5.6-sol",
      direction: "revert",
    });
  });
});
