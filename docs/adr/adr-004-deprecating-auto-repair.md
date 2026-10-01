> **Superseded:** this document describes the former V1/V2 architecture, which is no longer part of the active application. See the root `README.md` for the current architecture.

# ADR 004: Deprecating Auto-Repair

**Status:** Accepted

---

## Context

V1 included `bluswanRepairEngine.js` — a 1,400-line module with 40+ error codes, each with a multi-tier automatic repair strategy:

- `LINT_ERROR` → auto-run lint fix → re-read file → model re-call
- `TEST_FAILURE` → revert to last checkpoint → re-run with rollback
- `TYPE_ERROR` → insert type cast → model re-call → escalate to backup model
- `IMPORT_ERROR`, `SYNTAX_ERROR`, `RUNTIME_ERROR`, `BUILD_FAILURE` — each with 3 retries and exponential backoff

The repair engine ran silently inside every tool call. The user never saw it activate; they only received a final pass/fail after all tiers exhausted.

**Measured outcomes of the auto-repair model:**

- **40% of tokens** spent on repair loops that didn't converge
- **25% false-positive rollback rate** — legitimate refactors triggered safety rollbacks
- Errors that required human judgment (ambiguous type errors, architectural mismatches) were obscured by 9 automatic retry attempts before surfacing
- Backup model escalation added a new retry surface: the backup model could also enter a repair loop, creating nested repair recursion

---

## Decision

Delete `bluswanRepairEngine.js`. Replace with a classify-only module (`errorClassifier.js`) and shift repair decisions to the LLM.

**`errorClassifier.js` responsibilities:**
- Classify errors into typed categories: `lint`, `test_failure`, `type_error`, `build_failure`, `runtime_error`, `api_error`, `unknown`
- Determine fatality: `isFatal()` returns true for unrecoverable errors (malformed plan, missing required credentials, invalid phase transition)
- Format error context for the LLM prompt: structured description, suggested fix approaches, relevant file/line info
- No repair execution, no retry logic, no state resets

**Repair is now the LLM's responsibility:**
- The LLM sees the current remediation budget in its context (from `remediationBudget.js`)
- It chooses which fix action to take, knowing the cost of each
- It may decide not to fix a non-fatal error if the budget is low
- It cannot trigger escalation to a backup model — model selection is fixed at plan time

**V1 error codes retired:**
All 40+ V1 repair codes are replaced by the 7 classifier categories above. Individual error codes are not exposed in the public API.

The old `bluswanRepairEngine.js` is deleted, not archived. V1 tasks route through `src/services/agentLoop.js` which has its own inline retry (max 3, no budget tracking) — that path is unchanged and not affected by this decision.

---

## Consequences

### Positive

- **Errors surface immediately** — no silent 9-retry black box before the user sees a failure
- **Repair cost is explicit** — the LLM knows what each fix attempt costs and can prioritize
- **No repair recursion** — the classify-only model has no call stack depth issues
- **Simpler codebase** — 1,400 lines removed; `errorClassifier.js` is ~180 lines
- **Testable** — error classification is a pure function; easy to unit-test without simulating tool execution

### Negative

- **Transient errors cost budget** — network blips and rate-limit errors that auto-retry would have handled transparently now cost remediation units
- **Some V1 "eventually fixed" tasks will now surface warnings** — tasks that needed 8 retries to converge will complete with quality warnings instead
- **LLM must recognize fixable patterns** — without the repair engine's heuristics, the LLM's fix quality depends on good error context formatting from `errorClassifier.js`

---

## Related

- `src/core-v2/errorClassifier.js`
- `src/core-v2/remediationBudget.js`
- [ADR 002](./adr-002-bounded-remediation.md) — Bounded Remediation
- [ADR 005](./adr-005-quality-signals-vs-gates.md) — Quality Signals vs. Gates
