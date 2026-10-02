> **Superseded:** this document describes the former V1/V2 architecture, which is no longer part of the active application. See the root `README.md` for the current architecture.

# BLUSWAN V1 → V2 Migration Guide

## Overview

BLUSWAN V2 is a ground-up rewrite of the core execution engine. It replaces the nested-loop architecture with a deterministic task state machine, eliminating infinite loops, auto-remediation spirals, and false-positive rollbacks.

V1 and V2 run **side by side** with no V1 code deleted. Feature flags control which path executes. All flags default to `false` — V1 is the current default.

---

## Migration Status

| Component | V1 | V2 | Status |
|---|---|---|---|
| Execution Engine | `agentLoop.js` | `core-v2/taskRunner.js` | ✅ Ready |
| Tool Executor | `agentExecutor.js` (with hooks) | `services-v2/agentExecutor.js` (thin) | ✅ Ready |
| Context System | `pruneMessages` + injectors | `core-v2/contextBudget.js` | ✅ Ready |
| Loop Prevention | Warning injection | Structural guards | ✅ Ready |
| Reliability | 6 gates + auto-rollback | Safety blocks + quality signals | ✅ Ready |
| UI | Chat stream | Task dashboard | ✅ Ready |
| Telemetry | Scattered logs | Unified events | ✅ Ready |

---

## How to Enable V2

### Option 1: Environment Variables (recommended for development)

```sh
cp .env.example .env
# Edit .env:
VITE_V2_ENGINE=true
VITE_V2_UI=true
npm run dev
```

### Option 2: URL Parameters (quick testing, no restart needed)

```
http://localhost:5173/?v2=true
http://localhost:5173/?v2=true&v2ui=true
```

URL params override env variables and localStorage. They are not persisted — removing the param reverts to the next-priority source.

### Option 3: localStorage (persistent user preference)

Open the browser console:

```js
localStorage.setItem('bluswan_flags', JSON.stringify({ useV2Engine: true, useV2UI: true }))
location.reload()
```

To revert:

```js
localStorage.removeItem('bluswan_flags')
location.reload()
```

### Option 4: Partial Migration (individual subsystems)

Enable V2 subsystems independently while keeping V1 engine and UI:

```sh
VITE_V2_EXECUTOR=true      # Thin executor — no auto-hooks, errors returned as strings
VITE_V2_LOOP=true          # Structural loop prevention
VITE_V2_RELIABILITY=true   # Safety gates + quality signals
VITE_V2_CONTEXT=true       # Context budget system
# Leave VITE_V2_ENGINE and VITE_V2_UI=false to keep V1 chat UI
```

---

## Flag Priority Order

```
VITE_* env var  >  ?url=param  >  localStorage  >  default (false)
```

Flags are resolved once at page load. Changing any flag requires a page refresh.

---

## Gradual Cutover Plan

| Week | Action |
|------|--------|
| 1 | Enable V2 engine (`VITE_V2_ENGINE=true`) on simple tasks with V1 UI |
| 2 | Enable V2 UI (`VITE_V2_UI=true`) for power users via localStorage opt-in |
| 3 | Enable V2 for all tasks; V1 remains automatic fallback on crash |
| 4 | Collect metrics via `npm run test:metrics`; fix edge cases |
| 5 | Make V2 the default; V1 available via `?v2=false` or env var |
| 6 | Remove V1 code paths |

---

## Fallback Behavior

If V2 fails during a task:

1. Task halts with a detailed error (phase, failureReason, telemetry trace)
2. A dismissible notice appears offering "Use V1"
3. Work completed so far is **preserved** — V2 never auto-rolls back
4. Clicking "Use V1" switches to the V1 chat interface for the same goal
5. Setting `setFeatureFlag('useV2Engine', false)` + reload permanently opts out

---

## Known V2 Limitations

- **No sub-agent spawning** — use plan deliverables to decompose work instead
- **No automatic model escalation** — the planner selects the model
- **No persistent memory graph** — rebuilt per task via repo index
- **No vector embeddings** — BM25 path search + symbol index instead

---

## Reporting Issues

If V2 behaves unexpectedly:

1. Check the browser console for `[telemetry]` events and `[V2]` errors
2. The `TaskResult` object returned by `runTask()` includes a full `cycles` array and `failureReason`
3. Run `npm run test:chaos` to verify the engine handles the failure mode in isolation
4. File an issue with the telemetry log attached
