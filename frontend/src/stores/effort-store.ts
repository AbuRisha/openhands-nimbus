import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/**
 * Reasoning-effort value sent to /v1/chat/completions as `reasoning_effort`.
 * OpenAI-compatible values plus Nimbus's `max` stop for the Ultracode tier.
 */
export type EffortValue = "low" | "medium" | "high" | "max";

export interface EffortStop {
  value: EffortValue;
  chipLabel: string;
  description: string;
}

/**
 * Ordered list of stops rendered left-to-right on the slider.
 * Keep this list ordered from FASTEST to SMARTEST — the slider math
 * assumes the index maps directly to the fill percentage.
 */
export const EFFORT_STOPS: EffortStop[] = [
  {
    value: "low",
    chipLabel: "Faster",
    description: "Snappy replies. Skips deep reasoning.",
  },
  {
    value: "medium",
    chipLabel: "Balanced",
    description: "Reasonable thinking, good pace.",
  },
  {
    value: "high",
    chipLabel: "Smart",
    description: "Deeper reasoning. Better on hard tasks.",
  },
  {
    value: "max",
    chipLabel: "Ultracode",
    description: "Maximum reasoning budget. Slowest but sharpest.",
  },
];

interface EffortState {
  effort: EffortValue;
  setEffort: (value: EffortValue) => void;
}

export const useEffortStore = create<EffortState>()(
  persist(
    (set) => ({
      effort: "medium",
      setEffort: (value) => set({ effort: value }),
    }),
    {
      name: "nimbus.effort",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/**
 * Non-hook accessor for the current effort. Used by the axios request
 * interceptor which runs outside React (no hook context available).
 */
export function getStoredEffort(): EffortValue {
  return useEffortStore.getState().effort;
}
