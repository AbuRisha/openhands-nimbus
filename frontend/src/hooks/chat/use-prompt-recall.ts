import React from "react";
import { useEventStore } from "#/stores/use-event-store";
import { isV1Event, isUserMessageEvent } from "#/types/v1/type-guards";
import { isUserMessage } from "#/types/core/guards";
import { parseMessageFromEvent } from "#/components/v1/chat/event-content-helpers/parse-message-from-event";

/**
 * Walk back through your own sent prompts with the Up arrow, the way a shell
 * history works.
 *
 * SOURCE OF TRUTH IS THE TRANSCRIPT, not a side list. `conversation-store` has
 * a `submittedMessage` slot, but it holds exactly one message and is cleared on
 * send — the same single-slot shape that made queued messages overwrite each
 * other. Reading the events instead means history survives a reload, matches
 * exactly what the user can see above the composer, and cannot drift from it.
 *
 * NOT REGISTERED AS A GLOBAL SHORTCUT, deliberately. Everything else in the
 * shortcut registry is a global chord; Up is an ordinary cursor key that only
 * means "recall" when the composer is empty. Routing it through the registry
 * would put a document-level listener in the path of every arrow press in the
 * app, to serve one element. It belongs on the element.
 */

/** Oldest-first is wrong here: recall walks BACKWARDS, so index 0 must be the
 *  most recent thing you sent. */
const collectSentPrompts = (events: unknown[]): string[] => {
  const prompts: string[] = [];

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as never;
    let text: string | null = null;

    if (isV1Event(event) && isUserMessageEvent(event)) {
      text = parseMessageFromEvent(event);
    } else if (isUserMessage(event)) {
      text = (event as { args: { content: string } }).args.content;
    }

    if (text?.trim()) {
      // A prompt sent twice in a row should be ONE history entry. Pressing Up
      // twice and getting the same string reads as the key not working.
      if (prompts[prompts.length - 1] !== text) prompts.push(text);
    }
  }

  return prompts;
};

export interface PromptRecall {
  /** Returns the text to place in the composer, or null to let the key through
   *  to its normal cursor behaviour. */
  recallPrevious: (currentText: string) => string | null;
  recallNext: (currentText: string) => string | null;
  /** Call whenever the user types or sends, so the next Up starts fresh. */
  reset: () => void;
}

export function usePromptRecall(): PromptRecall {
  const events = useEventStore((state) => state.events);
  // -1 means "not currently walking history".
  const cursor = React.useRef(-1);

  const prompts = React.useMemo(() => collectSentPrompts(events), [events]);

  const reset = React.useCallback(() => {
    cursor.current = -1;
  }, []);

  const recallPrevious = React.useCallback(
    (currentText: string) => {
      // Up only recalls from an EMPTY composer, unless we are already walking
      // history. Otherwise Up would stop moving the caret in a multi-line
      // prompt, which is a worse regression than the feature is a gain.
      if (cursor.current === -1 && currentText.trim() !== "") return null;
      if (prompts.length === 0) return null;

      const next = Math.min(cursor.current + 1, prompts.length - 1);
      // Already at the oldest: swallow the key rather than returning the same
      // string, so the caller does not pointlessly rewrite the composer.
      if (next === cursor.current) return null;

      cursor.current = next;
      return prompts[next];
    },
    [prompts],
  );

  const recallNext = React.useCallback(() => {
    if (cursor.current === -1) return null;

    const next = cursor.current - 1;
    cursor.current = next;
    // Walking forward past the newest entry returns to the empty composer you
    // started from, rather than sticking on the most recent prompt.
    return next === -1 ? "" : prompts[next];
  }, [prompts]);

  return { recallPrevious, recallNext, reset };
}
