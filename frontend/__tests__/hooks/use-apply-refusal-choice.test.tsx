import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useApplyRefusalChoice } from "#/hooks/chat/use-apply-refusal-choice";

/**
 * The restore is what these tests exist for.
 *
 * Without it everything looks correct — the retry works, the answer arrives —
 * and every turn afterwards silently runs on a model the customer did not
 * choose, until they read a bill. It is invisible at the moment it starts,
 * which is exactly why it needs pinning.
 */

const PROFILES: Record<string, string> = {
  "anthropic/claude-opus-5": "Claude Opus 5",
  "openai/gpt-5.6-sol": "GPT 5.6 Sol",
};

interface Props {
  isRunning: boolean;
}

const setup = () => {
  const switchToProfile = vi.fn();
  const resend = vi.fn();
  const view = renderHook(
    (props: Props) =>
      useApplyRefusalChoice({
        isRunning: props.isRunning,
        switchToProfile,
        profileNameForModel: (model) => PROFILES[model] ?? null,
        resend,
      }),
    { initialProps: { isRunning: false } },
  );
  return { ...view, switchToProfile, resend };
};

describe("useApplyRefusalChoice", () => {
  it("switches by profile NAME and resends the refused request", () => {
    // Switching takes a name, not a model id. Passing an id is a silent no-op:
    // the mutation resolves, nothing switches, and the retry runs on the model
    // that just refused.
    const { result, switchToProfile, resend } = setup();

    act(() => {
      result.current.apply(
        { kind: "retry", model: "openai/gpt-5.6-sol", direction: "revert" },
        "do the thing",
        "anthropic/claude-opus-5",
      );
    });

    expect(switchToProfile).toHaveBeenCalledWith("GPT 5.6 Sol");
    expect(resend).toHaveBeenCalledWith("do the thing");
  });

  it("restores the original model after the retry's turn ends", () => {
    const { result, rerender, switchToProfile } = setup();

    act(() => {
      result.current.apply(
        { kind: "retry", model: "openai/gpt-5.6-sol", direction: "revert" },
        "do the thing",
        "anthropic/claude-opus-5",
      );
    });
    switchToProfile.mockClear();

    // The turn starts, then finishes.
    rerender({ isRunning: true });
    rerender({ isRunning: false });

    expect(switchToProfile).toHaveBeenCalledWith("Claude Opus 5");
  });

  it("does not restore before the retry has even begun", () => {
    // The choice is made while idle. Firing on that same idle state would put
    // the model back before the turn it is meant to outlive had started.
    const { result, switchToProfile } = setup();

    act(() => {
      result.current.apply(
        { kind: "retry", model: "openai/gpt-5.6-sol", direction: "revert" },
        "do the thing",
        "anthropic/claude-opus-5",
      );
    });
    switchToProfile.mockClear();

    expect(switchToProfile).not.toHaveBeenCalled();
  });

  it("keeps the fallback when sticky was chosen", () => {
    const { result, rerender, switchToProfile } = setup();

    act(() => {
      result.current.apply(
        { kind: "retry", model: "openai/gpt-5.6-sol", direction: "sticky" },
        "do the thing",
        "anthropic/claude-opus-5",
      );
    });
    switchToProfile.mockClear();

    rerender({ isRunning: true });
    rerender({ isRunning: false });

    expect(switchToProfile).not.toHaveBeenCalled();
  });

  it("restores only once, not on every later idle", () => {
    const { result, rerender, switchToProfile } = setup();

    act(() => {
      result.current.apply(
        { kind: "retry", model: "openai/gpt-5.6-sol", direction: "revert" },
        "do the thing",
        "anthropic/claude-opus-5",
      );
    });
    switchToProfile.mockClear();

    rerender({ isRunning: true });
    rerender({ isRunning: false });
    expect(switchToProfile).toHaveBeenCalledTimes(1);

    // A later, unrelated turn must not switch the model again.
    rerender({ isRunning: true });
    rerender({ isRunning: false });
    expect(switchToProfile).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all for edit or cancel", () => {
    const { result, rerender, switchToProfile, resend } = setup();

    act(() => {
      result.current.apply({ kind: "edit" }, "x", "anthropic/claude-opus-5");
      result.current.apply({ kind: "cancel" }, "x", "anthropic/claude-opus-5");
    });
    rerender({ isRunning: true });
    rerender({ isRunning: false });

    expect(switchToProfile).not.toHaveBeenCalled();
    expect(resend).not.toHaveBeenCalled();
  });

  it("refuses to act on a model the catalog does not know", () => {
    // Better to do nothing than to resend on the model that just refused.
    const { result, switchToProfile, resend } = setup();

    act(() => {
      result.current.apply(
        { kind: "retry", model: "who/knows", direction: "revert" },
        "do the thing",
        "anthropic/claude-opus-5",
      );
    });

    expect(switchToProfile).not.toHaveBeenCalled();
    expect(resend).not.toHaveBeenCalled();
  });
});
