import React, { useEffect, useRef } from "react";
import { useChatInputLogic } from "#/hooks/chat/use-chat-input-logic";
import { useFileHandling } from "#/hooks/chat/use-file-handling";
import { useGripResize } from "#/hooks/chat/use-grip-resize";
import { useChatInputEvents } from "#/hooks/chat/use-chat-input-events";
import { useChatSubmission } from "#/hooks/chat/use-chat-submission";
import { useSlashCommand } from "#/hooks/chat/use-slash-command";
import { useMentionPicker } from "#/hooks/chat/use-mention-picker";
import { usePromptRecall } from "#/hooks/chat/use-prompt-recall";
import { ChatInputGrip } from "./components/chat-input-grip";
import { ChatInputContainer } from "./components/chat-input-container";
import { HiddenFileInput } from "./components/hidden-file-input";
import { useConversationStore } from "#/stores/conversation-store";
import { V1SandboxStatus } from "#/api/sandbox-service/sandbox-service.types";

export interface CustomChatInputProps {
  disabled?: boolean;
  isNewConversationPending?: boolean;
  showButton?: boolean;
  sandboxStatus?: V1SandboxStatus | null;
  onSubmit: (message: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onFilesPaste?: (files: File[]) => void;
  className?: React.HTMLAttributes<HTMLDivElement>["className"];
  buttonClassName?: React.HTMLAttributes<HTMLButtonElement>["className"];
}

export function CustomChatInput({
  disabled = false,
  isNewConversationPending = false,
  showButton = true,
  sandboxStatus = null,
  onSubmit,
  onFocus,
  onBlur,
  onFilesPaste,
  className = "",
  buttonClassName = "",
}: CustomChatInputProps) {
  const {
    submittedMessage,
    clearAllFiles,
    setShouldHideSuggestions,
    setSubmittedMessage,
  } = useConversationStore();

  // Disable input when conversation is stopped
  const isConversationStopped = sandboxStatus === "MISSING";
  const isDisabled = disabled || isConversationStopped;

  // Listen to submittedMessage state changes
  useEffect(() => {
    if (!submittedMessage || disabled) {
      return;
    }
    onSubmit(submittedMessage);
    setSubmittedMessage(null);
  }, [submittedMessage, disabled, onSubmit, setSubmittedMessage]);

  // Custom hooks
  const {
    chatInputRef,
    messageToSend,
    checkIsContentEmpty,
    clearEmptyContentHandler,
    saveDraft,
  } = useChatInputLogic();

  const {
    fileInputRef,
    chatContainerRef,
    isDragOver,
    handleFileIconClick,
    handleFileInputChange,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useFileHandling(onFilesPaste);

  const {
    gripRef,
    isGripVisible,
    handleTopEdgeClick,
    smartResize,
    handleGripMouseDown,
    handleGripTouchStart,
    increaseHeightForEmptyContent,
    resetManualResize,
  } = useGripResize(
    chatInputRef as React.RefObject<HTMLDivElement | null>,
    messageToSend,
  );

  const { handleSubmit } = useChatSubmission(
    chatInputRef as React.RefObject<HTMLDivElement | null>,
    fileInputRef as React.RefObject<HTMLInputElement | null>,
    smartResize,
    onSubmit,
    resetManualResize,
  );

  const { handleInput, handlePaste, handleKeyDown, handleBlur, handleFocus } =
    useChatInputEvents(
      chatInputRef as React.RefObject<HTMLDivElement | null>,
      smartResize,
      increaseHeightForEmptyContent,
      checkIsContentEmpty,
      clearEmptyContentHandler,
      onFocus,
      onBlur,
    );

  const {
    isMenuOpen: isSlashMenuOpen,
    filteredItems: slashItems,
    selectedIndex: slashSelectedIndex,
    updateSlashMenu,
    selectItem: selectSlashItem,
    handleSlashKeyDown,
    closeMenu: closeSlashMenu,
  } = useSlashCommand(chatInputRef as React.RefObject<HTMLDivElement | null>);

  const {
    isMenuOpen: isMentionMenuOpen,
    items: mentionItems,
    selectedIndex: mentionSelectedIndex,
    isLoading: mentionIsLoading,
    isError: mentionIsError,
    truncated: mentionTruncated,
    updateMenu: updateMentionMenu,
    selectItem: selectMentionItem,
    handleMentionKeyDown,
    closeMenu: closeMentionMenu,
  } = useMentionPicker(chatInputRef as React.RefObject<HTMLDivElement | null>);

  const { recallPrevious, recallNext, reset: resetRecall } = usePromptRecall();

  /**
   * Recall writes to the composer and then fires a synthetic InputEvent so the
   * box resizes — but that event is indistinguishable from typing, and `onInput`
   * ends the history walk. Without this flag every Up would reset the cursor it
   * had just advanced, so recall could never go more than one entry deep.
   */
  const recallIsWriting = useRef(false);

  /**
   * Up/Down walk your own sent prompts, shell-style.
   *
   * Ordering in the key chain matters and is not arbitrary: the slash menu gets
   * the arrows FIRST (it uses them to move its selection), and this returns
   * false whenever it declines so the normal caret behaviour still happens.
   * Recall only engages from an empty composer — see `usePromptRecall` — so a
   * multi-line prompt keeps ordinary cursor movement.
   */
  const handleRecallKeyDown = (e: React.KeyboardEvent): boolean => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return false;

    const element = chatInputRef.current;
    if (!element) return false;

    const current = element.textContent ?? "";
    const next =
      e.key === "ArrowUp" ? recallPrevious(current) : recallNext(current);
    if (next === null) return false;

    e.preventDefault();
    element.textContent = next;

    // Same sequence the slash-command insert uses: collapse to the end, then
    // fire a native InputEvent so React's onInput runs and the box resizes.
    // Without the event the composer keeps its old height and a recalled
    // multi-line prompt is clipped.
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(element);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);

    recallIsWriting.current = true;
    element.dispatchEvent(new InputEvent("input", { bubbles: true }));
    recallIsWriting.current = false;
    element.focus();

    return true;
  };

