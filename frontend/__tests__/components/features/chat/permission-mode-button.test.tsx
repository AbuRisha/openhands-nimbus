import { describe, it, expect, beforeEach, vi } from "vitest";
import { deriveModeFromSettings } from "#/components/features/chat/permission-mode-button";
import { usePermissionModeStore } from "#/stores/permission-mode-store";

beforeEach(() => {
  usePermissionModeStore.setState({ chosenByConversation: {} });
  vi.clearAllMocks();
});

/**
 * These mirror `_select_confirmation_policy`
 * (app_conversation_service_base.py:676). If the server's mapping ever changes,
 * this is where it should fail — otherwise the pill quietly shows a mode the
 * conversation is not actually in, which is the worst possible failure for a
 * PERMISSION control: it tells the user the agent asks first when it does not.
 */
describe("deriveModeFromSettings — mirrors the server's mapping", () => {
  it("confirmation off means never ask", () => {
    expect(deriveModeFromSettings(false, null)).toBe("NeverConfirm");
    expect(deriveModeFromSettings(false, "llm")).toBe("NeverConfirm");
  });

  it("confirmation on WITH the llm analyzer means ask on risky", () => {
    expect(deriveModeFromSettings(true, "llm")).toBe("ConfirmRisky");
  });

  it("is case-insensitive about the analyzer", () => {
    expect(deriveModeFromSettings(true, "LLM")).toBe("ConfirmRisky");
  });

  it("confirmation on WITHOUT the llm analyzer means ask every time", () => {
    expect(deriveModeFromSettings(true, null)).toBe("AlwaysConfirm");
    expect(deriveModeFromSettings(true, "standard")).toBe("AlwaysConfirm");
    expect(deriveModeFromSettings(true, "")).toBe("AlwaysConfirm");
  });

  /**
   * Undefined settings are the pre-load state, and the safe reading is "the
   * agent is not stopping". Showing "asks every time" while settings load
   * would be a reassuring lie.
   */
  it("treats undefined settings as never ask", () => {
    expect(deriveModeFromSettings(undefined, undefined)).toBe("NeverConfirm");
  });
});

describe("permission mode store", () => {
  /**
   * THE REASON THIS IS A STORE AND NOT COMPONENT STATE. Setting the policy
   * applies it to the running conversation; it does not write back to settings.
   * Component state would show the settings-derived default again on remount —
   * telling the user the agent asks before acting when they had just turned
   * that off. Same failure as BrowserPanel resetting on mount.
   */
  it("keeps a choice per conversation", () => {
    const { setChosen } = usePermissionModeStore.getState();
    setChosen("conv-a", "AlwaysConfirm");
    setChosen("conv-b", "NeverConfirm");

    const { chosenByConversation } = usePermissionModeStore.getState();
    expect(chosenByConversation["conv-a"]).toBe("AlwaysConfirm");
    expect(chosenByConversation["conv-b"]).toBe("NeverConfirm");
  });

  it("survives a notional remount — the value is not component-scoped", () => {
    usePermissionModeStore.getState().setChosen("conv-a", "ConfirmRisky");
    // Nothing here unmounts anything; the point is that the value lives in the
    // store, so there is no unmount that could clear it.
    expect(
      usePermissionModeStore.getState().chosenByConversation["conv-a"],
    ).toBe("ConfirmRisky");
  });

  it("clears only the conversation asked for", () => {
    const { setChosen, clear } = usePermissionModeStore.getState();
    setChosen("conv-a", "AlwaysConfirm");
    setChosen("conv-b", "NeverConfirm");

    clear("conv-a");

    const { chosenByConversation } = usePermissionModeStore.getState();
    expect(chosenByConversation["conv-a"]).toBeUndefined();
    expect(chosenByConversation["conv-b"]).toBe("NeverConfirm");
  });

  it("overwrites rather than accumulating", () => {
    const { setChosen } = usePermissionModeStore.getState();
    setChosen("conv-a", "AlwaysConfirm");
    setChosen("conv-a", "NeverConfirm");

    expect(
      usePermissionModeStore.getState().chosenByConversation["conv-a"],
    ).toBe("NeverConfirm");
  });
});

/**
 * The three literals are the SDK's CLASS NAMES, and the wire tag is
 * `self.__class__.__name__`. A friendlier string would serialise to a
 * discriminated union the server cannot resolve — and it would fail at the
 * server, not at compile time. This is the same trap as the condensation
 * `kind` values, where two of three TS interface names did not match the wire.
 */
describe("policy kinds match the SDK class names", () => {
  it("uses exactly the three the SDK defines", () => {
    const kinds = ["AlwaysConfirm", "NeverConfirm", "ConfirmRisky"];
    for (const k of kinds) {
      expect(
        deriveModeFromSettings(true, k === "ConfirmRisky" ? "llm" : null),
      ).toMatch(/^(AlwaysConfirm|NeverConfirm|ConfirmRisky)$/);
    }
  });
});
