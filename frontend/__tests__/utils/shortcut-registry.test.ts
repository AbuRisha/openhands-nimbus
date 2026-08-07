import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ShortcutLayer,
  registerShortcut,
  clearShortcutsForTest,
} from "#/utils/shortcut-registry";

const press = (
  key: string,
  init: Partial<KeyboardEventInit> & { target?: HTMLElement } = {},
) => {
  const { target, ...rest } = init;
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...rest,
  });
  (target ?? document.body).dispatchEvent(event);
  return event;
};

beforeEach(() => {
  clearShortcutsForTest();
  document.body.innerHTML = "";
});

describe("shortcut registry", () => {
  /**
   * THE BUG THIS EXISTS FOR.
   *
   * `chat-interface` gates its Cmd+Enter on `isAgentRunning`, which is only
   * RUNNING or LOADING. AWAITING_USER_CONFIRMATION is neither, so both owners
   * of Cmd+Enter were mounted at once and a single keystroke both approved the
   * pending tool call and kicked off a plan build.
   *
   * Against seven independent `document` listeners this test fails: both spies
   * are called. It passes only because dispatch is exclusive.
   */
  it("fires only the highest-priority owner of a chord", () => {
    const build = vi.fn();
    const approve = vi.fn();

    registerShortcut({
      chord: { key: "Enter", mod: true },
      handler: build,
      priority: ShortcutLayer.COMPOSER,
    });
    registerShortcut({
      chord: { key: "Enter", mod: true },
      handler: approve,
      priority: ShortcutLayer.CONFIRMATION,
    });

    press("Enter", { metaKey: true });

    expect(approve).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
  });

  /** The Escape collision: a menu inside a modal closed both at once. */
  it("gives Escape to the innermost surface", () => {
    const closeModal = vi.fn();
    const closeMenu = vi.fn();

    registerShortcut({
      chord: { key: "Escape" },
      handler: closeModal,
      priority: ShortcutLayer.MODAL,
    });
    registerShortcut({
      chord: { key: "Escape" },
      handler: closeMenu,
      priority: ShortcutLayer.MENU,
    });

    press("Escape");

    expect(closeMenu).toHaveBeenCalledTimes(1);
    expect(closeModal).not.toHaveBeenCalled();
  });

  /**
   * A skipped handler must not CONSUME the chord. If the higher layer is
   * inactive the lower one still has to run, otherwise closing a menu would
   * leave Escape dead until the modal remounted.
   */
  it("falls through to a lower layer when the higher one is inactive", () => {
    const closeModal = vi.fn();
    const closeMenu = vi.fn();

    registerShortcut({
      chord: { key: "Escape" },
      handler: closeModal,
      priority: ShortcutLayer.MODAL,
    });
    registerShortcut({
      chord: { key: "Escape" },
      handler: closeMenu,
      priority: ShortcutLayer.MENU,
      when: () => false,
    });

    press("Escape");

    expect(closeMenu).not.toHaveBeenCalled();
    expect(closeModal).toHaveBeenCalledTimes(1);
  });

  it("re-reads `when` at keypress time, not at registration", () => {
    const handler = vi.fn();
    let active = false;

    registerShortcut({
      chord: { key: "Escape" },
      handler,
      priority: ShortcutLayer.MODAL,
      when: () => active,
    });

    press("Escape");
    expect(handler).not.toHaveBeenCalled();

    active = true;
    press("Escape");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  describe("typing", () => {
    it("does not steal an unmodified key from an input", () => {
      const handler = vi.fn();
      const input = document.createElement("input");
      document.body.appendChild(input);

      registerShortcut({
        chord: { key: "k" },
        handler,
        priority: ShortcutLayer.GLOBAL,
      });

      press("k", { target: input });
      expect(handler).not.toHaveBeenCalled();
    });

    it("still delivers a MODIFIED chord from an input", () => {
      // Cmd+Enter inside the composer textarea is the normal way to send, so
      // the typing guard must not swallow it.
      const handler = vi.fn();
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);

      registerShortcut({
        chord: { key: "Enter", mod: true },
        handler,
        priority: ShortcutLayer.COMPOSER,
      });

      press("Enter", { metaKey: true, target: textarea });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("honours allowInInput for unmodified keys", () => {
      const handler = vi.fn();
      const input = document.createElement("input");
      document.body.appendChild(input);

      registerShortcut({
        chord: { key: "Escape" },
        handler,
        priority: ShortcutLayer.MODAL,
        allowInInput: true,
      });

      press("Escape", { target: input });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("treats contentEditable as typing", () => {
      const handler = vi.fn();
      const div = document.createElement("div");
      div.contentEditable = "true";
      // jsdom does not derive isContentEditable from the attribute.
      Object.defineProperty(div, "isContentEditable", { value: true });
      document.body.appendChild(div);

      registerShortcut({
        chord: { key: "k" },
        handler,
        priority: ShortcutLayer.GLOBAL,
      });

      press("k", { target: div });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("chord matching", () => {
    it("requires the modifier when the chord asks for one", () => {
      const handler = vi.fn();
      registerShortcut({
        chord: { key: "Enter", mod: true },
        handler,
        priority: ShortcutLayer.COMPOSER,
      });

      press("Enter");
      expect(handler).not.toHaveBeenCalled();
    });

    it("accepts Ctrl as `mod` for non-Mac", () => {
      const handler = vi.fn();
      registerShortcut({
        chord: { key: "Enter", mod: true },
        handler,
        priority: ShortcutLayer.COMPOSER,
      });

      press("Enter", { ctrlKey: true });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("distinguishes Shift+Cmd+Backspace from Cmd+Backspace", () => {
      const withShift = vi.fn();
      registerShortcut({
        chord: { key: "Backspace", mod: true, shift: true },
        handler: withShift,
        priority: ShortcutLayer.CONFIRMATION,
      });

      press("Backspace", { metaKey: true });
      expect(withShift).not.toHaveBeenCalled();

      press("Backspace", { metaKey: true, shiftKey: true });
      expect(withShift).toHaveBeenCalledTimes(1);
    });

    it("ignores autorepeat", () => {
      // A held key is one intent. Approving a tool call twice because the
      // keystroke repeated is the failure this guards.
      const handler = vi.fn();
      registerShortcut({
        chord: { key: "Enter", mod: true },
        handler,
        priority: ShortcutLayer.CONFIRMATION,
      });

      press("Enter", { metaKey: true, repeat: true });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it("unregisters on cleanup", () => {
    const handler = vi.fn();
    const off = registerShortcut({
      chord: { key: "Escape" },
      handler,
      priority: ShortcutLayer.MODAL,
    });

    off();
    press("Escape");
    expect(handler).not.toHaveBeenCalled();
  });

  it("calls preventDefault by default and respects opting out", () => {
    registerShortcut({
      chord: { key: "Enter", mod: true },
      handler: () => {},
      priority: ShortcutLayer.COMPOSER,
    });
    expect(press("Enter", { metaKey: true }).defaultPrevented).toBe(true);

    clearShortcutsForTest();
    registerShortcut({
      chord: { key: "Enter", mod: true },
      handler: () => {},
      priority: ShortcutLayer.COMPOSER,
      preventDefault: false,
    });
    expect(press("Enter", { metaKey: true }).defaultPrevented).toBe(false);
  });
});
