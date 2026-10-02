# BLUSWAN

A chat-first coding agent. The user describes a coding task in natural language; the agent runtime works against a repository through tools and continues naturally from follow-up messages in the same session.

> **Status:** Phase 7 (review workspace). On top of the Phase 6 chat, a right-hand panel (a sheet on mobile) shows what BLUSWAN changed — git-backed changed files with exact line counts, per-file unified diffs, command output, validation details — and lets you revert a single file after confirmation. DeepSeek is still the **only** production provider. Persistence (reloading loses conversations), a commit/push workflow, an interactive terminal and additional providers are not implemented yet.

## Architecture

```text
user message
  → agent runtime ──► provider adapter (DeepSeek) ──► streamed text + normalized tool calls
        ▲                                                       │
        │ normalized tool results (role: tool)                  ▼
        └──────────── tool executor → tool registry → workspace (files · search · shell · git)
  → final assistant response (a response with no tool calls is a completion candidate; see Validation and completion)
```

| Layer | Path | Responsibility |
|---|---|---|
| Protocol | `src/protocol/` | Canonical event types, message/session/error schemas |
| Sessions | `src/sessions/` | Session manager (live state, subscribers) and a pluggable store (in-memory today) |
| Providers | `src/providers/` | One normalized adapter interface, registry, neutral stream events; `deepseek.js` is the initial adapter |
| Context | `src/context/` | Context engine: token budget, session summary, tool-observation compaction, repository/workspace context, relevance |
| Validation | `src/validation/` | Project detection, safe command discovery, change-aware policy, runners, result parsing, failure classification, validation state |
| Agent | `src/agent/` | Provider-neutral runtime, agent state, stop conditions, canonical system prompt |
| Workspace | `src/workspace/` | `Workspace` contract, `LocalWorkspace`, workspace manager, path safety, file index, search, patch engine, shell runner, git |
| Tools | `src/tools/` | Provider-neutral tool registry, executor, permission classifier, normalized results; definitions in `src/tools/definitions/` |
| Client | `src/client/` | React surface: renders session state and forwards user intent |
| Config | `src/config/runtimeConfig.js` | Provider, model, limits, timeouts, logging; secrets come from the environment |

**Runtime/client separation.** React renders sessions, messages and runtime events and submits user messages. It does not call providers, run tools, parse provider responses or decide task completion; the runtime owns all of that and is usable without React.

**Provider abstraction.** Provider-specific behavior (endpoints, auth, streaming format, tool schemas, error mapping) lives only in adapters. Adapters expose capabilities and emit provider-neutral events (`text_delta`, `reasoning_status`, `tool_call`, `usage`, `completed`); failures are normalized to `{ code, message, provider, retryable, cause }`.

**Sessions.** A session holds normalized messages, events, tool calls, changed files, status, and token usage. Statuses: `idle`, `running`, `waiting_permission`, `waiting_user`, `completed`, `error`, `cancelled`. Cancellation propagates through an `AbortController` to the provider request.

## Review workspace (Phase 7)

`src/client/workspace/` renders the review surface; the runtime owns the data.

