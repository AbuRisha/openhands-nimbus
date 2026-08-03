import React, { useEffect, useRef, useState } from "react";
import { cn } from "#/utils/utils";

/**
 * Nimbus composer model/effort chip.
 *
 * Small pill anchored bottom-right of the composer footer (Claude-Code-style):
 *   [avatar] [Model name]  · [effort dot]  ↻
 *
 * Clicking opens a fade+scale popover with:
 *   - Nimbus-native model list (per-provider avatar from nimbusapi.net/brand)
 *   - 3-way effort slider (Faster / Smart / Ultracode)
 *
 * Model + effort selection is persisted to localStorage and dispatched on
 * `window` as `nimbus:composer-model`. Both take effect on the NEXT message
 * (never mid-stream); the send hook is the intended listener.
 */

type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "deepseek"
  | "kimi"
  | "xai";

type Effort = "faster" | "smart" | "ultracode";

interface ModelOption {
  id: string;
  displayName: string;
  provider: Provider;
  defaultEffort: Effort;
}

// Nimbus-native catalog (SS-backed via api.nimbusapi.net/v1).
// No upstream vendor names in customer chrome — only friendly display names.
const NIMBUS_MODELS: ModelOption[] = [
  { id: "claude-sonnet-5",   displayName: "Sonnet 5",         provider: "anthropic", defaultEffort: "smart" },
  { id: "claude-opus-4-8",   displayName: "Opus 4.8",         provider: "anthropic", defaultEffort: "ultracode" },
  { id: "gpt-5-1",           displayName: "GPT-5.1",          provider: "openai",    defaultEffort: "smart" },
  { id: "gpt-5-1-codex",     displayName: "GPT-5.1 Codex",    provider: "openai",    defaultEffort: "ultracode" },
  { id: "gemini-3-1-pro",    displayName: "Gemini 3.1 Pro",   provider: "google",    defaultEffort: "smart" },
  { id: "gemini-3-1-flash",  displayName: "Gemini 3.1 Flash", provider: "google",    defaultEffort: "faster" },
  { id: "kimi-k3",           displayName: "Kimi K3",          provider: "kimi",      defaultEffort: "faster" },
  { id: "deepseek-v4-pro",   displayName: "DeepSeek V4 Pro",  provider: "deepseek",  defaultEffort: "smart" },
  { id: "grok-4-1-fast",     displayName: "Grok 4.1 Fast",    provider: "xai",       defaultEffort: "faster" },
];

// Nimbus palette: cyan #22D3EE (fast), violet #8B5CF6 (smart), gradient (ultracode).
const EFFORT_SOLID: Record<Exclude<Effort, "ultracode">, string> = {
  faster: "#22D3EE",
  smart: "#8B5CF6",
};

const EFFORT_LABEL: Record<Effort, string> = {
  faster: "Faster",
  smart: "Smart",
  ultracode: "Ultracode",
};

const effortDotStyle = (e: Effort): React.CSSProperties =>
  e === "ultracode"
    ? { background: "linear-gradient(135deg,#8B5CF6 0%,#22D3EE 100%)" }
    : { background: EFFORT_SOLID[e] };

const avatarUrl = (p: Provider) =>
  `https://nimbusapi.net/brand/model-avatar-${p}.png`;

const STORAGE_MODEL = "nimbus.composer.model";
const STORAGE_EFFORT = "nimbus.composer.effort";

function readInitialModel(): string {
  if (typeof window === "undefined") return NIMBUS_MODELS[0].id;
  const stored = window.localStorage.getItem(STORAGE_MODEL);
  if (stored && NIMBUS_MODELS.some((m) => m.id === stored)) return stored;
  return NIMBUS_MODELS[0].id;
}

function readInitialEffort(): Effort {
  if (typeof window === "undefined") return "smart";
  const stored = window.localStorage.getItem(STORAGE_EFFORT) as Effort | null;
  if (stored === "faster" || stored === "smart" || stored === "ultracode") {
    return stored;
  }
  return "smart";
}

interface ComposerModelChipProps {
  className?: string;
}

