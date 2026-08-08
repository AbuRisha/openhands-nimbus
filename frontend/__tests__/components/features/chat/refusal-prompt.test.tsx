import { render, screen, fireEvent, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { RefusalPrompt } from "#/components/features/chat/refusal-prompt";
import { REFUSAL_PROMPT_TIMEOUT_MS } from "#/utils/refusal-failover";

/**
 * The costly failures here are silent ones: a session that quietly changes
 * model for good, and a prompt that never answers itself and holds a turn open
 * looking hung.
 */

const FALLBACK = { name: "GPT 5.6 Sol", model: "openai/gpt-5.6-sol" };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RefusalPrompt", () => {
  it("keeps the two retries as separate choices", () => {
    // Collapsing them is how a session silently ends up on a model nobody
    // chose. Changing your model for good must always be a decision.
    const onChoose = vi.fn();
    render(
      <RefusalPrompt
        refusedModel="Claude Opus 5"
        fallback={FALLBACK}
        onChoose={onChoose}
      />,
    );

    expect(screen.getByTestId("refusal-retry-once")).toBeInTheDocument();
    expect(screen.getByTestId("refusal-retry-sticky")).toBeInTheDocument();
  });

  it("scopes the ordinary retry to this turn", () => {
    const onChoose = vi.fn();
    render(
      <RefusalPrompt
        refusedModel="Claude Opus 5"
        fallback={FALLBACK}
        onChoose={onChoose}
      />,
    );

    fireEvent.click(screen.getByTestId("refusal-retry-once"));

    expect(onChoose).toHaveBeenCalledWith({
      kind: "retry",
      model: "openai/gpt-5.6-sol",
      direction: "revert",
    });
  });

  it("only sticks when that was chosen explicitly", () => {
    const onChoose = vi.fn();
    render(
      <RefusalPrompt
        refusedModel="Claude Opus 5"
        fallback={FALLBACK}
        onChoose={onChoose}
      />,
    );

    fireEvent.click(screen.getByTestId("refusal-retry-sticky"));

    expect(onChoose).toHaveBeenCalledWith({
      kind: "retry",
      model: "openai/gpt-5.6-sol",
      direction: "sticky",
    });
  });

  it("offers edit and cancel", () => {
    const onChoose = vi.fn();
    render(
      <RefusalPrompt
        refusedModel="Claude Opus 5"
        fallback={FALLBACK}
        onChoose={onChoose}
      />,
    );

    fireEvent.click(screen.getByTestId("refusal-edit"));
    expect(onChoose).toHaveBeenCalledWith({ kind: "edit" });

    fireEvent.click(screen.getByTestId("refusal-cancel"));
    expect(onChoose).toHaveBeenCalledWith({ kind: "cancel" });
  });

  it("offers no retry at all when there is nothing different to try", () => {
    // Better to say so than to offer the model that just refused.
    const onChoose = vi.fn();
    render(
      <RefusalPrompt
        refusedModel="Claude Opus 5"
        fallback={null}
        onChoose={onChoose}
      />,
    );

    expect(screen.queryByTestId("refusal-retry-once")).toBeNull();
    expect(screen.queryByTestId("refusal-retry-sticky")).toBeNull();
    expect(screen.getByTestId("refusal-cancel")).toBeInTheDocument();
  });

  it("answers itself with cancel rather than holding the turn open", () => {
    const onChoose = vi.fn();
    render(
      <RefusalPrompt
        refusedModel="Claude Opus 5"
        fallback={FALLBACK}
        onChoose={onChoose}
      />,
    );

    expect(onChoose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(REFUSAL_PROMPT_TIMEOUT_MS);
    });

    expect(onChoose).toHaveBeenCalledWith({ kind: "cancel" });
  });

  it("does not restart its countdown when the parent re-renders", () => {
    // The parent re-renders constantly while a response streams. With onChoose
    // in the effect's deps the timer would reset every time and the prompt
    // would never self-answer — a bug that only shows up after five minutes of
    // an unattended session, which is exactly when nobody is watching.
    const onChoose = vi.fn();
    const { rerender } = render(
      <RefusalPrompt
        refusedModel="Claude Opus 5"
        fallback={FALLBACK}
        onChoose={onChoose}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(REFUSAL_PROMPT_TIMEOUT_MS / 2);
    });
    // A brand-new callback identity, as an inline arrow would produce.
    rerender(
      <RefusalPrompt
        refusedModel="Claude Opus 5"
        fallback={FALLBACK}
        onChoose={(...args) => onChoose(...args)}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(REFUSAL_PROMPT_TIMEOUT_MS / 2);
    });

    expect(onChoose).toHaveBeenCalledWith({ kind: "cancel" });
  });

  it("labels itself for screen readers rather than being an anonymous group", () => {
    // The refused model goes through t(..., { model }) for interpolation, and
    // the suite's i18n mock returns bare keys — so asserting the model NAME
    // here would be testing the mock. What is worth pinning is that the group
    // carries a label at all: a bare div of four buttons is unusable to anyone
    // not looking at the screen.
    render(
      <RefusalPrompt
        refusedModel="Claude Opus 5"
        fallback={FALLBACK}
        onChoose={vi.fn()}
      />,
    );

    const group = screen.getByTestId("refusal-prompt");
    expect(group).toHaveAttribute("role", "group");
    expect(group.getAttribute("aria-label")).toBeTruthy();
  });
});
