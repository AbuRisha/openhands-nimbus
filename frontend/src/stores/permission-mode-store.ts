import { create } from "zustand";
import type { ConfirmationPolicyKind } from "#/hooks/mutation/use-set-confirmation-policy";

interface PermissionModeState {
  /**
   * The mode the user has explicitly chosen, per conversation.
   *
   * KEYED BY CONVERSATION AND HELD OUTSIDE THE COMPONENT ON PURPOSE. Setting a
   * policy applies it to the RUNNING conversation via the agent server; it does
   * not write back to settings. So component-local state would show the
   * settings-derived default again the moment the composer remounted — telling
   * the user the agent asks before acting when they had just turned that off.
   *
   * That is the same failure as `BrowserPanel` resetting its store on mount and
   * erasing the screenshot it existed to display. A control that silently
   * reverts its own display is worse than one that is missing.
   *
   * `undefined` means "not chosen this session" — the button then shows the
   * value derived from settings, which is what the conversation actually
   * started with.
   */
  chosenByConversation: Record<string, ConfirmationPolicyKind>;
}

interface PermissionModeActions {
  setChosen: (conversationId: string, kind: ConfirmationPolicyKind) => void;
  clear: (conversationId: string) => void;
}

export const usePermissionModeStore = create<
  PermissionModeState & PermissionModeActions
>((set) => ({
  chosenByConversation: {},

  setChosen: (conversationId, kind) =>
    set((s) => ({
      chosenByConversation: {
        ...s.chosenByConversation,
        [conversationId]: kind,
      },
    })),

  clear: (conversationId) =>
    set((s) => {
      const next = { ...s.chosenByConversation };
      delete next[conversationId];
      return { chosenByConversation: next };
    }),
}));
