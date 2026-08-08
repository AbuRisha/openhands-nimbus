import { useEffect, useRef } from "react";
import { BrowserSnapshot } from "./browser-snapshot";
import { EmptyBrowserMessage } from "./empty-browser-message";
import { useConversationId } from "#/hooks/use-conversation-id";
import { useBrowserStore } from "#/stores/browser-store";

export function BrowserPanel() {
  const { url, screenshotSrc, reset } = useBrowserStore();
  const { conversationId } = useConversationId();

  /*
   * Reset when the CONVERSATION changes — never on mount.
   *
   * This used to be a bare `reset()` in an effect keyed on
   * `[conversationId, reset]`, which also runs on the panel's FIRST render.
   * The panel mounts when the user opens the Browser tab, and the events that
   * populate this store arrive over the socket well before that. So the order
   * was: agent browses -> store fills -> user opens the tab to look at it ->
   * the panel wipes the store it exists to display -> EmptyBrowserMessage.
   *
   * The symptom is that a screenshot is only ever visible if the tab was
   * ALREADY open when the agent browsed. Opening it afterwards — which is what
   * anyone actually does — always showed empty, and looked like the browser
   * feature had never worked.
   *
   * Carrying stale state across conversations is still wrong, so the reset
   * stays; it just fires on an actual change rather than on arrival.
   */
  const previousConversationId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const isFirstRender = previousConversationId.current === undefined;
    const changed = previousConversationId.current !== conversationId;
    previousConversationId.current = conversationId;

    if (!isFirstRender && changed) {
      reset();
    }
  }, [conversationId, reset]);

  const imgSrc = screenshotSrc?.startsWith("data:image/png;base64,")
    ? screenshotSrc
    : `data:image/png;base64,${screenshotSrc ?? ""}`;

  return (
    <div className="h-full w-full flex flex-col text-neutral-400">
      <div className="w-full p-2 truncate border-b border-neutral-600">
        {url}
      </div>
      <div className="overflow-y-auto grow scrollbar-hide rounded-xl">
        {screenshotSrc ? (
          <BrowserSnapshot src={imgSrc} />
        ) : (
          <EmptyBrowserMessage />
        )}
      </div>
    </div>
  );
}
