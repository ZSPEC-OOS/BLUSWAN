# BLUSWAN architecture

BLUSWAN is a chat-first autonomous coding agent: you describe a change in conversation, it reads and edits a
repository through safe tools, validates the result with the project's own checks, and shows you exactly what changed.
There is one runtime, one context engine, one tool executor, one provider abstraction and one UI.

```text
                          ┌────────────────────────────────────────────────────────────┐
  Browser (React)         │ BLUSWAN server (Node)                                       │
  ───────────────         │                                                             │
  sessions · chat ·       │  HTTP + SSE API ── auth (bearer / Firebase ID token)       │
  activity · diff ·  ───► │        │                                                    │
  permissions · settings  │        ▼                                                    │
  (no provider keys,      │  per-user Session Runtime ──► Context Engine                │
   no tool execution)     │        │        │                                           │
                          │        │        └──► Provider Registry ─► DeepSeek · Kimi · OpenAI · Anthropic ─► network
                          │        ▼                                                    │
                          │  Tool Executor ─► permissions ─► Workspace ─► files · search · shell · git
                          │        │                                                    │
                          │        ├──► Validation Engine (project tests / lint / build)│
                          │        └──► Persistence adapter ─► file │ memory │ Firestore │
                          └────────────────────────────────────────────────────────────┘
```

Module dependencies point one way (enforced by `src/architecture.test.mjs`):

```text
main → App → { auth, client, persistence(local cache) }
server → agent → { context, sessions, tools, validation, providers } → { workspace, persistence, protocol, config, utils }
client → { providers/labels, tools/permissionModes, utils }          (the browser never imports the runtime)
```

## Invariants

1. **React does not execute providers.** The browser talks to the server over an API; it holds no provider key and runs no tool.
2. **Providers do not execute tools.** An adapter turns a canonical request into one HTTP stream and back into canonical events; the runtime decides what to do with tool calls.
3. **The agent runtime is provider-neutral.** Behaviour depends on *capabilities*, never on a provider's name. Session state contains no provider-native structures.
4. **Tools operate through the workspace abstraction.** No tool touches the filesystem, a process or git directly.
5. **Validation is deterministic infrastructure.** Whether the code works is decided by running the project's checks, not by what the model says.
6. **Persistence is adapter-based.** Memory, file and Firestore backends implement one tiny document-store interface.
7. **Secrets stay server-side.** Provider keys are read from the server environment and used only inside provider adapters.
8. **Git and workspace state are authoritative.** Changed files, diffs and validation currency are derived from the repository now, not from remembered assumptions.

## Modules

| Module | Responsibility |
|---|---|
| `src/protocol` | Canonical session, message, event and error schemas shared by everything |
| `src/providers` | `provider.js` contract, `capabilities.js`, `errors.js`, `normalize.js` (stream events), `transport.js` (HTTP/SSE, timeouts, cancellation), `adapter.js`, `registry.js`, and one file per provider: `deepseek.js`, `kimi.js`, `openai.js`, `anthropic.js`; `credentials/` is the server-side key boundary |
| `src/agent` | `runtime.js` — the single agent loop: sessions, turns, tool scheduling, permissions, cancellation, completion cycle, persistence hooks |
| `src/context` | Context engine: token budgeting, deterministic session summary, compaction, repository awareness, history repair |
| `src/tools` | Tool registry/executor, effect classification (`permissions.js`), permission modes, tool definitions |
| `src/workspace` | `Workspace` contract, `LocalWorkspace`, path safety, patch engine, shell runner, git (status, diffs, restore), workspace restore |
| `src/validation` | Project detection, command discovery and safety, focused-then-broad plans, runners, result parsing, validation state |
| `src/sessions` | Autosave (`sessionStore.js`), hydration (`sessionHydrator.js`), session manager |
| `src/persistence` | Persistence contract, serializer, schema migrations, repositories, backends under `adapters/` |
| `src/server` | HTTP/SSE handler, per-user application service, authentication |
| `src/client` | Chat-first UI: store, event projection, sessions, chat, activity, permissions, workspace/diff review, settings |
| `src/auth` | Web sign-in (Firebase) used when the server requires authentication |
| `src/eval` | Provider-neutral coding evaluation harness |

