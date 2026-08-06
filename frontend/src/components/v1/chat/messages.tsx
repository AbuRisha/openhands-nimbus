import React from "react";
import { useParams } from "react-router";
import { OpenHandsEvent } from "#/types/v1/core";
import { EventMessage } from "./event-message";
import { ChatMessage } from "../../features/chat/chat-message";
import { ModelMessages } from "../../features/chat/model-messages";
import { useOptimisticUserMessageStore } from "#/stores/optimistic-user-message-store";
import { useModelStore } from "#/stores/model-store";
import { usePlanPreviewEvents } from "./hooks/use-plan-preview-events";
import { ToolCallRow } from "./tool-call-row";
import { planToolCalls } from "./event-content-helpers/tool-call-plan";
// TODO: Implement microagent functionality for V1 when APIs support V1 event IDs
// import { AgentState } from "#/types/agent-state";
// import MemoryIcon from "#/icons/memory_icon.svg?react";

interface MessagesProps {
  messages: OpenHandsEvent[]; // UI events (actions replaced by observations)
  allEvents: OpenHandsEvent[]; // Full event history (for action lookup)
}

export const Messages: React.FC<MessagesProps> = React.memo(
  ({ messages, allEvents }) => {
    const { getOptimisticUserMessage } = useOptimisticUserMessageStore();
    const params = useParams();
    const conversationId = params.conversationId ?? null;

    const optimisticUserMessage = getOptimisticUserMessage();

    // Get the set of event IDs that should render PlanPreview
    // This ensures only one preview per user message "phase"
    const planPreviewEventIds = usePlanPreviewEvents(allEvents);

    // Compute the set of event ids that have a /model entry anchored to them,
    // so we only mount <ModelMessages> for events that actually need one
    // instead of one-per-event with an early-return null.
    const modelEntries = useModelStore((s) =>
      conversationId ? s.entriesByConversation[conversationId] : undefined,
    );
    const modelAnchorIds = React.useMemo(() => {
      if (!modelEntries || modelEntries.length === 0) return null;
      const ids = new Set<string>();
      for (const entry of modelEntries) {
        if (entry.anchorEventId !== null) ids.add(entry.anchorEventId);
      }
      return ids.size > 0 ? ids : null;
    }, [modelEntries]);

    // TODO: Implement microagent functionality for V1 if needed
    // For now, we'll skip microagent features

    /*
     * One row per tool CALL, rather than one chip per RUN of them.
     *
     * A turn can emit twenty-plus action/observation rows, which buries the
     * actual conversation; folding them all into a single "Used 12 tools" chip
     * buried it differently, behind an opaque count. Pairing is pure and
     * unit-tested (tool-call-plan.ts): narration, streaming prose and agent
     * errors keep their full rows, so nothing a user needs to read ends up
     * behind a click.
     */
    // allEvents, not just messages: handleEventForUI replaces an action with
    // its observation in the rendered list, so the action a row needs for its
    // summary only exists in the full history.
    const renderPlan = React.useMemo(
      () => planToolCalls(messages, allEvents),
      [messages, allEvents],
    );

    const renderEvent = (message: OpenHandsEvent, index: number) => {
      const messageId = String(message.id);
      return (
        <React.Fragment key={message.id}>
          <EventMessage
            event={message}
            messages={allEvents}
            isLastMessage={messages.length - 1 === index}
            isInLast10Actions={messages.length - 1 - index < 10}
            planPreviewEventIds={planPreviewEventIds}
          />
          {modelAnchorIds?.has(messageId) && (
            <ModelMessages
              conversationId={conversationId}
              anchorEventId={messageId}
            />
          )}
        </React.Fragment>
      );
    };

    return (
      <>
        {renderPlan.map((item) => {
          if (item.type === "single") {
            return renderEvent(item.event, item.index);
          }
          /*
           * The row is the summary; the body is the existing rendering,
           * unchanged. Each child keeps its REAL index so isLastMessage still
           * resolves correctly — that flag drives the confirmation buttons,
           * and losing it would strand an agent waiting on approval.
           */
          return (
            <ToolCallRow
              key={`call-${item.action.id}`}
              action={item.action}
              observation={item.observation}
            >
              {renderEvent(item.action, item.index)}
              {item.observation !== undefined &&
                item.observationIndex !== undefined &&
                renderEvent(item.observation, item.observationIndex)}
            </ToolCallRow>
          );
        })}

        {optimisticUserMessage && (
          <ChatMessage type="user" message={optimisticUserMessage} />
        )}
      </>
    );
  },
  // Default shallow prop comparison: re-render whenever the `messages`/`allEvents`
  // array reference changes (a fresh array is produced whenever the event store
  // updates). A custom length-only comparator was previously used, but it
  // skipped re-renders when a streaming delta grows its bubble *in place*
  // (content changes, array length stays the same), so the live answer never
  // repainted until the next event changed the length.
);

Messages.displayName = "Messages";
