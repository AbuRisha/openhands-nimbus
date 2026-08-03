import { NimbusSkill } from "#/constants/nimbus-skills";
import { cn } from "#/utils/utils";

interface NimbusSkillCardProps {
  skill: NimbusSkill;
  isActive: boolean;
  onSelect: (skillId: string) => void;
}

// Accent → CSS colour token. Kept inline so no design-token file has to exist
// upfront; migrate to CSS variables once the design system lands.
const ACCENT_STYLES: Record<
  NimbusSkill["accent"],
  { ring: string; badge: string; glow: string }
> = {
  violet: {
    ring: "ring-[#8B5CF6]/60",
    badge: "bg-[#8B5CF6]/20 text-[#C4B5FD] border-[#8B5CF6]/40",
    glow: "shadow-[0_0_60px_-20px_rgba(139,92,246,0.55)]",
  },
  cyan: {
    ring: "ring-[#22D3EE]/60",
    badge: "bg-[#22D3EE]/15 text-[#67E8F9] border-[#22D3EE]/40",
    glow: "shadow-[0_0_60px_-20px_rgba(34,211,238,0.55)]",
  },
  amber: {
    ring: "ring-[#F59E0B]/60",
    badge: "bg-[#F59E0B]/15 text-[#FCD34D] border-[#F59E0B]/40",
    glow: "shadow-[0_0_60px_-20px_rgba(245,158,11,0.55)]",
  },
  rose: {
    ring: "ring-[#F43F5E]/60",
    badge: "bg-[#F43F5E]/15 text-[#FDA4AF] border-[#F43F5E]/40",
    glow: "shadow-[0_0_60px_-20px_rgba(244,63,94,0.55)]",
  },
  emerald: {
    ring: "ring-[#10B981]/60",
    badge: "bg-[#10B981]/15 text-[#6EE7B7] border-[#10B981]/40",
    glow: "shadow-[0_0_60px_-20px_rgba(16,185,129,0.55)]",
  },
};

export function NimbusSkillCard({
  skill,
  isActive,
  onSelect,
}: NimbusSkillCardProps) {
  const accent = ACCENT_STYLES[skill.accent];

  return (
    <button
      type="button"
      data-testid={`nimbus-skill-card-${skill.id}`}
      onClick={() => onSelect(skill.id)}
      className={cn(
        "group relative flex flex-col items-start gap-3 rounded-2xl border p-5 text-left transition-all duration-300",
        "border-white/10 bg-white/[0.03] backdrop-blur-md",
        "hover:-translate-y-[2px] hover:border-white/25 hover:bg-white/[0.06]",
        isActive
          ? cn("ring-2", accent.ring, accent.glow, "border-white/40")
          : "hover:" + accent.glow,
      )}
      aria-pressed={isActive}
    >
      <div className="flex w-full items-start justify-between gap-3">
        <div
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-xl border font-[Space_Grotesk,Inter,ui-sans-serif] text-lg font-semibold text-white",
            accent.badge,
          )}
          aria-hidden
        >
          {skill.glyph}
        </div>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
            accent.badge,
          )}
        >
          {skill.modelLabel}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="font-[Space_Grotesk,Inter,ui-sans-serif] text-base font-semibold text-white">
          {skill.name}
        </h3>
        <p className="text-[13px] leading-snug text-white/70">
          {skill.tagline}
        </p>
      </div>

      <div className="mt-auto flex w-full items-center justify-between pt-2 text-[11px] text-white/50">
        <span className="font-[JetBrains_Mono,ui-monospace] tracking-tight">
          /skill {skill.id}
        </span>
        {isActive ? (
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white">
            Active
          </span>
        ) : (
          <span className="opacity-0 transition-opacity group-hover:opacity-100">
            Activate →
          </span>
        )}
      </div>
    </button>
  );
}