## Runtime

One loop (`src/agent/runtime.js`): build context → stream a provider turn → execute tool calls (read-only calls in parallel, others in order) → feed results back → repeat until the model stops; then the **completion cycle** validates the changed code and, if checks fail, feeds classified failure evidence back for a bounded number of repair rounds. Hard limits (turns, identical calls, consecutive failed turns, validation rounds) end a run with a preserved, explained state.

Run lifecycle: `idle → running → (waiting_permission) → completed | cancelled | error`; every state is reopenable by the next message. `interrupted` is the state of a run that was active when the process died. Stop cancels the provider stream, running shell process groups and pending approvals; applied edits are kept.

## Providers

Every adapter implements the same contract and is built from the same transport:

```text
{ id, listModels(), capabilities(model), normalizeMessages(), normalizeTools(), validate(model), stream(request, {onEvent}) }
request: { model, messages, tools, signal, temperature, maxOutputTokens }
events:  text_delta · reasoning_delta · tool_call_start · tool_call_delta · tool_call_complete · usage · completed
errors:  configuration_error · authentication_error · rate_limit · network_error · provider_timeout · invalid_response ·
         context_limit · unsupported_feature · cancelled · provider_error
```

Tool calls are normalized to `{ id, name, input }`; tool results continue as canonical `{ role: 'tool', toolCallId, name, content }` messages that each adapter converts to its native continuation (OpenAI `function_call_output`, Anthropic `tool_result`, chat-completions `tool` messages). Usage is `{ input, output, reasoning, total, cachedInput? }`. A shared contract suite (`src/providers/contract.test.mjs`) runs against all four adapters through their native wire formats. See [PROVIDERS.md](PROVIDERS.md).

The selected model is explicit: there is no automatic routing and no silent fallback. A session's model can change between runs; the canonical history, summary, workspace and validation state carry over and the next provider's context is rebuilt from them. A model without tool calling cannot run the coding agent (`unsupported_feature`).

## Context

`src/context` builds each request within the model's window: system prompt, a structured deterministic session summary (goal, decisions, files inspected/changed, commands, validations, unresolved issues), recent conversation, relevant tool results (stale file reads are replaced when the file changed), repository and workspace state, and validation state. When the budget is pressed, older material is compacted deterministically. It has no provider-specific branches; sizes come from capabilities.

## Tools and permissions

Tools: `read_file`, `read_many_files`, `list_directory`, `search_files`, `grep`, `apply_patch`, `write_file`, `delete_file`, `shell`, `git_status`, `git_diff`. Every call is validated and classified into an effect — `read`, `workspace_write`, `dependency_change`, `external_effect`, `destructive`, `prohibited` — before it runs. Permission modes map effects to allow / ask / block:

| Mode | read | workspace write | destructive | dependency change | external effect | prohibited |
|---|---|---|---|---|---|---|
| Ask | allow | ask | ask | ask | ask | block |
| Auto Edit (default) | allow | allow | ask | ask | ask | block |
| Full Auto | allow | allow | allow | allow | ask | block |

Prohibited operations never run in any mode. Approvals are real: the run pauses (`waiting_permission`) until the user allows or denies; a denial is returned to the model. Shell classification is conservative: compound commands, substitutions and `sh -c` are analysed and the most severe segment wins; inline interpreters, `xargs`, `eval`, history-changing git commands, reads of credential locations and writes outside the workspace are never silently allowed. Commands run in their own process group with a timeout, cancellation and output limits, with secret-looking environment variables removed.

## Workspace and git

