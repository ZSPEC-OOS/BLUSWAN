> **Superseded:** this document describes the former V1/V2 architecture, which is no longer part of the active application. See the root `README.md` for the current architecture.

# BLUSWAN V2 Architecture

## Core Principles

1. **Deterministic execution** — Task completion is a state machine, not emergent behavior
2. **Bounded resources** — Cycles, turns, tokens, and remediation are all hard-capped
3. **Forward-only progress** — No replanning, no automatic rollback, no restart
4. **Explicit human checkpoints** — Plan review and completion confirmation are opt-in
5. **Advisory quality signals** — Warnings never block; safety gates do

---

## Data Flow

```
User Request
     │
     ▼
[Planner] → ExecutionPlan (immutable contract)
     │
     ▼
[Task State Machine] → forward-only phase transitions
     │
     ▼
[Cycle Engine] → bounded cycles (max 3 default, 25 turns each)
     │
     ▼
[Context Packer] → deterministic context assembly within token budget
     │
     ▼
[LLM] → tool calls or <CYCLE_COMPLETE> token
     │
     ├─ tool call ──► [Tool Executor] → thin, no hooks, errors as strings
     │                     │
     │                     ▼
     │               [Loop Guard] → structural prevention, immediate halt
     │
     └─ completion ─► [Cycle Validation] → run tests/lint once per cycle
                            │
                            ▼
                      [Completion Gate] → 5-layer verification
                            │
                            ▼
                      [Quality Signals] → advisory warnings only
                            │
                            ▼
                      TaskResult { phase, cycles, plan, failureReason }
                      phase ∈ { done | failed | halted }
```

---

## State Machine Phases

```
idle → planning → plan_review → cycle_prep → cycle_exec → cycle_validate
                                     ▲               │
                                     │   (cycles remain)
                                     └───────────────┘
                                                     │  (max cycles or all done)
                                                     ▼
                                           completion_check
                                                     │
                                                     ▼
                                           completion_confirm → done
                                                     │
                                               (gate fails)
                                                     ▼
                                                  failed
                                         (loop guard or user)
                                                     ▼
                                                  halted
```

Terminal phases: `done`, `failed`, `halted`. All transitions are forward-only.

---

## Module Reference

| Module | File | Responsibility |
|--------|------|----------------|
| Task State Machine | `core-v2/taskStateMachine.js` | Phase transitions and invariants |
| Plan Contract | `core-v2/planContract.js` | Immutable plan schema and validation |
| Cycle Engine | `core-v2/cycleEngine.js` | Bounded execution units |
| Context Budget | `core-v2/contextBudget.js` | Token allocation across tiers |
| Context Packer | `core-v2/contextPacker.js` | Message assembly within budget |
| Loop Prevention | `core-v2/loopPrevention.js` | Structural guards (sequence, read, idle) |
| Error Classifier | `core-v2/errorClassifier.js` | Error taxonomy and strategy |
| Completion Gate | `core-v2/completionGate.js` | 5-layer verification (safety + done-ness) |
| Remediation Budget | `core-v2/remediationBudget.js` | Cost accounting for fix attempts |
| Validator | `core-v2/validator.js` | Post-cycle test/lint runner |
| Quality Signals | `core-v2/qualitySignals.js` | Advisory checks (never blocking) |
| Repo Index | `core-v2/repoIndex.js` | Lightweight symbol + import indexing |
| Telemetry | `core-v2/telemetry.js` | Structured event collection |
| Task Runner | `core-v2/taskRunner.js` | Main orchestrator |
| Tool Executor | `services-v2/agentExecutor.js` | Thin I/O wrapper, no hooks |

---

## Context Budget Tiers

The context packer allocates tokens across five tiers (highest priority first):

| Tier | Content | Behavior |
|------|---------|----------|
| 1 | Plan contract | Always included — never pruned |
| 2 | Cycle goal + deliverables | Always included |
| 3 | Tool results from current cycle | Included if budget allows |
| 4 | Recent conversation history | Trimmed from oldest first |
| 5 | Repo map / file context | Best-effort, dropped if no budget |

---

## Loop Prevention Guards

Three independent structural guards run per turn:

| Guard | Trigger | Action |
|-------|---------|--------|
| Sequence guard | Same tool+args repeated > 2× | Halt cycle |
| Read guard | File read > 3× without mutation | Halt cycle |
| Idle guard | 8 turns with no deliverable progress | Halt cycle |

A fourth cross-cycle guard tracks per-deliverable retry attempts. After 2 failed cycles on the same deliverable, the task halts (not retries indefinitely).

---

## Completion Gate Layers

Gates run after each cycle's LLM reports `<CYCLE_COMPLETE>`:

| Gate | Check | On Fail |
|------|-------|---------|
| 1 – Safety | No hardcoded secrets, no sensitive file writes | Block (fatal) |
| 2 – Plan coverage | All required deliverables marked complete | Block |
| 3 – Structural | Completion token + required sections present | Block |
| 4 – Tool evidence | Non-empty tool results for each deliverable | Block |
| 5 – Self-assessment | Cycle status = `completed` | Block |

Gates 1–5 must all pass for `done`. Any failure → `failed` (unless more cycles remain).

---

## Adding a New Tool

1. Add the tool schema to `src/tools/contracts.js`
2. Add the I/O implementation to `src/services-v2/agentExecutor.js`
3. Add the tool to `BASE_ALLOWED_TOOLS` or `CREATE_FILE_TOOLS`/`EDIT_FILE_TOOLS` in `src/core-v2/taskRunner.js` depending on its mutability
4. Add a test case to `tests/unit/services-v2.test.mjs`

---

## Feature Flag Integration

All V1/V2 routing goes through `src/config/featureFlags.js`.

```
import { getFeatureFlags } from './config/featureFlags.js'

const flags = getFeatureFlags()
if (flags.useV2Engine) {
  // V2 path
} else {
  // V1 path
}
```

See `docs/MIGRATION.md` for flag priority order and cutover plan.
