import React from "react";
import { useTranslation } from "react-i18next";
import ChevronDownSmallIcon from "#/icons/chevron-down-small.svg?react";
import CircuitIcon from "#/icons/u-circuit.svg?react";
import { I18nKey } from "#/i18n/declaration";
import { useLlmProfiles } from "#/hooks/query/use-llm-profiles";
import { useSwitchLlmProfileAndLog } from "#/hooks/mutation/use-switch-llm-profile-and-log";
import { useActiveConversation } from "#/hooks/query/use-active-conversation";
import { useConversationId } from "#/hooks/use-conversation-id";
import { useModelStore } from "#/stores/model-store";
import { useClickOutsideElement } from "#/hooks/use-click-outside-element";
import { EFFORT_STOPS, useEffortStore } from "#/stores/effort-store";
import { isReasoningEffortSupported } from "#/utils/reasoning-effort-support";
import { cn } from "#/utils/utils";
import { EffortSlider } from "../effort-slider";

/**
 * Model and effort, as one control.
 *
 * WHY THESE TWO AND NOT SEPARATE BUTTONS
 * --------------------------------------
 * The composer footer had grown to six controls on the left before the context
 * ring and run status on the right, plus a second row of five git buttons —
 * reported simply as "there is too many things". Two of the six were the model
 * (SwitchProfileButton) and the effort (EffortSliderButton), and they are not
 * independent choices: effort is a property OF the model, and whether it does
 * anything at all depends on which model is selected. Splitting them into two
 * pills meant the answer to "why is my effort setting greyed out" lived in a
 * different popover from the cause.
 *
 * So they share one pill and one popover. Picking a model and setting how hard
 * it thinks is a single decision, made in a single place.
 *
 * THIS REPLACES A DECORATIVE VERSION
 * ----------------------------------
 * An earlier ComposerModelChip in this file looked right and did nothing: it
 * held its own hardcoded nine-model list, wrote localStorage keys and fired a
 * `nimbus:composer-model` event that nothing ever listened for, and was wired
 * into no screen. A model picker that silently fails to switch models is worse
 * than no model picker, so none of it survives here. The list is the real
 * catalog and selection goes through the mutation that actually persists;
 * effort is the shared effort store, not a private copy.
 *
 * IT IS A MODEL PICKER, NOT A PROFILE PICKER
 * ------------------------------------------
 * "LLM profile" is OpenHands vocabulary and no customer should ever meet it.
 * Every entry here is one Nimbus catalog model: the deployment seeds a profile
 * per model in NIMBUS_CHAT_MODELS and names each one after the model itself
 * (`anthropic/claude-sonnet-5` -> "Claude Sonnet 5"), precisely so the picker
 * shows the whole catalog without anyone visiting settings. The profile is
 * therefore an implementation detail of how a switch is persisted, and it stays
 * on that side of the boundary — the surface reads Model, groups by provider,
 * and says "profile" nowhere.
 */
/**
 * How each provider writes its own name.
 *
 * Carried over from switch-profile-context-menu, which this chip replaced.
 * Capitalising the first letter is not enough and looks unfinished exactly
 * where a customer is choosing what to pay for: "openai" becomes "Openai",
 * "z-ai" becomes "Z-ai", "deepseek" becomes "Deepseek". `nimbus` is our own
 * namespace (currently the Weekly Free passthrough) and needs the same
 * treatment so it does not sit lowercase beside properly-cased vendors.
 */
const PROVIDER_LABELS: Record<string, string> = {
  nimbus: "Nimbus",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot",
  qwen: "Qwen",
  alibaba: "Qwen",
  "z-ai": "Z.ai",
  xai: "xAI",
};

/**
 * Provider label from a model id: `anthropic/claude-sonnet-5` -> "Anthropic".
 *
 * Twenty-nine flat rows is a wall; grouped by maker it is a few short lists you
 * can aim at. A model id with no provider prefix is a real possibility for a
 * user-added entry, so those collect under "Other" rather than vanishing.
 */
