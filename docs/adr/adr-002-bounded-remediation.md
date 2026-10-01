> **Superseded:** this document describes the former V1/V2 architecture, which is no longer part of the active application. See the root `README.md` for the current architecture.

# ADR 002: Bounded Remediation

**Status:** Accepted

---

## Context

V1 auto-remediation ran silently inside every tool call:

- Auto-ran tests after every write operation
- Auto-ran lint after every edit operation
- The Repair Engine had 40+ error codes, each with automatic tiered repairs
- 3 automatic retries per error before surfacing to the user
- Delays, fallbacks, and state resets were hidden — the user saw only the final outcome

Result: **40% of tokens spent on repairs that didn't converge.** A typical complex task spent more budget on the repair loop than on the actual implementation.

The hidden retry model also created trust problems: the user couldn't tell if a "succeeded" response was clean on the first try or had silently failed 9 times before producing a degraded output.

---

## Decision

Replace auto-repair with an explicit **remediation budget**:

- **Total budget:** 100 units per task (configurable via `options.remediationBudget`)
- **Every fix attempt costs units** — costs are fixed, not negotiable:
  - `tool_retry: 5`, `file_re_read: 2`, `test_re_run: 10`, `lint_re_run: 5`
  - `model_re_call: 20`, `rollback_attempt: 50`, `error_recovery: 8`, `context_repack: 15`
- **Budget is per-task** and carries across all cycles
- **When exhausted:** task completes with quality warnings — it does not fail automatically
- **Full audit trail:** every spend recorded with timestamp, turn number, cycle number, and reason

The LLM sees the current budget in its context and must choose fix strategies knowing their cost. This shifts from reactive brute-force to strategic decision-making.

The budget is implemented in `src/core-v2/remediationBudget.js`. The cost table is frozen at module load — no dynamic pricing.

---

## Consequences

### Positive

- **Repair cost is user-visible** — the budget bar shows spend in real time
- **Prevents death-by-a-thousand-fixes** — spiral loops hit the budget cap and stop
- **Forces strategic fix selection** — LLM can't just retry everything and hope
- **Transparent history** — audit trail shows exactly what was spent and why
- **Testable** — deterministic cost accounting enables unit tests for budget exhaustion

### Negative

- **Some tasks that V1 "eventually fixed" via brute force will now complete with warnings** — tasks that needed 10+ retries are better surfaced than silently exhausted
- **User must manually request follow-up tasks** for remaining quality issues after budget exhaustion
- **Transient errors** (network blips, rate limits) that auto-retry would have transparently handled now cost budget units

---

## Related

- `src/core-v2/remediationBudget.js`
- `src/core-v2/errorClassifier.js`
- [ADR 004](./adr-004-deprecating-auto-repair.md) — Deprecating Auto-Repair
- [ADR 005](./adr-005-quality-signals-vs-gates.md) — Quality Signals vs. Gates
