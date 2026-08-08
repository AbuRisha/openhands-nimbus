import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import V1ConversationService from "#/api/conversation-service/v1-conversation-service.api";

/**
 * Send a message to a conversation whose sandbox is gone, without making the
 * user deal with that.
 *
 * A conversation reads as "archived and read-only" purely because
 * `sandbox.status == MISSING`, and under RUNTIME=process the sandbox is a child
 * process of the app container — so an ordinary deploy, replica recycle or
 * crash silently ends every live conversation. It is not something anyone
 * chose, it is not rare, and it is not the user's problem.
 *
 * The previous behaviour replaced the composer with a banner, so the only way
 * forward was to notice a Resume button and press it. That still framed routine
 * infrastructure churn as a state the user has to understand and act on. They
 * do not: they want to keep typing.
 *
 * So the composer stays, and the resume happens on send — attach a fresh
 * sandbox, wait for it to actually accept work, then deliver the message that
 * was already typed. The visible cost is a short "reconnecting" state on the
 * first message after a restart.
 *
 * WAITING IS THE WHOLE PROBLEM
 * ----------------------------
 * Resume returns a start TASK, not a running sandbox. Sending immediately after
 * it resolves races the sandbox into existence and the message is lost — which
 * is a worse failure than the banner, because the user watched their words
 * disappear. So this polls the conversation until the sandbox reports RUNNING
 * before it hands the message on, and gives up loudly rather than silently.
 */

/** Sandbox states that mean the conversation can accept a message. */
const READY = new Set(["RUNNING"]);
/** States that mean a resume is still in progress rather than failed. */
const PENDING = new Set(["STARTING", "MISSING", "PAUSED", "BUILDING"]);

const POLL_INTERVAL_MS = 1_500;
/** Cold sandbox starts are slow; 90s is generous but finite. */
const RESUME_TIMEOUT_MS = 90_000;

export type ResumeState = "idle" | "resuming" | "failed";

export function useResumeThenSend(conversationId: string | undefined) {
  const queryClient = useQueryClient();
  const [state, setState] = React.useState<ResumeState>("idle");
  const inFlight = React.useRef(false);

  /**
   * Ensure the conversation can accept work. Resolves true when it can.
   *
   * Safe to call when the sandbox is already running — it checks first and
   * returns without starting anything.
   */
  const ensureLive = React.useCallback(async (): Promise<boolean> => {
    if (!conversationId) return false;
    // Concurrent sends must not each attach their own sandbox.
    if (inFlight.current) return false;

    const current = await V1ConversationService.batchGetAppConversations([
      conversationId,
    ]).catch(() => null);
    const status = current?.[0]?.sandbox_status;
    if (status && READY.has(status)) return true;

    inFlight.current = true;
    setState("resuming");
    try {
      await V1ConversationService.resumeConversation(conversationId);

      const deadline = Date.now() + RESUME_TIMEOUT_MS;
      // Sequential awaits are the point: this is a poll, and each iteration
      // depends on the previous one having finished. no-await-in-loop exists to
      // catch accidentally serialised parallel work, which this is not.
      /* eslint-disable no-await-in-loop */
      for (;;) {
        await new Promise((r) => {
          setTimeout(r, POLL_INTERVAL_MS);
        });
        const rows = await V1ConversationService.batchGetAppConversations([
          conversationId,
        ]).catch(() => null);
        const next = rows?.[0]?.sandbox_status;

        if (next && READY.has(next)) {
          // Agent state, the conversation row and the recents list are all
          // derived from the sandbox; without clearing them the UI keeps
          // rendering an archived conversation that is now running.
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: ["user", "conversation", conversationId],
            }),
            queryClient.invalidateQueries({
              queryKey: ["user", "conversations"],
            }),
            queryClient.invalidateQueries({ queryKey: ["sandboxes"] }),
          ]);
          setState("idle");
          return true;
        }

        // An unknown state is not progress. Treating it as pending would spin
        // for the full timeout on a sandbox that has already failed.
        if (next && !PENDING.has(next)) break;
        if (Date.now() > deadline) break;
      }

      /* eslint-enable no-await-in-loop */

      setState("failed");
      return false;
    } catch {
      setState("failed");
      return false;
    } finally {
      inFlight.current = false;
    }
  }, [conversationId, queryClient]);

  return { ensureLive, resumeState: state };
}
