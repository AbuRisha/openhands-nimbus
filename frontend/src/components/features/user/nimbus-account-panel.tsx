import React from "react";
import { useTranslation } from "react-i18next";
import {
  useNimbusAccount,
  useSetNimbusSpendCap,
} from "#/hooks/query/use-nimbus-account";
import { I18nKey } from "#/i18n/declaration";

/**
 * Signed-in Nimbus account, balance, and what CHAT specifically has cost.
 *
 * The spend figure is scoped to the chat key rather than the account, which is
 * the whole point: it moves by the cost of a chat turn and by nothing else, so
 * a customer can tell whether chat is billing them correctly. An account-wide
 * total would mix in direct API traffic and answer nothing.
 *
 * "Unavailable" and "$0.00" are kept strictly apart. When the server cannot
 * reach nimbusapi.net it reports `configured: false`, and showing that as a
 * zero balance would tell someone with money that they have none — which is the
 * kind of wrong that makes the whole number untrustworthy.
 */
const usd = (n: number) =>
  `$${n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    // Chat turns cost fractions of a cent; rounding to 2dp would render most
    // real spend as $0.00 and look identical to "not billed at all".
    maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2,
  })}`;

export function NimbusAccountPanel() {
  const { data, isLoading, isError } = useNimbusAccount();
  const { t } = useTranslation();
  const setCap = useSetNimbusSpendCap();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const capInputRef = React.useRef<HTMLInputElement>(null);

  /*
   * Focus the limit field when it opens, without `autoFocus`.
   *
   * autoFocus is an accessibility problem because it steals focus on mount
   * regardless of what the user was doing. Here the field appears in response
   * to a deliberate click, so moving focus to it IS what was asked for — this
   * just scopes it to that transition rather than to mounting.
   */
  React.useEffect(() => {
    if (editing) capInputRef.current?.focus();
  }, [editing]);

  if (isLoading) {
    return (
      <div className="px-2 py-1.5 text-xs text-neutral-400">
        {t(I18nKey.NIMBUS$ACCOUNT$LOADING)}
      </div>
    );
  }

  if (isError || !data?.configured) {
    return (
      <div className="px-2 py-1.5 text-xs text-neutral-400">
        {t(I18nKey.NIMBUS$ACCOUNT$UNAVAILABLE)}
      </div>
    );
  }

  const cap = data.chat.spend_cap_usd;
  const remaining =
    cap !== null ? Math.max(0, cap - data.chat.spent_usd) : null;

  const submitCap = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setCap.mutate(null);
    } else {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n < 0) return;
      setCap.mutate(n);
    }
    setEditing(false);
  };

  return (
    <div className="flex flex-col gap-1 px-2 py-2 text-xs">
      {data.email ? (
        <div className="truncate font-medium text-white" title={data.email}>
          {data.email}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <span className="text-neutral-400">
          {t(I18nKey.NIMBUS$ACCOUNT$BALANCE)}
        </span>
        <span
          className={
            (data.balance_usd ?? 0) > 0 ? "text-emerald-400" : "text-amber-400"
          }
        >
          {usd(data.balance_usd ?? 0)}
        </span>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-neutral-400">
          {t(I18nKey.NIMBUS$ACCOUNT$SPENT_IN_CHAT)}
        </span>
        <span className="text-white">
          {usd(data.chat.spent_usd)}
          {data.chat.request_count > 0 ? (
            <span className="ml-1 text-neutral-500">
              ({data.chat.request_count})
            </span>
          ) : null}
        </span>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-neutral-400">
          {t(I18nKey.NIMBUS$ACCOUNT$CHAT_LIMIT)}
        </span>
        {editing ? (
          <span className="flex items-center gap-1">
            <input
              ref={capInputRef}
              type="number"
              min="0"
              step="0.01"
              value={draft}
              placeholder="none"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCap();
                if (e.key === "Escape") setEditing(false);
              }}
              className="w-16 rounded border border-white/20 bg-black/40 px-1 py-0.5 text-right text-white"
            />
            <button
              type="button"
              onClick={submitCap}
              disabled={setCap.isPending}
              className="rounded px-1 text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
            >
              {t(I18nKey.NIMBUS$ACCOUNT$SAVE)}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(cap === null ? "" : String(cap));
              setEditing(true);
            }}
            className="text-neutral-300 underline decoration-dotted underline-offset-2 hover:text-white"
            title={t(I18nKey.NIMBUS$ACCOUNT$CAP_TOOLTIP)}
          >
            {cap === null ? t(I18nKey.NIMBUS$ACCOUNT$NO_LIMIT) : usd(cap)}
          </button>
        )}
      </div>

      {remaining !== null ? (
        <div className="text-right text-[10px] text-neutral-500">
          {t(I18nKey.NIMBUS$ACCOUNT$REMAINING, { amount: usd(remaining) })}
        </div>
      ) : null}

      {setCap.isError ? (
        <div className="text-[10px] text-red-400">
          {t(I18nKey.NIMBUS$ACCOUNT$SAVE_FAILED)}
        </div>
      ) : null}
    </div>
  );
}
