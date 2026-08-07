import React from "react";
import {
  Chord,
  ShortcutOptions,
  registerShortcut,
} from "#/utils/shortcut-registry";

/**
 * Bind a global chord for as long as this component is mounted.
 *
 * The handler and `when` predicate are read through a ref, so passing inline
 * arrows — which every call site does — does NOT re-register on each render and
 * does NOT capture stale state. That combination was a real bug in
 * `modal-backdrop`: an empty dependency array meant Escape kept calling the
 * handler from the FIRST render forever, so clicking the backdrop used the
 * current `onClose` and Escape used a stale one. Holding them in a ref makes
 * that shape unavailable rather than merely fixed once.
 *
 * Re-registration therefore depends only on the CHORD and the priority.
 */
export function useShortcut(
  chord: Chord,
  handler: (event: KeyboardEvent) => void,
  options: ShortcutOptions,
): void {
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;

  const whenRef = React.useRef(options.when);
  whenRef.current = options.when;

  const {
    priority,
    allowInInput,
    preventDefault,
    key,
    mod,
    shift,
    alt,
  }: ShortcutOptions & Chord = { ...options, ...chord };

  React.useEffect(
    () =>
      registerShortcut({
        chord: { key, mod, shift, alt },
        priority,
        allowInInput,
        preventDefault,
        // Indirection through the refs is what makes the dep array below safe.
        when: (event) => whenRef.current?.(event) ?? true,
        handler: (event) => handlerRef.current(event),
      }),
    [key, mod, shift, alt, priority, allowInInput, preventDefault],
  );
}
