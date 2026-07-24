import React, { useState } from "react";
import { EFFORT_STOPS, useEffortStore } from "#/stores/effort-store";
import { isReasoningEffortSupported } from "#/utils/reasoning-effort-support";
import { useActiveConversation } from "#/hooks/query/use-active-conversation";
import { useClickOutsideElement } from "#/hooks/use-click-outside-element";
import { cn } from "#/utils/utils";
import { EffortSlider } from "./effort-slider";

/**
 * Composer-adjacent trigger + popover that houses the EffortSlider.
 *
 * The trigger is a compact pill showing the current effort chip;
 * clicking it opens a Nimbus-ink popover with the slider inside.
 * When the currently-active model doesn't support `reasoning_effort`
 * (per the substring whitelist in reasoning-effort-support.ts) a small
 * amber hint renders beneath the slider — the value is still saved
 * so it applies on switch to a reasoning-capable model.
 */
export function EffortSliderButton() {
  const [open, setOpen] = useState(false);
  const effort = useEffortStore((s) => s.effort);
  const { data: conversation } = useActiveConversation();

  const activeStop =
    EFFORT_STOPS.find((s) => s.value === effort) ?? EFFORT_STOPS[1];
  const currentModel = conversation?.llm_model ?? null;
  const supported = isReasoningEffortSupported(currentModel);

  const popoverRef = useClickOutsideElement<HTMLDivElement>(() =>
    setOpen(false),
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="effort-slider-button"
        title={`Effort: ${activeStop.chipLabel}`}
        className={cn(
          "flex items-center gap-1.5 border border-[#4B505F] rounded-[100px]",
          "px-2.5 py-1 transition-opacity cursor-pointer hover:opacity-80",
        )}
      >
        <span
          aria-hidden
          className="inline-block w-2 h-2 rounded-full bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE] shadow-[0_0_6px_rgba(139,92,246,0.6)]"
        />
        <span
          className="text-white text-2.75 not-italic font-normal leading-5"
          style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}
        >
          {activeStop.chipLabel}
        </span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          data-testid="effort-slider-popover"
          className={cn(
            "absolute z-40 bottom-full mb-2 left-0",
            "min-w-[320px] max-w-[360px] p-4",
            "rounded-xl border border-[#1E2233] bg-[#05070E]/95 backdrop-blur",
            "shadow-[0_20px_60px_rgba(0,0,0,0.55)]",
          )}
        >
          <div className="mb-3">
            <div className="flex items-baseline justify-between">
              <div
                className="text-white text-sm font-semibold tracking-tight"
                style={{
                  fontFamily: "'Space Grotesk', Inter, sans-serif",
                }}
              >
                Effort · Ultracode
              </div>
              <div
                className="text-[10px] text-[#8D93A6] uppercase tracking-widest"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                Faster ↔ Smarter
              </div>
            </div>
            <div className="mt-1 text-[11px] text-[#8D93A6]">
              {activeStop.description}
            </div>
          </div>

          <EffortSlider />

          {!supported && currentModel && (
            <div
              className="mt-3 flex items-start gap-2 rounded-lg border border-[#2A2130] bg-[#1C1420]/60 px-2.5 py-2"
              data-testid="effort-not-supported-hint"
            >
              <div className="mt-[3px] w-1.5 h-1.5 rounded-full bg-[#F59E0B] shrink-0" />
              <div className="text-[11px] leading-snug text-[#C8A264]">
                Not supported for{" "}
                <span className="text-white font-medium">{currentModel}</span>.
                Value is saved and will apply on switch to a reasoning model.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
