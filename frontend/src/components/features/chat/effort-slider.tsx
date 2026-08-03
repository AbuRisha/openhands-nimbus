import React from "react";
import {
  EFFORT_STOPS,
  useEffortStore,
} from "#/stores/effort-store";
import { cn } from "#/utils/utils";

interface EffortSliderProps {
  className?: string;
  disabled?: boolean;
}

const GLYPH_URL = "https://nimbusapi.net/brand/effort-slider-glyph.png";

/**
 * Horizontal 4-stop reasoning-effort slider.
 *
 * Layout:
 *   [ Faster ] [ Balanced ] [ Smart ] [ Ultracode ]    ← chip row
 *   ●━━━━━━━━━━●━━━━━━━━━━━━●━━━━━━━━━━●              ← gradient track + ticks
 *   FASTER                                    SMARTER   ← caption
 *
 * The track fills violet→cyan from left up to the active tick.
 * A subtle Nimbus glyph tiles behind the track as an underlay.
 * A hidden native <input type="range"> provides keyboard + a11y
 * without imposing its default chrome.
 */
export function EffortSlider({ className, disabled }: EffortSliderProps) {
  const effort = useEffortStore((s) => s.effort);
  const setEffort = useEffortStore((s) => s.setEffort);

  const activeIndex = Math.max(
    0,
    EFFORT_STOPS.findIndex((s) => s.value === effort),
  );
  const fillPercent = (activeIndex / (EFFORT_STOPS.length - 1)) * 100;

  return (
    <div
      className={cn("w-full select-none", className)}
      data-testid="effort-slider"
    >
      {/* Chip row */}
      <div className="relative flex justify-between mb-2 px-0.5">
        {EFFORT_STOPS.map((stop, i) => {
          const isActive = i === activeIndex;
          return (
            <button
              key={stop.value}
              type="button"
              disabled={disabled}
              onClick={() => setEffort(stop.value)}
              data-testid={`effort-chip-${stop.value}`}
              className={cn(
                "text-[10px] leading-none font-medium tracking-wide",
                "px-2 py-1 rounded-full border transition-all",
                isActive
                  ? "bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE] text-white border-transparent shadow-[0_0_10px_rgba(139,92,246,0.45)]"
                  : "bg-[#0E1017] text-[#8D93A6] border-[#1E2233] hover:text-white hover:border-[#3A3F55]",
                disabled && "opacity-40 cursor-not-allowed",
              )}
              style={{
                fontFamily: "'Space Grotesk', Inter, sans-serif",
              }}
            >
              {stop.chipLabel}
            </button>
          );
        })}
      </div>

      {/* Slider track */}
      <div className="relative h-6 w-full flex items-center">
        {/* Underlay glyph — subtle Nimbus mark repeated behind the track */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-6 rounded-full opacity-[0.14] pointer-events-none"
          style={{
            backgroundImage: `url(${GLYPH_URL})`,
            backgroundRepeat: "repeat-x",
            backgroundSize: "auto 100%",
            mixBlendMode: "screen",
          }}
        />

        {/* Base track */}
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-[#1A1D2A]" />

        {/* Filled track — violet→cyan gradient up to active stop */}
        <div
          className="absolute left-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full transition-all duration-300"
          style={{
            width: `${fillPercent}%`,
            background: "linear-gradient(90deg, #8B5CF6 0%, #22D3EE 100%)",
            boxShadow: "0 0 12px rgba(34, 211, 238, 0.35)",
          }}
        />

        {/* Tick markers — clickable, active tick is the visible thumb */}
        {EFFORT_STOPS.map((stop, i) => {
          const leftPct = (i / (EFFORT_STOPS.length - 1)) * 100;
          const isActive = i === activeIndex;
          return (
            <button
              key={stop.value}
              type="button"
              aria-label={`Effort: ${stop.chipLabel}`}
              disabled={disabled}
              onClick={() => setEffort(stop.value)}
              data-testid={`effort-tick-${stop.value}`}
              className={cn(
                "absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-10 rounded-full transition-all",
                isActive
                  ? "w-4 h-4 bg-white border-2 border-[#22D3EE] shadow-[0_0_12px_rgba(34,211,238,0.6)]"
                  : "w-2.5 h-2.5 bg-[#3A3F55] hover:bg-[#5C6478]",
                disabled && "opacity-40 cursor-not-allowed",
              )}
              style={{ left: `${leftPct}%` }}
            />
          );
        })}

        {/* Native range for keyboard control (invisible, sits over the track) */}
        <input
          type="range"
          min={0}
          max={EFFORT_STOPS.length - 1}
          step={1}
          value={activeIndex}
          onChange={(e) =>
            setEffort(EFFORT_STOPS[Number(e.target.value)].value)
          }
          disabled={disabled}
          aria-label="Reasoning effort"
          data-testid="effort-native-range"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
        />
      </div>

      {/* Caption row */}
      <div
        className="mt-2 flex justify-between text-[10px] uppercase tracking-widest text-[#5C6478]"
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        <span>Faster</span>
        <span>Smarter</span>
      </div>
    </div>
  );
}
