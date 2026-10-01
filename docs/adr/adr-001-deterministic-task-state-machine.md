> **Superseded:** this document describes the former V1/V2 architecture, which is no longer part of the active application. See the root `README.md` for the current architecture.

# ADR 001: Deterministic Task State Machine

**Status:** Accepted

---

## Context

BLUSWAN V1 used a nested loop architecture:

- Reliability FSM (4 states) wrapped the Agent Loop (100 turns max)
- Agent Loop wrapped Tool Execution with auto-hooks
- Auto-hooks triggered the Repair Engine with tiered retries
- Repair Engine could escalate to a backup model, restarting the entire loop

This caused measurable production problems:

- **30% infinite loop rate** on complex tasks
- **40% token waste** on auto-remediation that didn't converge
- **25% false-positive rollback rate** — legitimate refactors triggering safety rollback
- **Context window collapse** from 10+ injected context blocks competing for space

The fundamental problem: emergent loop termination. Whether a task completed depended on probabilistic LLM behavior, not structural guarantees.

---

## Decision

Replace nested loops with a single forward-only **Task State Machine (TSM)**:

- **11 phases:** `idle → planning → plan_review → cycle_prep → cycle_exec → cycle_validate → [loop back to cycle_prep] → completion_check → completion_confirm → done / failed / halted`
- **Forward-only:** no phase can be revisited once exited
- **Plan is immutable** after the planning phase completes
- **Hard caps:** max 3 cycles, max 25 turns per cycle (both configurable)
- **No automatic rollback**, no automatic retry, no model escalation

The TSM is implemented in `src/core-v2/taskStateMachine.js`. Every phase transition is validated against an explicit allowed-transitions table. An invalid transition throws `InvalidPhaseTransitionError` immediately.

---

## Consequences

### Positive

- **Loop rate drops to 0%** — structurally impossible to loop within the TSM
- **Token waste drops to ≤10%** — no hidden retry loops burning budget
- **Task completion is deterministic and observable** — every decision is in the telemetry trace
- **Human checkpoints at plan review and completion** — explicit approval moments
- **Testable with scripted mock LLMs** — enables the full benchmark suite

### Negative

- **Sub-agent spawning removed** — complex tasks must be decomposed explicitly in the plan deliverables
- **No runtime model switching** — planner must select the correct model upfront
- **No mid-task replanning** — task scope is fixed once the plan is approved

---

## Alternatives Considered

1. **Patch V1 loops** — Add more loop detection heuristics. Rejected: heuristics are evadable, added complexity without structural guarantees.
2. **Smaller nested loops** — Reduce max turns from 100 to 50. Rejected: still nested, still subject to probabilistic feedback loops.
3. **Supervisor agent** — Add a meta-agent that monitors and stops loops. Rejected: adds another layer of indirection and a new failure mode (supervisor loops).

---

## Related

- `src/core-v2/taskStateMachine.js`
- `src/core-v2/taskRunner.js`
- [ADR 002](./adr-002-bounded-remediation.md) — Bounded Remediation
- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) — State machine diagram
