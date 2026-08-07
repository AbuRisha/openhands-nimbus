/**
 * One keydown listener, and a stated rule for who wins.
 *
 * WHY THIS EXISTS
 * ---------------
 * Seven components each attached their own `document`/`window` keydown
 * listener, and two chords had more than one owner:
 *
 *   Cmd+Enter — `chat-interface` (Build plan) and `confirmation-buttons`
 *     (approve the pending tool call). `chat-interface` gates on
 *     `isAgentRunning`, which is only RUNNING or LOADING, so during
 *     AWAITING_USER_CONFIRMATION both were mounted: one keystroke approved a
 *     tool call AND kicked off a plan build.
 *
 *   Escape — `modal-backdrop` (close the modal) and the ACP model menu (close
 *     the menu). A menu inside a modal closed both at once.
 *
 * The Cmd+Enter case *looked* handled: `chat-interface` called
 * `event.stopPropagation()`. That does nothing here. stopPropagation stops
 * bubbling to ANCESTORS; it does not stop other listeners on the same node, and
 * both were on `document`. Only `stopImmediatePropagation` affects siblings,
 * and even then the winner is whoever registered first — i.e. mount order,
 * which is not a contract anyone can read off the source.
 *
 * So this module owns dispatch. Entries declare a PRIORITY, the highest live
 * match runs, and nothing below it does. Exclusivity becomes a property of the
 * registry rather than an accident of mount order.
 *
 * WHAT THIS IS NOT: a keymap the user can rebind. Chords are still declared at
 * the call site. The registry decides who WINS, not what the keys ARE.
 */

/** Higher wins. Named rather than numeric at the call site, so the ordering
 *  argument lives here in one place instead of being re-litigated per feature. */
export const ShortcutLayer = {
  /** Transient popovers. Escape must reach the innermost thing first — closing
   *  the modal out from under an open menu loses the menu's context too. */
  MENU: 40,
  /** Dialogs and modal backdrops. */
  MODAL: 30,
  /** A pending decision the agent is blocked on. Outranks the composer: if the
   *  agent is waiting for approval, Cmd+Enter means "approve", not "build". */
  CONFIRMATION: 20,
  /** Composer-level actions — send, build. */
  COMPOSER: 10,
  /** Always-available fallbacks. */
  GLOBAL: 0,
} as const;

export type ShortcutLayerValue =
  (typeof ShortcutLayer)[keyof typeof ShortcutLayer];

export interface Chord {
  /** Compared case-insensitively against `KeyboardEvent.key`. */
  key: string;
  /** True = required, false = required absent, undefined = don't care.
   *  `mod` is Cmd on Mac and Ctrl elsewhere; prefer it over meta/ctrl. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutOptions {
  priority: ShortcutLayerValue;
  /** Re-checked at keypress time, not at registration. A handler whose `when`
   *  returns false is skipped and does NOT consume the chord, so a lower layer
   *  can still take it.
   *
   *  Receives the event because some predicates need it — notably
   *  `event.defaultPrevented`, which is how a handler defers to a listener that
   *  is NOT in this registry (a React onKeyDown on an element runs before the
   *  document dispatch and can mark the event handled). Priority only orders
   *  the shortcuts the registry knows about. */
  when?: (event: KeyboardEvent) => boolean;
  /** By default a shortcut does not fire while the user is typing, because
   *  every one of these is a global chord and stealing keys from an input is
   *  the single most common way a shortcut becomes a bug. Chords carrying a
   *  modifier are exempt — Cmd+Enter in a textarea is the normal way to send. */
  allowInInput?: boolean;
  /** Default true. */
  preventDefault?: boolean;
}

interface Entry extends ShortcutOptions {
  chord: Chord;
  handler: (event: KeyboardEvent) => void;
}

const entries = new Set<Entry>();
let listening = false;

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
};

/** Cmd on Mac, Ctrl elsewhere. Reading the platform per-event rather than once
 *  keeps this correct under a userAgent override in tests. */
const modPressed = (event: KeyboardEvent): boolean =>
  event.metaKey || event.ctrlKey;

const matches = (chord: Chord, event: KeyboardEvent): boolean => {
  if (chord.key.toLowerCase() !== event.key.toLowerCase()) return false;
  if (chord.mod !== undefined && chord.mod !== modPressed(event)) return false;
  if (chord.shift !== undefined && chord.shift !== event.shiftKey) return false;
  if (chord.alt !== undefined && chord.alt !== event.altKey) return false;
  return true;
};

const dispatch = (event: KeyboardEvent): void => {
  // A repeat is a held key, not a second intent. Approving twice because a
  // keystroke autorepeated is exactly the kind of thing this registry exists
  // to make impossible.
  if (event.repeat) return;

  const candidates = [...entries]
    .filter((entry) => matches(entry.chord, event))
    .sort((a, b) => b.priority - a.priority);

  for (const entry of candidates) {
    const typing = isTypingTarget(event.target);
    const modified = modPressed(event) || event.altKey;
    const blockedByInput = typing && !modified && !entry.allowInInput;

    // `when` is deliberately checked here rather than at registration: the
    // answer changes between renders, and a stale predicate is how the
    // Cmd+Enter collision survived review in the first place.
    if (!blockedByInput && (entry.when?.(event) ?? true)) {
      if (entry.preventDefault ?? true) event.preventDefault();
      entry.handler(event);
      // Exclusive by construction. This is the whole point: the next-highest
      // owner of the same chord does not also run.
      return;
    }
  }
};

export const registerShortcut = (entry: Entry): (() => void) => {
  entries.add(entry);
  if (!listening) {
    document.addEventListener("keydown", dispatch);
    listening = true;
  }
  return () => {
    entries.delete(entry);
  };
};

/** Test seam. The listener is intentionally left attached — teardown between
 *  tests should clear registrations, not re-enter the attach path. */
export const clearShortcutsForTest = (): void => {
  entries.clear();
};

export const shortcutCountForTest = (): number => entries.size;
