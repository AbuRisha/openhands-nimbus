import { useCallback } from "react";
import { useNimbusSkillsStore } from "#/stores/nimbus-skills-store";
import { resolveNimbusSkill } from "#/constants/nimbus-skills";

/**
 * Parses composer input for a leading `/skill <name>` invocation and, when
 * present, activates the resolved skill for the given conversation.
 *
 * Grammar:
 *   /skill                     → open the Skills Panel (if resolvable)
 *   /skill <name>              → activate <name>, strip the command from the
 *                                message being sent
 *   /skill <name> rest of msg  → activate + let "rest of msg" continue as the
 *                                user's real prompt (the returned `rest` is
 *                                what the composer should submit instead of
 *                                the raw text)
 *
 * `<name>` matches ids, display names, and single-word aliases from
 * `nimbus-skills.ts` (case-insensitive).
 *
 * Wire this into the composer's submit path BEFORE the fetch/enqueue:
 *
 *   const parse = useNimbusSkillSlashCommand(conversationId);
 *   const { consumed, cleanText, skill } = parse(rawText);
 *   if (consumed) {
 *     // optional: toast "Activated <skill.name>"
 *     if (!cleanText) return; // slash-only command, nothing else to send
 *   }
 *   send(cleanText);
 */
export function useNimbusSkillSlashCommand(conversationId: string | null) {
  const activateSkill = useNimbusSkillsStore((s) => s.activateSkill);
  const openPanel = useNimbusSkillsStore((s) => s.openPanel);

  return useCallback(
    (rawInput: string) => {
      const text = rawInput ?? "";
      const trimmed = text.trimStart();
      if (!trimmed.toLowerCase().startsWith("/skill")) {
        return { consumed: false, cleanText: text, skill: null };
      }

      // strip leading `/skill` token
      const afterCmd = trimmed.slice("/skill".length);

      // /skill by itself → open the panel
      if (afterCmd.length === 0 || /^\s*$/.test(afterCmd)) {
        openPanel();
        return { consumed: true, cleanText: "", skill: null };
      }

      // must be `/skill<space>...`
      if (!/^\s/.test(afterCmd)) {
        return { consumed: false, cleanText: text, skill: null };
      }

      // split off the first arg word, keep the rest as the user's real prompt
      const rest = afterCmd.trimStart();
      const match = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
      if (!match) {
        openPanel();
        return { consumed: true, cleanText: "", skill: null };
      }
      const [, nameToken, tail = ""] = match;

      const skill = resolveNimbusSkill(nameToken);
      if (!skill) {
        // Unknown name — open the panel so the user can pick from the grid.
        openPanel();
        return { consumed: true, cleanText: tail, skill: null };
      }

      if (conversationId) {
        activateSkill(conversationId, skill.id);
      } else {
        // No conversation yet — still open the panel; activation will land on
        // the next created conversation.
        openPanel();
      }

      return { consumed: true, cleanText: tail, skill };
    },
    [conversationId, activateSkill, openPanel],
  );
}
