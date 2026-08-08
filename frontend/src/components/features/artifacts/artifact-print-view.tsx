import React from "react";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "#/components/features/markdown/markdown-renderer";
import { ArtifactKind } from "#/api/artifacts/artifacts.api";
import { I18nKey } from "#/i18n/declaration";

interface ArtifactPrintViewProps {
  title: string;
  content: string;
  kind: ArtifactKind;
  version: number | null;
  updatedAt: string;
}

/**
 * The paper version of one artifact.
 *
 * ALWAYS MOUNTED, positioned off-screen, rather than rendered on demand when
 * the print button is pressed. `window.print()` is SYNCHRONOUS — it captures
 * whatever the document contains at the moment it is called, and React's
 * commit is not guaranteed to have flushed by then. Mounting first and
 * printing later would work in development and produce blank pages for
 * somebody else. Off-screen positioning rather than `display: none` for the
 * same class of reason: a hidden subtree is not laid out and several browsers
 * print nothing.
 *
 * IT CARRIES A HEADER BECAUSE PAPER LOSES CONTEXT. On screen the title is in
 * the pane and the version is in the sidebar; a printed page that says neither
 * is an anonymous block of text, and the whole point of printing an artifact
 * is to take it somewhere the app is not. Title, version and date are the
 * minimum needed to match a page back to what produced it.
 */
export function ArtifactPrintView({
  title,
  content,
  kind,
  version,
  updatedAt,
}: ArtifactPrintViewProps) {
  const { t } = useTranslation();

  return (
    <div id="artifact-print-root" data-testid="artifact-print-view">
      <h1 style={{ fontSize: "18pt", marginBottom: "2mm" }}>{title}</h1>
      <p style={{ fontSize: "9pt", color: "#444", marginBottom: "8mm" }}>
        {version !== null &&
          `${t(I18nKey.ARTIFACTS$VERSION_N, { n: version })} · `}
        {new Date(updatedAt).toLocaleString()}
      </p>

      {/*
       * Markdown is RENDERED, everything else is printed as SOURCE.
       *
       * Running a code artifact through the markdown renderer would interpret
       * it — a shell script full of `#` becomes a page of headings, and `*` in
       * a glob becomes italics. Plain text has the same problem.
       *
       * `html` deliberately takes the source path too, and that one is a
       * security decision rather than a formatting one: the content is written
       * by an AGENT, and rendering it would inject agent-authored markup into
       * our own document. The preview pane solves that with a sandboxed iframe
       * carrying no `allow-same-origin`; there is no equivalent for a printed
       * page, so the honest output is the source.
       */}
      {kind === "markdown" ? (
        <MarkdownRenderer includeStandard>{content}</MarkdownRenderer>
      ) : (
        <pre
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: "9pt",
            lineHeight: 1.45,
          }}
        >
          {content}
        </pre>
      )}
    </div>
  );
}
