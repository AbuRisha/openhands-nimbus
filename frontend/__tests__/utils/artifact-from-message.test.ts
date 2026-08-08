import { describe, expect, it } from "vitest";
import { deriveArtifactFromMessage } from "#/utils/artifact-from-message";

const FALLBACK = "Untitled artifact";

describe("deriveArtifactFromMessage", () => {
  it("keeps a code-dominant message as the CODE ONLY", () => {
    const message = [
      "Here is the deploy script:",
      "```bash",
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'echo "deploying"',
      "rsync -a ./dist/ server:/srv/app/",
      "systemctl restart app",
      "```",
    ].join("\n");

    const result = deriveArtifactFromMessage(message, FALLBACK);

    expect(result.kind).toBe("code");
    expect(result.language).toBe("bash");
    // The chat-voice line must NOT be in the document — it makes no sense
    // outside the conversation it came from.
    expect(result.content).not.toContain("Here is the deploy script");
    expect(result.content.startsWith("#!/usr/bin/env bash")).toBe(true);
    // ...but it IS the best available title.
    expect(result.title).toBe("Here is the deploy script:");
  });

  it("keeps EVERY block when a message has more than one", () => {
    const message = [
      "First install it:",
      "```bash",
      "pip install thing",
      "```",
      "Then run this:",
      "```python",
      "import thing",
      "",
      "def main() -> None:",
      "    thing.run(retries=3, timeout=30)",
      "    thing.report()",
      "",
      "main()",
      "```",
    ].join("\n");

    const result = deriveArtifactFromMessage(message, FALLBACK);

    /*
     * Keeping only the largest block would be silent data loss — a message
     * with a config file and the script that reads it would save one and
     * discard the other with nothing saying so. An artifact carrying some
     * chat-voice is one edit from right; a missing half is not recoverable.
     */
    expect(result.kind).toBe("markdown");
    expect(result.content).toContain("pip install thing");
    expect(result.content).toContain("def main()");
  });

  it("keeps the whole message when the prose is carrying the content", () => {
    const message = [
      "# Why the deploy failed",
      "",
      "The webhook fires before the build finishes, so the box pulls a commit",
      "that has no dist/ directory yet. That is why it only happens on slow",
      "builds and never locally. The fix is to gate the webhook on the build",
      "status rather than on the push event itself.",
      "",
      "```",
      "exit 1",
      "```",
      "",
      "Everything after that is a consequence of the same race.",
    ].join("\n");

    const result = deriveArtifactFromMessage(message, FALLBACK);

    // The code block is incidental here; dropping the prose would lose the
    // part that made this worth keeping.
    expect(result.kind).toBe("markdown");
    expect(result.content).toContain("The webhook fires before");
    expect(result.content).toContain("exit 1");
  });

  it("strips markdown decoration from the title", () => {
    const result = deriveArtifactFromMessage(
      "## **Deploy** runbook\n\nSome prose that carries the content of this note.",
      FALLBACK,
    );
    expect(result.title).toBe("Deploy runbook");
  });

  it("falls back when there is no usable first line", () => {
    const result = deriveArtifactFromMessage("\n\n   \n", FALLBACK);
    expect(result.title).toBe(FALLBACK);
  });

  it("truncates a long title on a word boundary", () => {
    const long =
      "This is an extremely long opening sentence that would make a completely unusable title if it were kept whole";
    const result = deriveArtifactFromMessage(long, FALLBACK);

    expect(result.title.length).toBeLessThanOrEqual(61);
    expect(result.title.endsWith("…")).toBe(true);

    // Cut on a word boundary: the kept prefix must be followed by a SPACE in
    // the original. (Asserting /\w…$/ would be wrong — a clean cut ends with a
    // word character too, since the ellipsis follows the last whole word.)
    const kept = result.title.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(" ");
  });

  it("does not treat a fence inside prose as a block start", () => {
    // The fence must open a line. Otherwise a stray ``` mid-sentence swallows
    // the rest of the message.
    const message =
      "Use the ``` fence syntax when you want a code block in markdown output.";
    const result = deriveArtifactFromMessage(message, FALLBACK);

    expect(result.kind).toBe("markdown");
    expect(result.content).toBe(message);
  });

  it("handles a fenced block with no language", () => {
    const message = ["```", "some plain output", "more output here", "```"].join(
      "\n",
    );
    const result = deriveArtifactFromMessage(message, FALLBACK);

    expect(result.kind).toBe("code");
    expect(result.language).toBeNull();
    expect(result.content).toBe("some plain output\nmore output here");
  });

  it("titles a code block from the lead-in line, not from its syntax", () => {
    const message = [
      "A tiny helper for that:",
      "```ts",
      "export const clamp = (n: number, lo: number, hi: number) =>",
      "  Math.min(hi, Math.max(lo, n));",
      "```",
    ].join("\n");

    const result = deriveArtifactFromMessage(message, FALLBACK);

    expect(result.title).toBe("A tiny helper for that:");
    expect(result.title).not.toContain("export const");
  });
});
