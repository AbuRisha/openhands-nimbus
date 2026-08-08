import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const createMock = vi.hoisted(() => vi.fn());
const successToastMock = vi.hoisted(() => vi.fn());

vi.mock("#/api/artifacts/artifacts.api", () => ({
  default: { create: createMock },
}));

vi.mock("#/utils/custom-toast-handlers", () => ({
  displayErrorToast: vi.fn(),
  displaySuccessToast: successToastMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("#/i18n", () => ({ default: { t: (key: string) => key } }));

import { useKeepAsArtifactAction } from "#/hooks/chat/use-keep-as-artifact-action";

const CONVERSATION_ID = "11111111-1111-1111-1111-111111111111";

const wrapperFor = (path: string, pattern: string) =>
  function Wrapper({ children }: React.PropsWithChildren) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={pattern} element={<>{children}</>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };

const authed = wrapperFor(
  `/conversations/${CONVERSATION_ID}`,
  "/conversations/:conversationId",
);
const shared = wrapperFor(
  `/shared/conversations/${CONVERSATION_ID}`,
  "/shared/conversations/:conversationId",
);

afterEach(() => vi.clearAllMocks());

describe("useKeepAsArtifactAction", () => {
  it("is offered on an agent message", () => {
    const { result } = renderHook(
      () => useKeepAsArtifactAction("Some useful answer.", "agent"),
      { wrapper: authed },
    );
    expect(result.current).not.toBeNull();
    expect(result.current?.tooltip).toBe("ARTIFACTS$KEEP_THIS");
  });

  it("is NOT offered on a user message", () => {
    // Keeping your own prompt as a document is not a thing anyone wants; the
    // value is in what came back.
    const { result } = renderHook(
      () => useKeepAsArtifactAction("my prompt", "user"),
      { wrapper: authed },
    );
    expect(result.current).toBeNull();
  });

  it("is NOT offered on the unauthenticated shared route", () => {
    const { result } = renderHook(
      () => useKeepAsArtifactAction("Some useful answer.", "agent"),
      { wrapper: shared },
    );
    expect(result.current).toBeNull();
  });

  it("is NOT offered for an empty message", () => {
    const { result } = renderHook(
      () => useKeepAsArtifactAction("   \n  ", "agent"),
      { wrapper: authed },
    );
    expect(result.current).toBeNull();
  });

  it("creates an artifact carrying the originating conversation", async () => {
    createMock.mockResolvedValue({ id: "art-1" });

    const { result } = renderHook(
      () =>
        useKeepAsArtifactAction(
          "# Deploy runbook\n\nMerge to main and watch the webhook fire.",
          "agent",
        ),
      { wrapper: authed },
    );

    act(() => result.current!.onClick());

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

    const payload = createMock.mock.calls[0][0];
    expect(payload.title).toBe("Deploy runbook");
    expect(payload.kind).toBe("markdown");
    // So the artifact can be traced back to where it came from.
    expect(payload.conversation_id).toBe(CONVERSATION_ID);
  });

  it("disables itself after keeping, so a second press cannot duplicate", async () => {
    createMock.mockResolvedValue({ id: "art-1" });

    const { result } = renderHook(
      () => useKeepAsArtifactAction("Some useful answer.", "agent"),
      { wrapper: authed },
    );

    act(() => result.current!.onClick());

    await waitFor(() => expect(result.current?.isKept).toBe(true));
    expect(result.current?.isDisabled).toBe(true);
    expect(result.current?.tooltip).toBe("ARTIFACTS$KEPT");
    expect(successToastMock).toHaveBeenCalledWith("ARTIFACTS$KEPT");

    // Pressing again must not produce a second copy the customer then has to
    // find and delete.
    act(() => result.current!.onClick());
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
