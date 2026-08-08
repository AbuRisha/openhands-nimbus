import React from "react";
import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { convertImageToBase64 } from "#/utils/convert-image-to-base-64";
import { createChatMessage } from "#/services/chat-service";
import { BtwMessages } from "./btw-messages";
import { ModelMessages } from "./model-messages";
import { InteractiveChatBox } from "./interactive-chat-box";
import { AgentState } from "#/types/agent-state";
import { useFilteredEvents } from "#/hooks/use-filtered-events";
import { useScrollToBottom } from "#/hooks/use-scroll-to-bottom";
import { TypingIndicator } from "./typing-indicator";
import { ChatSuggestions } from "./chat-suggestions";
import { ScrollProvider } from "#/context/scroll-context";
import { useSendMessage } from "#/hooks/use-send-message";
import { useAgentState } from "#/hooks/use-agent-state";
import { useHandleBuildPlanClick } from "#/hooks/use-handle-build-plan-click";

import { ScrollToBottomButton } from "#/components/shared/buttons/scroll-to-bottom-button";
import { LoadingSpinner } from "#/components/shared/loading-spinner";
import { ChatMessagesSkeleton } from "./chat-messages-skeleton";
import { displayErrorToast } from "#/utils/custom-toast-handlers";
import { useErrorMessageStore } from "#/stores/error-message-store";
import { useSessionExpiredStore } from "#/stores/session-expired-store";
import { useOptimisticUserMessageStore } from "#/stores/optimistic-user-message-store";
import { ErrorMessageBanner } from "./error-message-banner";
import { SessionExpiredBanner } from "./session-expired-banner";
import { Messages as V1Messages } from "#/components/v1/chat";
import { useUnifiedUploadFiles } from "#/hooks/mutation/use-unified-upload-files";
import { validateFiles } from "#/utils/file-validation";
import { useConversationStore } from "#/stores/conversation-store";
import ConfirmationModeEnabled from "./confirmation-mode-enabled";
import { useTaskPolling } from "#/hooks/query/use-task-polling";
import { useConversationWebSocket } from "#/contexts/conversation-websocket-context";
import ChatStatusIndicator from "./chat-status-indicator";
import { getStatusColor, getStatusText } from "#/utils/utils";
import { useNewConversationCommand } from "#/hooks/mutation/use-new-conversation-command";
import { I18nKey } from "#/i18n/declaration";
import { ArchivedBanner } from "./archived-banner";
import { PendingMessages } from "./pending-messages";
import { RefusalPrompt } from "./refusal-prompt";
import { useRefusalFailover } from "#/hooks/chat/use-refusal-failover";
import { useApplyRefusalChoice } from "#/hooks/chat/use-apply-refusal-choice";
import { useLlmProfiles } from "#/hooks/query/use-llm-profiles";
import { useSwitchLlmProfileAndLog } from "#/hooks/mutation/use-switch-llm-profile-and-log";
import { useActiveConversation } from "#/hooks/query/use-active-conversation";
import { useResumeThenSend } from "#/hooks/use-resume-then-send";
import { useModelStore } from "#/stores/model-store";
import { useShortcut } from "#/hooks/use-shortcut";
import { ShortcutLayer } from "#/utils/shortcut-registry";
import { useFindInConversation } from "#/hooks/chat/use-find-in-conversation";
import { FindInConversation } from "./find-in-conversation";

