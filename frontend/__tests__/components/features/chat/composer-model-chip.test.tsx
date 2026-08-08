import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { ComposerModelChip } from "#/components/features/chat/components/composer-model-chip";
import type { LlmProfileSummary } from "#/api/settings-service/profiles-service.api";

/**
 * These cases carry over from SwitchProfileButton, which this replaces.
 *
 * The resolution order they pin is subtle and was learned the hard way: an
 * in-session switch is recorded BY NAME because several catalog entries can
 * share a model string behind the managed proxy, so matching on the model
 * alone resolves to the wrong one.
 *
 * The word "profile" survives only in the data layer. Every customer-facing
 * string here is a MODEL, which is the point of the component.
 */

const mockUseLlmProfiles = vi.hoisted(() => vi.fn());
const mockUseActiveConversation = vi.hoisted(() => vi.fn());
const mockSwitchAndLog = vi.hoisted(() => vi.fn());
const mockConversationId = vi.hoisted(() => ({ value: "conv-1" }));
const mockModelStore = vi.hoisted(() => ({
  activeProfileByConversation: {} as Record<string, string>,
}));

vi.mock("#/hooks/query/use-llm-profiles", () => ({
  useLlmProfiles: () => mockUseLlmProfiles(),
  LLM_PROFILES_QUERY_KEY: "llm-profiles",
}));

vi.mock("#/hooks/query/use-active-conversation", () => ({
  useActiveConversation: () => mockUseActiveConversation(),
}));

vi.mock("#/hooks/mutation/use-switch-llm-profile-and-log", () => ({
  useSwitchLlmProfileAndLog: () => ({
    switchAndLog: mockSwitchAndLog,
    isPending: false,
  }),
}));

vi.mock("#/hooks/use-conversation-id", () => ({
  useConversationId: () => ({ conversationId: mockConversationId.value }),
}));

vi.mock("#/stores/model-store", () => ({
  useModelStore: (
    selector: (s: {
      activeProfileByConversation: Record<string, string>;
    }) => unknown,
  ) => selector(mockModelStore),
}));

// The real slider is exercised by its own tests; here it would only add a
// second copy of the effort store to keep in sync.
vi.mock("#/components/features/chat/effort-slider", () => ({
  EffortSlider: () => <div data-testid="effort-slider" />,
}));

vi.mock("#/stores/effort-store", () => ({
  EFFORT_STOPS: [
    { value: "low", chipLabel: "Faster", description: "Quick answers" },
    { value: "medium", chipLabel: "Balanced", description: "Balanced" },
    { value: "high", chipLabel: "Smarter", description: "Deeper reasoning" },
    { value: "max", chipLabel: "Ultracode", description: "Maximum effort" },
  ],
  useEffortStore: (selector: (s: { effort: string }) => unknown) =>
    selector({ effort: "medium" }),
}));

const PROFILES: LlmProfileSummary[] = [
  {
    name: "Claude Sonnet 4.6",
    model: "anthropic/claude-sonnet-4-6",
    base_url: null,
    api_key_set: true,
  },
  {
    name: "GPT 5",
    model: "openai/gpt-5",
    base_url: null,
    api_key_set: true,
  },
];

const renderChip = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ComposerModelChip />
      </QueryClientProvider>
    </MemoryRouter>,
  );
};

const setupHooks = (
  options: {
    profiles?: LlmProfileSummary[];
    activeProfile?: string | null;
    conversationModel?: string | null;
    agentKind?: "openhands" | "acp";
    switchedProfile?: string;
  } = {},
) => {
  mockUseLlmProfiles.mockReturnValue({
    data: {
      profiles: options.profiles ?? PROFILES,
      active_profile: options.activeProfile ?? null,
    },
  });
  mockUseActiveConversation.mockReturnValue({
    data: {
      llm_model: options.conversationModel ?? null,
      agent_kind: options.agentKind ?? "openhands",
    },
  });
  mockModelStore.activeProfileByConversation = options.switchedProfile
    ? { "conv-1": options.switchedProfile }
    : {};
};

