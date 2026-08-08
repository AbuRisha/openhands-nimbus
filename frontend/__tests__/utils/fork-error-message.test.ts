import { describe, it, expect } from "vitest";
import {
  forkErrorKey,
  shouldWarnAboutHalves,
} from "#/utils/fork-error-message";
import { I18nKey } from "#/i18n/declaration";

describe("forkErrorKey", () => {
  /**
   * THE THREE STATUSES MEAN DIFFERENT THINGS AND MUST NOT COLLAPSE. The
   * endpoint distinguishes them deliberately; flattening them into "something
   * went wrong" throws away the only actionable part.
   */
  it("404 says there is nothing to retry from", () => {
    expect(forkErrorKey(404)).toBe(I18nKey.FORK$ERROR_NOT_FOUND);
  });

  it("409 says START the environment, not RETRY", () => {
    // The sandbox is not RUNNING and the fork must read its state. "Try again"
    // is wrong advice here and loops forever.
    expect(forkErrorKey(409)).toBe(I18nKey.FORK$ERROR_SANDBOX_NOT_RUNNING);
  });

  it("502 warns that a conversation EXISTS and is incomplete", () => {
    // The dangerous one. The target started but could not be populated, so
    // telling the user to retry leaves an untrustworthy conversation behind
    // with nothing flagging it.
    expect(forkErrorKey(502)).toBe(I18nKey.FORK$ERROR_PARTIAL);
  });

  it("falls back for anything else, including no status at all", () => {
    expect(forkErrorKey(500)).toBe(I18nKey.FORK$ERROR_GENERIC);
    expect(forkErrorKey(undefined)).toBe(I18nKey.FORK$ERROR_GENERIC);
  });

  it("maps the three known statuses to three DISTINCT messages", () => {
    const keys = [404, 409, 502].map(forkErrorKey);
    expect(new Set(keys).size).toBe(3);
  });
});

describe("shouldWarnAboutHalves", () => {
  /**
   * THESE TESTS PASS AND THE FUNCTION IS NOT SAFE TO USE. They assert the
   * mapping from the flag to the warning, which is correct; the flag itself is
   * meaningless, because `halves_agree` compares counts across two stores
   * holding different event KINDS and so is false on healthy forks too.
   *
   * Nothing in the frontend could have caught that — it took a fork against a
   * live sandbox. Kept green because the mapping is what should happen once the
   * server reports something real; `use-fork-conversation.ts` does not call it
   * in the meantime.
   */
  it("warns when the two halves were cut at different points", () => {
    expect(shouldWarnAboutHalves({ halves_agree: false })).toBe(true);
  });

  it("stays quiet when they agree", () => {
    expect(shouldWarnAboutHalves({ halves_agree: true })).toBe(false);
  });
});
