import { ArtifactKind } from "#/api/artifacts/artifacts.api";

export interface DerivedArtifact {
  title: string;
  content: string;
  kind: ArtifactKind;
  language: string | null;
}

interface FencedBlock {
  code: string;
  language: string | null;
}

/** Every fenced code block in the message, in order. */
const fencedBlocks = (message: string): FencedBlock[] => {
  // Non-greedy body, and the fence must START A LINE — otherwise a ``` written
  // inside prose swallows the rest of the message.
  const fence = /^```([\w+-]*)[ \t]*\r?\n([\s\S]*?)^```/gm;

  const blocks: FencedBlock[] = [];
  let match = fence.exec(message);

  while (match !== null) {
    blocks.push({
      code: match[2].replace(/\s+$/, ""),
      language: match[1] ? match[1].toLowerCase() : null,
    });
    match = fence.exec(message);
  }

  return blocks;
};

/**
 * Strip markdown decoration from a line so it can serve as a title.
 *
 * Only leading syntax is removed. Inline formatting inside the line is left
 * alone rather than half-stripped — a title reading "the **fast** path" is
 * better than one where an unbalanced strip has eaten a word.
 */
const asTitle = (line: string): string =>
  line
    .replace(/^#+\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/[*_`]/g, "")
    .trim();

const MAX_TITLE = 60;

const truncateTitle = (raw: string): string => {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_TITLE) return clean;
  // Cut on a word boundary when one is close enough that the result still
  // reads as a phrase; otherwise take the hard cut.
  const cut = clean.slice(0, MAX_TITLE);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > MAX_TITLE - 20 ? cut.slice(0, lastSpace) : cut}…`;
};

/**
 * Turn an agent message into something worth keeping.
 *
 * WHY THE WHOLE MESSAGE IS NOT ALWAYS THE ARTIFACT: most replies are a code
 * block wrapped in conversation ("Here's the script — let me know if you want
 * it to also handle X"). Keeping the prose means the artifact opens with
 * chat-voice text that makes no sense outside the conversation it came from,
 * and the customer edits it out every time. When a message is essentially one
 * code block, the block IS the document.
 *
 * EXACTLY ONE BLOCK, which is the part I got wrong first. The original version
 * took the LARGEST of however many blocks there were, on the reasoning that a
 * reply often opens with a one-line `pip install` before the real thing. But
 * "keep the biggest and discard the rest" is silent data loss: a message
 * containing a config file AND the script that reads it would save one and
 * throw the other away, with nothing on screen saying so. When there is more
 * than one block, every block and the prose between them is kept — an artifact
 * with some chat-voice in it is an edit away from right, whereas a missing
 * half is not recoverable at all.
 *
 * The dominance threshold is deliberately high. Below it the prose is carrying
 * real content — an explanation with an example in it — and dropping it loses
 * the part that made the message worth keeping.
 */
const CODE_DOMINANCE = 0.6;

export const deriveArtifactFromMessage = (
  message: string,
  fallbackTitle: string,
): DerivedArtifact => {
  const trimmed = message.trim();
  const blocks = fencedBlocks(trimmed);
  const block = blocks.length === 1 ? blocks[0] : null;

  if (block && block.code.length >= trimmed.length * CODE_DOMINANCE) {
    // Title from the last prose line BEFORE the fence — usually the sentence
    // that introduces the code ("Here is the deploy script:"), which describes
    // it better than its first line of syntax does.
    const beforeFence = trimmed.slice(0, trimmed.indexOf("```"));
    const lead = beforeFence.split(/\r?\n/).map(asTitle).filter(Boolean).pop();

    return {
      title: truncateTitle(lead || fallbackTitle),
      content: block.code,
      kind: "code",
      language: block.language,
    };
  }

  const firstLine = trimmed.split(/\r?\n/).map(asTitle).find(Boolean);

  return {
    title: truncateTitle(firstLine || fallbackTitle),
    content: trimmed,
    // Markdown rather than text: these messages are rendered as markdown in the
    // transcript, so storing them as plain text would make the artifact render
    // differently from the thing the customer chose to keep.
    kind: "markdown",
    language: null,
  };
};
