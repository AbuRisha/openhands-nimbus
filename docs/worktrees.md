# One worktree per session

Three sessions were writing to one working tree on 2026-08-07. That produced
four distinct failure modes in a single afternoon, one of which destroyed work
twice. This is the fix.

## Layout

| Path | Branch | Session |
|---|---|---|
| `openhands-nimbus` | `land/auth-gates` | **integration only** — do not develop here |
| `oh-wt-frontend` | `lane/frontend` | chat / transcript / composer |
| `oh-wt-bridge` | `lane/bridge` | browser bridge, pairing, settings panels |
| `oh-wt-backend` | `lane/backend` | app_server, auth, MCP |

Created with `git worktree add -b <lane> <path> land/auth-gates`.

**Why separate branches rather than everyone on `land/auth-gates`:** git refuses
to check out one branch in two worktrees. That constraint is doing you a favour
— it is what makes the indexes independent, which is the whole point.

### Setting up a lane

Run a real `npm ci` in `<worktree>/frontend`. It takes ~20 seconds.

**Do NOT junction `node_modules` from the main tree.** That was the first thing
tried here, to save 745MB per lane, and it is a false economy in both
directions: `npm ci` is fast, and the junction silently breaks TypeScript module
resolution — `tsc` reports `Cannot find type definition file for 'vite/client'`
and `npx` resolves the wrong `tsc` entirely. **Tests still passed through the
junction**, which is what makes it dangerous: it looks like it works right up
until you typecheck.

**RETRACTED: junctions do not manufacture type errors.** This section briefly
claimed they did, on the strength of six `TS2578 unused '@ts-expect-error'`
errors that appeared under a junction and not under a real install. That
comparison was CONFOUNDED — the real-install run happened to have a
`.react-router/` directory from an earlier `npm run typecheck` and the
junctioned run did not. Two variables, one credited. The real cause is below.

**`rm -rf` FOLLOWS a junction and deletes the real target**, and so does
`git worktree remove --force`. Delete the junction FIRST —
`cmd /c rmdir <link>` or `[System.IO.Directory]::Delete($path, $false)` — then
remove the worktree. This fired during a cleanup and was only avoided by
counting entries before and after.

`node_modules` is a symlink farm, so `ls node_modules` returns 0 entries in Git
Bash even when the install is fine. Do not read that as missing — it reads
exactly like a broken install and is not one.