describe("ComposerModelChip", () => {
  beforeEach(() => {
    mockSwitchAndLog.mockReset();
    mockConversationId.value = "conv-1";
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when the catalog is empty", () => {
    setupHooks({ profiles: [] });
    renderChip();
    expect(screen.queryByTestId("composer-model-chip")).toBeNull();
  });

  it("renders nothing for ACP conversations, where SwitchAcpModelButton applies", () => {
    // The sub-agent picks its own model; showing a switch that cannot take
    // effect is worse than showing none.
    setupHooks({ agentKind: "acp" });
    renderChip();
    expect(screen.queryByTestId("composer-model-chip")).toBeNull();
  });

  it("shows the model matching conversation.llm_model", () => {
    setupHooks({ conversationModel: "openai/gpt-5" });
    renderChip();
    expect(screen.getByTestId("composer-model-chip")).toHaveTextContent(
      "GPT 5",
    );
  });

  it("falls back to the placeholder when llm_model matches nothing", () => {
    setupHooks({
      conversationModel: "deleted/orphan-model",
      activeProfile: "Claude Sonnet 4.6",
    });
    renderChip();
    // Must NOT show the user-level default — that would misrepresent the
    // model actually running.
    const chip = screen.getByTestId("composer-model-chip");
    expect(chip).toHaveTextContent("LLM$SELECT_MODEL_PLACEHOLDER");
    expect(chip).not.toHaveTextContent("Claude Sonnet 4.6");
  });

  it("uses the user-level default when the conversation has no model yet", () => {
    setupHooks({ conversationModel: null, activeProfile: "Claude Sonnet 4.6" });
    renderChip();
    expect(screen.getByTestId("composer-model-chip")).toHaveTextContent(
      "Claude Sonnet 4.6",
    );
  });

  it("prefers an in-session switch over the model match, by name", () => {
    setupHooks({
      conversationModel: "openai/gpt-5",
      switchedProfile: "Claude Sonnet 4.6",
    });
    renderChip();
    expect(screen.getByTestId("composer-model-chip")).toHaveTextContent(
      "Claude Sonnet 4.6",
    );
  });

  it("ignores a switched model that no longer exists", () => {
    setupHooks({
      conversationModel: "openai/gpt-5",
      switchedProfile: "Deleted Model",
    });
    renderChip();
    expect(screen.getByTestId("composer-model-chip")).toHaveTextContent(
      "GPT 5",
    );
  });

  it("opens and closes the popover", async () => {
    const user = userEvent.setup();
    setupHooks({ conversationModel: "openai/gpt-5" });
    renderChip();
    const chip = screen.getByTestId("composer-model-chip");

    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("composer-model-popover")).toBeNull();

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("composer-model-popover")).toBeInTheDocument();

    await user.click(chip);
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("switches when a different model is chosen", async () => {
    const user = userEvent.setup();
    setupHooks({ conversationModel: "openai/gpt-5" });
    renderChip();
    await user.click(screen.getByTestId("composer-model-chip"));
    await user.click(
      screen.getByTestId("composer-model-option-Claude Sonnet 4.6"),
    );
    expect(mockSwitchAndLog).toHaveBeenCalledWith(
      "conv-1",
      "Claude Sonnet 4.6",
    );
  });

  it("does not switch when the already-active model is chosen", async () => {
    const user = userEvent.setup();
    setupHooks({ conversationModel: "openai/gpt-5" });
    renderChip();
    await user.click(screen.getByTestId("composer-model-chip"));
    await user.click(screen.getByTestId("composer-model-option-GPT 5"));
    expect(mockSwitchAndLog).not.toHaveBeenCalled();
  });

  it("is disabled while the conversation id is still the `task-` placeholder", () => {
    mockConversationId.value = "task-abc-123";
    setupHooks({ conversationModel: "openai/gpt-5" });
    renderChip();
    expect(screen.getByTestId("composer-model-chip")).toBeDisabled();
  });

  it("groups models by provider rather than listing 29 flat rows", async () => {
    const user = userEvent.setup();
    setupHooks({ conversationModel: "openai/gpt-5" });
    renderChip();
    await user.click(screen.getByTestId("composer-model-chip"));

    const popover = screen.getByTestId("composer-model-popover");
    expect(popover).toHaveTextContent("Anthropic");
    // "OpenAI", not "Openai". Title-casing the prefix is not enough and looks
    // unfinished exactly where someone is choosing what to pay for.
    expect(popover).toHaveTextContent("OpenAI");
  });

  it("carries the effort control in the same popover as the model", async () => {
    // Effort is a property OF the model, so splitting them put the reason a
    // setting is inert in a different popover from its cause.
    const user = userEvent.setup();
    setupHooks({ conversationModel: "openai/gpt-5" });
    renderChip();
    await user.click(screen.getByTestId("composer-model-chip"));

    expect(screen.getByTestId("effort-slider")).toBeInTheDocument();
  });

  it("never says 'profile' anywhere the customer can read it", async () => {
    // "LLM profile" is OpenHands vocabulary; the catalog entry IS the model.
    const user = userEvent.setup();
    setupHooks({ conversationModel: "openai/gpt-5" });
    renderChip();
    await user.click(screen.getByTestId("composer-model-chip"));

    expect(
      screen.getByTestId("composer-model-popover").textContent,
    ).not.toMatch(/profile/i);
  });
});
