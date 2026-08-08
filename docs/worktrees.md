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
