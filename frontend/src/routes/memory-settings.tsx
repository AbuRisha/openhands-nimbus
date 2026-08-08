import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useMemory } from "#/hooks/query/use-memory";
import { useSaveMemory } from "#/hooks/mutation/use-save-memory";
import { BrandButton } from "#/components/features/settings/brand-button";
import { LoadingSpinner } from "#/components/shared/loading-spinner";
import { cn } from "#/utils/utils";

/**
 * The customer's durable memory — one document, carried into every
 * conversation they start.
 *
 * This nav entry used to point at the CONDENSER, which compacts a single
 * conversation's context. Both are reasonably called "memory" by someone
 * describing the mechanism, but only one is what a customer means when they
 * click Memory: the thing the assistant knows about them. The condenser is now
 * named for what it does.
 *
 * The cap is shown rather than hidden because this text lands in EVERY
 * conversation's context window. A customer who fills it and then wonders why
 * the agent drops earlier turns has no way to connect the two unless the cost
 * is visible at the point of writing.
 */
function MemorySettingsScreen() {
  const { t } = useTranslation();
  const { data, isLoading } = useMemory();
  const { mutate: save, isPending } = useSaveMemory();

  const [draft, setDraft] = React.useState<string | null>(null);

  // `null` means "not edited yet" — the server value shows through. Seeding
  // state from `data` in an effect instead would clobber an in-progress edit
  // on any refetch.
  const value = draft ?? data?.text ?? "";
  const maxChars = data?.max_chars ?? 8000;
  const used = value.length;
  const over = used > maxChars;
  const dirty = draft !== null && draft !== (data?.text ?? "");

  const handleSave = () => {
    if (draft === null) return;
    save(draft, {
      // Drop back to the server's value on success: it is authoritative and
      // may be TRUNCATED relative to what was typed.
      onSuccess: () => setDraft(null),
    });
  };

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center h-full"
        data-testid="memory-settings-screen"
      >
        <LoadingSpinner size="large" />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-4 p-6 h-full overflow-y-auto"
      data-testid="memory-settings-screen"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-lg text-white">{t(I18nKey.MEMORY$TITLE)}</h2>
        <p className="text-sm text-[#A9B0C0] max-w-2xl">
          {t(I18nKey.MEMORY$DESCRIPTION)}
        </p>
      </div>

      <textarea
        data-testid="memory-textarea"
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t(I18nKey.MEMORY$PLACEHOLDER)}
        aria-label={t(I18nKey.MEMORY$TITLE)}
        className="w-full max-w-2xl min-h-[280px] rounded-lg border border-[#4B505F] bg-[#25272D] p-3 text-sm text-white outline-none resize-y placeholder:text-[#8A8F9C]"
      />

      <div className="flex items-center gap-3 max-w-2xl">
        <BrandButton
          type="button"
          variant="primary"
          testId="memory-save"
          isDisabled={!dirty || isPending || over}
          onClick={handleSave}
        >
          {t(I18nKey.MEMORY$SAVE)}
        </BrandButton>

        <span
          data-testid="memory-char-count"
          aria-live="polite"
          className={cn(
            "text-xs tabular-nums",
            over ? "text-[#F87171]" : "text-[#8A8F9C]",
          )}
        >
          {t(I18nKey.MEMORY$CHAR_COUNT, { used, max: maxChars })}
        </span>

        {over && (
          <span className="text-xs text-[#F87171]">
            {t(I18nKey.MEMORY$OVER_LIMIT)}
          </span>
        )}
      </div>
    </div>
  );
}

export default MemorySettingsScreen;
