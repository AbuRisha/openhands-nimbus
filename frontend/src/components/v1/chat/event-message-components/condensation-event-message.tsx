import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import {
  CondensationEvent,
  CondensationSummaryEvent,
} from "#/types/v1/core/events/condensation-event";

interface CondensationEventMessageProps {
  event: CondensationEvent | CondensationSummaryEvent;
}

/**
 * "Earlier messages were condensed."
 *
 * Deliberately a quiet divider rather than a message bubble. It is not
 * something the agent said, and styling it like speech would put words in its
 * mouth. But it is also not nothing: after a condensation the model can no
 * longer see turns the USER can still scroll to, and without this the only
 * symptom is an agent that seems to forget things for no reason.
 *
 * The summary is collapsed by default. It is the model's own compression of
 * what was dropped — useful when you are asking "why did it lose that?", noise
 * the rest of the time.
 */
export function CondensationEventMessage({
  event,
}: CondensationEventMessageProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);

  const summary = "summary" in event ? event.summary : undefined;
  // Only a full CondensationEvent carries the dropped ids; a summary event does
  // not, so the count is genuinely unknown there rather than zero.
  const forgottenCount =
    "forgotten_event_ids" in event && Array.isArray(event.forgotten_event_ids)
      ? event.forgotten_event_ids.length
      : null;

  const label =
    forgottenCount === null
      ? t(I18nKey.CONDENSATION$HISTORY_CONDENSED)
      : t(I18nKey.CONDENSATION$HISTORY_CONDENSED_COUNT, {
          count: forgottenCount,
        });

  return (
    <div
      data-testid="condensation-event"
      className="flex flex-col gap-1 py-2 text-xs text-[#8A8F9C]"
    >
      <div className="flex items-center gap-2">
        <span className="h-px grow bg-[#3A3E48]" aria-hidden="true" />
        <span data-testid="condensation-label">{label}</span>
        {summary ? (
          <button
            type="button"
            data-testid="condensation-toggle"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            className="rounded px-1.5 py-0.5 text-[#A9B0C0] underline decoration-dotted hover:text-white"
          >
            {expanded
              ? t(I18nKey.CONDENSATION$HIDE_SUMMARY)
              : t(I18nKey.CONDENSATION$SHOW_SUMMARY)}
          </button>
        ) : null}
        <span className="h-px grow bg-[#3A3E48]" aria-hidden="true" />
      </div>

      {expanded && summary ? (
        <p
          data-testid="condensation-summary"
          className="whitespace-pre-wrap rounded border border-[#3A3E48] bg-[#20222A] p-2 text-[#C7CCD8]"
        >
          {summary}
        </p>
      ) : null}
    </div>
  );
}