function providerOf(model: string | null | undefined): string {
  if (!model?.includes("/")) return "Other";
  const raw = model.split("/", 1)[0];
  // Unknown providers still get title-cased rather than shown raw: a vendor we
  // have not met yet should look ordinary, not broken.
  return PROVIDER_LABELS[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function ComposerModelChip() {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const { conversationId } = useConversationId();
  const { data } = useLlmProfiles();
  const { data: conversation } = useActiveConversation();
  const { switchAndLog, isPending } = useSwitchLlmProfileAndLog();
  const switchedProfileName = useModelStore(
    (s) => s.activeProfileByConversation[conversationId] ?? null,
  );
  const effort = useEffortStore((s) => s.effort);

  const popoverRef = useClickOutsideElement<HTMLDivElement>(() =>
    setOpen(false),
  );

  const profiles = data?.profiles ?? [];
  const conversationModel = conversation?.llm_model ?? null;

  // Still starting: the id is the placeholder `task-<uuid>`, not the real
  // conversation UUID yet, so a switch can't be persisted (would 422).
  const isStarting = conversationId.startsWith("task-");

  // Resolve the active profile, most-authoritative source first:
  //   1. A switch the user made this session (recorded by name, so it's exact
  //      even when several profiles share a model string, e.g. SaaS managed
  //      models behind the litellm_proxy, and instant — no refetch needed).
  //   2. The running model, matched by `llm_model` (covers a freshly loaded
  //      conversation where no switch happened this session).
  //   3. The user-level default, only when the conversation has no model yet —
  //      otherwise we'd misrepresent the running model.
  const switchedProfileMatch =
    switchedProfileName && profiles.some((p) => p.name === switchedProfileName)
      ? switchedProfileName
      : null;
  const activeProfileName =
    switchedProfileMatch ??
    (conversationModel
      ? (profiles.find((p) => p.model === conversationModel)?.name ?? null)
      : (data?.active_profile ?? null));

  const activeProfileModel =
    profiles.find((p) => p.name === activeProfileName)?.model ??
    conversationModel ??
    null;

  const activeStop =
    EFFORT_STOPS.find((s) => s.value === effort) ?? EFFORT_STOPS[1];
  const effortSupported = isReasoningEffortSupported(conversationModel);

  // Grouped in catalog order, which is curated (strongest first per maker) —
  // sorting alphabetically here would throw that away and bury the model most
  // people want behind the ones they don't.
  const grouped = React.useMemo(() => {
    const byProvider = new Map<string, typeof profiles>();
    for (const profile of profiles) {
      const key = providerOf(profile.model);
      const bucket = byProvider.get(key);
      if (bucket) bucket.push(profile);
      else byProvider.set(key, [profile]);
    }
    return [...byProvider.entries()];
  }, [profiles]);

  // LLM profiles don't apply to ACP conversations: the sub-agent
  // (Claude Code / Codex / Gemini CLI) drives its own model selection, and
  // SwitchAcpModelButton is the control that does apply there.
  if (conversation?.agent_kind === "acp") return null;
  if (profiles.length === 0) return null;

  const handleSelect = (profileName: string) => {
    if (profileName === activeProfileName) return;
    switchAndLog(conversationId, profileName);
    // Deliberately left open: effort is the next thing a user reaches for
    // after changing model, and closing would make that a second trip.
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        disabled={isPending || isStarting}
        data-testid="composer-model-chip"
        title={
          activeProfileModel
            ? `${activeProfileModel} · ${activeStop.chipLabel}`
            : undefined
        }
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1 border border-[#4B505F] rounded-[100px]",
          "pl-2 pr-1 max-w-[240px] transition-opacity cursor-pointer",
          "hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        <CircuitIcon
          width={16}
          height={16}
          color="#ffffff"
          className="shrink-0"
        />
        <span className="text-white text-2.75 not-italic font-normal leading-5 truncate">
          {activeProfileName ?? t(I18nKey.LLM$SELECT_MODEL_PLACEHOLDER)}
        </span>

        {/*
         * The effort dot rides on the model pill rather than standing alone,
         * which is the whole point of merging them — and it dims when the
         * active model has no reasoning_effort, so the state is legible
         * without opening anything.
         */}
        <span
          aria-hidden
          data-testid="composer-effort-dot"
          className={cn(
            "inline-block w-2 h-2 rounded-full shrink-0 ml-0.5",
            "bg-gradient-to-r from-[#8B5CF6] to-[#22D3EE]",
            effortSupported
              ? "shadow-[0_0_6px_rgba(139,92,246,0.6)]"
              : "opacity-40",
          )}
        />
        <ChevronDownSmallIcon
          width={20}
          height={20}
          color="#ffffff"
          className="shrink-0"
        />
      </button>

      {open && (
        <div
          ref={popoverRef}
          data-testid="composer-model-popover"
          className={cn(
            "absolute z-40 bottom-full mb-2 left-0",
            "min-w-[320px] max-w-[360px]",
            "rounded-xl border border-[#1E2233] bg-[#05070E]/95 backdrop-blur",
            "shadow-[0_20px_60px_rgba(0,0,0,0.55)] overflow-hidden",
          )}
        >
          <div className="px-4 pt-3 pb-1.5 flex items-baseline justify-between">
            <div
              className="text-white text-sm font-semibold tracking-tight"
              style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}
            >
              {t(I18nKey.SCHEMA$LLM$MODEL$LABEL)}
            </div>
            {activeProfileModel && (
              <div
                className="text-[10px] text-[#8D93A6] truncate max-w-[170px]"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
                title={activeProfileModel}
              >
                {activeProfileModel}
              </div>
            )}
          </div>

          <ul className="max-h-[280px] overflow-y-auto pb-1" role="menu">
            {grouped.map(([provider, models]) => (
              <li key={provider}>
                <div
                  className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-[0.14em] text-white/40 font-semibold"
                  style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}
                >
                  {provider}
                </div>
                <ul>
                  {models.map((model) => {
                    const isActive = model.name === activeProfileName;
                    return (
                      <li key={model.name}>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleSelect(model.name);
                          }}
                          disabled={isPending || isStarting}
                          data-testid={`composer-model-option-${model.name}`}
                          aria-current={isActive ? "true" : undefined}
                          className={cn(
                            "w-full flex items-center gap-2 px-4 py-2 text-left transition-colors",
                            "disabled:opacity-50 disabled:cursor-not-allowed",
                            isActive
                              ? "bg-[#8B5CF6]/12 text-white"
                              : "text-white/85 hover:bg-white/[0.04]",
                          )}
                        >
                          <span className="text-[13px] font-medium leading-none flex-1 truncate">
                            {model.name}
                          </span>
                          {isActive && (
                            <span
                              aria-hidden
                              className="w-1.5 h-1.5 rounded-full bg-[#22D3EE] shrink-0"
                            />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>

          <div className="border-t border-[#1E2233] p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <div
                className="text-white text-sm font-semibold tracking-tight"
                style={{ fontFamily: "'Space Grotesk', Inter, sans-serif" }}
              >
                {t(I18nKey.SCHEMA$LLM$REASONING_EFFORT$LABEL)}
              </div>
              {/* Built from the stops themselves rather than written out, so it
                  stays true if the scale ever gains or loses a step — and so
                  there is no untranslated English baked into the chrome. */}
              <div
                className="text-[10px] text-[#8D93A6] uppercase tracking-widest"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                {`${EFFORT_STOPS[0].chipLabel} ↔ ${EFFORT_STOPS[EFFORT_STOPS.length - 1].chipLabel}`}
              </div>
            </div>
            <div className="mb-3 text-[11px] text-[#8D93A6]">
              {activeStop.description}
            </div>

            <EffortSlider />

            {!effortSupported && conversationModel && (
              <div
                className="mt-3 flex items-start gap-2 rounded-lg border border-[#2A2130] bg-[#1C1420]/60 px-2.5 py-2"
                data-testid="effort-not-supported-hint"
              >
                <div className="mt-[3px] w-1.5 h-1.5 rounded-full bg-[#F59E0B] shrink-0" />
                <div className="text-[11px] leading-snug text-[#C8A264]">
                  {t(I18nKey.NIMBUS$EFFORT_NOT_SUPPORTED_FOR_MODEL, {
                    model: conversationModel,
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
