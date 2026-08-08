import React from "react";
import { DragOver } from "../drag-over";
import { UploadedFiles } from "../uploaded-files";
import { ChatInputRow } from "./chat-input-row";
import { ChatInputActions } from "./chat-input-actions";
import { SlashCommandMenu } from "./slash-command-menu";
import { MentionFileMenu } from "./mention-file-menu";
import { useConversationStore } from "#/stores/conversation-store";
import { cn } from "#/utils/utils";
import { SlashCommandItem } from "#/hooks/chat/use-slash-command";
import { WorkspaceFile } from "#/api/workspace-service/workspace-service.api";

interface ChatInputContainerProps {
  chatContainerRef: React.RefObject<HTMLDivElement | null>;
  isDragOver: boolean;
  disabled: boolean;
  isNewConversationPending?: boolean;
  showButton: boolean;
  buttonClassName: string;
  chatInputRef: React.RefObject<HTMLDivElement | null>;
  handleFileIconClick: (isDisabled: boolean) => void;
  handleSubmit: () => void;
  onDragOver: (e: React.DragEvent, isDisabled: boolean) => void;
  onDragLeave: (e: React.DragEvent, isDisabled: boolean) => void;
  onDrop: (e: React.DragEvent, isDisabled: boolean) => void;
  onInput: () => void;
  onPaste: (e: React.ClipboardEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  isSlashMenuOpen?: boolean;
  slashItems?: SlashCommandItem[];
  slashSelectedIndex?: number;
  onSlashSelect?: (item: SlashCommandItem) => void;
  isMentionMenuOpen?: boolean;
  mentionItems?: WorkspaceFile[];
  mentionSelectedIndex?: number;
  mentionIsLoading?: boolean;
  mentionIsError?: boolean;
  mentionTruncated?: boolean;
  onMentionSelect?: (file: WorkspaceFile) => void;
}

export function ChatInputContainer({
  chatContainerRef,
  isDragOver,
  disabled,
  isNewConversationPending = false,
  showButton,
  buttonClassName,
  chatInputRef,
  handleFileIconClick,
  handleSubmit,
  onDragOver,
  onDragLeave,
  onDrop,
  onInput,
  onPaste,
  onKeyDown,
  onFocus,
  onBlur,
  isSlashMenuOpen = false,
  slashItems = [],
  slashSelectedIndex = 0,
  onSlashSelect,
  isMentionMenuOpen = false,
  mentionItems = [],
  mentionSelectedIndex = 0,
  mentionIsLoading = false,
  mentionIsError = false,
  mentionTruncated = false,
  onMentionSelect,
}: ChatInputContainerProps) {
  const conversationMode = useConversationStore(
    (state) => state.conversationMode,
  );

  return (
    <div className="nimbus-composer-wrap relative w-full">
      <div
        ref={chatContainerRef}
        className={cn(
          "nimbus-composer bg-[#111318]/85 box-border content-stretch flex flex-col items-start justify-center p-4 pt-3 relative rounded-[15px] w-full border border-[rgba(139,92,246,0.18)]",
          conversationMode === "plan" && "border-[#597FF4]",
        )}
        onDragOver={(e) => onDragOver(e, disabled)}
        onDragLeave={(e) => onDragLeave(e, disabled)}
        onDrop={(e) => onDrop(e, disabled)}
      >
        {isDragOver && <DragOver />}

        <UploadedFiles />

        <div className="relative w-full">
          {isSlashMenuOpen && onSlashSelect && (
            <SlashCommandMenu
              items={slashItems}
              selectedIndex={slashSelectedIndex}
              onSelect={onSlashSelect}
            />
          )}

          {/* Only one menu at a time: both own Up/Down/Enter, and a composer
              with two open listboxes has no defensible keyboard contract.
              Slash wins because it is triggered by an explicit command. */}
          {isMentionMenuOpen && !isSlashMenuOpen && (
            <MentionFileMenu
              items={mentionItems}
              selectedIndex={mentionSelectedIndex}
              isLoading={mentionIsLoading}
              isError={mentionIsError}
              truncated={mentionTruncated}
              onSelect={onMentionSelect}
            />
          )}

          <ChatInputRow
            chatInputRef={chatInputRef}
            disabled={disabled}
            isNewConversationPending={isNewConversationPending}
            showButton={showButton}
            buttonClassName={buttonClassName}
            handleFileIconClick={handleFileIconClick}
            handleSubmit={handleSubmit}
            onInput={onInput}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            onFocus={onFocus}
            onBlur={onBlur}
          />
        </div>

        <ChatInputActions disabled={disabled} />
      </div>
    </div>
  );
}