A frontend lane does not need the Python env. The backend pre-commit hook aborts
there (`pre-commit` is not installed in the lane's poetry env), but every one of
its hooks reports "no files to check" for a frontend-only change. Either run
`poetry install` in the lane, or run the frontend gates explicitly —
`npx eslint <files>`, `npm run typecheck`, `npm run check-translation-completeness`
— and commit with `--no-verify`, stating both the reason and the compensation in
the message.

## What this actually fixes

Four failure modes, all observed, all on 2026-08-07:

1. **Shared index.** `git add <my paths>` produced an index containing another
   session's files, because the index is shared state. Caught three times by
   `git diff --cached --name-only`; would otherwise have swept a security fix
   into an unrelated frontend commit.
2. **Hook stashes.** The backend pre-commit stashes unstaged files. With three
   sessions writing, it stashes *their* work too, and a failed restore rolls it
   back.
3. **Hook reads the tree, not the index.** `typecheck:staged` fails on another
   session's half-written file, so your correct commit cannot land.
4. **Rollback drops staged work.** A failed restore reverted a staged change off
   disk entirely. This one is **silent** — the commit simply does not happen and
   the change is gone. The other three announce themselves.

Worktrees remove 1, 2 and 3 outright, and reduce 4 to your own lane.

## Rules that still apply inside a lane

- `git diff --cached --name-only` before every commit. Cheap, and it is what
  caught the shared-index cases.
- Prefer write + `git add` + `git commit` in ONE invocation. Zero window is the
  only window size that is safe if anything else can touch the tree.
- **PUSH, do not just commit.** This is the sharpest lesson of the day and it is
  a correction of an earlier one. The claim here used to be "untracked work has
  no safety net", from a 12KB test file that appeared lost while five tracked
  files beside it survived. That file was NOT lost — it had been committed and
  pushed (`39e78f0b6`), and I had simply not looked for it there. The true
  lesson is stronger: those five files were TRACKED and still vanished from the
  working tree three times. What saved the test file was the commit being
  **pushed**. A local commit lives in a tree something is repeatedly clearing.

- **Before declaring anything lost, look in git.** `git show <ref>:<path>`,
  `git log --all -- <path>`, `git fsck --lost-found`. Absence from the working
  tree is not absence.

## Merging back

Lanes merge into `land/auth-gates`, which is the PR branch. Merge from the lane,
do not develop in the integration tree.

```
git -C openhands-nimbus merge --no-ff lane/frontend
```

## If work disappears anyway

pre-commit writes its stash to a patch file and **retains it on failure**:

```
ls -t "$LOCALAPPDATA/../.cache/pre-commit/" | grep patch | head
git apply --check --include='<paths>' <patch>
git apply         --include='<paths>' <patch>
```

Recover with a path filter, then **enumerate every path in the patch and report
the ones you did not restore**. A filtered recovery silently defines everyone
outside the filter as not-your-problem, and in a shared tree that set is not
empty — this is how a staged one-line change was lost while five files beside it
were recovered byte-exact.

Verify recovery with byte sizes and grep markers recorded *before* the loss, not
by eye.

## Worktrees share ONE `.git` — remote refs move under you mid-session

`origin/<branch>` is stored once, in the common git dir, so a `git fetch` in ANY
worktree — or another session pushing — updates it for all of them. Two
`git diff origin/land/auth-gates` calls in the same session are not necessarily
against the same commit.

That misattributed a fix to the wrong PR: a diff taken before and after a push
showed `use-websocket.ts` in the second, and the change was credited to a PR
that never touched it.

**Resolve to an explicit sha before any comparison that matters:**

    BASE=$(git rev-parse origin/land/auth-gates)
    git diff --stat "$BASE" HEAD     # stable
    git diff --stat origin/land/auth-gates HEAD   # can move between two runs

## Git cannot tell you WHICH SESSION did anything

    git log --format="%an" -20 origin/land/auth-gates | sort -u
    AbuRisha

Every commit, from every concurrent session, carries one identity. So authorship
is not a routing key, and "your commit" / "your deploy" is a guess that will be
wrong at some rate. It was wrong twice in one afternoon: work was attributed to
a session that had run zero `az` commands, and an offer to verify a build was
parked with someone who had no build — which is worse than useless, because the
offering side stands down believing it is owned and the real owner never hears.

**Route by commit hash, never by "yours".**

## State the command, not the value

A shared ref moves. Three different values for `origin/land/auth-gates` were
quoted between sessions inside one conversation, none matching the message that
stated them by the time it was read.

A message saying *"run `git rev-parse origin/land/auth-gates`"* stays true. One
saying *"it is cfab972fd"* is wrong within minutes. Same for ancestry: one
session correctly measured `088fe0f76` as NOT in the tip and drew a load-bearing
conclusion about a dangerous build pairing; by the time it was read, a merge had
landed it and the conclusion had inverted.

Generalised: **anything you learned about shared state is stale by the time you
act on it.** Re-measure at the point of use.

## A completeness claim is only as wide as the space you searched

"All 13 checkouts repaired, 0 pinned remain" was true — of
`.codex/git-migrations/20260719/`. The loop never descended anywhere else, and
26 pinned checkouts sat outside it, including the `bolt-src` clone that
originally motivated the repair. The claim was not a lie about the result; it
was a true statement about a search space that structurally excluded the
counterexample. Same family as an assertion placed where it cannot observe the
defect.

Two ways it hid, both worth knowing:

- `[ -d "$d/.git" ]` is FALSE for a git worktree, where `.git` is a FILE. An
  audit using it silently reports worktrees as "gone".
- A correct refspec is not a populated remote. Several checkouts had
  `+refs/heads/*:refs/remotes/origin/*` and exactly ONE remote-tracking ref,
  because nothing had fetched since the repair. Verify `refs=` too, not just the
  config line.

The repaired set is now verified per checkout rather than by the loop's exit
code: `bolt-src` 3 refs -> 26, `oh-src` 1452, `clawref` 192, `hermes-agent`
1475, and every worktree of those repos inherits it through the shared config.
Vendor clones were deliberately left alone; `ghidra-mcp` is pinned to a TAG
refspec on purpose and rewriting it would be the bug, not the fix.

## Diagnostic traps that produced false findings today

Every one of these made a working thing look broken, or a present thing look
missing. A NEGATIVE result needs the instrument checked before the conclusion.

- **`git diff` silently omits changes another session has STAGED.** Use
  `git diff HEAD`. A working backup taken with plain `git diff` will quietly
  exclude staged work.
- **`grep -c pattern file || echo 0` prints TWO values** when there are no
  matches, because `grep -c` exits 1 on zero. It reads like a garbled count and
  makes intact files look empty.
- **An anchored grep misses indented definitions.** `grep -c "^def test_"`
  returned 0 on a file with 15 tests, because they sit inside a class. The file
  was fine.
- **`ls node_modules` returns 0 entries in Git Bash** on a healthy symlink farm.
- **RUN THE PROJECT'S OWN CHECK, not a bare compiler.** `typecheck` is
  `react-router typegen && tsc`. Bare `tsc` skips the codegen and typechecks
  against route types that may be absent or stale, which emits six
  `TS2578 unused '@ts-expect-error'` errors in test files nobody touched. They
  look exactly like real pre-existing breakage. Controlled experiment, one
  directory, single variable:

        rm -rf .react-router && tsc   ->  6x TS2578
        react-router typegen && tsc   ->  0

  A bare compiler invocation is a DIFFERENT QUESTION from `npm run <script>`
  whenever the script has a codegen step, and the difference is invisible until
  it emits errors that look real. Three sessions read those six errors and the
  first two explanations — "pre-existing on the integration branch" and "a
  junction resolution artifact" — were both wrong.
- **A baseline only isolates the variable you changed if both environments are
  identical AND CORRECT.** Two environments that are identical and both missing
  a codegen step will AGREE, and agreement reads as confirmation. Identical-and-
  both-wrong is worse than a disagreement, because a disagreement makes you
  look.
- **A MISSING junction is indistinguishable from a wiped dependency.** A lane
  checked `.venv/Scripts/python.exe` in its OWN worktree, got a failure, and
  reported the SHARED venv as wiped to two other sessions — telling both their
  backend results were stale. The venv was fine; that lane simply had no
  junction. Check the TARGET, not the link, before concluding anything about a
  shared dependency, and say which directory you checked.
- **A zero-width viewport makes every element "overflow"** — every structural
  measurement taken through it is meaningless, not alarming.
- **Setting `textContent` directly fires no `input` event**, so any probe that
  does it bypasses the semantics it is trying to test.

To answer "did this fail before my change too?" in a contended tree, use a
throwaway `git worktree add --detach <tmp> HEAD` — never `git stash`.
