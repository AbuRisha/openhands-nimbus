/**
 * Find a trigger word ("@file", "/command") at the cursor.
 *
 * Extracted as a pure function because the subtle part of an in-composer menu
 * is not the menu — it is knowing WHICH characters the user meant and which
 * ones to replace on selection. Getting the range wrong wipes the rest of the
 * message, and that is not something a component test notices.
 *
 * `use-slash-command` has an equivalent inline. It is deliberately NOT
 * refactored onto this: it works, it is load-bearing, and rewriting it to
 * share code would put a working composer at risk for tidiness. If it is
 * touched for another reason, this is the thing to migrate it to — the two
 * drifting apart is the real cost, and it is worth paying attention to rather
 * than paying now.
 */

export interface TriggerWord {
  /** Text after the trigger character, e.g. "src/ap" for "@src/ap". */
  query: string;
  /** Offset of the trigger character itself, within the full text. */
  start: number;
  /**
   * End of the word, which extends PAST the cursor.
   *
   * A cursor sitting mid-word still means the whole word: replacing only up to
   * the caret would leave the tail behind, so "@src|.ts" becomes
   * "@src/app.ts.ts".
   */
  end: number;
}

/**
 * @param text  full composer text
 * @param cursor character offset of the caret
 * @param trigger single character, e.g. "@"
 */
export function findTriggerWord(
  text: string,
  cursor: number,
  trigger: string,
): TriggerWord | null {
  if (cursor < 0 || cursor > text.length) return null;

  const before = text.slice(0, cursor);
  // The trigger must start a word: at position 0 or after whitespace.
  // Without that, an email address opens a file picker on every keystroke.
  const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = before.match(new RegExp(`(^|\\s)(${escaped}\\S*)$`));
  if (!match) return null;

  const word = match[2];
  const start = before.length - word.length;
  const trailing = text.slice(cursor).match(/^\S*/);
  const end = cursor + (trailing ? trailing[0].length : 0);

  return { query: word.slice(trigger.length), start, end };
}

/**
 * Splice a replacement over the trigger word, returning the new text and where
 * the caret belongs.
 *
 * Returns the caret position rather than moving it: this stays pure so it can
 * be tested without a DOM, and the caller owns the selection API.
 */
export function replaceTriggerWord(
  text: string,
  word: TriggerWord,
  replacement: string,
): { text: string; cursor: number } {
  return {
    text: text.slice(0, word.start) + replacement + text.slice(word.end),
    cursor: word.start + replacement.length,
  };
}