- **Source of truth:** `runtime.getWorkspaceState(sessionId)` reads `git status` + `git diff --numstat HEAD` (rename-aware; untracked files counted directly) and returns kinds (modified / added / untracked / deleted / renamed), per-file and total `+/−`, branch and a `revision` that advances on any mutation. Outside Git it falls back to the files the session changed and says so ("Session-tracked"); diffs and revert then need Git, and the panel shows current file contents instead.
- **Diffs:** `runtime.getFileDiff(sessionId, path)` returns the unified diff of one file against `HEAD` (staged + unstaged). Diffs are fetched only for the selected file, parsed into files → hunks → typed lines (`parseDiff`), cached per workspace revision, and rendered progressively (800 lines at a time). Binary files, truncated diffs, empty diffs and load errors have explicit states.
- **Refresh:** the client store refreshes through one debounced path on `file.changed`, `file.reverted`, `validation.completed`, `session.completed/cancelled/failed` and shell completion, and when the window regains focus. Git state wins over the optimistic activity feed.
- **Commands:** the runtime keeps a bounded, secret-redacted log of shell and validation commands (`listCommands`, `getCommand`): exit code, duration, stdout/stderr, timeout/cancel, truncation. The UI strips terminal escape sequences and renders output as plain text; it is read-only inspection, not a terminal.
- **Validation:** only checks that ran are shown; a result from before the latest change reads **Stale**, never Passed. Diagnostics link to changed files when locations are known.
- **Revert (user-driven only):** `runtime.revertFile(sessionId, path)` after an explicit confirmation. It restores the file from `HEAD` (index and working tree); a file that is new or untracked is removed. It never resets, cleans, or touches other files, is refused while a run is active, and is not available to the model. It updates `session.changedFiles`, marks validation stale, invalidates context/summary state and emits `file.reverted`.
- **Layout:** desktop shows sessions · conversation · resizable, collapsible workspace panel (Ctrl/Cmd+Shift+D; closed until opened, width and open state persist locally). Below 900px the panel becomes a sheet reached from a "N files changed" chip, with list → diff drill-down; Escape closes it and focus returns to the opener. Activity rows link to the diff, command output or validation details using `file.changed` metadata and tool-call ids.

Limitations: the panel shows the repository's git state, which includes changes made outside the session (marked "earlier" when they predate it); no commit/push/branch UI, no editor, no interactive terminal.

## Chat UX and permissions (Phase 6)

`src/client/` is organized as `sessions/` (sidebar), `chat/` (transcript, safe Markdown, composer), `activity/` (event projection, tool labels, validation rows), `permissions/`, `status/`, `settings/`, `state/` (framework-free client store) and `shared/`.

- **Data flow:** runtime events → `createProjector()` (incremental, no timers; one row per tool call, one assistant message per stream) → `createClientStore()` snapshot → React via `useSyncExternalStore`. The UI never calls providers or tools; it calls runtime actions (`sendMessage`, `cancelSession`, `approvePermission`, `denyPermission`, `deleteSession`).
- **Sessions:** new chat, switching (a running session keeps working in the background), delete with confirmation (running sessions are stopped first; repository files are never touched). Titles come from the first message without a model call.
- **Stop:** invokes real runtime cancellation (provider stream, running shell process group, pending approvals); applied file changes are kept.
- **Markdown:** own parser, no raw HTML, only `http(s)`/`mailto` links, code blocks with copy.

| Mode | read | workspace write | destructive | dependency change | external effect | prohibited |
|---|---|---|---|---|---|---|
| Ask | allow | ask | ask | ask | ask | blocked |
| Auto Edit (default) | allow | allow | ask | ask | ask | blocked |
| Full Auto | allow | allow | allow | allow | ask | blocked |

Pending approvals are real: the runtime emits `permission.requested`, the session status becomes `waiting_permission`, and the loop resumes only after "Allow once" (or continues with the denial returned to the model after "Deny"). Prohibited commands never prompt and are shown as "blocked by workspace safety policy". Headless runs (CLI, tests) use `approvals: 'unattended'` and return `permission_required` instead of waiting.

Known limitations: a browser cannot open local folders, so repository tools in the web app need a host that supplies a workspace manager (none is included yet; use `npm run agent -- --workspace <dir>` for repository work). The API key is stored in browser `localStorage`; do not ship a shared key in a production bundle.

## Validation and completion (Phase 5)

There is still one agent, one tool loop and one workspace. Validation is a capability inside that loop, not a workflow phase: the runtime supplies **evidence**; the model decides how to fix things.

```text
model returns a final answer (no tool calls)
        │
        ▼
completion check ── nothing changed / docs only / user declined / nothing available ──► finish (reason recorded)
        │ code changed and validation is stale or missing
        ▼
validation policy ─► focused tests → typecheck → lint → (broader tests) → build   (stops at the first failure)
        │
        ├─ pass ──► model sees COMPLETION EVIDENCE (checks, changed files, git summary) → grounded final answer
        └─ fail ──► model sees classified diagnostics → repairs → edit makes evidence stale → checks run again
```

