import { OpenHandsEvent } from "#/types/v1/core";
import {
  isActionEvent,
  isObservationEvent,
  isMessageEvent,
  isAgentErrorEvent,
  isStreamingDeltaEvent,
} from "#/types/v1/type-guards";

/**
 * Turn a flat event list into one row per tool CALL.
 *
 * WHAT WAS WRONG WITH THE OLD SHAPE
 * ---------------------------------
 * Consecutive machinery was folded into a single "Used 12 tools" chip. That
 * fixed the original complaint — twenty full-width rows burying the actual
 * conversation — by trading it for a different one: everything the agent did
 * sat behind one click, as an opaque count. You could see THAT it worked and
 * not WHAT it did, and finding one command meant opening the whole wall.
 *
 * A count is not a summary. The shape people actually read is one line per
 * call — the tool and the single argument that identifies it —
 *
 *   Bash    npm test
 *   Read    src/hooks/use-resume-then-send.ts
 *   Edit    src/components/chat/messages.tsx
 *
 * — each expanding on its own to the detail that already renders today. The
 * conversation stays scannable because a collapsed call is one line, and
 * nothing is more than one click from being read.
 *
 * WHAT STAYS A FULL ROW
 * ---------------------
 * Narration, streaming prose and agent errors, exactly as before: that test
 * lives in isToolMachineryEvent and is the load-bearing part carried over from
 * this module's predecessor. An action that carries a `thought` renders as an ordinary
 * assistant message, so it is prose and keeps its full row — compressing it to
 * `Bash npm test` would delete the sentence the agent wrote to explain itself.
 *
 * This module is pure: events in, a render plan out. It touches no React state
 * so it can be tested directly, which is the point — the alternative is finding
 * the pairing edge cases in production.
 */

/**
 * Does this action say something the user is meant to read?
 *
 * Mirrors ThoughtEventMessage's own test — it renders nothing when the joined
 * text parts are empty — so an action stays machinery when its thought is
 * absent, blank, or carries no text parts. Anything that WOULD render on its
 * own keeps its row.
 */
function hasVisibleNarration(event: OpenHandsEvent): boolean {
  const { action } = event as { action?: { kind?: string; thought?: unknown } };

  // ThinkAction's entire payload is reasoning; event-message.tsx renders it as
  // a plain chat message rather than a collapsible block.
  if (action?.kind === "ThinkAction") return true;

  const { thought } = event as { thought?: unknown };
  if (typeof thought === "string") return thought.trim().length > 0;
  if (!Array.isArray(thought)) return false;

  return thought.some(
    (part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: string }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string" &&
      (part as { text: string }).text.trim().length > 0,
  );
}

/**
 * Is this event machinery, rather than something the user is meant to read?
 *
 * Deliberately an allowlist of machinery rather than a denylist of narration:
 * an event type added upstream should default to getting its own full row, not
 * to being silently compressed into a one-line summary that was never written
 * with it in mind.
 */
export function isToolMachineryEvent(event: OpenHandsEvent): boolean {
  // Narration and failures are always shown in full.
  if (isMessageEvent(event)) return false;
  if (isStreamingDeltaEvent(event)) return false;
  if (isAgentErrorEvent(event)) return false;

  // An action can BE narration, and that was the hole in the first version of
  // this: ActionEvent carries a `thought`, which ThoughtEventMessage renders as
  // an ordinary assistant message, and ThinkAction is nothing but reasoning.
  // Summarising those to `Bash npm test` deletes the sentence the agent wrote
  // to explain itself — reported against the previous design as "it says used
  // tools but hides informative text from the user".
  if (isActionEvent(event) && hasVisibleNarration(event)) return false;

  return isActionEvent(event) || isObservationEvent(event);
}

export interface ToolCallItem {
  type: "toolCall";
  /** The action that started this call. */
  action: OpenHandsEvent;
  /**
   * Its result, when it has arrived. Absent means the call is still running or
   * is waiting on the user to approve it — which is why rows without one are
   * shown open.
   */
  observation?: OpenHandsEvent;
  /** Index of the action in the original list. */
  index: number;
  /** Index of the observation, so it keeps its own real position. */
  observationIndex?: number;
}

export interface SingleItem {
  type: "single";
  event: OpenHandsEvent;
  index: number;
}

export type PlanItem = SingleItem | ToolCallItem;

/**
 * The id an observation uses to name the action it answers.
 *
 * Both sides carry `tool_call_id` and it is the LLM's own identifier for the
 * call, so it is the primary key. `action_id` is the fallback because it is
 * what the event store fills in, and older events carry only that.
 */
function callKey(event: OpenHandsEvent): string | null {
  const e = event as { tool_call_id?: unknown; action_id?: unknown };
  if (typeof e.tool_call_id === "string" && e.tool_call_id) {
    return e.tool_call_id;
  }
  if (typeof e.action_id === "string" && e.action_id) return e.action_id;
  return null;
}

/**
 * Build the render plan.
 *
 * Order is preserved and no event is dropped: every input event appears
 * exactly once, either as a `single`, as a `toolCall`'s action, or as its
 * observation. That total-coverage property is what the test asserts, because
 * a pairing bug that silently swallows an event is invisible until someone
 * notices a missing result.
 */
export function planToolCalls(events: OpenHandsEvent[]): PlanItem[] {
  // An observation can only be attached to an action that came before it, so a
  // single forward pass with a pending map is enough.
  const pendingByKey = new Map<string, ToolCallItem>();
  const out: PlanItem[] = [];

  events.forEach((event, index) => {
    if (!isToolMachineryEvent(event)) {
      // Narration, errors, and actions that say something. Full row.
      out.push({ type: "single", event, index });
      return;
    }

    if (isActionEvent(event)) {
      const item: ToolCallItem = { type: "toolCall", action: event, index };
      const key = callKey(event);
      if (key) pendingByKey.set(key, item);
      out.push(item);
      return;
    }

    if (isObservationEvent(event)) {
      const key = callKey(event);
      const pending = key ? pendingByKey.get(key) : undefined;
      if (pending && !pending.observation) {
        // Fold into the row its action already occupies rather than emitting a
        // second one. Mutating the item already pushed is deliberate: it keeps
        // the action's position in the transcript, which is where the reader
        // expects to find the result.
        pending.observation = event;
        pending.observationIndex = index;
        if (key) pendingByKey.delete(key);
        return;
      }
      // No action to attach to. Render it rather than dropping it — an
      // unmatched result is exactly the kind of thing worth seeing.
      out.push({ type: "single", event, index });
      return;
    }

    out.push({ type: "single", event, index });
  });

  return out;
}
