import React from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { ContextMenu } from "#/ui/context-menu";
import { ContextMenuListItem } from "../context-menu/context-menu-list-item";
import { Divider } from "#/ui/divider";
import { ToolsContextMenuIconText } from "../controls/tools-context-menu-icon-text";
import { useClickOutsideElement } from "#/hooks/use-click-outside-element";
import CircuitIcon from "#/icons/u-circuit.svg?react";
import SettingsIcon from "#/icons/settings.svg?react";
import CheckIcon from "#/icons/checkmark.svg?react";
import { cn } from "#/utils/utils";
import { CONTEXT_MENU_ICON_TEXT_CLASSNAME } from "#/utils/constants";
import type { LlmProfileSummary } from "#/api/settings-service/profiles-service.api";

const itemClassName = cn(
  "cursor-pointer p-0 h-auto hover:bg-transparent",
  CONTEXT_MENU_ICON_TEXT_CLASSNAME,
);

// Profile rows are two lines (name + model), so they need auto height —
// unlike `itemClassName`, which keeps the single-line Settings link compact.
const profileItemClassName = "cursor-pointer p-0 h-auto hover:bg-transparent";

/**
 * Display names for the vendor prefix in a model id.
 *
 * `alibaba` maps to Qwen, and is kept even though the catalog no longer ships
 * any `alibaba/` id. It used to: qwen3.8-max was listed under the prefix it
 * carries upstream until we confirmed the gateway resolves `qwen/qwen3.8-max`
 * to the same model at the same rate. Profiles seeded before that change, and
 * conversations already pinned to the old id, still hold `alibaba/qwen3.8-max`
 * and still route — so without this entry they would render under a bare
 * "alibaba" heading, which is the supplier's name and not something a customer
 * should ever see.
 */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot",
  qwen: "Qwen",
  alibaba: "Qwen",
  "z-ai": "Z.ai",
};

/** Everything before the first "/", which is how the gateway namespaces ids. */
function providerKeyOf(model: string | null | undefined): string {
  if (!model) return "Other";
  const prefix = model.includes("/") ? model.split("/")[0] : "";
  return PROVIDER_LABELS[prefix] ?? (prefix || "Other");
}

interface SwitchProfileContextMenuProps {
  profiles: LlmProfileSummary[];
  activeProfileName: string | null;
  onSelect: (profileName: string) => void;
  onClose: () => void;
}

export function SwitchProfileContextMenu({
  profiles,
  activeProfileName,
  onSelect,
  onClose,
}: SwitchProfileContextMenuProps) {
  const { t } = useTranslation();
  const ref = useClickOutsideElement<HTMLUListElement>(onClose);
  const [providerFilter, setProviderFilter] = React.useState<string | null>(
    null,
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Group by provider, preserving the order the API returned.
   *
   * That order is the catalog's — newest model first within each vendor — and
   * it is deliberately NOT re-sorted here. Sorting by name would put
   * "Claude Haiku 4.5" above "Claude Opus 5", i.e. the oldest and weakest model
   * at the top of the list, which is the opposite of useful.
   */
  const groups = React.useMemo(() => {
    const byProvider = new Map<string, LlmProfileSummary[]>();
    profiles.forEach((profile) => {
      const key = providerKeyOf(profile.model);
      const bucket = byProvider.get(key);
      if (bucket) bucket.push(profile);
      else byProvider.set(key, [profile]);
    });
    return Array.from(byProvider.entries());
  }, [profiles]);

  const visibleGroups = providerFilter
    ? groups.filter(([provider]) => provider === providerFilter)
    : groups;

  const renderProfile = (profile: LlmProfileSummary) => {
    const isActive = profile.name === activeProfileName;
    return (
      <ContextMenuListItem
        key={profile.name}
        testId={`switch-profile-option-${profile.name}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSelect(profile.name);
          onClose();
        }}
        className={profileItemClassName}
        ariaCurrent={isActive ? "true" : undefined}
      >
        {/* Two lines: the profile name, with its provider/model beneath
            (matches agent-canvas). Full model also in the title tooltip. */}
        <div
          title={profile.model ?? undefined}
          className={cn(
            "flex flex-col gap-0.5 p-2 rounded",
            isActive ? "bg-[#5C5D62]" : "hover:bg-[#5C5D62]",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <CircuitIcon width={16} height={16} className="shrink-0" />
              <span className="truncate">{profile.name}</span>
            </div>
            {isActive && <CheckIcon width={14} height={14} className="shrink-0" />}
          </div>
          {profile.model && (
            <span className="block truncate text-xs leading-4 text-gray-400 pl-6">
              {profile.model}
            </span>
          )}
        </div>
      </ContextMenuListItem>
    );
  };

  return (
    <ContextMenu
      ref={ref}
      testId="switch-profile-context-menu"
      position="top"
      alignment="left"
      className="left-0 mb-2 bottom-full min-w-[300px] max-h-[60vh] overflow-y-auto"
    >
      {/* Provider filter. Scrolling the whole list still works — this narrows
          it for someone who knows which vendor they want, rather than
          replacing the scroll. Only shown when there is more than one vendor,
          since a single chip filters nothing. */}
      {groups.length > 1 && (
        <div className="flex flex-wrap gap-1 px-2 pt-2 pb-1 sticky top-0 z-10 bg-[#454545]">
          <button
            type="button"
            data-testid="switch-profile-filter-all"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setProviderFilter(null);
            }}
            className={cn(
              "text-xs px-2 py-0.5 rounded-full border transition-colors",
              providerFilter === null
                ? "border-primary text-primary"
                : "border-[#5C5D62] text-gray-300 hover:text-white",
            )}
          >
            {t(I18nKey.COMMON$ALL)}
          </button>
          {groups.map(([provider]) => (
            <button
              key={provider}
              type="button"
              data-testid={`switch-profile-filter-${provider}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setProviderFilter((current) =>
                  current === provider ? null : provider,
                );
              }}
              className={cn(
                "text-xs px-2 py-0.5 rounded-full border transition-colors",
                providerFilter === provider
                  ? "border-primary text-primary"
                  : "border-[#5C5D62] text-gray-300 hover:text-white",
              )}
            >
              {provider}
            </button>
          ))}
        </div>
      )}

      {visibleGroups.map(([provider, providerProfiles]) => (
        <div key={provider} data-testid={`switch-profile-group-${provider}`}>
          <div className="px-2 pt-2 pb-1 text-xs uppercase tracking-wide text-gray-400">
            {provider}
          </div>
          {providerProfiles.map(renderProfile)}
        </div>
      ))}

      <Divider />
      <Link
        to="/settings"
        onClick={onClose}
        data-testid="switch-profile-open-settings"
        className={cn("block", itemClassName)}
      >
        <ToolsContextMenuIconText
          icon={<SettingsIcon width={16} height={16} />}
          text={t(I18nKey.MODEL$OPEN_SETTINGS)}
          className={CONTEXT_MENU_ICON_TEXT_CLASSNAME}
        />
      </Link>
    </ContextMenu>
  );
}
