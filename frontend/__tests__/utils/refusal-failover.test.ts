import { describe, it, expect } from "vitest";
import {
  looksLikeRefusal,
  chooseFallback,
  modelToRestoreAfterTurn,
  REFUSAL_PROMPT_TIMEOUT_MS,
  FailoverChoice,
} from "#/utils/refusal-failover";

/**
 * The expensive mistakes here are asymmetric, and the tests are written around
 * that rather than around coverage.
 *
 * Calling a real answer a refusal offers to re-run a turn that already worked,
 * and bills for it. Offering a same-vendor fallback burns a second paid turn to
 * be told no twice. Forgetting the revert silently changes the model for the
 * rest of a session and the only evidence is a bill.
 */

const CATALOG = [
  { name: "Claude Opus 5", model: "anthropic/claude-opus-5" },
  { name: "Claude Sonnet 5", model: "anthropic/claude-sonnet-5" },
  { name: "GPT 5.6 Sol", model: "openai/gpt-5.6-sol" },
];

describe("looksLikeRefusal", () => {
  it("recognises a refusal", () => {
    expect(looksLikeRefusal("I can't help with that.")).toBe(true);
    expect(looksLikeRefusal("I must decline this request.")).toBe(true);
  });

  it("survives the curly apostrophe every model actually emits", () => {
    // A marker list written with a straight quote silently fails on real
    // output, which would defeat the whole feature without failing anything.
    expect(looksLikeRefusal("I can’t assist with that")).toBe(true);
  });

  it("ignores case and collapsed whitespace", () => {
    expect(looksLikeRefusal("I  CAN'T   HELP WITH\nthat")).toBe(true);
  });

  it("does not fire on an ordinary answer", () => {
    // The costly direction: re-running a turn that already succeeded.
    expect(looksLikeRefusal("Here's the refactored function.")).toBe(false);
    expect(looksLikeRefusal("I can help with that.")).toBe(false);
    expect(looksLikeRefusal("")).toBe(false);
    expect(looksLikeRefusal(null)).toBe(false);
  });
});

describe("chooseFallback", () => {
  it("prefers a different provider", () => {
    // Two models from one vendor share a policy; retrying Opus on Sonnet is
    // the least likely thing to change the answer.
    const pick = chooseFallback("anthropic/claude-opus-5", CATALOG);

    expect(pick?.model).toBe("openai/gpt-5.6-sol");
  });

  it("falls back to a same-provider model when that is all there is", () => {
    const pick = chooseFallback("anthropic/claude-opus-5", CATALOG.slice(0, 2));

    expect(pick?.model).toBe("anthropic/claude-sonnet-5");
  });

  it("never offers the model that just refused", () => {
    const pick = chooseFallback("openai/gpt-5.6-sol", CATALOG);

    expect(pick?.model).not.toBe("openai/gpt-5.6-sol");
  });

  it("returns null rather than inventing a choice", () => {
    expect(chooseFallback("openai/gpt-5.6-sol", [])).toBeNull();
    expect(
      chooseFallback("openai/gpt-5.6-sol", [
        { name: "GPT 5.6 Sol", model: "openai/gpt-5.6-sol" },
      ]),
    ).toBeNull();
  });

  it("still picks something when the current model is unknown", () => {
    expect(chooseFallback(null, CATALOG)?.model).toBe(
      "anthropic/claude-opus-5",
    );
  });
});

describe("modelToRestoreAfterTurn", () => {
  const retry = (direction: "revert" | "sticky"): FailoverChoice => ({
    kind: "retry",
    model: "openai/gpt-5.6-sol",
    direction,
  });

  it("restores the original after a reverting retry", () => {
    // The whole point: one refusal must not quietly change the model for every
    // remaining turn, with a bill as the only evidence.
    expect(
      modelToRestoreAfterTurn(retry("revert"), "anthropic/claude-opus-5"),
    ).toBe("anthropic/claude-opus-5");
  });

  it("keeps the fallback when the customer chose sticky", () => {
    expect(
      modelToRestoreAfterTurn(retry("sticky"), "anthropic/claude-opus-5"),
    ).toBeNull();
  });

  it("restores nothing when the model never moved", () => {
    expect(
      modelToRestoreAfterTurn(retry("revert"), "openai/gpt-5.6-sol"),
    ).toBeNull();
    expect(modelToRestoreAfterTurn(retry("revert"), null)).toBeNull();
  });

  it("restores nothing for edit or cancel, which never switched", () => {
    expect(
      modelToRestoreAfterTurn({ kind: "edit" }, "anthropic/claude-opus-5"),
    ).toBeNull();
    expect(
      modelToRestoreAfterTurn({ kind: "cancel" }, "anthropic/claude-opus-5"),
    ).toBeNull();
  });
});

describe("REFUSAL_PROMPT_TIMEOUT_MS", () => {
  it("gives up after five minutes rather than holding the turn open", () => {
    // An unattended session would otherwise sit on an unanswered question
    // indefinitely, looking hung. Cancel is the safe self-answer: it is the
    // only option that spends nothing and changes nothing.
    expect(REFUSAL_PROMPT_TIMEOUT_MS).toBe(300_000);
  });
});
