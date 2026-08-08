import { useCallback } from "react";
import { useHelpStore } from "#/stores/help-store";
import { useEventStore } from "#/stores/use-event-store";
import { getRenderedV1Events } from "#/components/v1/chat";
import { HELP_COMMAND } from "#/utils/constants";

/**
 * Intercept `/help` and render the command list inline, instead of sending it
 * to the model.
 *
 * Same shape as `use-model-interceptor` and `use-btw-interceptor`: each takes
 * the next handler and either consumes the message or passes it on. The chain
 * is assembled in `interactive-chat-box`, and ORDER MATTERS there — see the
 * comment at the call site.
 *
 * `/help` with any argument falls through to the model deliberately. "/help me
 * fix this test" is a sentence, not a command, and swallowing it to show a
 * command list would be the most annoying possible response.
 */
export const useHelpInterceptor = (
  conversationId: string | null | undefined,
  onSubmit: (message: string) => void,
) => {
  const showHelp = useHelpStore((s) => s.show);

  return useCallback(
    (message: string) => {
      const trimmed = message.trim();

      // Exact match only. See above: an argument means prose.
      if (!conversationId || trimmed !== HELP_COMMAND) {
        onSubmit(message);
        return;
      }

      // Anchor to the last event that actually RENDERS, not the last event.
      // `shouldRenderEvent` filters several kinds out (ConversationStateUpdate
      // among them), and anchoring to one of those would mount the entry
      // somewhere the user is not looking — usually above the thing they just
      // typed.
      const last = getRenderedV1Events(useEventStore.getState().uiEvents).at(
        -1,
      );
      showHelp(conversationId, last ? String(last.id) : null);
    },
    [conversationId, onSubmit, showHelp],
  );
};
