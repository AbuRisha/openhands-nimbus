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

`node_modules` and `.venv` are Windows junctions to the main tree rather than
copies: 745MB each otherwise, and all lanes share a lockfile. If a lane changes
`package.json`, that lane needs a real `npm ci` instead.

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
- **Commit WIP early.** Untracked files have no safety net at all: pre-commit
  does not stash them, so they never enter its patch files. A 12KB test file was
  lost exactly this way while five tracked files beside it survived.

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
