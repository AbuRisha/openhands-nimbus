import { create } from "zustand";
import { devtools } from "zustand/middleware";

export interface HelpEntry {
  id: string;
  /**
   * Id of the chat event after which this entry renders, or `null` to pin it to
   * the top when /help is the first thing typed in an empty conversation.
   */
  anchorEventId: string | null;
}

/**
 * Where a `/help` response should appear in the transcript — and nothing else.
 *
 * THE ENTRY DELIBERATELY CARRIES NO CONTENT. `model-store` snapshots the
 * profile list into its entry because that list is a server response that can
 * legitimately differ from one /model to the next. The command set cannot: it
 * is `BUILT_IN_COMMANDS`, a module constant. Storing a copy would create a
 * second source of truth that silently goes stale the moment a command is
 * added — a help text that documents commands the build no longer has is worse
 * than no help at all, because it is confidently wrong.
 *
 * So the renderer reads the registry directly and this holds only the anchor.
 */
interface HelpState {
  entriesByConversation: Record<string, HelpEntry[]>;
}

interface HelpActions {
  show: (conversationId: string, anchorEventId: string | null) => void;
  clear: (conversationId: string) => void;
}

type HelpStore = HelpState & HelpActions;

let seq = 0;
/** Monotonic rather than random: two /help entries anchored to the same event
 *  need stable, distinct React keys, and Math.random would re-key on re-render
 *  in dev double-invoke. */
const nextId = () => {
  seq += 1;
  return `help-${seq}`;
};

export const useHelpStore = create<HelpStore>()(
  devtools(
    (set) => ({
      entriesByConversation: {},

      show: (conversationId, anchorEventId) =>
        set(
          (s) => ({
            entriesByConversation: {
              ...s.entriesByConversation,
              [conversationId]: [
                ...(s.entriesByConversation[conversationId] ?? []),
                { id: nextId(), anchorEventId },
              ],
            },
          }),
          false,
          "help/show",
        ),

      clear: (conversationId) =>
        set(
          (s) => {
            const next = { ...s.entriesByConversation };
            delete next[conversationId];
            return { entriesByConversation: next };
          },
          false,
          "help/clear",
        ),
    }),
    { name: "help-store" },
  ),
);
