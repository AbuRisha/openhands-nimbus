import { OpenHandsEvent } from "#/types/v1/core";

/**
 * Where output stops being shown.
 *
 * Was 1000, which is roughly a screenful — so a test run, a build log or a
 * long file view was cut mid-sentence and the reader had no way to tell
 * whether the important line was in the part they got. 12,000 covers the
 * overwhelming majority of real tool output while still bounding a runaway
 * process that prints megabytes.
 *
 * The number is the smaller half of this fix. What mattered was that the old
 * behaviour appended a bare "..." and said nothing about how much it had
 * taken, so amputation was indistinguishable from the command simply ending
 * there. `truncateForDisplay` below never does that.
 */
export const MAX_CONTENT_LENGTH = 12_000;

/**
 * Cut long output, and SAY SO in terms the reader can act on.
 *
 * Returns the text unchanged when it fits, so callers can use it
 * unconditionally without a length check of their own — which is what let the
 * old inline `slice(0, N) + "..."` drift into seventeen separate call sites,
 * two of which said "...(truncated)" and the rest said nothing at all.
 */
export const truncateForDisplay = (text: string): string => {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  const omitted = text.length - MAX_CONTENT_LENGTH;
  const notice = `_… ${omitted.toLocaleString()} more characters not shown._`;
  return [text.slice(0, MAX_CONTENT_LENGTH), "", notice].join("\n");
};

export const getDefaultEventContent = (event: OpenHandsEvent): string =>
  `\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``;
