# BLUSWAN

A chat-first coding agent. The user describes a coding task in natural language; the agent runtime works against a repository through tools and continues naturally from follow-up messages in the same session.

> **Status:** Phase 3 (autonomous agent loop). The runtime now drives DeepSeek through a single tool loop: the model inspects the repository, edits with `apply_patch`, runs commands, observes results, adapts, and answers. DeepSeek is the **only** production provider; the runtime is provider-neutral, but no other provider is implemented. Context management/compaction, deterministic validation gates, a permission-approval UI and rich diff/terminal UI are not implemented yet.

## Architecture

```text
user message
  → agent runtime ──► provider adapter (DeepSeek) ──► streamed text + normalized tool calls
        ▲                                                       │
        │ normalized tool results (role: tool)                  ▼
        └──────────── tool executor → tool registry → workspace (files · search · shell · git)
  → final assistant response (a response with no tool calls ends the run)
```

| Layer | Path | Responsibility |
|---|---|---|
| Protocol | `src/protocol/` | Canonical event types, message/session/error schemas |
| Sessions | `src/sessions/` | Session manager (live state, subscribers) and a pluggable store (in-memory today) |
| Providers | `src/providers/` | One normalized adapter interface, registry, neutral stream events; `deepseek.js` is the initial adapter |
| Agent | `src/agent/` | Provider-neutral runtime, agent state, stop conditions, canonical system prompt |
| Workspace | `src/workspace/` | `Workspace` contract, `LocalWorkspace`, workspace manager, path safety, file index, search, patch engine, shell runner, git |
| Tools | `src/tools/` | Provider-neutral tool registry, executor, permission classifier, normalized results; definitions in `src/tools/definitions/` |
| Client | `src/client/` | React surface: renders session state and forwards user intent |
| Config | `src/config/runtimeConfig.js` | Provider, model, limits, timeouts, logging; secrets come from the environment |

**Runtime/client separation.** React renders sessions, messages and runtime events and submits user messages. It does not call providers, run tools, parse provider responses or decide task completion; the runtime owns all of that and is usable without React.

**Provider abstraction.** Provider-specific behavior (endpoints, auth, streaming format, tool schemas, error mapping) lives only in adapters. Adapters expose capabilities and emit provider-neutral events (`text_delta`, `reasoning_status`, `tool_call`, `usage`, `completed`); failures are normalized to `{ code, message, provider, retryable, cause }`.

**Sessions.** A session holds normalized messages, events, tool calls, changed files, status, and token usage. Statuses: `idle`, `running`, `waiting_permission`, `waiting_user`, `completed`, `error`, `cancelled`. Cancellation propagates through an `AbortController` to the provider request.

## Agent loop (Phase 3)

`src/agent/runtime.js` owns the one canonical loop. React, the provider adapter and the workspace each own only their own concern.

```text
sendMessage(sessionId, text)
  validate (provider, model, credentials, workspace) — before any network request
  repeat:
    stop check            cancelled · max turns · no progress
    provider turn         stream one response → text deltas, tool calls, usage        (retry only if nothing was shown)
    commit                assistant message {content, toolCalls}; trace + usage
    no tool calls?        → status completed, session.completed
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
| `npm run test:agent` | Agent loop, DeepSeek adapter (mocked wire), retries, cancellation, client activity |
| `npm run agent -- --workspace DIR "request"` | Run the agent on a local repository from the terminal |
| `npm run test:deepseek` | Optional live DeepSeek smoke test (requires credentials; not in `npm test`) |
| `npm run test:workspace` | Workspace layer: path safety, patch engine, files, search, git, shell |
| `npm run test:tools` | Tool registry/executor/permissions, every tool, and the Phase 2 acceptance test |

## Planned

Not yet implemented: context management and compaction (Phase 4), automatic validation, permission/approval and diff/terminal UI, additional providers, and Git push/PR flows.

## Legacy code

`src/services/`, `src/core-v2/`, `src/services-v2/`, `src/components-v2/`, `src/components/`, the legacy tool files in `src/tools/` (everything there except `registry.js`, `executor.js`, `result.js`, `permissions.js`, `validate.js` and `definitions/`), `src/cli/` and `src/config/featureFlags.js` contain superseded V1/V2 code retained temporarily for later deletion. None of it is reachable from the application entry point. Documents under `docs/` describing V1/V2 are historical.
