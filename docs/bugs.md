# Bugs — open and recently fixed

Newest first. A bug leaves this file only when something proves it is gone,
not when it stops being reproduced.

## 2026-08-08 — conversation-panel "should render the conversations" flakes under full-suite load

NOT A REAL FAILURE, and not the i18n merge. Symptom: `findAllByTestId(
"conversation-card")` times out in `__tests__/components/features/
conversation-panel/conversation-panel.test.tsx` during `vitest run` with no
filter. The SAME FILE ON THE SAME TREE passes 22/22 when run alone.

The variable is machine load, not code. The failing run reported 2381s of
environment time against 293s wall clock — several sessions were building
concurrently. `findAllByTestId` waits 1000ms by default, and that is what
expires.

How to check it is still this and not something real: run the file alone. If
it passes alone and fails in the suite, it is this. If it fails alone, it is
not — start looking at the conversation-service mocks.

Worth raising the timeout on that assertion if it keeps costing people time,
but a bare timeout bump hides real regressions too, so it is left alone.
