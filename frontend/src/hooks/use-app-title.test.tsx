import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useParams } from "react-router";
import OptionService from "#/api/option-service/option-service.api";
import { useUserConversation } from "./query/use-user-conversation";
import { useAppTitle } from "./use-app-title";

const renderAppTitleHook = () =>
  renderHook(() => useAppTitle(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={new QueryClient()}>
        {children}
      </QueryClientProvider>
    ),
  });

vi.mock("./query/use-user-conversation");
vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return {
    ...actual,
    useParams: vi.fn(),
  };
});

describe("useAppTitle", () => {
  const getConfigSpy = vi.spyOn(OptionService, "getConfig");
  const mockUseUserConversation = vi.mocked(useUserConversation);
  const mockUseParams = vi.mocked(useParams);

  beforeEach(() => {
    // @ts-expect-error - only returning partial config for test
    mockUseUserConversation.mockReturnValue({ data: null });
    mockUseParams.mockReturnValue({});
  });

  // These used to expect "OpenHands" in OSS and "OpenHands Cloud" in SaaS. The
  // product is Nimbus Chat now and `use-app-title` holds ONE constant, so the
  // brand no longer varies by deployment mode. Both modes are still exercised
  // rather than collapsed into one case: "the title is the same either way" is
  // the actual claim, and it only has teeth if both modes are asserted.
  it("returns the app name in OSS when NOT in /conversations", async () => {
    // @ts-expect-error - only returning partial config for test
    getConfigSpy.mockResolvedValue({
      app_mode: "oss",
    });

    const { result } = renderAppTitleHook();

    await waitFor(() => expect(result.current).toBe("Nimbus Chat"));
  });

  it("returns the SAME app name in SaaS — no Cloud suffix", async () => {
    // @ts-expect-error - only returning partial config for test
    getConfigSpy.mockResolvedValue({
      app_mode: "saas",
    });

    const { result } = renderAppTitleHook();

    await waitFor(() => expect(result.current).toBe("Nimbus Chat"));
  });

  it("returns '{some title} | Nimbus Chat' if is OSS and in /conversations", async () => {
    // @ts-expect-error - only returning partial config for test
    getConfigSpy.mockResolvedValue({ app_mode: "oss" });
    mockUseParams.mockReturnValue({ conversationId: "123" });
    mockUseUserConversation.mockReturnValue({
      // @ts-expect-error - only returning partial config for test
      data: { title: "My Conversation" },
    });

    const { result } = renderAppTitleHook();

    await waitFor(() =>
      expect(result.current).toBe("My Conversation | Nimbus Chat"),
    );
  });

  it("returns '{some title} | Nimbus Chat' if is SaaS and in /conversations", async () => {
    // @ts-expect-error - only returning partial config for test
    getConfigSpy.mockResolvedValue({ app_mode: "saas" });
    mockUseParams.mockReturnValue({ conversationId: "456" });
    mockUseUserConversation.mockReturnValue({
      // @ts-expect-error - only returning partial config for test
      data: { title: "Another Conversation Title" },
    });

    const { result } = renderAppTitleHook();

    await waitFor(() =>
      expect(result.current).toBe("Another Conversation Title | Nimbus Chat"),
    );
  });

  it("should return app name while conversation is loading", async () => {
    // @ts-expect-error - only returning partial config for test
    getConfigSpy.mockResolvedValue({ app_mode: "oss" });
    mockUseParams.mockReturnValue({ conversationId: "123" });
    // @ts-expect-error - only returning partial config for test
    mockUseUserConversation.mockReturnValue({ data: undefined });

    const { result } = renderAppTitleHook();

    await waitFor(() => expect(result.current).toBe("Nimbus Chat"));
  });
});
