import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { ChatStopButton } from "#/components/features/chat/chat-stop-button";

/**
 * Escape interrupts the run.
 *
 * It did not, for the only case that matters. The guard below this treated any
 * contentEditable element as "a text field the user is editing, leave it
 * alone" — and the composer IS a contentEditable div that holds focus for the
 * entire time an agent is running. So the one shortcut people reach for when a
 * run goes wrong was silently impossible, in exactly the state where they'd
 * want it. Nothing errored; the key just did nothing.
 */

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** Focus a contentEditable standing in for the real composer. */
function mountComposer(testId = "chat-input") {
  const el = document.createElement("div");
  el.setAttribute("contenteditable", "true");
  el.setAttribute("data-testid", testId);
  // jsdom does not derive isContentEditable from the attribute.
  Object.defineProperty(el, "isContentEditable", { value: true });
  document.body.appendChild(el);
  el.focus();
  Object.defineProperty(document, "activeElement", {
    value: el,
    configurable: true,
  });
  return el;
}

const pressEscape = (init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document, { key: "Escape", ...init });

describe("ChatStopButton", () => {
  it("stops the agent on Escape while the composer has focus", () => {
    const handleStop = vi.fn();
    render(<ChatStopButton handleStop={handleStop} />);
    mountComposer();

    pressEscape();

    expect(handleStop).toHaveBeenCalledTimes(1);
  });

  it("still leaves Escape alone in other text fields", () => {
    // A search box or a rename field owns its own Escape; only the composer is
    // exempt, because only the composer is focused during a run.
    const handleStop = vi.fn();
    render(<ChatStopButton handleStop={handleStop} />);

    const input = document.createElement("input");
    document.body.appendChild(input);
    Object.defineProperty(document, "activeElement", {
      value: input,
      configurable: true,
    });

    pressEscape();

    expect(handleStop).not.toHaveBeenCalled();
  });

  it("does not also stop the agent when something already handled the key", () => {
    // The slash menu closes on Escape and calls preventDefault WITHOUT
    // stopping propagation. Without the defaultPrevented check, one press
    // would close the menu and kill the run in the same breath.
    const handleStop = vi.fn();
    render(<ChatStopButton handleStop={handleStop} />);
    mountComposer();

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    document.dispatchEvent(event);

    expect(handleStop).not.toHaveBeenCalled();
  });

  it("lets an open dialog close first", () => {
    const handleStop = vi.fn();
    render(<ChatStopButton handleStop={handleStop} />);
    mountComposer();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);

    pressEscape();

    expect(handleStop).not.toHaveBeenCalled();
  });

  it("ignores keys that are not Escape", () => {
    const handleStop = vi.fn();
    render(<ChatStopButton handleStop={handleStop} />);
    mountComposer();

    fireEvent.keyDown(document, { key: "a" });

    expect(handleStop).not.toHaveBeenCalled();
  });

  it("still stops when the button itself is clicked", () => {
    const handleStop = vi.fn();
    render(<ChatStopButton handleStop={handleStop} />);

    fireEvent.click(screen.getByTestId("stop-button"));

    expect(handleStop).toHaveBeenCalledTimes(1);
  });
});