  // Cleanup: reset suggestions visibility when component unmounts
  useEffect(
    () => () => {
      setShouldHideSuggestions(false);
      clearAllFiles();
    },
    [setShouldHideSuggestions, clearAllFiles],
  );
  return (
    <div className={`w-full ${className}`}>
      {/* Hidden file input */}
      <HiddenFileInput
        fileInputRef={fileInputRef}
        onChange={handleFileInputChange}
      />

      {/* Container with grip */}
      <div className="relative w-full">
        <ChatInputGrip
          gripRef={gripRef}
          isGripVisible={isGripVisible}
          handleTopEdgeClick={handleTopEdgeClick}
          handleGripMouseDown={handleGripMouseDown}
          handleGripTouchStart={handleGripTouchStart}
        />

        <ChatInputContainer
          chatContainerRef={chatContainerRef}
          isDragOver={isDragOver}
          disabled={isDisabled}
          isNewConversationPending={isNewConversationPending}
          showButton={showButton}
          buttonClassName={buttonClassName}
          chatInputRef={chatInputRef}
          handleFileIconClick={handleFileIconClick}
          handleSubmit={handleSubmit}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onInput={() => {
            handleInput();
            updateSlashMenu();
            updateMentionMenu();
            saveDraft();
            // Typing ends the history walk, so the next Up starts from the most
            // recent prompt again. Recall's own write is exempt — see
            // `recallIsWriting`.
            if (!recallIsWriting.current) resetRecall();
          }}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (handleSlashKeyDown(e)) return;
            // BEFORE recall: recall also claims Up, and an open menu has the
            // stronger claim on it.
            if (handleMentionKeyDown(e)) return;
            if (handleRecallKeyDown(e)) return;
            handleKeyDown(e, isDisabled, handleSubmit);
          }}
          onFocus={handleFocus}
          onBlur={() => {
            handleBlur();
            closeSlashMenu();
            closeMentionMenu();
          }}
          isSlashMenuOpen={isSlashMenuOpen}
          slashItems={slashItems}
          slashSelectedIndex={slashSelectedIndex}
          onSlashSelect={selectSlashItem}
          isMentionMenuOpen={isMentionMenuOpen}
          mentionItems={mentionItems}
          mentionSelectedIndex={mentionSelectedIndex}
          mentionIsLoading={mentionIsLoading}
          mentionIsError={mentionIsError}
          mentionTruncated={mentionTruncated}
          onMentionSelect={selectMentionItem}
        />
      </div>
    </div>
  );
}
