import Markdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { code } from "./code";
import { ul, ol } from "./list";
import { paragraph } from "./paragraph";
import { anchor } from "./anchor";
import { h1, h2, h3, h4, h5, h6 } from "./headings";
import { table, th, td } from "./table";
import { splitStreamSafe } from "#/utils/stream-safe-markdown";

interface MarkdownRendererProps {
  /**
   * The markdown content to render. Can be passed as children (string) or content prop.
   */
  children?: string;
  content?: string;
  /**
   * Additional or override components for markdown elements.
   * Default components (code, ul, ol) are always included unless overridden.
   */
  components?: Partial<Components>;
  /**
   * Whether to include standard components (anchor, paragraph).
   * Defaults to false.
   */
  includeStandard?: boolean;
  /**
   * Whether to include heading components (h1-h6).
   * Defaults to false.
   */
  includeHeadings?: boolean;
  /**
   * Set while the content is still streaming in.
   *
   * A partial stream is, by definition, frequently invalid markdown: an
   * arrived-but-unclosed ``` fence makes the renderer treat the entire rest
   * of the message as code, then undo that a tick later when the closer
   * lands. Tables and lists flicker the same way, and the whole reply reads
   * as thrashing rather than as text arriving.
   *
   * With this set, only the portion provably outside any open construct is
   * parsed as markdown; the unsafe tail is shown as plain text so it still
   * appears immediately without being mis-parsed. When the stream finishes,
   * pass `false` (or omit) and the whole thing renders normally.
   */
  streaming?: boolean;
}

/**
 * A reusable Markdown renderer component that provides consistent
 * markdown rendering across the application.
 *
 * By default, includes:
 * - code, ul, ol components
 * - remarkGfm and remarkBreaks plugins
 *
 * Can be extended with:
 * - includeStandard: adds anchor and paragraph components
 * - includeHeadings: adds h1-h6 heading components
 * - components prop: allows custom overrides or additional components
 */
export function MarkdownRenderer({
  children,
  content,
  components: customComponents,
  includeStandard = false,
  includeHeadings = false,
  streaming = false,
}: MarkdownRendererProps) {
  // Build the components object with defaults and optional additions
  const components: Components = {
    code,
    ul,
    ol,
    table,
    th,
    td,
    ...(includeStandard && {
      a: anchor,
      p: paragraph,
    }),
    ...(includeHeadings && {
      h1,
      h2,
      h3,
      h4,
      h5,
      h6,
    }),
    ...customComponents, // Custom components override defaults
  };

  const markdownContent = content ?? children ?? "";

  // While streaming, parse only what is provably complete and let the rest
  // stream as plain text. See `streaming` above for why.
  const { render: safeContent, pending } = splitStreamSafe(
    markdownContent,
    !streaming,
  );

  return (
    <div data-testid="markdown-renderer">
      <Markdown
        components={components}
        remarkPlugins={[remarkGfm, remarkBreaks]}
      >
        {safeContent}
      </Markdown>
      {pending && (
        // Plain text on purpose: this tail is mid-construct, so parsing it
        // is exactly what causes the flicker. whitespace-pre-wrap keeps the
        // shape of partially-arrived code until its fence closes.
        <div
          data-testid="markdown-streaming-tail"
          className="whitespace-pre-wrap break-words"
        >
          {pending}
        </div>
      )}
    </div>
  );
}