**Project detection** (`src/validation/projectDetector.js`): Node (npm, pnpm, yarn, bun from lockfiles or the `packageManager` field; conflicting lockfiles resolve pnpm > yarn > bun > npm and are reported; npm is the documented fallback), TypeScript, Python (pip/poetry/pipenv/uv, pytest), Rust (cargo), Go. The descriptor is plain serializable data.

**Command discovery** (`commandDiscovery.js`): explicit project scripts (`test`, `lint`, `typecheck`, `build`, `test:unit`, …) outrank well-known ecosystem defaults; nothing is invented for missing scripts. Script *names are never trusted*: each script body, the scripts it calls, and npm `pre`/`post` hooks go through the shell command classifier, and anything that is not read/workspace-only (publishing, `git push`, `curl | sh`, installs, deletion) is marked unsafe and never auto-run.

**Policy** (`changedFileStrategy.js`): changes are classified (source, test, config, dependency, style, docs). Related tests are found by naming convention (`src/auth.js` → `tests/auth.test.js`, `*.spec.ts`, `test_auth.py`, `auth_test.go`, …) and run as a focused check; significant changes (config, dependencies, several modules) add the full suite; build runs for production-code or config changes; CSS-only changes skip tests; test-only changes run just those tests; docs-only changes run nothing. Every decision carries a reason (`debugValidation(sessionId)` shows it). A check the agent already ran itself through `shell` counts as evidence and is not repeated.

**Evidence and staleness** (`validationState.js`, `session.validation`): every result is stamped with a mutation counter. Any successful code/config mutation makes earlier results stale (documentation does not); a passing result is never accepted as proof about code edited afterwards. Unresolved failures persist until the same command passes. The validation state and unresolved failures are included at high priority in the context engine; old validation logs are compacted like any other tool result.

**Failures** (`resultParser.js`, `failureClassifier.js`): output is parsed for node:test/TAP, jest/vitest, pytest, cargo, go, ESLint, TypeScript and build errors, then classified as `test_failure`, `lint_failure`, `type_error`, `build_failure`, `dependency_missing`, `command_not_found`, `configuration_error`, `timeout`, `runtime_crash`, `environment_error` or `unknown`, with key messages and file:line locations. Missing tooling yields status `unavailable`, not a failure to repair. Output is bounded (beginning and end are kept).

**Limits and recovery** (`src/agent/recovery.js`): at most `maxAutomaticValidationRounds` (3) validation rounds and `maxRecoveryRounds` (3) repair rounds per user request. A failing check is not rerun on unchanged code; failures that no edit can fix (missing dependency, environment) stop automatic continuation. When the limit is reached the model receives the failing evidence ("Automatic validation will not continue") and answers honestly; the run outcome is `failed` and the failure stays unresolved in the session. Per-check timeouts (`defaultTestTimeoutMs` 60 s focused / `broadTestTimeoutMs` 180 s, lint, typecheck, build) and session cancellation terminate the check's process tree; a cancelled check never triggers recovery.

**Outcomes.** Each user request is a run (`session.runs[]`): `success`, `warning` (e.g. an unsupported claim was made), `failed` (unresolved validation failure) or `cancelled`, with metrics (`validationCommandsRun`, passes/failures, `recoveryRounds`, `firstPassSuccess`, `repairSuccess`, `staleValidationPrevented`, `finalValidationStatus`). The reusable `session.status` stays `completed` after a failed run so the conversation can continue. A narrow deterministic check flags explicit claims (“tests pass”, “build succeeds”, …) that the evidence does not support (`completion.warning`); the response is never rewritten and no second model is consulted.

**Safety.** Validation is observational: it never runs fixers (`--fix`, `--write`), never installs dependencies (including when something is missing), and never mutates git; git is read only to report status and diff statistics. "Do not run tests" in the user's message is honored and recorded as `skipped`. Settings (`enableAutomaticValidation`, `enableBroadValidation`, limits, timeouts, `maxValidationOutputBytes`) live in `src/config/runtimeConfig.js`.