export function ComposerModelChip({ className = "" }: ComposerModelChipProps) {
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState<string>(readInitialModel);
  const [effort, setEffort] = useState<Effort>(readInitialEffort);

  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const current =
    NIMBUS_MODELS.find((m) => m.id === modelId) ?? NIMBUS_MODELS[0];

  // Persist + broadcast. The send hook can listen for `nimbus:composer-model`
  // and read localStorage on the next submit — never mid-stream.
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_MODEL, current.id);
    window.localStorage.setItem(STORAGE_EFFORT, effort);
    window.dispatchEvent(
      new CustomEvent("nimbus:composer-model", {
        detail: { modelId: current.id, effort },
      }),
    );
  }, [current.id, effort]);

  // Close on Escape / outside click. Return focus to the trigger.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={cn("relative shrink-0", className)}
      style={{ fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}
    >
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        data-testid="composer-model-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${current.displayName}, effort: ${EFFORT_LABEL[effort]}. Click to change.`}
        title={`${current.displayName} · ${EFFORT_LABEL[effort]}`}
        className={cn(
          "group flex items-center gap-1.5 h-6 pl-1 pr-1.5 rounded-full",
          "border border-[#2A2D39] bg-[#12141C]/80 backdrop-blur-sm",
          "hover:border-[#8B5CF6]/60 hover:bg-[#171A24]",
          "transition-colors cursor-pointer select-none",
          "shadow-[0_1px_0_rgba(0,0,0,0.4),0_0_0_1px_rgba(139,92,246,0.05)]",
          open && "border-[#8B5CF6]/70 bg-[#171A24]",
        )}
      >
        <img
          src={avatarUrl(current.provider)}
          alt=""
          width={14}
          height={14}
          className="rounded-full shrink-0"
          onError={(ev) => {
            (ev.currentTarget as HTMLImageElement).style.visibility = "hidden";
          }}
        />
        <span className="text-[11px] font-medium leading-none text-white/90 truncate max-w-[110px]">
          {current.displayName}
        </span>
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={effortDotStyle(effort)}
          aria-hidden="true"
        />
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-white/45 group-hover:text-white/85 transition-colors shrink-0"
          aria-hidden="true"
        >
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15A9 9 0 1 1 5.64 5.64L23 10" />
        </svg>
      </button>

      {open && (
        <ComposerModelPopover
          popRef={popRef}
          currentId={current.id}
          effort={effort}
          onSelect={(id) => {
            setModelId(id);
            // do NOT auto-close — user may adjust effort next
          }}
          onEffort={setEffort}
          onClose={() => {
            setOpen(false);
            btnRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

interface ComposerModelPopoverProps {
  popRef: React.RefObject<HTMLDivElement | null>;
  currentId: string;
  effort: Effort;
  onSelect: (id: string) => void;
  onEffort: (e: Effort) => void;
  onClose: () => void;
}

function ComposerModelPopover({
  popRef,
  currentId,
  effort,
  onSelect,
  onEffort,
  onClose,
}: ComposerModelPopoverProps) {
  return (
    <div
      ref={popRef}
      role="dialog"
      aria-label="Choose model and effort"
      data-testid="composer-model-popover"
      className={cn(
        "absolute bottom-full right-0 mb-2 w-[280px] z-40",
        "rounded-xl border border-[#2A2D39] bg-[#0B0D14]/95",
        "shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7),0_0_0_1px_rgba(139,92,246,0.08)]",
        "backdrop-blur-md overflow-hidden",
        "origin-bottom-right animate-[nimbusComposerChipPopIn_200ms_ease-out]",
      )}
      style={{ fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}
    >
      <style>{`
        @keyframes nimbusComposerChipPopIn {
          0%   { opacity: 0; transform: scale(0.9) translateY(4px); }
          100% { opacity: 1; transform: scale(1)   translateY(0);   }
        }
      `}</style>

      <div className="px-3 pt-2.5 pb-1.5 flex items-center justify-between">
        <span
          className="text-[10px] uppercase tracking-[0.14em] text-white/45 font-semibold"
          style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}
        >
          Model
        </span>
        <span className="text-[10px] text-white/30">Applies next message</span>
      </div>

      <ul className="max-h-[240px] overflow-y-auto py-1">
        {NIMBUS_MODELS.map((m) => {
          const isActive = m.id === currentId;
          return (
            <li key={m.id}>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelect(m.id);
                }}
                data-testid={`composer-model-option-${m.id}`}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
                  isActive
                    ? "bg-[#8B5CF6]/12 text-white"
                    : "text-white/85 hover:bg-white/[0.04]",
                )}
              >
                <img
                  src={avatarUrl(m.provider)}
                  alt=""
                  width={18}
                  height={18}
                  className="rounded-full shrink-0"
                  onError={(ev) => {
                    (ev.currentTarget as HTMLImageElement).style.visibility =
                      "hidden";
                  }}
                />
                <span className="text-[13px] font-medium leading-none flex-1 truncate">
                  {m.displayName}
                </span>
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={effortDotStyle(m.defaultEffort)}
                  aria-hidden="true"
                />
                {isActive && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#22D3EE"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="shrink-0"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-white/5 px-3 py-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span
            className="text-[10px] uppercase tracking-[0.14em] text-white/45 font-semibold"
            style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}
          >
            Effort
          </span>
          <span className="text-[11px] text-white/75">
            {EFFORT_LABEL[effort]}
          </span>
        </div>
        <div
          role="radiogroup"
          aria-label="Effort"
          className="grid grid-cols-3 gap-1 rounded-lg bg-white/[0.03] p-0.5"
        >
          {(["faster", "smart", "ultracode"] as Effort[]).map((e) => {
            const active = e === effort;
            return (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={(ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  onEffort(e);
                }}
                data-testid={`composer-effort-${e}`}
                className={cn(
                  "flex items-center justify-center gap-1 py-1.5 rounded-md text-[11px] font-medium",
                  "transition-colors cursor-pointer",
                  active
                    ? "bg-[#171A24] text-white shadow-[inset_0_0_0_1px_rgba(139,92,246,0.35)]"
                    : "text-white/60 hover:text-white/85 hover:bg-white/[0.03]",
                )}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={effortDotStyle(e)}
                  aria-hidden="true"
                />
                {EFFORT_LABEL[e]}
              </button>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
        data-testid="composer-model-popover-done"
        className="w-full py-2 text-[11px] text-white/45 hover:text-white/80 hover:bg-white/[0.03] transition-colors border-t border-white/5 cursor-pointer"
      >
        Done
      </button>
    </div>
  );
}
