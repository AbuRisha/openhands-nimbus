import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const listMock = vi.hoisted(() => vi.fn());
const getMock = vi.hoisted(() => vi.fn());
const restoreMock = vi.hoisted(() => vi.fn());
const updateMock = vi.hoisted(() => vi.fn());
const removeMock = vi.hoisted(() => vi.fn());

vi.mock("#/api/artifacts/artifacts.api", () => ({
  default: {
    list: listMock,
    get: getMock,
    restore: restoreMock,
    update: updateMock,
    remove: removeMock,
  },
}));

vi.mock("#/hooks/query/use-is-authed", () => ({
  useIsAuthed: () => ({ data: true }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("#/i18n", () => ({ default: { t: (key: string) => key } }));

vi.mock("#/utils/custom-toast-handlers", () => ({
  displayErrorToast: vi.fn(),
  displaySuccessToast: vi.fn(),
}));

import ArtifactsScreen from "#/routes/artifacts";

const SUMMARIES = [
  {
    id: "art-1",
    title: "Deploy runbook",
    kind: "markdown" as const,
    language: null,
    created_at: "2026-08-08T10:00:00Z",
    updated_at: "2026-08-08T12:00:00Z",
    version_count: 3,
  },
  {
    id: "art-2",
    title: "Pricing notes",
    kind: "text" as const,
    language: null,
    created_at: "2026-08-08T09:00:00Z",
    updated_at: "2026-08-08T09:00:00Z",
    version_count: 1,
  },
];

const DETAIL = {
  id: "art-1",
  title: "Deploy runbook",
  kind: "markdown" as const,
  language: null,
  created_at: "2026-08-08T10:00:00Z",
  updated_at: "2026-08-08T12:00:00Z",
  current_version: 3,
  content: "current body",
  versions: [
    {
      version: 1,
      created_at: "2026-08-08T10:00:00Z",
      restored_from: null,
      conversation_id: null,
      size_chars: 5,
    },
    {
      version: 2,
      created_at: "2026-08-08T11:00:00Z",
      restored_from: null,
      conversation_id: null,
      size_chars: 8,
    },
    {
      version: 3,
      created_at: "2026-08-08T12:00:00Z",
      restored_from: 1,
      conversation_id: null,
      size_chars: 5,
    },
  ],
};

const renderScreen = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArtifactsScreen />
    </QueryClientProvider>,
  );
};

afterEach(() => vi.clearAllMocks());

describe("ArtifactsScreen", () => {
  it("lists artifacts", async () => {
    listMock.mockResolvedValue(SUMMARIES);
    renderScreen();

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-row")).toHaveLength(2),
    );
    expect(screen.getByText(/Deploy runbook/)).toBeInTheDocument();
  });

  it("shows an empty state rather than a blank pane", async () => {
    listMock.mockResolvedValue([]);
    renderScreen();

    await waitFor(() =>
      expect(screen.getByTestId("artifacts-empty")).toBeInTheDocument(),
    );
  });

  it("does not fetch a detail until one is selected", async () => {
    listMock.mockResolvedValue(SUMMARIES);
    renderScreen();

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-row")).toHaveLength(2),
    );
    expect(getMock).not.toHaveBeenCalled();
  });

  it("opens an artifact and shows its current content and history", async () => {
    listMock.mockResolvedValue(SUMMARIES);
    getMock.mockResolvedValue(DETAIL);
    renderScreen();

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-row")).toHaveLength(2),
    );
    await userEvent.click(screen.getAllByTestId("artifact-row")[0]);

    await waitFor(() =>
      expect(screen.getByTestId("artifact-content")).toHaveValue(
        "current body",
      ),
    );
    expect(screen.getAllByTestId("artifact-version-row")).toHaveLength(3);
  });

  it("orders history newest first WITHOUT mutating the cached array", async () => {
    listMock.mockResolvedValue(SUMMARIES);
    getMock.mockResolvedValue(DETAIL);
    renderScreen();

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-row")).toHaveLength(2),
    );
    await userEvent.click(screen.getAllByTestId("artifact-row")[0]);

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-version-row")).toHaveLength(3),
    );

    const rows = screen.getAllByTestId("artifact-version-row");
    expect(rows[0]).toHaveTextContent("3");
    expect(rows[2]).toHaveTextContent("1");

    // The object handed to the component must still be oldest-first. An
    // in-place .reverse() would corrupt the react-query cache and the NEXT
    // render would show history running backwards.
    expect(DETAIL.versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it("offers restore on every version EXCEPT the current one", async () => {
    listMock.mockResolvedValue(SUMMARIES);
    getMock.mockResolvedValue(DETAIL);
    renderScreen();

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-row")).toHaveLength(2),
    );
    await userEvent.click(screen.getAllByTestId("artifact-row")[0]);

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-version-row")).toHaveLength(3),
    );

    // 3 versions, 2 restore buttons: restoring the current version would be a
    // no-op that still appends, filling history with entries that changed
    // nothing.
    expect(screen.getAllByTestId("artifact-restore")).toHaveLength(2);

    const currentRow = screen.getAllByTestId("artifact-version-row")[0];
    expect(
      within(currentRow).queryByTestId("artifact-restore"),
    ).not.toBeInTheDocument();
  });

  it("restores the version that was clicked", async () => {
    listMock.mockResolvedValue(SUMMARIES);
    getMock.mockResolvedValue(DETAIL);
    restoreMock.mockResolvedValue({ ...DETAIL, current_version: 4 });
    renderScreen();

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-row")).toHaveLength(2),
    );
    await userEvent.click(screen.getAllByTestId("artifact-row")[0]);
    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-restore")).toHaveLength(2),
    );

    // History is newest-first, current (v3) has no button, so the first
    // button is v2 — the assertion that catches an off-by-one in the mapping.
    await userEvent.click(screen.getAllByTestId("artifact-restore")[0]);

    await waitFor(() =>
      expect(restoreMock).toHaveBeenCalledWith("art-1", 2),
    );
  });

  it("saving sends the edited content as a new version", async () => {
    listMock.mockResolvedValue(SUMMARIES);
    getMock.mockResolvedValue(DETAIL);
    updateMock.mockResolvedValue({ ...DETAIL, content: "edited" });
    renderScreen();

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-row")).toHaveLength(2),
    );
    await userEvent.click(screen.getAllByTestId("artifact-row")[0]);
    await waitFor(() =>
      expect(screen.getByTestId("artifact-content")).toHaveValue(
        "current body",
      ),
    );

    await userEvent.clear(screen.getByTestId("artifact-content"));
    await userEvent.type(screen.getByTestId("artifact-content"), "edited");
    await userEvent.click(screen.getByTestId("artifact-save"));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith("art-1", { content: "edited" }),
    );
  });

  it("save is disabled until something actually changes", async () => {
    listMock.mockResolvedValue(SUMMARIES);
    getMock.mockResolvedValue(DETAIL);
    renderScreen();

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-row")).toHaveLength(2),
    );
    await userEvent.click(screen.getAllByTestId("artifact-row")[0]);
    await waitFor(() =>
      expect(screen.getByTestId("artifact-content")).toHaveValue(
        "current body",
      ),
    );

    expect(screen.getByTestId("artifact-save")).toBeDisabled();
  });

  it("deleting asks first, and does not delete on cancel", async () => {
    listMock.mockResolvedValue(SUMMARIES);
    getMock.mockResolvedValue(DETAIL);
    renderScreen();

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-row")).toHaveLength(2),
    );
    await userEvent.click(screen.getAllByTestId("artifact-row")[0]);
    await waitFor(() =>
      expect(screen.getByTestId("artifact-delete")).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByTestId("artifact-delete"));
    expect(screen.getByTestId("confirmation-modal")).toBeInTheDocument();
    // Every version goes with it, so a mis-click must not be enough.
    expect(removeMock).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("cancel-button"));
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("deleting on confirm removes it", async () => {
    listMock.mockResolvedValue(SUMMARIES);
    getMock.mockResolvedValue(DETAIL);
    removeMock.mockResolvedValue(undefined);
    renderScreen();

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-row")).toHaveLength(2),
    );
    await userEvent.click(screen.getAllByTestId("artifact-row")[0]);
    await waitFor(() =>
      expect(screen.getByTestId("artifact-delete")).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByTestId("artifact-delete"));
    await userEvent.click(screen.getByTestId("confirm-button"));

    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("art-1"));
  });

  it("switching artifacts drops an unsaved draft rather than carrying it over", async () => {
    listMock.mockResolvedValue(SUMMARIES);
    getMock.mockImplementation(async (id: string) =>
      id === "art-1"
        ? DETAIL
        : { ...DETAIL, id: "art-2", title: "Pricing notes", content: "other" },
    );
    renderScreen();

    await waitFor(() =>
      expect(screen.getAllByTestId("artifact-row")).toHaveLength(2),
    );
    await userEvent.click(screen.getAllByTestId("artifact-row")[0]);
    await waitFor(() =>
      expect(screen.getByTestId("artifact-content")).toHaveValue(
        "current body",
      ),
    );

    await userEvent.type(screen.getByTestId("artifact-content"), " UNSAVED");

    await userEvent.click(screen.getAllByTestId("artifact-row")[1]);

    // Carrying the draft would show one artifact's text under another's
    // title — data loss that presents as a rendering bug.
    await waitFor(() =>
      expect(screen.getByTestId("artifact-content")).toHaveValue("other"),
    );
  });
});
