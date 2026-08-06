import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import {
  FailoverChoice,
  FallbackCandidate,
  REFUSAL_PROMPT_TIMEOUT_MS,
} from "#/utils/refusal-failover";
import { cn } from "#/utils/utils";

/**
 * Offered when a model declines, inline in the transcript.
 *
 * Inline rather than a modal on purpose. A refusal is a thing that happened in
 * the conversation, and the record of it belongs where the conversation is —
 * a modal would cover the very message being reacted to, and dismissing one is
 * indistinguishable from choosing to cancel.
 *
 * THE TWO RETRIES ARE NOT THE SAME BUTTON
 * ---------------------------------------
 * "This turn only" and "for the rest of this chat" are separated because
 * collapsing them is how a session silently ends up on a model nobody chose.
 * The scoped one is listed first and is the ordinary answer; making the sticky
 * one an explicit second choice means changing your model for good is always
 * something you decided, never something that happened to you.
 *
 * The retry labels name the model AND say what a retry costs, because it costs
 * a paid turn and the person deciding is the person paying.
 */

function Action({
  testId,
  label,
  onClick,
  primary,
}: {
  testId: string;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "rounded-md px-2.5 py-1 text-[12px] transition-colors cursor-pointer",
        primary
          ? "bg-[#8B5CF6]/20 text-white hover:bg-[#8B5CF6]/30"
          : "text-neutral-300 hover:text-white hover:bg-white/[0.06]",
      )}
    >
      {label}
    </button>
  );
}

interface RefusalPromptProps {
  /** The model that declined, as the picker names it. */
  refusedModel: string;
  /** What to offer instead. Null when the catalog has nothing different. */
  fallback: FallbackCandidate | null;
  onChoose: (choice: FailoverChoice) => void;
}

export function RefusalPrompt({
  refusedModel,
  fallback,
  onChoose,
}: RefusalPromptProps) {
  const { t } = useTranslation();

  // Hold the callback in a ref so the timeout is armed ONCE. With onChoose in
  // the dependency array, a parent that re-renders (which it does constantly
  // during streaming) would restart the countdown on every render and the
  // prompt would never self-answer.
  const onChooseRef = React.useRef(onChoose);
  React.useEffect(() => {
    onChooseRef.current = onChoose;
  }, [onChoose]);

  React.useEffect(() => {
    // Cancel is the safe self-answer: the only option that spends nothing and
    // changes nothing. An unattended session would otherwise hold the turn
    // open indefinitely and look hung.
    const timer = setTimeout(
      () => onChooseRef.current({ kind: "cancel" }),
      REFUSAL_PROMPT_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      data-testid="refusal-prompt"
      role="group"
      aria-label={t(I18nKey.REFUSAL$TITLE, { model: refusedModel })}
      className={cn(
        "my-2 w-full rounded-lg border border-[#2A2130] bg-[#1C1420]/60 p-3",
      )}
    >
      <div className="text-sm font-medium text-white">
        {t(I18nKey.REFUSAL$TITLE, { model: refusedModel })}
      </div>
      <div className="mt-1 text-[12px] text-[#C8A264]">
        {fallback ? t(I18nKey.REFUSAL$BODY) : t(I18nKey.REFUSAL$NO_FALLBACK)}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {fallback && (
          <>
            <Action
              testId="refusal-retry-once"
              primary
              label={t(I18nKey.REFUSAL$RETRY_ONCE, { model: fallback.name })}
              onClick={() =>
                onChoose({
                  kind: "retry",
                  model: fallback.model,
                  direction: "revert",
                })
              }
            />
            <Action
              testId="refusal-retry-sticky"
              label={t(I18nKey.REFUSAL$RETRY_STICKY, { model: fallback.name })}
              onClick={() =>
                onChoose({
                  kind: "retry",
                  model: fallback.model,
                  direction: "sticky",
                })
              }
            />
          </>
        )}
        <Action
          testId="refusal-edit"
          label={t(I18nKey.REFUSAL$EDIT)}
          onClick={() => onChoose({ kind: "edit" })}
        />
        <Action
          testId="refusal-cancel"
          label={t(I18nKey.REFUSAL$CANCEL)}
          onClick={() => onChoose({ kind: "cancel" })}
        />
      </div>
    </div>
  );
}
