import React from "react";
import {
  BookmarkCheck,
  BookmarkPlus,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import { MessageEvent } from "#/types/v1/core";
import { ChatMessage } from "../../../features/chat/chat-message";
import { ImageCarousel } from "../../../features/images/image-carousel";
import { V1ConfirmationButtons } from "#/components/shared/buttons/v1-confirmation-buttons";
import { parseMessageFromEvent } from "../event-content-helpers/parse-message-from-event";
import { CriticResultDisplay } from "./critic-result-display";
import { useRetryFromHereAction } from "#/hooks/chat/use-retry-from-here-action";
import { useKeepAsArtifactAction } from "#/hooks/chat/use-keep-as-artifact-action";
import { ConfirmationModal } from "#/components/shared/modals/confirmation-modal";

interface UserAssistantEventMessageProps {
  event: MessageEvent;
  isLastMessage: boolean;
  isFromPlanningAgent: boolean;
}

export function UserAssistantEventMessage({
  event,
  isLastMessage,
  isFromPlanningAgent,
}: UserAssistantEventMessageProps) {
  const message = parseMessageFromEvent(event);

  /*
   * Offered on BOTH sides of the conversation, deliberately. The operation is
   * one thing — "start again from this point, keeping everything up to and
   * including it" — and it is equally meaningful pointed at either speaker: at
   * an agent reply to take a good answer somewhere new, at your own message to
   * ask it differently without losing what came before. Putting it only on
   * assistant replies would leave no way to redo your own prompt except
   * scrolling back and retyping it.
   *
   * The tooltip is the same string in both places on purpose; a control that
   * renames itself by context is harder to learn, not easier.
   */
  const retry = useRetryFromHereAction(event.id);

  // Agent replies only — see the hook. This is the creation path for #20;
  // without it the artifact gallery is a working feature that stays empty.
  const keep = useKeepAsArtifactAction(message, event.source);

  /*
   * Built as a list so each action decides independently whether it applies.
   * "Keep this" is agent-only and retry is both-sides, so a user message shows
   * one control and an agent reply shows two — without either hook needing to
   * know the other exists.
   *
   * Keep comes first because it is the non-destructive one. Retry starts a new
   * conversation and spends credit, so it sits further from where the pointer
   * lands.
   */
  const actions = [
    keep && {
      icon: (() => {
        if (keep.isPending) {
          return (
            <LoaderCircle
              className="w-4 h-4 animate-spin"
              data-testid="keep-artifact-spinner"
            />
          );
        }
        return keep.isKept ? (
          <BookmarkCheck className="w-4 h-4" data-testid="keep-artifact-done" />
        ) : (
          <BookmarkPlus className="w-4 h-4" data-testid="keep-artifact-icon" />
        );
      })(),
      onClick: keep.onClick,
      tooltip: keep.tooltip,
      isDisabled: keep.isDisabled,
      keepVisible: keep.keepVisible,
    },
    retry && {
      icon: retry.isPending ? (
        <LoaderCircle
          className="w-4 h-4 animate-spin"
          data-testid="retry-from-here-spinner"
        />
      ) : (
        <RotateCcw className="w-4 h-4" data-testid="retry-from-here-icon" />
      ),
      onClick: retry.onClick,
      tooltip: retry.tooltip,
      isDisabled: retry.isDisabled,
      keepVisible: retry.keepVisible,
    },
  ].filter(Boolean) as NonNullable<
    React.ComponentProps<typeof ChatMessage>["actions"]
  >;

  const imageUrls: string[] = [];
  if (Array.isArray(event.llm_message.content)) {
    event.llm_message.content.forEach((content) => {
      if (content.type === "image") {
        imageUrls.push(...content.image_urls);
      }
    });
  }

  return (
    <>
      <ChatMessage
        type={event.source}
        message={message}
        isFromPlanningAgent={isFromPlanningAgent}
        actions={actions.length > 0 ? actions : undefined}
      >
        {imageUrls.length > 0 && (
          <ImageCarousel size="small" images={imageUrls} />
        )}
        {isLastMessage && <V1ConfirmationButtons />}
      </ChatMessage>
      {event.source === "agent" && event.critic_result != null && (
        <CriticResultDisplay criticResult={event.critic_result} />
      )}

      {retry?.confirmationText && (
        <ConfirmationModal
          text={retry.confirmationText}
          onConfirm={retry.confirm}
          onCancel={retry.cancel}
        />
      )}
    </>
  );
}
