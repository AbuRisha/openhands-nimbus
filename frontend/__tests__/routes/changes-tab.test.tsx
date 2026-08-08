import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AxiosError } from "axios";
import { MemoryRouter } from "react-router";
import GitChanges from "#/routes/changes-tab";
import { useUnifiedGetGitChanges } from "#/hooks/query/use-unified-get-git-changes";
import { useAgentState } from "#/hooks/use-agent-state";
import { AgentState } from "#/types/agent-state";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("#/hooks/query/use-unified-get-git-changes");
vi.mock("#/hooks/use-agent-state");
vi.mock("#/hooks/use-conversation-id", () => ({
  useConversationId: () => ({ conversationId: "test-id" }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <MemoryRouter>
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  </MemoryRouter>
);

describe("Changes Tab", () => {
  it("should show EmptyChangesMessage when there are no changes", () => {
    vi.mocked(useUnifiedGetGitChanges).mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(useAgentState).mockReturnValue({
      curAgentState: AgentState.RUNNING,
      isArchived: false,
    });

    render(<GitChanges />, { wrapper });

    expect(screen.getByText("DIFF_VIEWER$NO_CHANGES")).toBeInTheDocument();
  });

  it("should not show EmptyChangesMessage when there are changes", () => {
    vi.mocked(useUnifiedGetGitChanges).mockReturnValue({
      data: [{ path: "src/file.ts", status: "M" }],
      isLoading: false,
      isFetching: false,
      isSuccess: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(useAgentState).mockReturnValue({
      curAgentState: AgentState.RUNNING,
      isArchived: false,
    });

    render(<GitChanges />, { wrapper });

    expect(
      screen.queryByText("DIFF_VIEWER$NO_CHANGES"),
    ).not.toBeInTheDocument();
  });

  /**
   * Found by looking at the running app, not by a failing test.
   *
   * A 500 from the git-changes endpoint rendered "Request failed with status
   * code 500" in the middle of the panel — the raw axios string, because the
   * only anticipated error was "not a git repository" and everything else fell
   * through to the message verbatim. Every other state in this tab renders a
   * sentence; this was the one a customer gets when something is actually
   * wrong, and it was the one that told them nothing.
   *
   * The mock `t` returns the key unchanged, so an i18n key and a raw string are
   * distinguishable here: the assertion is that the human line is present AND
   * leads, not merely that some text appeared.
   */
  it("leads with a human explanation when the request fails", () => {
    vi.mocked(useUnifiedGetGitChanges).mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
      isSuccess: false,
      isError: true,
      error: new AxiosError("Request failed with status code 500"),
      refetch: vi.fn(),
    });
    vi.mocked(useAgentState).mockReturnValue({
      curAgentState: AgentState.RUNNING,
      isArchived: false,
    });

    render(<GitChanges />, { wrapper });

    expect(screen.getByText("DIFF_VIEWER$LOAD_FAILED")).toBeInTheDocument();
    // The technical detail is KEPT — support needs it — but as a second line
    // under the explanation rather than as the whole message.
    expect(
      screen.getByText("Request failed with status code 500"),
    ).toBeInTheDocument();
  });

  it("still says 'not a git repository' in its own words", () => {
    vi.mocked(useUnifiedGetGitChanges).mockReturnValue({
      data: [],
      isLoading: false,
      isFetching: false,
      isSuccess: false,
      isError: true,
      error: new AxiosError("fatal: not a git repository"),
      refetch: vi.fn(),
    });
    vi.mocked(useAgentState).mockReturnValue({
      curAgentState: AgentState.RUNNING,
      isArchived: false,
    });

    render(<GitChanges />, { wrapper });

    // The pre-existing branch must not regress into the generic one.
    expect(screen.getByText("DIFF_VIEWER$NOT_A_GIT_REPO")).toBeInTheDocument();
    expect(
      screen.queryByText("DIFF_VIEWER$LOAD_FAILED"),
    ).not.toBeInTheDocument();
  });
});
