import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { MentionFileMenu } from "#/components/features/chat/components/mention-file-menu";
import { I18nKey } from "#/i18n/declaration";

const FILES = [
  { path: "src/app.ts", name: "app.ts" },
  { path: "src/router/index.ts", name: "index.ts" },
];

const base = {
  items: FILES,
  selectedIndex: 0,
  isLoading: false,
  isError: false,
  truncated: false,
};

describe("MentionFileMenu", () => {
  it("lists the name and its path", () => {
    // The name is what you scan for; the path is what disambiguates two
    // files called index.ts.
    render(<MentionFileMenu {...base} />);

    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getByText("src/router/index.ts")).toBeInTheDocument();
  });

  it("marks the selected row for assistive tech, not just visually", () => {
    render(<MentionFileMenu {...base} selectedIndex={1} />);

    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
  });

  it("selects on mouse-down rather than click", async () => {
    // The composer's blur handler closes this menu, and blur lands before
    // click — so a click handler would never fire.
    const onSelect = vi.fn();
    const user = userEvent.setup();

    render(<MentionFileMenu {...base} onSelect={onSelect} />);
    await user.pointer({
      keys: "[MouseLeft>]",
      target: screen.getAllByRole("option")[0],
    });

    expect(onSelect).toHaveBeenCalledWith(FILES[0]);
  });

  describe("the three states are distinct, because collapsing them lies", () => {
    it("says it is still looking rather than showing nothing", () => {
      render(<MentionFileMenu {...base} items={[]} isLoading />);

      expect(
        screen.getByTestId("mention-file-menu-loading"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("mention-file-menu-empty"),
      ).not.toBeInTheDocument();
    });

    it("distinguishes a failed listing from an empty one", () => {
      // "No matching files" for a stopped sandbox tells the user their file
      // does not exist, which is a different and wrong statement.
      render(<MentionFileMenu {...base} items={[]} isError />);

      expect(screen.getByTestId("mention-file-menu-error")).toHaveTextContent(
        I18nKey.WORKSPACE$FILES_UNAVAILABLE,
      );
      expect(
        screen.queryByTestId("mention-file-menu-empty"),
      ).not.toBeInTheDocument();
    });

    it("reports a genuine no-match", () => {
      render(<MentionFileMenu {...base} items={[]} />);

      expect(screen.getByTestId("mention-file-menu-empty")).toBeInTheDocument();
    });
  });

  it("says when the list was cut short", () => {
    // A silent truncation reads as "no such file" and the user retypes a
    // query that was already correct.
    render(<MentionFileMenu {...base} truncated />);

    expect(
      screen.getByTestId("mention-file-menu-truncated"),
    ).toBeInTheDocument();
  });

  it("does not claim truncation when everything fit", () => {
    render(<MentionFileMenu {...base} />);

    expect(
      screen.queryByTestId("mention-file-menu-truncated"),
    ).not.toBeInTheDocument();
  });
});
