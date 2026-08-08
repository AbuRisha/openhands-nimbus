import { useTranslation } from "react-i18next";
import { RotateCw } from "lucide-react";
import { I18nKey } from "#/i18n/declaration";

interface SessionExpiredBannerProps {
  /** Injected by tests. Production reloads the page. */
  onReload?: () => void;
}

/**
 * Terminal state for the event socket: the session key was refused and will be
 * refused again, so there is nothing to wait for.
 *
 * It replaces the error banner rather than sitting next to it, because the
 * thing it replaces — "WebSocket closed with code 1008", re-raised every three
 * seconds — described the mechanism and named no action.
 */
export function SessionExpiredBanner({ onReload }: SessionExpiredBannerProps) {
  const { t } = useTranslation();

  return (
    <div
      role="alert"
      data-testid="session-expired-banner"
      className="w-full rounded-lg p-2 border border-[#FF0006] bg-[#4A0709] flex gap-2 items-center justify-between text-white"
    >
      <span className="min-w-0 break-words">
        {t(I18nKey.STATUS$SESSION_EXPIRED_RELOAD)}
      </span>

      <button
        type="button"
        onClick={() => (onReload ? onReload() : window.location.reload())}
        className="shrink-0 flex items-center gap-1 rounded-md px-2 py-1 underline font-semibold cursor-pointer hover:bg-black/20"
        data-testid="session-expired-banner-reload"
      >
        <RotateCw className="h-4 w-4" />
        {t(I18nKey.BUTTON$RELOAD_PAGE)}
      </button>
    </div>
  );
}
