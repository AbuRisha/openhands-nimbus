import { useTranslation } from "react-i18next";
import useMetricsStore from "#/stores/metrics-store";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

/**
 * How full the model's context is, in the composer where it is actually useful.
 *
 * The same numbers already existed — ContextWindowSection renders them — but
 * only inside the metrics modal, which nobody opens mid-task. By the time a
 * conversation is close to the window the symptom is the agent quietly losing
 * earlier turns, and the one place that would have warned you was two clicks
 * away. Claude Code keeps this on the composer; so does this.
 *
 * Renders nothing until there is something real to report: no usage yet, or a
 * model that publishes no context window (several in the catalog do not), means
 * no ring rather than a confident-looking 0%.
 */
export function ContextUsageRing() {
  const { t } = useTranslation();
  const usage = useMetricsStore((state) => state.usage);

  const contextWindow = usage?.context_window ?? 0;
  const used = usage?.per_turn_token ?? 0;
  if (!contextWindow || !used) return null;

  const pct = Math.min(100, (used / contextWindow) * 100);

  // Amber past 75%, red past 90%. The thresholds exist because the failure is
  // silent: the agent starts dropping context rather than erroring, so the only
  // warning is this.
  const tone =
    pct >= 90
      ? "text-red-400"
      : pct >= 75
        ? "text-amber-400"
        : "text-neutral-400";

  const RADIUS = 7;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  const dash = (pct / 100) * CIRCUMFERENCE;

  return (
    <div
      data-testid="context-usage-ring"
      title={`${t(I18nKey.CONVERSATION$CONTEXT_WINDOW)}: ${used.toLocaleString()} / ${contextWindow.toLocaleString()} (${pct.toFixed(1)}% ${t(I18nKey.CONVERSATION$USED)})`}
      className={cn("flex items-center gap-1 shrink-0", tone)}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle
          cx="9"
          cy="9"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="2"
        />
        <circle
          cx="9"
          cy="9"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${CIRCUMFERENCE}`}
          // Start the arc at 12 o'clock rather than 3, which is what makes it
          // read as a gauge instead of a spinner.
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="text-[11px] leading-none tabular-nums">
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}
