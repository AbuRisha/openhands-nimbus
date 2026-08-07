import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ConversationTabs } from "#/components/features/conversation/conversation-tabs/conversation-tabs";
import { useConversationStore } from "#/stores/conversation-store";

const TASK_CONVERSATION_ID = "task-ec03fb2ab8604517b24af632b058c2fd";
const REAL_CONVERSATION_ID = "conv-abc123";

let mockConversationId = TASK_CONVERSATION_ID;

vi.mock("#/hooks/use-conversation-id", () => ({
  useConversationId: () => ({ conversationId: mockConversationId }),
}));

let mockHasTaskList = false;
vi.mock("#/hooks/use-task-list", () => ({
  useTaskList: () => ({
    hasTaskList: mockHasTaskList,
    taskList: [],
  }),
}));

const createWrapper = (conversationId: string) => {
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[`/conversations/${conversationId}`]}>
      <QueryClientProvider client={new QueryClient()}>
        {children}
      </QueryClientProvider>
    </MemoryRouter>
  );
};

describe("ConversationTabs localStorage behavior", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
    mockConversationId = TASK_CONVERSATION_ID;
    mockHasTaskList = false;
    useConversationStore.setState({
      selectedTab: null,
      isRightPanelShown: false,
      hasRightPanelToggled: false,
    });
  });

  describe("task-prefixed conversation IDs", () => {
    it("should not create localStorage entries for task-prefixed conversation IDs", () => {
      render(<ConversationTabs />, {
        wrapper: createWrapper(TASK_CONVERSATION_ID),
      });

      expect(
        localStorage.getItem(`conversation-state-${TASK_CONVERSATION_ID}`),
      ).toBeNull();
    });
  });

  describe("consolidated localStorage key", () => {
    it("should use a single consolidated key for tab state", async () => {
      mockConversationId = REAL_CONVERSATION_ID;
      const user = userEvent.setup();

      render(<ConversationTabs />, {
        wrapper: createWrapper(REAL_CONVERSATION_ID),
      });

      const changesTab = screen.getByTestId("conversation-tab-editor");
      await user.click(changesTab);

      const consolidatedKey = `conversation-state-${REAL_CONVERSATION_ID}`;
      const storedState = localStorage.getItem(consolidatedKey);
      expect(storedState).not.toBeNull();

      const parsed = JSON.parse(storedState!);
      expect(parsed).toHaveProperty("selectedTab");
      expect(parsed).toHaveProperty("rightPanelShown");
      expect(parsed).toHaveProperty("unpinnedTabs");
    });
  });

  describe("hook integration", () => {
    it("should open panel and select tab when clicking a tab while panel is closed", async () => {
      mockConversationId = REAL_CONVERSATION_ID;
      const user = userEvent.setup();

      // Arrange: Panel is closed, no tab selected
      useConversationStore.setState({
        selectedTab: null,
        isRightPanelShown: false,
        hasRightPanelToggled: false,
      });

      render(<ConversationTabs />, {
        wrapper: createWrapper(REAL_CONVERSATION_ID),
      });

      // Act: Click the terminal tab
      const terminalTab = screen.getByTestId("conversation-tab-terminal");
      await user.click(terminalTab);

      // Assert: Panel should be open and terminal tab selected
      expect(useConversationStore.getState().selectedTab).toBe("terminal");
      expect(useConversationStore.getState().hasRightPanelToggled).toBe(true);

      // Verify localStorage was updated
      const storedState = JSON.parse(
        localStorage.getItem(`conversation-state-${REAL_CONVERSATION_ID}`)!,
      );
      expect(storedState.selectedTab).toBe("terminal");
      expect(storedState.rightPanelShown).toBe(true);
    });

    it("should close panel when clicking the same active tab", async () => {
      mockConversationId = REAL_CONVERSATION_ID;
      const user = userEvent.setup();

      // Arrange: Panel is open with editor tab selected
      useConversationStore.setState({
        selectedTab: "editor",
        isRightPanelShown: true,
        hasRightPanelToggled: true,
      });

      render(<ConversationTabs />, {
        wrapper: createWrapper(REAL_CONVERSATION_ID),
      });

      // Act: Click the editor tab again
      const editorTab = screen.getByTestId("conversation-tab-editor");
      await user.click(editorTab);

      // Assert: Panel should be closed
      expect(useConversationStore.getState().hasRightPanelToggled).toBe(false);

      // Verify localStorage was updated
      const storedState = JSON.parse(
        localStorage.getItem(`conversation-state-${REAL_CONVERSATION_ID}`)!,
      );
      expect(storedState.rightPanelShown).toBe(false);
    });

    it("should switch to different tab when clicking another tab while panel is open", async () => {
      mockConversationId = REAL_CONVERSATION_ID;
      const user = userEvent.setup();

      // Arrange: Panel is open with editor tab selected
      useConversationStore.setState({
        selectedTab: "editor",
        isRightPanelShown: true,
        hasRightPanelToggled: true,
      });

      render(<ConversationTabs />, {
        wrapper: createWrapper(REAL_CONVERSATION_ID),
      });

      // Act: Click the browser tab
      const browserTab = screen.getByTestId("conversation-tab-browser");
      await user.click(browserTab);

      // Assert: Browser tab should be selected, panel still open
      expect(useConversationStore.getState().selectedTab).toBe("browser");
      expect(useConversationStore.getState().hasRightPanelToggled).toBe(true);

      // Verify localStorage was updated
      const storedState = JSON.parse(
        localStorage.getItem(`conversation-state-${REAL_CONVERSATION_ID}`)!,
      );
      expect(storedState.selectedTab).toBe("browser");
    });
  });

  describe("tasklist tab", () => {
    beforeEach(() => {
      mockConversationId = REAL_CONVERSATION_ID;
      mockHasTaskList = true;
    });

    it("should show tasklist tab when hasTaskList is true", () => {
      render(<ConversationTabs />, {
        wrapper: createWrapper(REAL_CONVERSATION_ID),
      });

      expect(
        screen.getByTestId("conversation-tab-tasklist"),
      ).toBeInTheDocument();
    });

    it("should select tasklist tab when clicked", async () => {
      const user = userEvent.setup();

      render(<ConversationTabs />, {
        wrapper: createWrapper(REAL_CONVERSATION_ID),
      });

      const tasklistTab = screen.getByTestId("conversation-tab-tasklist");
      await user.click(tasklistTab);

      const { selectedTab, hasRightPanelToggled } =
        useConversationStore.getState();
      expect(selectedTab).toBe("tasklist");
      expect(hasRightPanelToggled).toBe(true);
    });
  });

  /**
   * Every test above finds its tab with getByTestId, which is exactly why this
   * shipped broken: the visible label renders only while a tab is ACTIVE, so
   * every INACTIVE tab was an icon-only button with no accessible name. A test
   * id is not an accessible name — it is invisible to screen readers, and it is
   * invisible to anything driving the page by role, which is how this was
   * actually found (an accessibility-tree search for the preview tab returned
   * nothing while the tab was plainly on screen).
   *
   * So these assert by ROLE AND NAME. Written that way on purpose: a test that
   * can only find the element by test id cannot tell whether it has a name.
   */
  describe("accessible names", () => {
    it("names every tab, including the inactive ones", () => {
      render(<ConversationTabs />, {
        wrapper: createWrapper(REAL_CONVERSATION_ID),
      });

      // Only one of these can be active at a time, so if the name came from
      // the visible label alone, all but one would fail.
      for (const name of [/changes/i, /terminal/i, /preview/i, /browser/i]) {
        expect(screen.getByRole("button", { name })).toBeInTheDocument();
      }
    });

    it("does not claim any tab is current while the panel is closed", () => {
      render(<ConversationTabs />, {
        wrapper: createWrapper(REAL_CONVERSATION_ID),
      });

      // `isTabActive` is `isRightPanelShown && selectedTab === tab`, and
      // isRightPanelShown cannot be driven from here, so the positive case
      // (aria-current="page" on the open tab) is NOT asserted in this file --
      // it was verified in a browser instead. What is worth pinning here is the
      // half that is reachable: with the panel closed, nothing is current.
      for (const name of [/preview/i, /terminal/i, /browser/i]) {
        expect(screen.getByRole("button", { name })).not.toHaveAttribute(
          "aria-current",
        );
      }
    });
  });
});
