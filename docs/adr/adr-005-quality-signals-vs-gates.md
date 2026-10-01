> **Superseded:** this document describes the former V1/V2 architecture, which is no longer part of the active application. See the root `README.md` for the current architecture.

# ADR 005: Quality Signals vs. Gates

**Status:** Accepted

---

## Context

V1 ran quality checks as **gates**: every check was pass/fail, and any failure blocked task completion. The check suite included:

- TypeScript type check (`tsc --noEmit`)
- ESLint clean run
- Test suite pass (all tests green)
- Dependency audit (no high-severity vulnerabilities)
- Dead code detection
- Bundle size regression check

A single ESLint warning in an unrelated file would block a completed refactor. A new test file with a pending test would block a deployment. The gates were applied uniformly regardless of whether the failing check was related to the task's deliverables.

This caused a high false-block rate on legitimate completions and pushed the LLM toward suppressing checks or generating minimal code that avoided triggering quality tools.

---

## Decision

Split quality evaluation into two tiers:

**Tier 1 — Completion Gates (blocking):**
- All deliverable files exist at the paths declared in the plan
- No syntax errors in modified files (parse-level, not lint-level)
- Task-critical tests pass (only tests that reference modified files or are listed in `validationSteps`)

**Tier 2 — Quality Signals (non-blocking, reported):**
- Full lint run across modified files
- Full type check across the project
- Test suite coverage for modified modules
- Bundle size delta (warn if >10% increase)
- Dependency audit

Quality signals are collected by `qualitySignals.js` and included in the `TaskResult.qualityReport` field. They are visible to the user and included in the telemetry trace, but they do not block the `done` phase transition.

**The distinction:** a gate asks "is the task complete?" A signal asks "how healthy is the output?" Signals inform the next task's planning; they do not override the current task's completion.

Tasks that complete with quality signal warnings are marked `phase: done` with `qualityReport.hasWarnings: true`. The user sees the warnings and decides whether to file a follow-up task.

---

## Consequences

### Positive

- **No false blocks from unrelated files** — gates only check what the plan touched
- **Quality debt is visible, not suppressed** — signals surface lint warnings and type issues without blocking shipping
- **LLM stops avoiding quality tools** — signals can't block completion, so there's no incentive to suppress them
- **Completion is deterministic** — gate criteria are specified in the plan; the same inputs always produce the same gate result
- **Signals improve planning** — the next cycle's context can include the previous cycle's quality report

### Negative

- **Quality debt can accumulate** — signals that are never actioned become background noise
- **Users must triage warnings manually** — no automatic escalation path from signal to follow-up task
- **Gate criteria must be specified correctly** — a poorly scoped plan may declare too-narrow gates and miss genuine regressions

---

## Related

- `src/core-v2/qualitySignals.js`
- `src/core-v2/completionGate.js`
- `src/core-v2/validator.js`
- [ADR 002](./adr-002-bounded-remediation.md) — Bounded Remediation
- [ADR 004](./adr-004-deprecating-auto-repair.md) — Deprecating Auto-Repair
- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) — Quality pipeline diagram
