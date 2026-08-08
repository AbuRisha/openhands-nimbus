import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { AgentState } from "#/types/agent-state";
import { generateAgentStateChangeEvent } from "#/services/agent-state-service";
import { ActionTooltip } from "../action-tooltip";
import { isOpenHandsAction, isActionOrObservation } from "#/types/core/guards";
import { ActionSecurityRisk } from "#/stores/security-analyzer-store";
import { RiskAlert } from "#/components/shared/risk-alert";
import WarningIcon from "#/icons/u-warning.svg?react";
import { useEventMessageStore } from "#/stores/event-message-store";
import { useEventStore } from "#/stores/use-event-store";
import { isV0Event } from "#/types/v1/type-guards";
import { useSendMessage } from "#/hooks/use-send-message";
import { useShortcut } from "#/hooks/use-shortcut";
import { ShortcutLayer } from "#/utils/shortcut-registry";

export function ConfirmationButtons() {
  const submittedEventIds = useEventMessageStore(
    (state) => state.submittedEventIds,
  );
  const addSubmittedEventId = useEventMessageStore(
    (state) => state.addSubmittedEventId,
  );

  const { t } = useTranslation();

  const { send } = useSendMessage();
  const events = useEventStore((state) => state.events);

  // Find the most recent action awaiting confirmation
  const awaitingAction = events
    .filter(isV0Event)
    .filter(isActionOrObservation)
    .slice()
    .reverse()
    .find((ev) => {
      if (!isOpenHandsAction(ev) || ev.source !== "agent") return false;
      const args = ev.args as Record<string, unknown>;
      return args?.confirmation_state === "awaiting_confirmation";
    });

  const handleStateChange = useCallback(
    (state: AgentState) => {
      if (!awaitingAction) {
        return;
      }

      addSubmittedEventId(awaitingAction.id);
      send(generateAgentStateChangeEvent(state));
    },
    [send, addSubmittedEventId],
  );

  // Continue: Cmd+Enter (⌘↩) — see v1-confirmation-buttons for why this sits at
  // CONFIRMATION priority and why `mod` replaced a metaKey-only test.
  useShortcut(
    { key: "Enter", mod: true },
    () => handleStateChange(AgentState.USER_CONFIRMED),
    { priority: ShortcutLayer.CONFIRMATION, when: () => !!awaitingAction },
  );

  // Cancel: Shift+Cmd+Backspace (⇧⌘⌫)
  useShortcut(
    { key: "Backspace", mod: true, shift: true },
    () => handleStateChange(AgentState.USER_REJECTED),
    { priority: ShortcutLayer.CONFIRMATION, when: () => !!awaitingAction },
  );

  if (!awaitingAction || submittedEventIds.includes(awaitingAction.id)) {
    return null;
  }

  const { args } = awaitingAction as { args: Record<string, unknown> };

  const risk = args?.security_risk;

  const isHighRisk =
    typeof risk === "string"
      ? risk.toLowerCase() === "high"
      : Number(risk) === ActionSecurityRisk.HIGH;

  return (
    <div className="flex flex-col gap-2 pt-4">
      {isHighRisk && (
        <RiskAlert
          content={t(I18nKey.CHAT_INTERFACE$HIGH_RISK_WARNING)}
          icon={<WarningIcon width={16} height={16} color="#fff" />}
          severity="high"
          title={t(I18nKey.COMMON$HIGH_RISK)}
        />
      )}
      <div className="flex justify-between items-center">
        <p className="text-sm font-normal text-white">
          {t(I18nKey.CHAT_INTERFACE$USER_ASK_CONFIRMATION)}
        </p>
        <div className="flex items-center gap-3">
          <ActionTooltip
            type="reject"
            onClick={() => handleStateChange(AgentState.USER_REJECTED)}
          />
          <ActionTooltip
            type="confirm"
            onClick={() => handleStateChange(AgentState.USER_CONFIRMED)}
          />
        </div>
      </div>
    </div>
  );
}
