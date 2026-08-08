import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import V1ConversationService from "#/api/conversation-service/v1-conversation-service.api";
import { useResumeThenSend } from "#/hooks/use-resume-then-send";

/**
 * The failure this guards against is worse than the bug it replaces.
 *
 * Resuming returns a start TASK, not a running sandbox. If the composer sends
 * as soon as that resolves, the message races the sandbox into existence and is
 * dropped — and the user watched their words vanish, which is a worse
 * experience than being told the conversation was archived.
 *
 * So the contract under test is narrow and specific: ensureLive resolves true
 * ONLY once the sandbox actually reports RUNNING.
 */

const CONV = "conv-1";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const conv = (sandbox_status: string) =>
  [{ id: CONV, sandbox_status }] as never;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useResumeThenSend", () => {
  it("does not resume a conversation that is already running", async () => {
    const batch = vi
      .spyOn(V1ConversationService, "batchGetAppConversations")
      .mockResolvedValue(conv("RUNNING"));
    const resume = vi.spyOn(V1ConversationService, "resumeConversation");

    const { result } = renderHook(() => useResumeThenSend(CONV), { wrapper });
    await expect(result.current.ensureLive()).resolves.toBe(true);

    expect(batch).toHaveBeenCalledTimes(1);
    // The normal path must cost nothing — no sandbox is attached.
    expect(resume).not.toHaveBeenCalled();
  });

  it("waits for RUNNING before reporting the conversation live", async () => {
    // MISSING, then still STARTING, then finally RUNNING.
    vi.spyOn(V1ConversationService, "batchGetAppConversations")
      .mockResolvedValueOnce(conv("MISSING"))
      .mockResolvedValueOnce(conv("STARTING"))
      .mockResolvedValue(conv("RUNNING"));
    vi.spyOn(V1ConversationService, "resumeConversation").mockResolvedValue(
      {} as never,
    );

    const { result } = renderHook(() => useResumeThenSend(CONV), { wrapper });
    const live = result.current.ensureLive();
    await vi.advanceTimersByTimeAsync(5_000);

    // True only after RUNNING — never on the STARTING poll.
    await expect(live).resolves.toBe(true);
  });

  it("fails rather than hanging when the sandbox lands in an unexpected state", async () => {
    vi.spyOn(V1ConversationService, "batchGetAppConversations")
      .mockResolvedValueOnce(conv("MISSING"))
      .mockResolvedValue(conv("ERROR"));
    vi.spyOn(V1ConversationService, "resumeConversation").mockResolvedValue(
      {} as never,
    );

    const { result } = renderHook(() => useResumeThenSend(CONV), { wrapper });
    const live = result.current.ensureLive();
    await vi.advanceTimersByTimeAsync(5_000);

    // ERROR is not in PENDING, so it must break out immediately rather than
    // spin for the full 90s timeout on a sandbox that already failed.
    await expect(live).resolves.toBe(false);
    await waitFor(() => expect(result.current.resumeState).toBe("failed"));
  });

  it("reports failure when the resume call itself throws", async () => {
    vi.spyOn(V1ConversationService, "batchGetAppConversations").mockResolvedValue(
      conv("MISSING"),
    );
    vi.spyOn(V1ConversationService, "resumeConversation").mockRejectedValue(
      new Error("boom"),
    );

    const { result } = renderHook(() => useResumeThenSend(CONV), { wrapper });
    await expect(result.current.ensureLive()).resolves.toBe(false);
  });

  it("returns false without a conversation id instead of throwing", async () => {
    const { result } = renderHook(() => useResumeThenSend(undefined), {
      wrapper,
    });
    await expect(result.current.ensureLive()).resolves.toBe(false);
  });
});
