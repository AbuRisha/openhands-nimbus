import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import {
  NIMBUS_SKILLS,
  NimbusSkill,
  nimbusSkillById,
  resolveNimbusSkill,
} from "#/constants/nimbus-skills";

/**
 * Per-conversation Nimbus Skill selection.
 *
 * A conversation's active skill controls two side-effects:
 *   1. The chat completion request auto-selects `skill.recommendedModel`
 *      unless the user has explicitly overridden the model afterwards.
 *   2. `skill.systemPrompt` is prepended (as a synthetic system message)
 *      to the request payload for the next user turn.
 *
 * The selection persists to localStorage keyed by conversationId so the skill
 * survives a page reload, in line with the rest of the OpenHands conversation
 * state model (see conversation-store.ts).
 */

interface NimbusSkillsState {
  /** Map of conversationId → activated skill id. */
  activeSkillByConversation: Record<string, string>;
  /** Sidebar panel open/closed. Not persisted — always defaults to closed. */
  isPanelOpen: boolean;
  /**
   * Nonce that increments every time a skill is applied. Downstream systems
   * that need to react to activation (model swap, prompt injection) can
   * subscribe to this key without re-reading unchanged payloads.
   */
  activationNonce: number;
}

interface NimbusSkillsActions {
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  /**
   * Activate a skill for a given conversation. Returns the resolved skill or
   * null if the id/alias could not be resolved.
   */
  activateSkill: (
    conversationId: string,
    skillIdOrAlias: string,
  ) => NimbusSkill | null;
  /** Clear the active skill for a conversation (revert to plain chat). */
  clearSkill: (conversationId: string) => void;
  /** Read helper — returns the active skill for the given conversation. */
  getActiveSkill: (conversationId: string) => NimbusSkill | null;
}

type NimbusSkillsStore = NimbusSkillsState & NimbusSkillsActions;

export const useNimbusSkillsStore = create<NimbusSkillsStore>()(
  devtools(
    persist(
      (set, get) => ({
        activeSkillByConversation: {},
        isPanelOpen: false,
        activationNonce: 0,

        openPanel: () => set({ isPanelOpen: true }, false, "openPanel"),
        closePanel: () => set({ isPanelOpen: false }, false, "closePanel"),
        togglePanel: () =>
          set(
            (s) => ({ isPanelOpen: !s.isPanelOpen }),
            false,
            "togglePanel",
          ),

        activateSkill: (conversationId, skillIdOrAlias) => {
          const skill = resolveNimbusSkill(skillIdOrAlias);
          if (!skill || !conversationId) return null;
          set(
            (s) => ({
              activeSkillByConversation: {
                ...s.activeSkillByConversation,
                [conversationId]: skill.id,
              },
              activationNonce: s.activationNonce + 1,
              // panel auto-closes on activate for a snappy Claude-like feel
              isPanelOpen: false,
            }),
            false,
            `activateSkill:${skill.id}`,
          );
          return skill;
        },

        clearSkill: (conversationId) => {
          if (!conversationId) return;
          set(
            (s) => {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const { [conversationId]: _drop, ...rest } =
                s.activeSkillByConversation;
              return {
                activeSkillByConversation: rest,
                activationNonce: s.activationNonce + 1,
              };
            },
            false,
            "clearSkill",
          );
        },

        getActiveSkill: (conversationId) => {
          if (!conversationId) return null;
          const id = get().activeSkillByConversation[conversationId];
          return id ? nimbusSkillById(id) : null;
        },
      }),
      {
        name: "nimbus-skills-store",
        // Persist only the per-chat selection — panel open state and nonce
        // should always start fresh on reload.
        partialize: (state) => ({
          activeSkillByConversation: state.activeSkillByConversation,
        }),
      },
    ),
    { name: "NimbusSkillsStore" },
  ),
);

/** Convenience selector list, exported for consumers that want stable refs. */
export const nimbusSkills = NIMBUS_SKILLS;
