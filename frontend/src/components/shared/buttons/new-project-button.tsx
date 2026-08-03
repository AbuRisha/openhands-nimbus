import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { StyledTooltip } from "#/components/shared/buttons/styled-tooltip";
import PlusIcon from "#/icons/u-plus.svg?react";
import { NewProjectModal } from "#/components/features/projects/new-project-modal";
import { cn } from "#/utils/utils";

interface NewProjectButtonProps {
  disabled?: boolean;
}

/**
 * Sidebar entry point for the "New project" flow.
 *
 * Historically this was a NavLink back to "/" — which conflated "start a new
 * conversation" with "start a new project" and left the user with no way to
 * bind a workspace. It now opens the workspace-picker modal, which routes the
 * user to a fresh conversation once they've picked a binding.
 */
export function NewProjectButton({ disabled = false }: NewProjectButtonProps) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const label = t(I18nKey.CONVERSATION$START_NEW);

  return (
    <>
      <StyledTooltip content={label} placement="right">
        <button
          type="button"
          data-testid="new-project-button"
          aria-label={label}
          tabIndex={disabled ? -1 : 0}
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            setOpen(true);
          }}
          className={cn("inline-flex items-center justify-center", {
            "pointer-events-none opacity-50": disabled,
            "cursor-pointer": !disabled,
          })}
        >
          <PlusIcon width={24} height={24} />
        </button>
      </StyledTooltip>
      {open && <NewProjectModal onClose={() => setOpen(false)} />}
    </>
  );
}
