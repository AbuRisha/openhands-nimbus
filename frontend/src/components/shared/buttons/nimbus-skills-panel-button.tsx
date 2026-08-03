import { Sparkles } from "lucide-react";
import { StyledTooltip } from "#/components/shared/buttons/styled-tooltip";
import { cn } from "#/utils/utils";

interface NimbusSkillsPanelButtonProps {
  isOpen: boolean;
  onClick: () => void;
  disabled?: boolean;
  hasActiveSkill?: boolean;
}

/**
 * Sidebar rail button that opens the Nimbus Skills Panel.
 *
 * Mirrors the pattern of ConversationPanelButton so it slots into the
 * existing icon column with no layout drift. Shows a small violet dot when
 * the current conversation has an active skill.
 */
export function NimbusSkillsPanelButton({
  isOpen,
  onClick,
  disabled = false,
  hasActiveSkill = false,
}: NimbusSkillsPanelButtonProps) {
  const label = "Nimbus Skills";

  return (
    <StyledTooltip content={label}>
      <button
        type="button"
        data-testid="toggle-nimbus-skills-panel"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className="relative border-0 bg-transparent p-0"
      >
        <Sparkles
          width={22}
          height={22}
          strokeWidth={1.8}
          className={cn(
            "cursor-pointer transition-colors",
            isOpen ? "text-white" : "text-[#B1B9D3] hover:text-white",
            disabled && "opacity-50",
          )}
        />
        {hasActiveSkill && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full"
            style={{
              backgroundColor: "#8B5CF6",
              boxShadow: "0 0 8px rgba(139,92,246,0.85)",
            }}
          />
        )}
      </button>
    </StyledTooltip>
  );
}