`Workspace` is the only way tools touch a repository. Paths are normalized and confined to the root (traversal, absolute paths and escaping symlinks are rejected; `.git` is never written). `apply_patch` is atomic. Git is inspection-only for the agent; `revertFile` (user-driven, confirmed in the UI) restores one file from `HEAD` or removes a new file, never resets or cleans. `getWorkspaceState` reads `git status` + `numstat` for the changed-file list; diffs are per file against `HEAD`.

## Validation

`src/validation` detects the project, discovers its own test/lint/typecheck/build commands, plans focused checks for the changed files first and broader checks when warranted, runs them non-interactively with bounded output, classifies failures (test failure, type error, lint, build, timeout, missing command), and records evidence bound to a mutation counter so a pass can never be mistaken for proof about code edited afterwards. Commands that would be unsafe are skipped, never run. Validation never installs dependencies or auto-fixes.

## Sessions and persistence

Sessions autosave through `src/sessions/sessionStore.js`: immediately for state changes (user message, completed message/tool, file change, validation, run boundary), debounced for high-frequency events, never per text delta, with revision checks (optimistic concurrency), bounded retry and visible status. Records are provider-neutral and secret-free: messages, compacted events, tool history, runs, changed files, context summary, validation state, bounded command output, a workspace snapshot. `schemaVersion` + `migration.js` evolve the stored layout. A separate index record per session serves the sidebar.

Hydration (`sessionHydrator.js`): load → migrate/validate → re-attach the workspace → reconcile with the repository (changed files from git; validation becomes *stale* if commit, branch or dirty files differ) → register. A run that was active restores as `interrupted`; nothing is resumed or replayed. Corrupt or too-new records fail with normalized errors without affecting other sessions. Backends: file (default local server), Firestore (cloud, ownership by path `users/{uid}/…`), memory (tests); IndexedDB caches the session list in the browser for offline display.

## Server and security

`npm run server` hosts the runtime. Every route but `/api/health` authenticates (`BLUSWAN_AUTH=none` for one local user on loopback only; `firebase` verifies ID tokens server-side). Each user gets an isolated runtime, so other users' ids resolve to "not found" — in lists, operations and the event stream alike. Events cross the boundary unchanged as Server-Sent Events with stable ids; the client de-duplicates on reconnect. See [SECURITY.md](SECURITY.md).

### Connection model (browser ↔ runtime)

`createRemoteRuntime` owns an explicit state machine, independent of React: `starting → checking_server → authenticating → loading_bootstrap →
connecting_stream → online`, then `reconnecting` when the stream drops, and `offline_cached`, `server_unreachable`, `auth_error`,
`server_error` when the runtime cannot be used. Boot is health → readiness → token → bootstrap → stream; every failure is classified
(`server_unreachable`, `server_not_ready`, `authentication_failed`, `persistence_unavailable`, `workspace_host_unavailable`,
`configuration_error`, `client_server_version_mismatch`, `unknown_server_error`) with a retry policy (bounded backoff 0.5→15 s; never for
auth, configuration or version problems). With a cached session list the app renders read-only (`offline_cached`) and recovers without a
reload. A silent stream (no heartbeat for 45 s) is treated as dropped; after any drop the client resyncs from the runtime's canonical
state and de-duplicates events by id. `diagnoseConnection()` probes each stage separately for the "Connection details" view.
`protocolVersion` (independent of the release) is checked on `/api/health` and the stream `hello`.

## Client

The UI is a projection of runtime events: `projectEvents` turns the canonical event stream into transcript entries, grouped activity, permission prompts and notices; a framework-free store feeds React through `useSyncExternalStore`. The workspace panel (changes, validation, commands) fetches git-backed state and per-file diffs on demand and caches them by workspace revision. Layout adapts: three columns on desktop, sheets on mobile; on phones the toolbar is replaced by a compact header with Workspace and Settings drawers composed from the same components and state ([MOBILE.md](MOBILE.md)).
