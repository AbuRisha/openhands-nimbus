# The frontend suite is not a single-run gate

**Read this before quoting a test result.** Running `npx vitest run` once and
reporting the number it prints will, roughly two times in three, report failures
that are not real.

## The measurement

Four full runs of the frontend suite at the same commit, no source changes
between them:

| Run | Workers | Result | Failing files |
|-----|---------|--------|---------------|
| 1 | default (20) | **2702 passed, 0 failed** | — |
| 2 | default (20) | 2696 passed, **6 failed** | agent-settings, app-settings, git-settings, llm-settings, conversation-panel, sdk-section-page |
| 3 | default (20) | 2695 passed, **7 failed** | marketplace-modal, agent-settings, secrets-settings |
| 4 | `--maxWorkers=2` | **2702 passed, 0 failed** | — |

Identical code, three different answers on the default settings. The failing
sets barely overlap — only `agent-settings` appears twice — so this is
nondeterminism, not a stable ordering bug.

## What it is not

**It is not slowness.** The obvious reading is "loaded machine, 5s default
timeout, tests need longer". That was tested directly by raising `testTimeout`
and `hookTimeout` to 15000. Four tests then failed with
`Test timed out in 15000ms` — tripling the budget rescued none of them. A merely
slow test passes with 3x the time. These are not finishing at all.

The change was reverted, because it was made on that hypothesis and the
hypothesis is dead. Raising the limit would only have made failing runs slower.

**It is not a broken assertion.** `conversation-panel` failing to find
`conversation-card` rendered `CONVERSATION$NO_CONVERSATIONS` — the EMPTY state.
So the fetch resolved and returned nothing, meaning the spy that should have
supplied conversations was not in effect. The test is not wrong about what it
expects; the environment it expected was not there.

## What the evidence supports

Contention between workers, on a 20-core machine running 20 of them plus other
sessions and builds. The per-phase totals (summed across workers) show it:

    uncapped:  environment 1937.67s   import 1064.48s   setup 819.15s
    capped(2): environment  352.44s   import  201.65s   setup 164.33s

Five times the environment-setup work for the same 316 files. The workers spend
their time fighting each other to stand up jsdom, and something in that
contention leaves module mocks unapplied rather than merely late.

Capping to 2 workers costs about 1.8x wall clock — ~500s against ~265-305s —
and returns a result that means something.

## How to get a trustworthy answer

    npx vitest run --maxWorkers=2

Or, for a targeted change, run the affected files alone; every file that fails
in a full run passes on its own.

**This is not committed as the default.** Two capped runs went green against one
of three uncapped, which is enough to act on and not enough to call proven.
Intermediate values (4, 6, 8) are untested — there may be a setting that keeps
the reliability at less than 1.8x. Whoever needs the speed back should measure
those rather than assume the cap has to be 2.

## The rule this exists to enforce

A single red run is not evidence that a change broke something, and a single
green run is not evidence that it didn't. To judge a change: run before AND
after, capped, and compare — a failure that appears in one run and not the other
is noise until it survives a repeat.

This was written after "2670 pass, 1 fail" was quoted in a handoff as a stable
baseline. It was one sample of a distribution.
