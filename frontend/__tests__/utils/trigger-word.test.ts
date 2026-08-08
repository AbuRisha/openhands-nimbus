import { describe, it, expect } from "vitest";
import { findTriggerWord, replaceTriggerWord } from "#/utils/trigger-word";

const at = (text: string, cursor = text.length) =>
  findTriggerWord(text, cursor, "@");

describe("findTriggerWord", () => {
  it("finds a trigger at the start of the input", () => {
    expect(at("@src")).toMatchObject({ query: "src", start: 0, end: 4 });
  });

  it("finds a trigger after whitespace", () => {
    expect(at("look at @src/app")).toMatchObject({ query: "src/app" });
  });

  it("returns null with no trigger", () => {
    expect(at("just typing")).toBe(null);
  });

  it("returns null for a bare trigger character mid-word", () => {
    // An email address must not open a file picker on every keystroke.
    expect(at("mail me at erick@example.com")).toBe(null);
  });

  it("matches the trigger with no query yet", () => {
    // The menu should open the moment "@" is typed, not on the first letter.
    expect(at("@")).toMatchObject({ query: "", start: 0, end: 1 });
  });

  it("only considers the word the cursor is in", () => {
    // Cursor after "@one", with "@two" later in the text.
    expect(findTriggerWord("@one @two", 4, "@")).toMatchObject({
      query: "one",
      start: 0,
      end: 4,
    });
  });

  it("extends the end PAST the cursor for a mid-word caret", () => {
    // "@src|.ts" — replacing only to the caret would leave ".ts" behind and
    // produce "@src/app.ts.ts".
    const word = findTriggerWord("@src.ts", 4, "@");

    expect(word).toMatchObject({ query: "src", start: 0, end: 7 });
  });

  it("stops at whitespace after the trigger", () => {
    // "@file " has been completed; the menu must not re-open on it.
    expect(at("@file ")).toBe(null);
  });

  it("returns null for an out-of-range cursor", () => {
    expect(findTriggerWord("@src", 99, "@")).toBe(null);
    expect(findTriggerWord("@src", -1, "@")).toBe(null);
  });

  it("works for other trigger characters", () => {
    expect(findTriggerWord("/dep", 4, "/")).toMatchObject({ query: "dep" });
  });

  it("does not treat a regex metacharacter trigger as a pattern", () => {
    // A trigger of "." must match a literal dot, not "any character".
    expect(findTriggerWord("abc", 3, ".")).toBe(null);
    expect(findTriggerWord(".env", 4, ".")).toMatchObject({ query: "env" });
  });
});

describe("replaceTriggerWord", () => {
  it("replaces only the trigger word, keeping the rest of the message", () => {
    const text = "please read @src and tell me";
    const word = findTriggerWord(text, 16, "@")!;

    expect(replaceTriggerWord(text, word, "@src/app.ts ")).toEqual({
      text: "please read @src/app.ts  and tell me",
      cursor: 24,
    });
  });

  it("puts the caret after the replacement", () => {
    const word = findTriggerWord("@s", 2, "@")!;
    const out = replaceTriggerWord("@s", word, "@src/app.ts ");

    expect(out.text.slice(0, out.cursor)).toBe("@src/app.ts ");
  });

  it("consumes the tail when the caret was mid-word", () => {
    const text = "@src.ts";
    const word = findTriggerWord(text, 4, "@")!;

    expect(replaceTriggerWord(text, word, "@a.ts ").text).toBe("@a.ts ");
  });
});
