import { useTranslation } from "react-i18next";
import { RotateCw } from "lucide-react";
import { I18nKey } from "#/i18n/declaration";
import { SessionEndReason } from "#/stores/session-expired-store";

interface SessionExpiredBannerProps {
  /** Injected by tests. Production reloads the page. */
  onReload?: () => void;
  /** Defaults to the certain case, which is what the original call site meant. */
  reason?: SessionEndReason | null;
}

/**
 * Terminal state for the event socket: nothing left to wait for.
 *
 * It replaces the error banner rather than sitting next to it, because the
 * thing it replaces — "WebSocket closed with code 1008", re-raised every three
 * seconds — described the mechanism and named no action.
 *
 * THE COPY CHANGES WITH HOW MUCH WE ACTUALLY KNOW. When the server accepted
 * and then closed with a permanent code, it told us the session was rejected
 * and the banner says so. When the upgrade was refused outright the browser
 * reports 1006, which is indistinguishable from an unreachable server — so the
 * banner offers the same reload without asserting a cause. Claiming "your
 * session expired" to someone whose network dropped is a specific untrue
 * statement about their account, and it costs nothing to avoid.
 */
export function SessionExpiredBanner({
  onReload,
  reason = "rejected",
}: SessionExpiredBannerProps) {
  const { t } = useTranslation();

  const message =
    reason === "refused"
      ? t(I18nKey.STATUS$CONNECTION_REFUSED_RELOAD)
      : t(I18nKey.STATUS$SESSION_EXPIRED_RELOAD);

  return (
    <div
      role="alert"
      data-testid="session-expired-banner"
      className="w-full rounded-lg p-2 border border-[#FF0006] bg-[#4A0709] flex gap-2 items-center justify-between text-white"
    >
      <span className="min-w-0 break-words">{message}</span>

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
