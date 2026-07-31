# Decision: Retire LibreChat `MidGenModelSwitch` — superseded by OpenHands profile switcher

**Date:** 2026-07-31
**Status:** Accepted
**Context:** POST-cutover sweep (loose-ends task #36). LibreChat-nimbus is being
retired; before it can be archived, its unported `MidGenModelSwitch` feature must
be either ported or consciously retired with a record.

## Summary

The LibreChat mid-generation model switcher
(`client/src/components/Chat/MidGenModelSwitch.tsx`) is **retired**, not ported.
Its capability is already superseded by two switchers that ship in
openhands-nimbus and are mounted in the chat composer
(`components/features/chat/components/chat-input-actions.tsx`):

- **`SwitchProfileButton`** — standard Nimbus chat lane (`agent_kind !== "acp"`).
  Switches the conversation's LLM profile via
  `POST /api/v1/app-conversations/{id}/switch_profile`.
- **`SwitchAcpModelButton`** — coding-agent CLI lane (`agent_kind === "acp"`).
  Switches the sub-agent model via `/switch_acp_model`.

## Behavioral diff

| Behavior | LibreChat `MidGenModelSwitch` | OpenHands `SwitchProfileButton` | Verdict |
|---|---|---|---|
| When visible | Only during `isSubmitting` | Always in composer | OpenHands broader |
| Model source | Hardcoded `QUICK_MODELS` (4 ids) | Live LLM profiles | OpenHands live, no rot |
| Switch persistence | Client-side `setOption('model')` (next reply only) | Persisted to backend conversation | OpenHands durable |
| Inline record | None | Switch logged + anchored to chat event (`/model` UX) | OpenHands richer |
| ACP coding agents | Not handled | `SwitchAcpModelButton` | OpenHands covers |
| e2e coverage | `model-switching.spec.ts` (generic endpoint streaming) | Own switch tests | Covered |

The LibreChat component's only unique trait is the "quick-pill" affordance shown
during generation. It depends on a **hardcoded** model list
(`anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-5`,
`openai/gpt-5.4-mini`, `deepseek/deepseek-v4-pro`) that drifts out of sync with
the live SpiderSense roster — the exact anti-pattern the roster-driven
switcher avoids.

## Known gap (tracked separately, not a blocker for retirement)

`SwitchProfileButton` lists only the **profiles a user has created**. A
zero-profile customer sees no switcher, and the switch endpoint takes a profile
*name*, not a raw model id. Exposing the full healthy SpiderSense roster
mid-conversation is being handled on the backend (seed one profile per healthy
roster model) so the existing UI lights up automatically — no frontend change
required for the happy path. Tracked with the wallet/inventory work, not here.

## If the "quick-pills during generation" UX is wanted later

Re-introduce it as a thin layer over the existing switch plumbing, sourcing its
pill list from the live roster/profiles (never a hardcoded array), and calling
the same `switch_profile` mutation. This is an optional enhancement, not a
prerequisite for archiving LibreChat-nimbus.

## Consequence

LibreChat-nimbus has no remaining unported feature blocking archival on the
MidGen axis. Archival remains gated only on the preservation checkpoint
(final tag + git bundle + branch-only-commit preservation) owned separately.
