import { OpenHandsEvent } from "#/types/v1/core";
import {
  isActionEvent,
  isObservationEvent,
  isMessageEvent,
  isAgentErrorEvent,
  isStreamingDeltaEvent,
} from "#/types/v1/type-guards";

/**
 * Collapse runs of consecutive tool calls into a single expandable row.
 *
 * THE PROBLEM
 * -----------
 * Every action and observation renders as its own full-width row. A single
 * agent turn that greps four files, edits two and runs a test emits well over
 * twenty of them, so the actual conversation — what the user asked and what
 * the assistant said back — is buried between walls of machinery. Reported as
 * "this is literally unreadable and unusable".
 *
 * The fix is the shape Claude Code uses: narration stays visible, the
 * machinery folds into one "Used 14 tools" chip you can open when you care.
 *
 * WHAT BREAKS A RUN
 * -----------------
 * Anything the user reads as narration or as a turn boundary:
 *   - message events (the user's prompt, the assistant's prose)
 *   - streaming deltas (prose arriving live)
 *   - agent errors — never hide a failure inside a collapsed group
 * Everything else — actions and their observations — is machinery and groups.
 *
 * WHY A MINIMUM SIZE
 * ------------------
 * Collapsing two rows into a chip that says "Used 2 tools" saves nothing and
 * costs a click. Below the threshold the events are emitted individually, so
 * short turns look exactly as they do today.
 *
 * This module is pure: it takes events and returns a plan. It renders nothing
 * and reads no React state, so it can be unit-tested on its own — which is the
 * point, because the alternative is discovering the edge cases in production.
 */

export const MIN_GROUP_SIZE = 3;

export type GroupedEventItem =
  | { type: "single"; event: OpenHandsEvent; index: number }
  | { type: "group"; events: OpenHandsEvent[]; startIndex: number };

/**
 * Is this event machinery (groupable) rather than narration?
 *
 * Deliberately a allowlist of "groupable" rather than a denylist of
 * "narration": a new event type added upstream should default to being shown
 * on its own, not silently folded into a collapsed chip where nobody sees it.
 */
export function isGroupableToolEvent(event: OpenHandsEvent): boolean {
  // Narration and failures always break the run.
  if (isMessageEvent(event)) return false;
  if (isStreamingDeltaEvent(event)) return false;
  if (isAgentErrorEvent(event)) return false;

  // An action can BE narration, and that was the hole in the first version of
  // this: ActionEvent carries a `thought`, which ThoughtEventMessage renders as
  // an ordinary assistant message, and ThinkAction is nothing but reasoning.
  // Grouping those folded the assistant's own explanation of what it was doing
  // into a collapsed "Used N tools" chip — reported as "it says used tools but
  // hides informative text from the user". The machinery was supposed to fold
  // away; the talking never was.
  if (isActionEvent(event) && hasVisibleNarration(event)) return false;

  return isActionEvent(event) || isObservationEvent(event);
}

/**
 * Does this action say something the user is meant to read?
 *
 * Mirrors ThoughtEventMessage's own test — it renders nothing when the joined
 * text parts are empty — so an action stays groupable when its thought is
 * absent, blank, or carries no text parts. Anything that WOULD render on its
 * own must not be hidden behind a click.
 */
function hasVisibleNarration(event: OpenHandsEvent): boolean {
  const action = (event as { action?: { kind?: string; thought?: unknown } })
    .action;

  // ThinkAction's entire payload is reasoning; event-message.tsx renders it as
  // a plain chat message rather than a collapsible block.
  if (action?.kind === "ThinkAction") return true;

  const thought = (event as { thought?: unknown }).thought;
  if (typeof thought === "string") return thought.trim().length > 0;
  if (!Array.isArray(thought)) return false;

  return thought.some(
    (part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: string }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string" &&
      ((part as { text: string }).text.trim().length > 0),
  );
}

/**
 * Turn a flat event list into a render plan of singles and groups.
 *
 * Order is preserved exactly; no event is dropped. Callers can rely on the
 * concatenation of every `single.event` and every `group.events` being the
 * input list, in order — which is what the test asserts.
 */
export function groupToolEvents(
  events: OpenHandsEvent[],
  minGroupSize: number = MIN_GROUP_SIZE,
): GroupedEventItem[] {
  const out: GroupedEventItem[] = [];
  let run: OpenHandsEvent[] = [];
  let runStart = 0;

  const flushRun = () => {
    if (run.length === 0) return;
    if (run.length >= minGroupSize) {
      out.push({ type: "group", events: run, startIndex: runStart });
    } else {
      // Too short to be worth a chip — emit as-is so nothing is hidden
      // behind a click for no benefit.
      run.forEach((e, i) =>
        out.push({ type: "single", event: e, index: runStart + i }),
      );
    }
    run = [];
  };

  events.forEach((event, index) => {
    if (isGroupableToolEvent(event)) {
      if (run.length === 0) runStart = index;
      run.push(event);
      return;
    }
    flushRun();
    out.push({ type: "single", event, index });
  });

  flushRun();
  return out;
}

/**
 * Label for a collapsed group.
 *
 * Counts ACTIONS, not events. An action and its observation are one thing the
 * agent did; counting both would report "Used 28 tools" for fourteen calls and
 * read as noise inflation.
 */
export function groupLabel(events: OpenHandsEvent[]): string {
  const actionCount = events.filter(isActionEvent).length;
  const n = actionCount > 0 ? actionCount : events.length;
  return `Used ${n} ${n === 1 ? "tool" : "tools"}`;
}
