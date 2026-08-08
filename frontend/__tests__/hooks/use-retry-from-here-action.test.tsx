import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const forkConversationMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const displayErrorToastMock = vi.hoisted(() => vi.fn());

vi.mock("#/api/fork-conversation", () => ({
  forkConversation: forkConversationMock,
}));

vi.mock("#/utils/custom-toast-handlers", () => ({
  displayErrorToast: displayErrorToastMock,
  displaySuccessToast: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>(
    "react-router",
  );
  return { ...actual, useNavigate: () => navigateMock };
});

// i18n is stubbed so `t` returns the KEY, and that is what these tests assert
// on — not the English string. Asserting on English would turn a copy edit
// into a test failure while changing nothing functional.
//
// Both surfaces need stubbing: the component-facing `useTranslation`, and the
// `i18n` SINGLETON that the mutation hook imports directly (it has no
// component to read a hook from). Stubbing only the first leaves the real
// module loading its Backend/LanguageDetector chain and blowing up on import.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("#/i18n", () => ({
  default: { t: (key: string) => key },
}));

import { useRetryFromHereAction } from "#/hooks/chat/use-retry-from-here-action";

const CONVERSATION_ID = "11111111-1111-1111-1111-111111111111";
const EVENT_ID = "abcdef0123456789";

const wrapperFor = (path: string, routePattern: string) =>
  function Wrapper({ children }: React.PropsWithChildren) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={routePattern} element={<>{children}</>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
  };

const authedWrapper = wrapperFor(
  `/conversations/${CONVERSATION_ID}`,
  "/conversations/:conversationId",
);

const sharedWrapper = wrapperFor(
  `/shared/conversations/${CONVERSATION_ID}`,
  "/shared/conversations/:conversationId",
);

afterEach(() => {
  vi.clearAllMocks();
});

describe("useRetryFromHereAction", () => {
  it("offers the action on an authed conversation route", () => {
    const { result } = renderHook(() => useRetryFromHereAction(EVENT_ID), {
      wrapper: authedWrapper,
    });

    expect(result.current).not.toBeNull();
    expect(result.current?.tooltip).toBe("FORK$RETRY_FROM_HERE");
    expect(result.current?.isDisabled).toBe(false);
  });

  /*
   * The one that matters. `shared/conversations/:conversationId` is served
   * WITHOUT authentication, so a control here would be offered to a visitor
   * with no account and would act against someone else's conversation.
   */
  it("does NOT offer the action on the unauthenticated shared route", () => {
    const { result } = renderHook(() => useRetryFromHereAction(EVENT_ID), {
      wrapper: sharedWrapper,
    });

    expect(result.current).toBeNull();
  });

  it("returns null rather than throwing when the event has no id", () => {
    const { result } = renderHook(() => useRetryFromHereAction(undefined), {
      wrapper: authedWrapper,
    });

    expect(result.current).toBeNull();
  });

  it("clicking opens a confirmation and does NOT fire the request", () => {
    const { result } = renderHook(() => useRetryFromHereAction(EVENT_ID), {
      wrapper: authedWrapper,
    });

    expect(result.current?.confirmationText).toBeNull();

    act(() => result.current!.onClick());

    expect(result.current?.confirmationText).toBe(
      "FORK$FILES_UNCHANGED_WARNING",
    );
    // The request costs money and starts a sandbox. A click must not spend it.
    expect(forkConversationMock).not.toHaveBeenCalled();
  });

  it("cancelling closes the confirmation without firing", () => {
    const { result } = renderHook(() => useRetryFromHereAction(EVENT_ID), {
      wrapper: authedWrapper,
    });

    act(() => result.current!.onClick());
    act(() => result.current!.cancel());

    expect(result.current?.confirmationText).toBeNull();
    expect(forkConversationMock).not.toHaveBeenCalled();
  });

  it("confirming forks up to THIS event, inclusive, and navigates there", async () => {
    forkConversationMock.mockResolvedValue({
      conversation_id: "22222222-2222-2222-2222-222222222222",
      sandbox_id: "sb-1",
      events_in_agent_state: 4,
      events_in_transcript: 4,
      halves_agree: true,
    });

    const { result } = renderHook(() => useRetryFromHereAction(EVENT_ID), {
      wrapper: authedWrapper,
    });

    act(() => result.current!.onClick());
    act(() => result.current!.confirm());

    // `waitFor`, not a bare assert: react-query dispatches the mutationFn in a
    // microtask, so nothing has been called on the line after confirm().
    //
    // Positional args, so a silent re-order of the client signature fails here
    // rather than quietly sending the event id as the conversation id.
    await waitFor(() => {
      expect(forkConversationMock).toHaveBeenCalledWith(
        CONVERSATION_ID,
        EVENT_ID,
      );
    });

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(
        "/conversations/22222222-2222-2222-2222-222222222222",
      );
    });
    expect(displayErrorToastMock).not.toHaveBeenCalled();
  });

  /*
   * `halves_agree` MUST NOT reach the customer. It compares a count of files
   * in the sandbox's SDK EventLog against a count from the app server's own
   * event mirror — two different stores, which need not agree even when both
   * copies are complete. Surfacing it fired "do not trust this conversation"
   * on every successful fork, which is how a warning becomes noise.
   */
  it("does NOT warn on halves_agree=false, and still navigates", async () => {
    forkConversationMock.mockResolvedValue({
      conversation_id: "33333333-3333-3333-3333-333333333333",
      sandbox_id: "sb-2",
      events_in_agent_state: 2,
      events_in_transcript: 7,
      halves_agree: false,
    });

    const { result } = renderHook(() => useRetryFromHereAction(EVENT_ID), {
      wrapper: authedWrapper,
    });

    act(() => result.current!.onClick());
    act(() => result.current!.confirm());

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(
        "/conversations/33333333-3333-3333-3333-333333333333",
      );
    });
    // The signal is unsound, so it must produce no customer-visible output.
    expect(displayErrorToastMock).not.toHaveBeenCalled();
  });

  it.each([
    [404, "FORK$ERROR_NOT_FOUND"],
    [409, "FORK$ERROR_SANDBOX_NOT_RUNNING"],
    [502, "FORK$ERROR_PARTIAL"],
    [500, "FORK$ERROR_GENERIC"],
    [undefined, "FORK$ERROR_GENERIC"],
  ])("maps status %s to %s", async (status, expectedKey) => {
    forkConversationMock.mockRejectedValue(
      Object.assign(new Error("boom"), {
        response: status === undefined ? undefined : { status },
      }),
    );

    const { result } = renderHook(() => useRetryFromHereAction(EVENT_ID), {
      wrapper: authedWrapper,
    });

    act(() => result.current!.onClick());
    act(() => result.current!.confirm());

    await waitFor(() => {
      expect(displayErrorToastMock).toHaveBeenCalledWith(expectedKey);
    });
    // A failed retry must not move the customer off the conversation they are
    // reading — there is nothing to move them to.
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
