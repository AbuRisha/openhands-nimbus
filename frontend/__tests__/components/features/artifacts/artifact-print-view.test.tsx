import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { ArtifactPrintView } from "#/components/features/artifacts/artifact-print-view";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// A helper rather than a spread: the repo forbids JSX prop spreading, and
// spelling the props out also makes each test say which ones it varies.
const renderPrintView = (
  kind: "markdown" | "code" | "html" | "text",
  content: string,
  version: number | null = 3,
) =>
  render(
    <ArtifactPrintView
      title="Deploy runbook"
      version={version}
      updatedAt="2026-08-08T12:00:00Z"
      kind={kind}
      content={content}
    />,
  );

describe("ArtifactPrintView", () => {
  it("carries a header, because paper loses the context the app provides", () => {
    renderPrintView("markdown", "# Body\n\ntext");

    const root = screen.getByTestId("artifact-print-view");
    expect(within(root).getByText("Deploy runbook")).toBeInTheDocument();
    // Version identifies WHICH state was printed — a page that says neither
    // title nor version is an anonymous block of text.
    expect(root.textContent).toContain("ARTIFACTS$VERSION_N");
  });

  it("renders markdown as markdown", () => {
    // Braces, not a bare string attribute: in JSX `content="a\nb"` passes a
    // literal backslash-n, so the whole thing parses as one heading and the
    // assertion below fails for a reason that has nothing to do with printing.
    renderPrintView("markdown", "# A heading\n\nsome prose");

    const root = screen.getByTestId("artifact-print-view");
    // The artifact's own H1, in addition to the title H1.
    expect(within(root).getByText("A heading").tagName).toBe("H1");
  });

  it("prints CODE as source, not as markdown", () => {
    // A shell script is full of `#`. Through the markdown renderer every
    // comment becomes a heading and the printout is unreadable.
    const script = "#!/bin/sh\n# deploy the thing\nrsync -a ./dist/ srv:/app/";
    renderPrintView("code", script);

    const root = screen.getByTestId("artifact-print-view");
    const pre = root.querySelector("pre");

    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe(script);
    // "deploy the thing" must NOT have become a heading.
    expect(
      within(root).queryByRole("heading", { name: "deploy the thing" }),
    ).toBeNull();
  });

  it("prints HTML as SOURCE — the content is agent-authored", () => {
    const html = '<img src=x onerror="alert(1)"><b>hello</b>';
    renderPrintView("html", html);

    const root = screen.getByTestId("artifact-print-view");

    /*
     * The security case. Rendering this would inject agent-authored markup
     * into our own document; the preview pane only gets away with rendering
     * agent HTML because it is in a sandboxed iframe with no
     * allow-same-origin, and there is no equivalent for a printed page.
     */
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("pre")!.textContent).toBe(html);
  });

  it("prints plain text as source", () => {
    const text = "* not a bullet\n_not italics_";
    renderPrintView("text", text);
    expect(
      screen.getByTestId("artifact-print-view").querySelector("pre")!
        .textContent,
    ).toBe(text);
  });

  it("omits the version when the artifact has none", () => {
    renderPrintView("text", "body", null);
    expect(screen.getByTestId("artifact-print-view").textContent).not.toContain(
      "ARTIFACTS$VERSION_N",
    );
  });

  it("uses the id the print stylesheet targets", () => {
    renderPrintView("text", "body");
    // The whole @media print rule set keys off this id. Renaming it silently
    // turns printing back into "print the entire app".
    expect(screen.getByTestId("artifact-print-view").id).toBe(
      "artifact-print-root",
    );
  });
});
