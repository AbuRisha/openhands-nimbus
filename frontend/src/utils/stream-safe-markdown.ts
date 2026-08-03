/**
 * Find the last point in a partial markdown stream that is safe to render.
 *
 * THE PROBLEM
 * -----------
 * A streamed assistant reply arrives a few tokens at a time. Rendering the
 * buffer on every tick means repeatedly rendering markdown that is
 * syntactically incomplete, and the failure is loud rather than subtle: a
 * half-arrived code fence
 *
 *     ```ts
 *     const x =
 *
 * has an opening fence and no closing one, so the renderer treats the entire
 * remainder of the message as code, then un-treats it a tick later when the
 * closer lands. Tables, lists and block quotes flicker the same way. The
 * result reads as the UI thrashing rather than as text arriving.
 *
 * THE FIX
 * -------
 * Split the buffer at the last position that is provably outside any open
 * construct, render everything before it, and hold the remainder until more
 * arrives. Two rules produce that position:
 *
 *   - a blank line at the top level is always safe — no markdown block spans
 *     one, so nothing is mid-construct there
 *   - the line that closes a fence is safe, because the fence is now balanced
 *
 * and, critically, nothing inside an open fence is ever a boundary — a blank
 * line in the middle of a code block must not split it.
 *
 * Ported from claw-code's terminal renderer (`find_stream_safe_boundary` in
 * rust/crates/rusty-claude-cli/src/render.rs). The fence rules follow
 * CommonMark: an opener is 3+ backticks or tildes indented at most 3 spaces;
 * a backtick opener's info string may not itself contain a backtick; a closer
 * is the same character, at least as long as the opener, indented at most 3,
 * followed by nothing but whitespace.
 */

interface FenceMarker {
  character: "`" | "~";
  length: number;
}

/** Leading spaces, capped so we can cheaply reject over-indented lines. */
function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n += 1;
  return n;
}

/** Does this line open a fenced code block? */
export function parseFenceOpener(line: string): FenceMarker | null {
  const indent = leadingSpaces(line);
  // 4+ spaces is an indented code block, not a fence.
  if (indent > 3) return null;

  const rest = line.slice(indent);
  const character = rest[0];
  if (character !== "`" && character !== "~") return null;

  let length = 0;
  while (length < rest.length && rest[length] === character) length += 1;
  if (length < 3) return null;

  // CommonMark: a backtick info string cannot contain a backtick, otherwise
  // `` `a` `` inline code would read as a fence.
  const infoString = rest.slice(length);
  if (character === "`" && infoString.includes("`")) return null;

  return { character, length };
}

/** Does this line close the currently open fence? */
export function lineClosesFence(line: string, opener: FenceMarker): boolean {
  const indent = leadingSpaces(line);
  if (indent > 3) return false;

  const rest = line.slice(indent);
  let length = 0;
  while (length < rest.length && rest[length] === opener.character) length += 1;

  // A closer must be at least as long as its opener.
  if (length < opener.length) return false;

  // ...and carry nothing after it but whitespace.
  return /^[ \t]*$/.test(rest.slice(length));
}

/**
 * Byte offset of the last stream-safe split point, or null if there is none
 * yet (the whole buffer is mid-construct — hold all of it).
 */
export function findStreamSafeBoundary(markdown: string): number | null {
  let openFence: FenceMarker | null = null;
  let lastBoundary: number | null = null;
  let cursor = 0;

  // split(/(?<=\n)/) keeps the newline attached, so offsets stay exact.
  const lines = markdown.split(/(?<=\n)/);

  for (const rawLine of lines) {
    const start = cursor;
    cursor += rawLine.length;
    const line = rawLine.endsWith("\n") ? rawLine.slice(0, -1) : rawLine;

    if (openFence) {
      if (lineClosesFence(line, openFence)) {
        openFence = null;
        lastBoundary = start + rawLine.length;
      }
      // Inside a fence nothing else can be a boundary — not even a blank
      // line, which would otherwise split the code block in half.
      continue;
    }

    const opener = parseFenceOpener(line);
    if (opener) {
      openFence = opener;
      continue;
    }

    if (line.trim() === "") {
      lastBoundary = start + rawLine.length;
    }
  }

  return lastBoundary;
}

/**
 * Split a streaming buffer into the part that is safe to render now and the
 * part to hold back.
 *
 * `done` short-circuits the whole thing: once the stream has ended the buffer
 * is complete by definition, so it all renders even if it ends mid-fence
 * (a truncated reply should still be shown, not swallowed).
 */
export function splitStreamSafe(
  markdown: string,
  done = false,
): { render: string; pending: string } {
  if (done) return { render: markdown, pending: "" };

  const boundary = findStreamSafeBoundary(markdown);
  if (boundary === null) return { render: "", pending: markdown };

  return {
    render: markdown.slice(0, boundary),
    pending: markdown.slice(boundary),
  };
}