export function ChatInterface() {
  const { setMessageToSend } = useConversationStore();
  const { errorMessage, removeErrorMessage } = useErrorMessageStore();
  const isSessionExpired = useSessionExpiredStore(
    (state) => state.isSessionExpired,
  );
  const { isTask, taskStatus, taskDetail } = useTaskPolling();
  const conversationWebSocket = useConversationWebSocket();
  const { send } = useSendMessage();
  const {
    v0Events,
    v1UiEvents,
    v1FullEvents,
    totalEvents,
    hasSubstantiveAgentActions,
    v1UserEventsExist,
    userEventsExist,
  } = useFilteredEvents();
  const { setOptimisticUserMessage, getOptimisticUserMessage } =
    useOptimisticUserMessageStore();
  const { t } = useTranslation();
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const {
    scrollDomToBottom,
    onChatBodyScroll,
    hitBottom,
    autoScroll,
    setAutoScroll,
    setHitBottom,
  } = useScrollToBottom(scrollRef);
  const {
    mutate: newConversationCommand,
    isPending: isNewConversationPending,
  } = useNewConversationCommand();

  const { curAgentState, isArchived } = useAgentState();
  const { handleBuildPlanClick } = useHandleBuildPlanClick();

  // Disable Build button while agent is running (streaming)
  const isAgentRunning =
    curAgentState === AgentState.RUNNING ||
    curAgentState === AgentState.LOADING;

  // Build button (Cmd+Enter / Ctrl+Enter), at COMPOSER priority.
  //
  // It sits here rather than in PlanPreview because several PlanPreviews can be
  // in the transcript at once and each would bind its own listener. The
  // registry makes that hoist unnecessary — duplicate registrations of one
  // chord resolve to a single winner — but there is still no reason for N
  // registrations where one will do, so it stays.
  //
  // CONFIRMATION outranks COMPOSER, which is the fix for a real collision: this
  // effect is gated on `isAgentRunning`, which covers only RUNNING and LOADING.
  // AWAITING_USER_CONFIRMATION is neither, so while the agent waited for
  // approval both this and the confirmation buttons were listening, and one
  // Cmd+Enter approved a tool call AND started a plan build. The old
  // `stopPropagation()` here never prevented that: both listeners were on
  // `document`, and stopPropagation does not stop siblings on the same node.
  useShortcut(
    { key: "Enter", mod: true },
    (event) => {
      handleBuildPlanClick(event);
      scrollDomToBottom();
    },
    { priority: ShortcutLayer.COMPOSER, when: () => !isAgentRunning },
  );

  const find = useFindInConversation(scrollRef, [v1FullEvents]);

  // Cmd/Ctrl+F. This one DOES belong in the registry — it is a global chord,
  // unlike the composer's Up/Down recall, which is a cursor key that only means
  // something in one element.
  //
  // It takes the browser's own find bar, which is a real cost. What it buys:
  // a match count scoped to the transcript, next/prev that scrolls the chat
  // container rather than the window, and highlighting that survives the
  // transcript re-rendering underneath it.
  //
  // WHAT IT DOES NOT BUY, measured rather than assumed: it does NOT see inside
  // collapsed tool rows. Their content is not hidden, it is UNMOUNTED — a
  // conversation showing five collapsed rows has `document.body.textContent`
  // containing exactly one "total" while the underlying events contain many.
  // So on collapsed content this is no better than native find, and anyone
  // extending it should know that before assuming a low count is a bug. The
  // fix is to search event DATA and expand the owning row on match; that is a
  // real change, not a tweak, and it is not done here.
  //
  // `allowInInput` so it opens while the composer has focus, which is where
  // focus normally sits.
  useShortcut({ key: "f", mod: true }, () => find.open(), {
    priority: ShortcutLayer.GLOBAL,
    allowInInput: true,
  });

  const params = useParams();

  /*
   * A ref, because the resend path below is wired BEFORE handleSendMessage is
   * defined and a retry must go through the same function a typed message
   * does — it carries the archived-sandbox resume and the queueing behaviour,
   * and a second near-identical send path would drift from it silently.
   */
  const handleSendMessageRef = React.useRef<
    ((content: string, images: File[], files: File[]) => Promise<void>) | null
  >(null);

  // A missing sandbox is infrastructure churn, not a decision the user made.
  // Rather than replacing the composer with a dead end, resume on send.
  const { ensureLive, resumeState } = useResumeThenSend(params.conversationId);

  /*
   * Model failover when a model refuses.
   *
   * All four pieces are unit-tested on their own; this is the wiring, and the
   * wiring is where the interesting mistakes live — every one of them is a
   * silent no-op rather than an error.
   */
  const { data: conversation } = useActiveConversation();
  const { data: llmProfiles } = useLlmProfiles();
  const { switchAndLog } = useSwitchLlmProfileAndLog();

  // {name, model} is exactly the catalog shape, and the profile NAME is what
  // switching takes — mapping back through this is why the catalog carries
  // both.
  const failoverCatalog = React.useMemo(
    () =>
      (llmProfiles?.profiles ?? [])
        .filter((profile) => !!profile.model)
        .map((profile) => ({
          name: profile.name,
          model: profile.model as string,
        })),
    [llmProfiles],
  );

  const profileNameForModel = React.useCallback(
    (model: string) =>
      failoverCatalog.find((entry) => entry.model === model)?.name ?? null,
    [failoverCatalog],
  );

  const currentModel = conversation?.llm_model ?? null;
  const currentModelName =
    failoverCatalog.find((entry) => entry.model === currentModel)?.name ??
    currentModel ??
    "";

  const { refusal, resolve } = useRefusalFailover({
    events: v1FullEvents,
    isRunning: isAgentRunning,
    currentModel,
    currentModelName,
    catalog: failoverCatalog,
  });

  const { apply } = useApplyRefusalChoice({
    isRunning: isAgentRunning,
    switchToProfile: (profileName) => {
      if (params.conversationId)
        switchAndLog(params.conversationId, profileName);
    },
    profileNameForModel,
    // Resend through the same path a typed message takes, so a retry gets the
    // archived-sandbox resume and the queueing behaviour rather than a second,
    // subtly different send.
    resend: (text) => {
      // .catch rather than `void`: handleSendMessage surfaces its own failures
      // as toasts, so this only stops an unhandled rejection and hides nothing.
      handleSendMessageRef.current?.(text, [], []).catch(() => {});
    },
  });

  /*
   * The refused request comes from the last USER message, not the optimistic
   * store — by the time a refusal has come back that store has been cleared,
   * and reading it would resend an empty string. A silent no-op, which is why
   * it is worth naming here rather than trusting.
   */
  const lastUserText = React.useMemo(() => {
    for (let i = v1FullEvents.length - 1; i >= 0; i -= 1) {
      const message = (
        v1FullEvents[i] as {
          llm_message?: {
            role?: string;
            content?: { type?: string; text?: string }[];
          };
        }
      ).llm_message;
      if (message?.role !== "user" || !Array.isArray(message.content)) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const text = message.content
        .filter(
          (part) => part?.type === "text" && typeof part.text === "string",
        )
        .map((part) => part.text)
        .join("\n");
      if (text) return text;
    }
    return "";
  }, [v1FullEvents]);
  const { mutateAsync: uploadFiles } = useUnifiedUploadFiles();

  const optimisticUserMessage = getOptimisticUserMessage();
  const modelEntriesByConversation = useModelStore(
    (s) => s.entriesByConversation,
  );
  const modelEntriesCount =
    (params.conversationId &&
      modelEntriesByConversation[params.conversationId]?.length) ||
    0;
  const hasModelEntries = modelEntriesCount > 0;

  // Show V1 messages immediately if events exist in store (e.g., remount),
  // or once loading completes. This replaces the old transition-observation
  // pattern (useState + useEffect watching loading→loaded) which always showed
  // skeleton on remount because local state initialized to false.
  const showV1Messages =
    v1FullEvents.length > 0 || !conversationWebSocket?.isLoadingHistory;

  const isReturningToConversation = !!params.conversationId;
  // Only show loading skeleton when genuinely loading AND no events in store yet.
  // If events exist (e.g., remount after data was already fetched), skip skeleton.
  const isHistoryLoading = !showV1Messages;
  const isChatLoading = isHistoryLoading && !isTask;

  const handleSendMessage = async (
    content: string,
    originalImages: File[],
    originalFiles: File[],
  ) => {
    // Handle /new command for V1 conversations
    if (content.trim() === "/new") {
      if (!params.conversationId) {
        displayErrorToast(t(I18nKey.CONVERSATION$CLEAR_NO_ID));
        return;
      }
      if (totalEvents === 0) {
        displayErrorToast(t(I18nKey.CONVERSATION$CLEAR_EMPTY));
        return;
      }
      if (isNewConversationPending) {
        return;
      }
      newConversationCommand();
      return;
    }

    // If the sandbox died under us (deploy, recycle, crash), bring it back
    // before the message goes anywhere. ensureLive is a no-op when the sandbox
    // is already running, so this costs nothing on the normal path.
    if (isArchived) {
      const live = await ensureLive();
      if (!live) {
        displayErrorToast(t(I18nKey.CONVERSATION$RESUME_FAILED));
        return;
      }
    }

    // Create mutable copies of the arrays
    const images = [...originalImages];
    const files = [...originalFiles];
    // Validate file sizes before any processing
    const allFiles = [...images, ...files];
    const validation = validateFiles(allFiles);

    if (!validation.isValid) {
      displayErrorToast(`Error: ${validation.errorMessage}`);
      return; // Stop processing if validation fails
    }

    const promises = images.map((image) => convertImageToBase64(image));
    const imageUrls = await Promise.all(promises);

    const timestamp = new Date().toISOString();

    const { skipped_files: skippedFiles, uploaded_files: uploadedFiles } =
      files.length > 0
        ? await uploadFiles({ conversationId: params.conversationId!, files })
        : { skipped_files: [], uploaded_files: [] };

    skippedFiles.forEach((f) => displayErrorToast(f.reason));

    const filePrompt = `${t("CHAT_INTERFACE$AUGMENTED_PROMPT_FILES_TITLE")}: ${uploadedFiles.join("\n\n")}`;
    const prompt =
      uploadedFiles.length > 0 ? `${content}\n\n${filePrompt}` : content;

    await send(createChatMessage(prompt, imageUrls, uploadedFiles, timestamp));
    // Show it whether it went out now or was queued.
    //
    // Queued sends used to render nothing at all, on the reasoning that the
    // message "will appear when actually delivered". But the composer is
    // cleared on the very next line, so between those two moments the user's
    // text simply vanished — no bubble, no pending state, nothing — for as long
    // as the agent stayed busy. The only available reading is that it was lost,
    // and the natural response is to type it again.
    //
    // The optimistic bubble is cleared when the real message echoes back over
    // the websocket, so this cannot double up: it shows the text until the
    // thing it stands for exists.
    //
    // KNOWN LIMIT: the store holds one message, so queueing a second replaces
    // the first in the display. Both are still delivered and both appear for
    // real. Showing every queued message (and letting them be cancelled or
    // reordered) needs an actual queue store — see docs/parity-roadmap.md.
    setOptimisticUserMessage(content);
    setMessageToSend("");
  };

  // Kept current every render: the retry path holds this ref, and a stale one
  // would resend through a closure over last render's state.
  handleSendMessageRef.current = handleSendMessage;

  // Auto-scroll to bottom when new messages arrive
  React.useEffect(() => {
    if (autoScroll) {
      scrollDomToBottom();
    }
    // Note: We intentionally exclude autoScroll from deps because we only want
    // to scroll when message content changes, not when autoScroll state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    v1UiEvents.length,
    v0Events.length,
    optimisticUserMessage,
    modelEntriesCount,
    scrollDomToBottom,
  ]);

  // Create a ScrollProvider with the scroll hook values
  const scrollProviderValue = {
    scrollRef,
    autoScroll,
    setAutoScroll,
    scrollDomToBottom,
    hitBottom,
    setHitBottom,
    onChatBodyScroll,
  };

  // Get server status indicator props
  const isStartingStatus =
    curAgentState === AgentState.LOADING || curAgentState === AgentState.INIT;
  const isStopStatus = curAgentState === AgentState.STOPPED;
  const isPausing = curAgentState === AgentState.PAUSED;
  const serverStatusColor = getStatusColor({
    isPausing,
    isTask,
    taskStatus,
    isStartingStatus,
    isStopStatus,
    curAgentState,
  });
  const serverStatusText = getStatusText({
    isPausing,
    isTask,
    taskStatus,
    taskDetail,
    isStartingStatus,
    isStopStatus,
    curAgentState,
    errorMessage,
    t,
  });

  return (
    <ScrollProvider value={scrollProviderValue}>
      <div className="h-full flex flex-col justify-between pr-0 md:pr-4 relative">
        {!hasSubstantiveAgentActions &&
          !optimisticUserMessage &&
          !userEventsExist &&
          !isChatLoading &&
          !hasModelEntries && (
            <ChatSuggestions
              onSuggestionsClick={(message) => setMessageToSend(message)}
            />
          )}
        {/* Note: We only hide chat suggestions when there's a user message */}

        <FindInConversation
          isOpen={find.isOpen}
          query={find.query}
          matchCount={find.matchCount}
          currentMatch={find.currentMatch}
          onQueryChange={find.setQuery}
          onNext={find.next}
          onPrevious={find.previous}
          onClose={find.close}
        />

        <div
          ref={scrollRef}
          onScroll={(e) => onChatBodyScroll(e.currentTarget)}
          // pb-8: the transcript had pt-4 and no bottom padding, so the last
          // line sat flush against the composer and under its glow underlay.
          className="custom-scrollbar-always flex flex-col grow overflow-y-auto overflow-x-hidden px-4 pt-4 pb-8 gap-2"
        >
          {isChatLoading && isReturningToConversation && (
            <ChatMessagesSkeleton />
          )}

          {isChatLoading && !isReturningToConversation && (
            <div className="flex justify-center" data-testid="loading-spinner">
              <LoadingSpinner size="small" />
            </div>
          )}

          <ModelMessages
            conversationId={params.conversationId}
            anchorEventId={null}
          />
          {showV1Messages && v1UserEventsExist && (
            <V1Messages messages={v1UiEvents} allEvents={v1FullEvents} />
          )}
        </div>

        <div className="flex flex-col gap-[6px]">
          <BtwMessages conversationId={params.conversationId} />
          <div className="flex justify-between relative">
            <div className="flex items-end gap-1">
              <ConfirmationModeEnabled />
              {isStartingStatus && (
                <ChatStatusIndicator
                  statusColor={serverStatusColor}
                  status={serverStatusText}
                />
              )}
            </div>

            <div className="absolute left-1/2 transform -translate-x-1/2 bottom-0">
              {curAgentState === AgentState.RUNNING && <TypingIndicator />}
            </div>

            {!hitBottom && <ScrollToBottomButton onClick={scrollDomToBottom} />}
          </div>

          {/* The expired banner REPLACES the error banner rather than stacking
              with it. Both describe the same dead socket, and only one of them
              names something the user can do about it. */}
          {isSessionExpired && <SessionExpiredBanner />}

          {!isSessionExpired && errorMessage && (
            <ErrorMessageBanner
              message={errorMessage}
              onDismiss={removeErrorMessage}
            />
          )}

          {/* The composer is ALWAYS available. Hiding it behind an archived
              banner made routine infrastructure churn look like the end of the
              conversation — the user could not even type. Sending resumes
              first; the only visible cost is a brief reconnect on the first
              message after a restart. */}
          {refusal && (
            <RefusalPrompt
              refusedModel={refusal.refusedModel}
              fallback={refusal.fallback}
              onChoose={(choice) => {
                apply(resolve(choice), lastUserText, currentModel);
              }}
            />
          )}

          {resumeState === "failed" && <ArchivedBanner />}

          {/* Above the composer: what you typed while the agent was busy is
              still yours, and still cancellable, until it is delivered. */}
          <PendingMessages />

          <InteractiveChatBox
            onSubmit={handleSendMessage}
            disabled={isNewConversationPending || resumeState === "resuming"}
          />
        </div>
      </div>
    </ScrollProvider>
  );
}
