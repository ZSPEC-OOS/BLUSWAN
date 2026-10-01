# BLUSWAN

A chat-first coding agent. The user describes a coding task in natural language; the agent runtime works against a repository through tools and continues naturally from follow-up messages in the same session.

> **Status:** Foundation (Phase 1). The session protocol, provider abstraction, DeepSeek adapter, agent-runtime skeleton and chat client are implemented. Repository tools, file editing, command execution and the autonomous tool loop are **not** implemented yet; the runtime currently streams a model response for each user message.

## Architecture

```text
User message → Session → Agent runtime → Model provider → (tool calls) → Workspace
```

| Layer | Path | Responsibility |
|---|---|---|
| Protocol | `src/protocol/` | Canonical event types, message/session/error schemas |
| Sessions | `src/sessions/` | Session manager (live state, subscribers) and a pluggable store (in-memory today) |
| Providers | `src/providers/` | One normalized adapter interface, registry, neutral stream events; `deepseek.js` is the initial adapter |
| Agent | `src/agent/` | Provider-neutral runtime, agent state, stop conditions, canonical system prompt |
| Client | `src/client/` | React surface: renders session state and forwards user intent |
| Config | `src/config/runtimeConfig.js` | Provider, model, limits, timeouts, logging; secrets come from the environment |

**Runtime/client separation.** React renders sessions, messages and runtime events and submits user messages. It does not call providers, run tools, parse provider responses or decide task completion; the runtime owns all of that and is usable without React.

**Provider abstraction.** Provider-specific behavior (endpoints, auth, streaming format, tool schemas, error mapping) lives only in adapters. Adapters expose capabilities and emit provider-neutral events (`text_delta`, `reasoning_status`, `tool_call`, `usage`, `completed`); failures are normalized to `{ code, message, provider, retryable, cause }`.

**Sessions.** A session holds normalized messages, events, tool calls, changed files, status, and token usage. Statuses: `idle`, `running`, `waiting_permission`, `waiting_user`, `completed`, `error`, `cancelled`. Cancellation propagates through an `AbortController` to the provider request.

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
| `npm test` | Unit tests (no network or API key required) |

## Planned

A workspace/tool layer (file read/search/edit, command execution, validation) and additional providers are planned for later phases and are not part of the current code.

## Legacy code

`src/services/`, `src/core-v2/`, `src/services-v2/`, `src/components-v2/`, `src/components/`, `src/tools/`, `src/cli/` and `src/config/featureFlags.js` contain superseded V1/V2 code retained temporarily for later deletion. None of it is reachable from the application entry point. Documents under `docs/` describing V1/V2 are historical.
