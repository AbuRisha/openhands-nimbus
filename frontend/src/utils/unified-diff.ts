/**
 * Turn a before/after pair into a unified diff.
 *
 * WHY THIS EXISTS
 * ---------------
 * A file edit used to render as the whole new file in a plain code block. That
 * is technically the truth and practically useless: the one thing a reader
 * wants — what changed — is the one thing it does not say, and a two-line edit
 * to a 400-line file printed 400 lines to hide it. Reviewing the agent's work
 * IS the loop, so the transcript has to answer "what did it do" without being
 * read line by line.
 *
 * Output is a ```diff block, which the markdown code renderer already colours
 * through Prism. No new dependency, no new rendering path.
 *
 * SPEED, AND WHY IT IS NOT A PROBLEM
 * ----------------------------------
 * A naive LCS over two files is O(n*m) and would stall the UI on anything
 * large. Real diff tools avoid that by stripping the common prefix and suffix
 * first, and for the thing this actually renders — an agent changing a few
 * lines in a big file — that reduces the interesting region to almost nothing
 * before any quadratic work starts.
 *
 * Past that there is a hard ceiling: when the differing middle is still huge,
 * both sides are effectively rewritten and a line-by-line diff would be noise
 * anyway. It says so instead of grinding.
 */

/** Lines of changed region past which a line-level diff stops being useful. */
const MAX_DIFF_REGION_LINES = 2_000;
/** Unchanged lines kept either side of a change. */
const CONTEXT_LINES = 3;

export interface UnifiedDiffOptions {
  /**
   * Shown on the ---/+++ header lines. Nullable because that is how the
   * observation carries it, and a diff without a path is still a valid diff —
   * making callers coerce would only move the check somewhere less obvious.
   */
  path?: string | null;
}

/**
 * Longest common subsequence over two line arrays, as a list of edits.
 *
 * Only ever called on the region that actually differs, which the caller has
 * already trimmed.
 */
function diffLines(
  before: string[],
  after: string[],
): Array<{ type: "keep" | "del" | "add"; line: string }> {
  const n = before.length;
  const m = after.length;

  // lcs[i][j] = length of the LCS of before[i:] and after[j:]
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        before[i] === after[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: Array<{ type: "keep" | "del" | "add"; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ type: "keep", line: before[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", line: before[i] });
      i += 1;
    } else {
      out.push({ type: "add", line: after[j] });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ type: "del", line: before[i] });
    i += 1;
  }
  while (j < m) {
    out.push({ type: "add", line: after[j] });
    j += 1;
  }
  return out;
}

/**
 * A unified diff of `before` -> `after`, or null when nothing changed.
 *
 * Returning null rather than an empty string is deliberate: "no change" is a
 * real outcome the caller must decide how to present, and an empty diff block
 * rendered as an empty grey box reads like a bug.
 */
export function buildUnifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): string | null {
  if (before === after) return null;

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  // Trim the identical head and tail. This is what keeps the quadratic step
  // small for the common case: a small edit inside a large file.
  let head = 0;
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  ) {
    head += 1;
  }

  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] ===
      afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const beforeMiddle = beforeLines.slice(head, beforeLines.length - tail);
  const afterMiddle = afterLines.slice(head, afterLines.length - tail);

  const header = options.path
    ? `--- a/${options.path}\n+++ b/${options.path}\n`
    : "";

  if (
    beforeMiddle.length > MAX_DIFF_REGION_LINES ||
    afterMiddle.length > MAX_DIFF_REGION_LINES
  ) {
    // Both sides are effectively rewritten. A line-level diff here is noise,
    // and computing it is the one case that would actually hurt.
    return (
      `${header}@@ rewritten @@\n` +
      `- ${beforeMiddle.length} lines replaced\n` +
      `+ ${afterMiddle.length} lines written`
    );
  }

  const edits = diffLines(beforeMiddle, afterMiddle);

  // Keep only CONTEXT_LINES of unchanged text around each change, so a diff
  // stays about the change rather than the file.
  const keep = new Array<boolean>(edits.length).fill(false);
  edits.forEach((edit, index) => {
    if (edit.type === "keep") return;
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(edits.length - 1, index + CONTEXT_LINES);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  });

  const body: string[] = [];

  // Context has to come back from the trimmed head. The trim is a performance
  // device — it decides what the LCS has to look at — but the lines it removed
  // are still the surrounding text a reader needs to place the change. Dropping
  // them entirely produced diffs that were correct and unreadable: a bare
  // "-b / +B" with nothing around it.
  const headContext = Math.min(CONTEXT_LINES, head);
  if (head > headContext) body.push("@@ ... @@");
  for (let k = head - headContext; k < head; k += 1) {
    body.push(` ${beforeLines[k]}`);
  }

  let skipping = false;
  edits.forEach((edit, index) => {
    if (!keep[index]) {
      // One marker per elided run, not one per line.
      if (!skipping) {
        body.push("@@ ... @@");
        skipping = true;
      }
      return;
    }
    skipping = false;
    if (edit.type === "keep") body.push(` ${edit.line}`);
    else if (edit.type === "del") body.push(`-${edit.line}`);
    else body.push(`+${edit.line}`);
  });

  const tailStart = beforeLines.length - tail;
  const tailContext = Math.min(CONTEXT_LINES, tail);
  for (let k = tailStart; k < tailStart + tailContext; k += 1) {
    body.push(` ${beforeLines[k]}`);
  }
  if (tail > tailContext) body.push("@@ ... @@");

  return header + body.join("\n");
}
