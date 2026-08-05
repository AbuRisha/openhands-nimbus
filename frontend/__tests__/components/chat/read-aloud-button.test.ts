import { describe, expect, it } from "vitest";
import { speakableText } from "#/components/features/chat/read-aloud-button";

describe("speakableText", () => {
  it("replaces fenced code with a spoken placeholder", () => {
    const out = speakableText("Try this:\n```py\nprint('hi')\n```\ndone");
    expect(out).not.toContain("print");
    expect(out).toContain("Code omitted");
  });

  it("keeps link text and drops the target", () => {
    // A TTS model reading a raw URL spells it character by character.
    expect(speakableText("see [the docs](https://example.com/a/b)")).toBe(
      "see the docs",
    );
  });

  it("drops images entirely", () => {
    expect(speakableText("before ![alt text](img.png) after")).toBe(
      "before after",
    );
  });

  it("strips heading, quote, list and emphasis markers", () => {
    expect(speakableText("## Title")).toBe("Title");
    expect(speakableText("> quoted")).toBe("quoted");
    expect(speakableText("- one\n- two")).toBe("one two");
    expect(speakableText("**bold** and _italic_")).toBe("bold and italic");
  });

  it("turns table pipes into pauses rather than reading them", () => {
    expect(speakableText("| a | b |")).toBe(", a , b ,");
  });

  it("unwraps inline code without announcing it", () => {
    expect(speakableText("run `npm test` now")).toBe("run npm test now");
  });

  it("collapses whitespace so pauses are not doubled", () => {
    expect(speakableText("a\n\n\nb   c")).toBe("a b c");
  });

  it("returns empty for content with nothing speakable", () => {
    // The button uses this to decide whether to do anything at all.
    expect(speakableText("```\ncode only\n```")).toBe("Code omitted.");
    expect(speakableText("   ")).toBe("");
  });
});
