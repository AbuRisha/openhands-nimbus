import { useMemo } from "react";
import { useLocation } from "react-router";
import { X } from "lucide-react";
import {
  NIMBUS_SKILLS,
  NIMBUS_SKILLS_PANEL_HERO_URL,
} from "#/constants/nimbus-skills";
import { useNimbusSkillsStore } from "#/stores/nimbus-skills-store";
import { NimbusSkillCard } from "./nimbus-skill-card";

interface NimbusSkillsPanelProps {
  onClose: () => void;
}

/**
 * The Skills Panel — a Claude-style grid of 9 curated presets. On card click
 * the skill is activated for the current conversation (auto-selects the
 * recommended model and stages the system prompt for the next turn).
 *
 * Activation is per-conversation: switching chats does NOT carry the skill
 * over; once selected for a chat it persists across reloads (localStorage).
 */
export function NimbusSkillsPanel({ onClose }: NimbusSkillsPanelProps) {
  const { pathname } = useLocation();
  const conversationId = useMemo(() => {
    const match = pathname.match(/\/conversations\/([^/]+)/);
    return match ? match[1] : null;
  }, [pathname]);

  const activeSkillByConversation = useNimbusSkillsStore(
    (s) => s.activeSkillByConversation,
  );
  const activateSkill = useNimbusSkillsStore((s) => s.activateSkill);
  const clearSkill = useNimbusSkillsStore((s) => s.clearSkill);

  const activeSkillId = conversationId
    ? activeSkillByConversation[conversationId]
    : null;

  const handleSelect = (skillId: string) => {
    if (!conversationId) {
      // No conversation yet — just close; slash command will still work.
      onClose();
      return;
    }
    if (activeSkillId === skillId) {
      clearSkill(conversationId);
      return;
    }
    activateSkill(conversationId, skillId);
  };

  return (
    <section
      aria-label="Nimbus Skills"
      data-testid="nimbus-skills-panel"
      className="relative flex h-full w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#05070E] text-white"
      style={{
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
      }}
    >
      {/* Hero art background */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(180deg, rgba(5,7,14,0.55) 0%, rgba(5,7,14,0.85) 55%, rgba(5,7,14,0.98) 100%), url(${NIMBUS_SKILLS_PANEL_HERO_URL})`,
          backgroundSize: "cover",
          backgroundPosition: "center top",
        }}
      />
      {/* Radial violet+cyan accent to sell the Nimbus brand even before the
          hero image loads. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(1200px 400px at 15% -10%, rgba(139,92,246,0.25), transparent 60%), radial-gradient(900px 500px at 100% 100%, rgba(34,211,238,0.18), transparent 55%)",
        }}
      />

      <header className="relative z-10 flex items-start justify-between gap-4 px-8 pt-8">
        <div className="flex flex-col gap-2">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-white/15 bg-white/[0.04] px-3 py-1 text-[11px] uppercase tracking-[0.16em] text-white/70">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: "#8B5CF6" }}
            />
            Nimbus Skills
          </span>
          <h2
            className="text-3xl font-semibold text-white md:text-4xl"
            style={{
              fontFamily:
                "'Space Grotesk', Inter, ui-sans-serif, system-ui, sans-serif",
            }}
          >
            Pick a specialist.
          </h2>
          <p className="max-w-xl text-sm text-white/60">
            One click swaps the model and prepares a system prompt tuned for
            the job. Every skill also works from the composer:{" "}
            <span
              className="rounded bg-white/10 px-1.5 py-0.5 text-[12px]"
              style={{
                fontFamily:
                  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              /skill &lt;name&gt;
            </span>
            .
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          data-testid="nimbus-skills-panel-close"
          aria-label="Close Skills panel"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-white/[0.04] text-white/80 transition hover:bg-white/[0.12]"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </header>

      <div className="relative z-10 flex-1 overflow-auto px-8 pb-8 pt-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {NIMBUS_SKILLS.map((skill) => (
            <NimbusSkillCard
              key={skill.id}
              skill={skill}
              isActive={activeSkillId === skill.id}
              onSelect={handleSelect}
            />
          ))}
        </div>

        {activeSkillId && conversationId && (
          <div className="mt-6 flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/75">
            <span>
              Skill active for this chat. Model + system prompt applied on the
              next turn.
            </span>
            <button
              type="button"
              onClick={() => clearSkill(conversationId)}
              className="rounded-md border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/80 transition hover:bg-white/10"
            >
              Clear
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
