import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useConversationId } from "#/hooks/use-conversation-id";
import { useActiveConversation } from "#/hooks/query/use-active-conversation";
import { usePreviewPorts } from "#/hooks/query/use-preview-ports";
import { cn } from "#/utils/utils";

/**
 * The customer's own app, running in their sandbox, inside our page.
 *
 * This is the one capability where a browser product is at NO disadvantage to a
 * desktop one: the thing being previewed is a web app and the user is already
 * in a browser. Everything reaches them through the app server's preview proxy,
 * because Azure Container Apps publishes exactly one port per app, so there is
 * no second ingress to expose.
 *
 * THE SANDBOX ATTRIBUTE IS A SECURITY BOUNDARY, NOT A DETAIL
 * ---------------------------------------------------------
 * `allow-scripts allow-forms` and deliberately NOT `allow-same-origin`. The
 * proxy serves the customer's app from OUR origin, so without this the agent's
 * own output would run with our page's privileges and could read the session
 * storage and cookies of the product hosting it. Omitting `allow-same-origin`
 * gives the frame an opaque origin instead: scripts still run, forms still
 * submit, and postMessage still crosses — but our storage is unreachable.
 *
 * The cost is real and worth stating rather than discovering: the previewed app
 * cannot use its own cookies, localStorage or service workers. For looking at a
 * dev server that is the right trade; for anything needing a real session it is
 * not, and the subdomain migration in roadmap §7 is what fixes it properly.
 *
 * WHY THE KEY IS IN THE URL
 * -------------------------
 * An iframe cannot set a header on its document request, so the proxy takes a
 * bootstrap `?session_api_key=` and converts it to a path-scoped cookie for
 * every subresource after. That means the key is briefly in a src attribute —
 * so it is kept out of anything that persists: no history entry, and the
 * open-in-new-tab link deliberately omits it and relies on the cookie the first
 * load already set.
 */

/** Ports below this are not where a dev server lives. */
const MIN_PORT = 1024;

function Message({ text }: { text: string }) {
  return (
    <div
      data-testid="preview-message"
      className="flex h-full items-center justify-center px-4 text-center text-sm text-neutral-400"
    >
      {text}
    </div>
  );
}

export function PreviewPanel() {
  const { t } = useTranslation();
  const { conversationId } = useConversationId();
  const { data: conversation } = useActiveConversation();
  const { data, isLoading, isError } = usePreviewPorts(conversationId);

  const [selected, setSelected] = React.useState<number | null>(null);
  const [reloadNonce, setReloadNonce] = React.useState(0);

  const ports = React.useMemo(
    () => (data?.ports ?? []).filter((p) => p >= MIN_PORT),
    [data?.ports],
  );

  // Follow the first port until the user picks one, and let go of a port that
  // stops listening rather than showing a dead frame.
  React.useEffect(() => {
    if (ports.length === 0) {
      if (selected !== null) setSelected(null);
      return;
    }
    if (selected === null || !ports.includes(selected)) setSelected(ports[0]);
  }, [ports, selected]);

  const sessionKey = conversation?.session_api_key ?? null;

  const src =
    conversationId && selected !== null
      ? `/preview/${conversationId}/${selected}/${
          sessionKey ? `?session_api_key=${encodeURIComponent(sessionKey)}` : ""
        }`
      : null;

  if (isLoading) {
    return <Message text={t(I18nKey.PREVIEW$LOADING)} />;
  }

  // "Cannot look" and "nothing is listening" are different answers and the
  // backend distinguishes them, so this does too. Telling someone their server
  // is not running when we never checked is the failure worth avoiding.
  if (isError) return <Message text={t(I18nKey.PREVIEW$UNAVAILABLE)} />;
  if (data && !data.supported) {
    return <Message text={t(I18nKey.PREVIEW$NOT_SUPPORTED)} />;
  }
  if (ports.length === 0)
    return <Message text={t(I18nKey.PREVIEW$NO_SERVER)} />;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 border-b border-[#1E2233] px-2 py-1.5">
        <select
          data-testid="preview-port-select"
          aria-label={t(I18nKey.PREVIEW$PORT)}
          value={selected ?? ""}
          onChange={(e) => setSelected(Number(e.target.value))}
          className="rounded border border-[#4B505F] bg-transparent px-1.5 py-0.5 text-xs text-white"
        >
          {ports.map((port) => (
            <option key={port} value={port}>
              {`:${port}`}
            </option>
          ))}
        </select>

        <button
          type="button"
          data-testid="preview-reload"
          onClick={() => setReloadNonce((n) => n + 1)}
          className="rounded px-1.5 py-0.5 text-xs text-neutral-300 hover:text-white"
        >
          {t(I18nKey.PREVIEW$RELOAD)}
        </button>

        {/*
         * No session key on this link. The first frame load already set the
         * path-scoped cookie, so a new tab authenticates without putting a
         * credential into browser history where it would outlive the session.
         */}
        {conversationId && selected !== null && (
          <a
            href={`/preview/${conversationId}/${selected}/`}
            target="_blank"
            rel="noreferrer"
            data-testid="preview-open-tab"
            className="ml-auto rounded px-1.5 py-0.5 text-xs text-neutral-300 hover:text-white"
          >
            {t(I18nKey.PREVIEW$OPEN_IN_TAB)}
          </a>
        )}
      </div>

      {src && (
        <iframe
          // Remounts on reload rather than reaching into contentWindow, which
          // an opaque-origin frame does not permit anyway.
          key={`${src}-${reloadNonce}`}
          src={src}
          title={t(I18nKey.PREVIEW$TITLE)}
          data-testid="preview-iframe"
          sandbox="allow-scripts allow-forms"
          className={cn("h-full w-full flex-1 border-0 bg-white")}
        />
      )}
    </div>
  );
}
