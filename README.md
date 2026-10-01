# BLUSWAN

A chat-first coding agent. The user describes a coding task in natural language; the agent runtime works against a repository through tools and continues naturally from follow-up messages in the same session.

> **Status:** Phase 2 (workspace and tools). On top of the Phase 1 foundation (session protocol, provider abstraction, DeepSeek adapter, runtime, chat client), BLUSWAN now has a workspace abstraction, a local-filesystem workspace, and eleven canonical coding tools (read, search, patch, write, delete, shell, git). **These tools are available programmatically only** (`runtime.executeTool`). The provider-driven tool loop — the model choosing and calling tools autonomously — arrives in Phase 3; today the runtime still just streams a model response for each user message.

## Architecture

```text
User message → Session → Agent runtime → Model provider            (Phase 1, live)
                              └─ executeTool → Tool executor → Tool registry → Workspace
                                                                       (Phase 2, programmatic)
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

## Workspace and tools (Phase 2)

```text
Agent runtime → Tool executor → Tool registry → Workspace manager → LocalWorkspace → files · search · shell · git
```

The model never touches Node, the shell, GitHub, or legacy executors: it requests a normalized tool, the executor validates and permission-checks it, and the workspace performs it. No API key or network is needed to exercise any of this.

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
| `VITE_DEEPSEEK_API_KEY` | DeepSeek API key (required) |
| `VITE_DEEPSEEK_MODEL` | DeepSeek model identifier (required; no default is assumed) |
| `VITE_DEEPSEEK_BASE_URL` | API base URL (default `https://api.deepseek.com`) |

Browser-side execution is temporary: any `VITE_*` value is exposed to the client bundle, so do not ship a production key this way. The adapter takes its configuration by injection so execution can move server-side without changing the provider interface.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm test` | Unit and integration tests (no network or API key required) |
| `npm run test:workspace` | Workspace layer: path safety, patch engine, files, search, git, shell |
| `npm run test:tools` | Tool registry/executor/permissions, every tool, and the Phase 2 acceptance test |

## Planned

Not yet implemented: the provider-driven autonomous tool loop (Phase 3), context management, automatic validation, permission/approval and diff/terminal UI, additional providers, and Git push/PR flows.

## Legacy code

`src/services/`, `src/core-v2/`, `src/services-v2/`, `src/components-v2/`, `src/components/`, the legacy tool files in `src/tools/` (everything there except `registry.js`, `executor.js`, `result.js`, `permissions.js`, `validate.js` and `definitions/`), `src/cli/` and `src/config/featureFlags.js` contain superseded V1/V2 code retained temporarily for later deletion. None of it is reachable from the application entry point. Documents under `docs/` describing V1/V2 are historical.
