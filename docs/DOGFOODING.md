# Dogfooding: BLUSWAN working on BLUSWAN

The purpose is to find friction that fixtures hide — long file paths, a real test suite, real git history — **without risking the checkout
you develop in**. The procedure is automated and has a deterministic, offline form that is part of `npm test`.

## Rules

- The agent works in a **disposable git worktree** (detached HEAD under the OS temp directory) of the current commit. It never touches the
  checkout you run the command from; the report states, and a test verifies, that HEAD, branches and working-tree status are unchanged afterwards.
- Uncommitted work in your checkout is **not** in the worktree (it is a copy of the last commit). Commit or stash what you want included.
- A defect is seeded and committed on top, so the agent's diff is exactly its own change.
- The worktree contains tracked files only: no `.env`, no provider keys, no `node_modules`.
- Nothing is pushed, fetched or merged. Review a kept worktree (`--keep`) by hand; copy a change back deliberately if you want it.
- Validation inside the worktree is disabled for the run: a full `npm test` there would run this suite recursively. The task's objective check is a focused test file.

## Run it

```bash
npm run dogfood                          # scripted reference model: deterministic, offline, free — verifies the procedure
npm run dogfood -- --provider deepseek   # a real model (needs DEEPSEEK_API_KEY + DEEPSEEK_MODEL; billable)
npm run dogfood -- --keep                # keep the worktree so you can inspect `git diff`
npm run dogfood -- --json
```

Exit code 0 = objective check passed **and** the primary checkout is untouched; 1 = failed; 2 = not run (no credentials).

## Tasks

| id | Seeded defect | Objective check |
|---|---|---|
| `fix-backoff-schedule` | `backoffDelay` in `src/client/runtime/connectivity.js` indexes the schedule one step ahead (first retry 1 s instead of 0.5 s) | `node --test src/client/runtime/connection.test.mjs` passes (the test is not edited) |

Add tasks in `src/eval/dogfood.js` (`seed`, `prompt`, `expectedFiles`, `check`, `reference`). The same harness metrics as `npm run eval` apply: raw
numbers, no ranking, a model that changes nothing fails regardless of what it says.

## Evaluation tasks on the repository

`npm run eval` keeps using small fixture repositories so provider baselines are comparable over time. The dogfood task is the repository-scale
counterpart; record its raw row next to the provider baselines rather than folding it into a score.

## Run log

Recorded on the Phase 10 branch (scripted reference model — see the limits below):

```text
Dogfood: fix-backoff-schedule — Repair a seeded defect in BLUSWAN's reconnect backoff
  model: scripted/reference
  outcome: SUCCESS (session completed; objective check passed)
  files changed: src/client/runtime/connectivity.js
  turns 4 · tool calls 3 · tokens 60 · 1.5s
  primary checkout untouched: yes · pushed: no · worktree removed
  src/client/runtime/connectivity.js | 2 +-
   1 file changed, 1 insertion(+), 1 deletion(-)
```

### What this does and does not show

- **Shows**: the real runtime, tools, patch engine, shell runner and git integration operate correctly on BLUSWAN's own repository layout; the
  worktree isolation and the "primary checkout untouched" guarantee hold; a no-op model fails the check.
- **Does not show**: how well any real model performs on this task. Live results require provider credentials; in the Phase 10 environment
  none were available, so the **live dogfood run is NOT RUN**. Run `npm run dogfood -- --provider <id>` with your own key and record the row here.

| Date | Model | Outcome | Files changed | Turns | Notes |
|---|---|---|---|---|---|
| Phase 10 | scripted/reference | success | `src/client/runtime/connectivity.js` | 4 | procedure verification (offline) |
| — | _live model_ | NOT RUN | — | — | no provider credentials in the build environment |
