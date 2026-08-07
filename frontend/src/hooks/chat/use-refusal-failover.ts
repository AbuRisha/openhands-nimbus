import React from "react";
import { OpenHandsEvent } from "#/types/v1/core";
import { isMessageEvent } from "#/types/v1/type-guards";
import {
  FailoverChoice,
  FallbackCandidate,
  chooseFallback,
  looksLikeRefusal,
} from "#/utils/refusal-failover";

/**
 * Decide whether to offer a failover prompt, and remember the answer.
 *
 * Everything that needs a conversation, a network or a store is passed IN, so
 * this stays testable against plain arrays. The caller supplies events, whether
 * a turn is still running, the model in use and the catalog; this returns what
 * to render.
 *
 * WHY IT WAITS FOR THE TURN TO END
 * --------------------------------
 * Detection runs only when the agent has stopped. A response streams token by
 * token, and "I can't help with" is a phrase that appears mid-sentence in
 * answers that go on to help — "I can't help with the old API, but here's the
 * new one". Matching per delta would fire the prompt against a message still
 * being written, and the customer would be offered a retry for an answer that
 * was about to arrive.
 *
 * WHY ANSWERS ARE REMEMBERED FOREVER
 * ----------------------------------
 * A message that has been prompted for is never prompted for again, whatever
 * the answer was. Without that a retry that ALSO refuses re-arms the prompt on
 * the new message, the user retries again, and a fallback chain becomes a paid
 * loop nobody asked for. Cancelling has to be permanent for the same reason: a
 * dismissed prompt that reappears on the next render is not dismissable.
 */

export interface RefusalState {
  /** The message that was refused, so the prompt can be anchored to it. */
  eventId: string;
  /** The model that refused, named as the picker names it. */
  refusedModel: string;
  /** What to offer instead; null when the catalog has nothing different. */
  fallback: FallbackCandidate | null;
}

interface UseRefusalFailoverArgs {
  events: OpenHandsEvent[];
  /** True while the agent is still producing. Detection waits for false. */
  isRunning: boolean;
  /** Provider-qualified id of the model in use. */
  currentModel: string | null | undefined;
  /** Display name of that model, for the prompt's title. */
  currentModelName: string;
  catalog: FallbackCandidate[];
}

/** Text of a message event, or null if it carries none. */
function messageText(event: OpenHandsEvent): string | null {
  const message = (
    event as { llm_message?: { role?: string; content?: unknown[] } }
  ).llm_message;
  if (!message || message.role !== "assistant") return null;
  if (!Array.isArray(message.content)) return null;
  const text = message.content
    .filter(
      (part): part is { type: string; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
  return text || null;
}

export function useRefusalFailover({
  events,
  isRunning,
  currentModel,
  currentModelName,
  catalog,
}: UseRefusalFailoverArgs) {
  // Ids that have already been offered a prompt. A Set in a ref rather than
  // state: adding to it must not itself cause a render, or answering a prompt
  // would re-run detection in the same commit.
  const answered = React.useRef<Set<string>>(new Set());
  const [active, setActive] = React.useState<RefusalState | null>(null);

  const lastAssistant = React.useMemo(() => {
    // Newest first, and stop at the first assistant message whatever it says.
    // Scanning past it would resurrect an older refusal the conversation has
    // already moved on from.
    const newestAssistant = [...events]
      .reverse()
      .find((event) => isMessageEvent(event) && messageText(event) !== null);
    if (!newestAssistant) return null;
    const text = messageText(newestAssistant);
    return text === null ? null : { id: String(newestAssistant.id), text };
  }, [events]);

  React.useEffect(() => {
    if (isRunning) return;
    /*
     * Wait for the catalog.
     *
     * It arrives from a query, so on the first idle render it is empty — and
     * because detection marks a message answered the moment it fires, an early
     * run recorded `fallback: null` PERMANENTLY and never re-evaluated. The
     * prompt then said "no other model is available" for every refusal, with
     * the whole feature dead behind a correct-looking message.
     *
     * Unit tests could not see this: they pass a populated array synchronously.
     * It took looking at the running app.
     */
    if (catalog.length === 0) return;
    if (!lastAssistant) return;
    if (answered.current.has(lastAssistant.id)) return;
    if (!looksLikeRefusal(lastAssistant.text)) return;

    answered.current.add(lastAssistant.id);
    setActive({
      eventId: lastAssistant.id,
      refusedModel: currentModelName,
      fallback: chooseFallback(currentModel, catalog),
    });
  }, [isRunning, lastAssistant, currentModel, currentModelName, catalog]);

  /**
   * Record an answer and clear the prompt.
   *
   * Returns the choice so the caller can act on it, keeping the decision here
   * and the side effects — switching a model, resending — with whoever owns
   * those.
   */
  const resolve = React.useCallback((choice: FailoverChoice) => {
    setActive(null);
    return choice;
  }, []);

  return { refusal: active, resolve };
}
