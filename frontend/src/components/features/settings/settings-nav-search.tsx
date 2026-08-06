import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { cn } from "#/utils/utils";

/**
 * Filter the settings nav by typing.
 *
 * Settings pages are the one place people arrive knowing WHAT they want and not
 * WHERE it lives — "where do I change the model", "where are my API keys" — and
 * the answer has never been guessable from a category name. Every mature
 * settings surface answers that with a search box above the nav, and ours has
 * grown enough sections that scanning is no longer instant.
 *
 * Filtering happens on the rendered labels, which is deliberate: it matches
 * what the user can actually see, so a search never returns an item whose name
 * they could not have known.
 */

interface SettingsNavSearchProps {
  value: string;
  onChange: (value: string) => void;
}

export function SettingsNavSearch({ value, onChange }: SettingsNavSearchProps) {
  const { t } = useTranslation();
  const inputRef = React.useRef<HTMLInputElement>(null);

  return (
    <div className="px-1 sm:px-4.5">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Escape clears rather than closing anything. The box has no open
          // state, so closing would mean removing focus from the thing the
          // user is actively typing into.
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
        data-testid="settings-nav-search"
        placeholder={t(I18nKey.SETTINGS$NAV_SEARCH_PLACEHOLDER)}
        aria-label={t(I18nKey.SETTINGS$NAV_SEARCH_PLACEHOLDER)}
        className={cn(
          "w-full rounded-lg border border-[#4B505F] bg-transparent",
          "px-2.5 py-1.5 text-sm text-white placeholder:text-white/40",
          "focus:outline-none focus:border-[#8B5CF6]/70",
        )}
      />
    </div>
  );
}