Known limitation: file changes made indirectly by a shell command (not through `apply_patch`/`write_file`/`delete_file`) are not tracked as mutations.

## Context engine (Phase 4)

**Full session state is stored separately from the bounded provider working context.** `session.messages` is the complete, canonical record and is never trimmed to fit a model. Before each provider turn the runtime asks the context engine for a derived view (`src/context/`); nothing else builds provider messages, and the engine contains no provider-specific logic (the model's window and output limit come from adapter capabilities).

```text
session + workspace + tool state ─► context engine ─► { messages, tools } ─► provider adapter
                                         │
   system instructions · workspace · session summary · repository · conversation (incl. tool observations)
                                         │
                       token budget → compact if projected input > threshold → verify → build
```

**Sections and priorities.** `critical`: system instructions and the current user request (never altered or dropped — if they cannot fit, the run fails with `context_budget_exceeded`). `high`: the session summary (goal, objective, decisions, changed files, unresolved issues, validation) and the active tool cycle. `medium`: recent conversation, workspace metadata, repository context. `low`: older narration, stale tool outputs, old exchanges. Every included item carries `{section, type, source, priority, estimatedTokens}`; `runtime.debugContext(sessionId)` returns that metadata plus omitted items and per-section token counts (no message bodies, so no secrets).

**Token budgeting.** `usable input = context window − reserved output − safety margin − tool schemas`, all from model capabilities and `runtimeConfig.js` (`contextSafetyMarginTokens`, `compactionThresholdRatio` 0.78, `compactionTargetRatio` 0.6, …). One replaceable estimator (`tokenEstimator.js`, conservative ~3.6 chars/token) is used everywhere; tool schemas are budgeted with extra headroom. Compaction runs *before* the request when the projected input exceeds the threshold, and aims for the lower target so it does not re-run every turn.

**Progressive compaction** (each step only if still over target): strip old tool-call narration → replace old tool results (and large arguments of old tool calls) with compact observations → fold the oldest *complete* exchanges into the summary → shrink repository context → shrink the summary to its core → keep only the active tool result in full → drop middle cycles of the current exchange. Tool call/result pairs are atomic and every output is re-validated (`context_invalid_history`); the active cycle and the current request are pinned. Reads that a later edit made obsolete are replaced by a "superseded" note. Folding is persisted as `summary.lastCompactedMessageId` + `revision`, so history is summarized incrementally and never re-summarized from scratch. Compaction announces itself with a metadata-only `context.compacted` event; nothing is added to the visible chat.

**Structured session summary** (`session.contextSummary`, plain JSON): `goal`, `currentObjective`, `decisions` (standing constraints extracted from user messages; later entries override earlier ones), `filesInspected` (merged line ranges, redundant-reread counts), `filesChanged` (with whether validated since), `commandsRun`, `validations`, `unresolvedIssues` (a failing validation stays until the same command passes), `errorsEncountered`, `importantFacts`, `revision`. It is updated deterministically from tool results as they arrive. Optionally (`summarizeWithModel`, off by default) the session's own provider is asked, through a tiny separate prompt with no tools, to add decisions/facts when history is folded; failure falls back to deterministic compaction. Hidden model reasoning is never stored in the summary.

**Repository context.** Bounded and workspace-scoped: a compact top-level tree and conventions (language, frameworks, test tool, source/test dirs), the first of `AGENTS.md`/`CONTRIBUTING.md` (clipped), and the top *relevant* files chosen by a deterministic scorer (`relevance.js`: changed, recently read, search hits, named in the request, path-term and symbol matches, import proximity — each with reasons). File summaries (symbols, imports, content hash) are cached per workspace and invalidated when tools modify a file or its mtime/size changes. `.env*`, credentials/keys, binary files and generated directories (`node_modules`, `.git`, `dist`, `build`, `coverage`, `.cache`, `vendor`) are never injected automatically. There are no embeddings, vector stores or memory graphs.

**Failure.** If even the pinned context cannot fit, the run fails before any request with `context_budget_exceeded` ("The current session exceeds the model's usable context capacity and could not be compacted safely…"); the session stays intact.

## Agent loop (Phase 3)

`src/agent/runtime.js` owns the one canonical loop. React, the provider adapter and the workspace each own only their own concern.

```text
sendMessage(sessionId, text)
  validate (provider, model, credentials, workspace) — before any network request
  repeat:
    stop check            cancelled · max turns · no progress
    provider turn         stream one response → text deltas, tool calls, usage        (retry only if nothing was shown)
    commit                assistant message {content, toolCalls}; trace + usage
    no tool calls?        → completion check (Phase 5): validate if warranted, else status completed, session.completed
    execute tool calls    read-only calls run concurrently, everything else in emitted order
    append tool results   one `tool` message per call; loop guard; next turn
```

**Turn.** One provider response is one turn, together with the tool calls it requested and their results. `maxTurns` (default 25) applies per run; exceeding it stops the run with a grounded assistant notice and a `max_turns` error, keeping all work done so far.

**Lifecycle.** The run lifecycle is `idle → running → completed | cancelled | error`; the conversation is separate and always continues: every one of those end states accepts the next user message in the same session, with the same workspace, messages, tool history and file changes. A second `sendMessage` while a run is active is rejected with a normalized `session_busy` error. A new conversation is a new session (fresh messages, turns and counters).

**Messages.** The canonical history holds `user`, `assistant` (`content` + `toolCalls: [{id, name, input}]`, plus provider reasoning kept only for continuation and never rendered) and `tool` (`toolCallId`, `name`, deterministic plain-text `content`) messages. Tool results are serialized as `Tool / Status / …` text (read_file shows the content, shell shows `Exit code`, STDOUT, STDERR; bounded by the Phase 2 limits plus a final `maxToolResultChars` cap). Each response's text and tool calls are committed together, before any tool runs, and every tool call always receives a result (including skipped or cancelled ones) so the history stays valid for the provider.

**Tool errors are observations.** Unknown tools (`unknown_tool`), malformed or invalid arguments (`invalid_input`), missing files and refused commands (`permission_required`, `permission_denied`) are returned to the model, which can correct itself. A shell command that exits non-zero is a successful tool call whose result shows the exit code. Only infrastructure failures end a run. Commands classified `dependency_change`, `external_effect` or `destructive` are not executed without approval (no approval UI yet); there is no commit, push or PR tooling.

**Safety rails.** Three identical consecutive tool calls (same name and arguments) get a corrective `loop_detected` observation instead of being executed; a further repeat ends the run. Six consecutive turns in which every tool call failed end the run (`no_progress`). Both are small and configurable (`maxIdenticalToolCalls`, `maxFailedTurns`).

**Cancellation.** `runtime.cancelSession(id)` aborts the in-flight provider request and any running tool; shell process trees are killed. Completed edits are kept (nothing is reverted), unexecuted tool calls are recorded as cancelled, partial streamed text is kept, `session.cancelled` is emitted, and the session accepts another message.

**Transport reliability.** Retries wrap a single provider request: up to `maxTransportRetries` (default 2) with exponential backoff and jitter, only for retryable failures (429, 5xx, connection errors, request timeouts) and only while nothing from the attempt has been shown (a failure after content started streaming is reported, not replayed). Authentication, invalid-request and cancelled failures are never retried. Each retry emits `provider.retry {attempt, reason, delayMs}`. A request timeout (`requestTimeoutMs`, until response headers) and a stream-inactivity timeout (`streamTimeoutMs`) both yield a normalized `provider_timeout`. Errors are scrubbed of API keys and bearer tokens before they reach events or history.

**DeepSeek adapter.** `src/providers/deepseek.js` is the only place that knows the DeepSeek wire format: it converts canonical messages/tools to chat-completions requests (tool schemas come from the tool registry; nothing is duplicated), parses the SSE stream into neutral events (`text_delta`, `reasoning_delta`, `tool_call_start/delta/complete`, `usage`, `completed`), reassembles fragmented tool arguments, and maps HTTP/stream failures to normalized errors. In thinking mode it echoes the model's reasoning back only on tool-call turns of the current exchange; this continuation behavior follows the documented API but has not been verified against the live service (see the smoke test).

**Events and trace.** A typical run emits `user.message`, `session.updated`, `assistant.text.delta`*, `assistant.text.completed`, then per tool `tool.started`, `file.changed`, `tool.completed|failed`, and finally `session.completed` (or `session.cancelled` / `session.failed`). `session.turns` holds `{turn, startedAt, completedAt, provider, model, toolCalls, usage, finishReason}` per turn; `session.tokenUsage` aggregates `{input, output, reasoning, total}`; `session.toolCalls` records `{id, name, input, status, resultSummary, startedAt, completedAt}`; `session.changedFiles` holds `{path, action}` (latest action wins).

```js
const workspaces = createNodeWorkspaceManager()
const runtime = createAgentRuntime({ workspaces })
const ws = await workspaces.openWorkspace({ root: '/path/to/repo' })
const session = runtime.createSession({ workspaceId: ws.id, model: { provider: 'deepseek', model: process.env.DEEPSEEK_MODEL } })
runtime.subscribe(session.id, event => render(event))
await runtime.sendMessage(session.id, 'Fix the failing parser test.')
runtime.cancelSession(session.id) // from another handler: Stop
```

Illustrative output format (tool lines are derived from runtime events by the CLI and web client; the content shown is an example, not a recorded run):

```text
> Fix the failing parser test.
▸ Finding files "parser"
▸ Reading 2 files
▸ Applying patch
  modified src/parser.js
▸ Running npm test -- parser
Fixed the parser's empty-token handling; `npm test -- parser` now passes.
```

**Running it.** The browser has no filesystem access, so the web client renders any runtime it is given but, without a workspace, offers no repository tools (it says so). To run the agent against a local repository use the terminal host:

```bash
DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=... npm run agent -- --workspace ../my-repo "Fix the failing parser test"
```

Ctrl-C stops the run and keeps completed edits. `npm run test:deepseek` is an optional live smoke test (needs `DEEPSEEK_API_KEY` and `DEEPSEEK_MODEL`; uses a disposable temp repository; not part of `npm test`).

## Workspace and tools (Phase 2)

```text
Agent runtime → Tool executor → Tool registry → Workspace manager → LocalWorkspace → files · search · shell · git
```

The model never touches Node, the shell, GitHub, or legacy executors: it requests a normalized tool, the executor validates and permission-checks it, and the workspace performs it. No API key or network is needed to exercise the tools directly with `runtime.executeTool`; the model-driven loop above uses the same path.

**Workspace abstraction.** `src/workspace/workspace.js` defines the contract (`readFile`, `writeFile`, `deleteFile`, `listDirectory`, `searchFiles`, `grep`, `applyPatch`, `runCommand`, `gitStatus`, `gitDiff`, `exists`, `stat`) plus `id`, `root`, and `metadata` (repository info and an opening baseline of `branch`, `headSha`, `initialStatus`). The tool layer depends only on this contract.

**LocalWorkspace / manager.** `LocalWorkspace` operates on a real directory; `createWorkspaceManager` registers/opens/closes workspaces (optionally restricted to `allowedRoots`) and is environment-agnostic. `createNodeWorkspaceManager()` (`src/workspace/node.js`) wires the local factory; the runtime receives the manager by injection and never imports Node modules. Sessions reference a `workspaceId` and tools resolve the workspace from the session, never from a per-call path.

**Path safety.** All tool paths are workspace-relative and normalized (`./src//a.js` → `src/a.js`). Absolute paths and any `..` escape are rejected with `path_outside_workspace`; symlinks are resolved and must stay inside the root (dangling symlinks are refused); `.git/` cannot be written, deleted or patched. A repository whose top level is not the workspace root is treated as non-git.

**Tools** (stable snake_case names; permission classes `read`, `workspace_write`, `dependency_change`, `external_effect`, `destructive`, `prohibited`):

| Tool | Effect | Notes |
|---|---|---|
| `read_file` | read | optional 1-based line range; byte cap with explicit `truncated` and `nextStartLine` |
| `read_many_files` | read | file-count and total-byte caps; per-file errors don't fail the call |
| `list_directory` | read | `depth` option; generated directories flagged, not expanded |
| `search_files` | read | filename/path substring or glob; deterministic scoring |
| `grep` | read | literal or regex content search (pure Node); binary/oversize files skipped |
| `apply_patch` | workspace_write | **primary edit tool**; see below |
| `write_file` | workspace_write | create or full rewrite; reports `created` / `overwritten` |
| `delete_file` | destructive | single files only; no recursive deletion |
| `shell` | classified per command | workspace-root execution, timeout, cancellation, output cap |
| `git_status` | read | porcelain-based; branch, HEAD, staged/modified/deleted/untracked |
| `git_diff` | read | real `git diff` (untracked files included as additions); `path`, `staged`; capped |

**`apply_patch`.** Accepts a unified diff (`---`/`+++`/`@@`, `a/` `b/` prefixes optional, `/dev/null` for create/delete, multiple files and hunks, CRLF-preserving, `\ No newline at end of file`). Hunks are located by context (nearest match, then ignoring trailing whitespace). The whole patch is parsed, path-checked and applied in memory first; writes are then rolled back if any fails, so a patch either fully applies or changes nothing. Binary patches, renames, duplicate targets and malformed hunks are rejected (`patch_parse_error`); mismatched context yields `patch_apply_failed` with the expected/found lines.

**Shell execution.** `/bin/sh -c` from the workspace root in its own process group. Per-call `timeoutMs` is clamped to `maxShellTimeoutMs` (default `defaultShellTimeoutMs`); on timeout or `AbortSignal` abort the whole process tree is terminated (SIGTERM, then SIGKILL) and any leftovers in the group are reaped on exit. stdout/stderr each keep their first and last halves with an explicit `truncated` marker. Inherited environment variables that look like secrets (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `VITE_*`) are not passed to commands. A non-zero exit, timeout or cancellation returns `ok: false` (`command_failed` / `command_timeout` / `command_cancelled`) with the command result still in `output`.

**Command classification.** `src/tools/permissions.js` classifies each `shell` command (compound commands, substitutions and `sh -c` are analyzed; the most severe segment wins). `npm test`, `npm run lint|build`, `git status|diff` are `read`; `npm install`, `pip install`, `npx` are `dependency_change`; `git push`, `npm publish`, `curl`, `ssh` are `external_effect`; `rm`, `git reset --hard`, `git clean` are `destructive`; `sudo`, `rm -rf /`, writes outside the workspace, piping into interpreters are `prohibited` and never run. Unknown programs are assumed to write to the workspace. The default policy allows `read`, `workspace_write` and `destructive`; `dependency_change` and `external_effect` return `permission_denied` until an approval flow exists (a different policy can be injected). Git push, merge, reset and PR creation are not available.

**Results and events.** Every call returns `{ ok, tool, toolCallId, output, error, metadata, durationMs }`, with `error = { code, message, details? }` from a fixed code set (`invalid_input`, `path_outside_workspace`, `file_not_found`, `patch_apply_failed`, `command_timeout`, `git_not_repository`, `output_limit_exceeded`, `internal_error`, …). The executor emits `tool.started` then `tool.completed` or `tool.failed` (and `file.changed` for mutations) carrying only the call ID, tool name, a redacted input summary and duration — never file bodies or secrets. The runtime records each call on `session.toolCalls` (`{ id, name, input, result, status, startedAt, completedAt }`) and updates `session.changedFiles`. Cancelling a session aborts its in-flight tool calls.

**Limits** live in `src/config/runtimeConfig.js` (`DEFAULT_LIMITS`; override with `VITE_BLUSWAN_LIMIT_<SNAKE_CASE>`), e.g. `maxReadBytes`, `maxReadManyFiles`, `maxReadManyBytes`, `maxGrepResults`, `maxShellOutputBytes`, `maxDiffBytes`, `defaultShellTimeoutMs`, `maxShellTimeoutMs`, `maxDirectoryDepth`.

```js
const workspaces = createNodeWorkspaceManager()
const runtime = createAgentRuntime({ workspaces })
const ws = await workspaces.openWorkspace({ root: '/path/to/repo' })
const session = runtime.startSession({ workspaceId: ws.id })
const read = await runtime.executeTool(session.id, { name: 'read_file', input: { path: 'src/math.js' } })
await runtime.executeTool(session.id, { name: 'apply_patch', input: { patch } })
const test = await runtime.executeTool(session.id, { name: 'shell', input: { command: 'npm test' } })
const diff = await runtime.executeTool(session.id, { name: 'git_diff', input: {} })
```

## Quick start

```bash
npm install
cp .env.example .env     # set VITE_DEEPSEEK_API_KEY and VITE_DEEPSEEK_MODEL
npm run dev
```

| Variable | Purpose |
|---|---|
| `VITE_DEEPSEEK_API_KEY` (or `DEEPSEEK_API_KEY` in Node) | DeepSeek API key (required) |
| `VITE_DEEPSEEK_MODEL` (or `DEEPSEEK_MODEL`) | DeepSeek model identifier (required; no default is assumed) |
| `VITE_DEEPSEEK_BASE_URL` (or `DEEPSEEK_BASE_URL`) | API base URL (default `https://api.deepseek.com`) |

Other runtime settings (`VITE_BLUSWAN_MAX_TURNS`, `…_MAX_TRANSPORT_RETRIES`, `…_REQUEST_TIMEOUT_MS`, `…_STREAM_TIMEOUT_MS`, `VITE_BLUSWAN_LIMIT_*`) live in `src/config/runtimeConfig.js`.

Browser-side execution is temporary: any `VITE_*` value is exposed to the client bundle, so do not ship a production key this way. The adapter takes its configuration by injection so execution can move server-side without changing the provider interface.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm test` | Unit and integration tests (no network or API key required) |
| `npm run test:diff` | Diff parser, terminal-text sanitizer, git changes, per-file diff, revert, command log |
| `npm run test:workspace-ui` | Workspace panels, store and the Phase 7 end-to-end review scenario |
| `npm run test:client` | Client store, projection, Markdown, components (SSR), permissions, Phase 6 integration |
| `npm run test:validation` | Project detection, command discovery/safety, policy, parsing, runners, validation state, completion/recovery, Phase 5 acceptance |
| `npm run test:context` | Context engine: estimator, budget, summary, relevance, compaction, long sessions, Phase 4 acceptance |
| `npm run test:agent` | Agent loop, DeepSeek adapter (mocked wire), retries, cancellation, client activity |
| `npm run agent -- --workspace DIR "request"` | Run the agent on a local repository from the terminal |
| `npm run test:deepseek` | Optional live DeepSeek smoke test (requires credentials; not in `npm test`) |
| `npm run test:workspace` | Workspace layer: path safety, patch engine, files, search, git, shell |
| `npm run test:tools` | Tool registry/executor/permissions, every tool, and the Phase 2 acceptance test |

## Planned

Not yet implemented: permission/approval and diff/terminal UI, additional providers, and Git push/PR flows.

## Legacy code

`src/services/`, `src/core-v2/`, `src/services-v2/`, `src/components-v2/`, `src/components/`, the legacy tool files in `src/tools/` (everything there except `registry.js`, `executor.js`, `result.js`, `permissions.js`, `validate.js` and `definitions/`), `src/cli/` and `src/config/featureFlags.js` contain superseded V1/V2 code retained temporarily for later deletion. None of it is reachable from the application entry point. Documents under `docs/` describing V1/V2 are historical.
