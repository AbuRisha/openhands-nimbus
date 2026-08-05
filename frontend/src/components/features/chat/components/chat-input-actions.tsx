import { AgentStatus } from "#/components/features/controls/agent-status";
import { Tools } from "../../controls/tools";
import { useUnifiedPauseConversationSandbox } from "#/hooks/mutation/use-unified-stop-conversation";
import { useConversationId } from "#/hooks/use-conversation-id";
import { useV1PauseConversation } from "#/hooks/mutation/use-v1-pause-conversation";
import { useV1ResumeConversation } from "#/hooks/mutation/use-v1-resume-conversation";
import { ChangeAgentButton } from "../change-agent-button";
import { SwitchAcpModelButton } from "../switch-acp-model-button";
import { SwitchProfileButton } from "../switch-profile-button";
import { EffortSliderButton } from "../effort-slider-popover";
import { ContextUsageRing } from "../context-usage-ring";
import { VoiceInputButton } from "../voice-input-button";

interface ChatInputActionsProps {
  disabled: boolean;
}

export function ChatInputActions({ disabled }: ChatInputActionsProps) {
  const pauseConversationSandboxMutation = useUnifiedPauseConversationSandbox();
  const v1PauseConversationMutation = useV1PauseConversation();
  const v1ResumeConversationMutation = useV1ResumeConversation();
  const { conversationId } = useConversationId();

  const handlePauseAgent = () => {
    // V1: Pause the conversation (agent execution)
    v1PauseConversationMutation.mutate({ conversationId });
  };

  const handleResumeAgentClick = () => {
    // V1: Resume the conversation (agent execution)
    v1ResumeConversationMutation.mutate({ conversationId });
  };

  const isPausing =
    pauseConversationSandboxMutation.isPending ||
    v1PauseConversationMutation.isPending;

  return (
    <div className="w-full flex items-center justify-between">
      <div className="flex items-center gap-1">
        <div className="flex items-center gap-4">
          <Tools />
          <ChangeAgentButton />
          <SwitchProfileButton />
          <SwitchAcpModelButton />
          <EffortSliderButton />
          <VoiceInputButton disabled={disabled} />
        </div>
      </div>
      {/* Sits beside the run status, which is where the eye already goes when
          a turn is in flight — and the moment context pressure matters. */}
      <div className="flex items-center gap-3 ml-2 md:ml-3">
        <ContextUsageRing />
        <AgentStatus
          handleStop={handlePauseAgent}
          handleResumeAgent={handleResumeAgentClick}
          disabled={disabled}
          isPausing={isPausing}
        />
      </div>
    </div>
  );
}
