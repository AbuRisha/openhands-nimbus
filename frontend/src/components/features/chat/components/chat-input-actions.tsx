import { AgentStatus } from "#/components/features/controls/agent-status";
import { Tools } from "../../controls/tools";
import { useUnifiedPauseConversationSandbox } from "#/hooks/mutation/use-unified-stop-conversation";
import { useConversationId } from "#/hooks/use-conversation-id";
import { useV1PauseConversation } from "#/hooks/mutation/use-v1-pause-conversation";
import { useV1ResumeConversation } from "#/hooks/mutation/use-v1-resume-conversation";
import { ChangeAgentButton } from "../change-agent-button";
import { PermissionModeButton } from "../permission-mode-button";
import { SwitchAcpModelButton } from "../switch-acp-model-button";
import { ContextUsageRing } from "../context-usage-ring";
import { VoiceInputButton } from "../voice-input-button";
import { ComposerModelChip } from "./composer-model-chip";

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
      {/* Five controls. Model and effort share one pill because they are one
          decision (see ComposerModelChip); the ACP model button is mutually
          exclusive with that chip — each hides itself for the conversation kind
          the other serves — so only one is ever visible.
          Permission mode sits beside Code/Plan because both answer "how should
          the agent behave", and because the moment you want to change it is the
          moment the agent is about to do something you are unsure about. */}
      <div className="flex items-center gap-1">
        <div className="flex items-center gap-4">
          <Tools />
          <ChangeAgentButton />
          <PermissionModeButton />
          <ComposerModelChip />
          <SwitchAcpModelButton />
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
