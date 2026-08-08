import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useConversationId } from "#/hooks/use-conversation-id";
import {
  PendingMessage,
  useCancelPendingMessage,
  usePendingMessages,
} from "#/hooks/query/use-pending-messages";
import { cn } from "#/utils/utils";

/**
 * What you typed while the agent was busy, shown as chips above the composer.
 *
 * Queuing used to be invisible: the composer cleared, nothing rendered, and the
 * message reappeared minutes later when it was delivered. The only reading
 * available to a customer is that it was lost, and the natural response is to
 * type it again — which is how one question becomes two.
 *
 * These come from the queue endpoint rather than the optimistic-message store.
 * That store holds ONE string with a different lifecycle, and stretching it to
 * cover a queue is what produced the single-message limitation this replaces.
 */

/** Enough to recognise which message a chip is, without becoming a paragraph. */
const MAX_PREVIEW = 80;

function previewOf(message: PendingMessage): string {
  const text = message.content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= MAX_PREVIEW) return text;
  return `${text.slice(0, MAX_PREVIEW - 1)}…`;
}

export function PendingMessages() {
  const { t } = useTranslation();
  const { conversationId } = useConversationId();
  const { data } = usePendingMessages(conversationId);
  const cancel = useCancelPendingMessage(conversationId);

  // Cancelled ids are hidden immediately rather than waiting for the next
  // poll. A chip that lingers for three seconds after you click cancel reads
  // as a button that did not work.
  const [dismissed, setDismissed] = React.useState<string[]>([]);

  const messages = (data ?? []).filter((m) => !dismissed.includes(m.id));
  if (messages.length === 0) return null;

  return (
    <div
      data-testid="pending-messages"
      className="flex flex-col gap-1 px-1 pb-1"
    >
      {messages.map((message) => (
        <div
          key={message.id}
          data-testid="pending-message"
          className={cn(
            "flex items-center gap-2 rounded-md border border-[#4B505F]/60",
            "bg-white/[0.03] px-2 py-1 text-[12px] text-neutral-300",
          )}
        >
          <span
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#8B5CF6]"
          />
          <span className="min-w-0 flex-1 truncate" title={previewOf(message)}>
            {previewOf(message)}
          </span>
          <span className="shrink-0 text-[10px] text-neutral-500">
            {t(I18nKey.QUEUE$WAITING)}
          </span>
          <button
            type="button"
            data-testid="pending-message-cancel"
            aria-label={t(I18nKey.QUEUE$CANCEL)}
            onClick={() => {
              // Hidden first, then requested. The backend answers 204 whether
              // or not the message was still there, so there is no failure
              // case to roll this back for.
              setDismissed((ids) => [...ids, message.id]);
              cancel.mutate(message.id);
            }}
            className="shrink-0 rounded px-1 text-neutral-400 hover:text-white"
          >
            {t(I18nKey.QUEUE$CANCEL)}
          </button>
        </div>
      ))}
    </div>
  );
}
