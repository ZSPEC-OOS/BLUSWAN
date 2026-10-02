# Changelog

All notable changes to BLUSWAN are documented in this file.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/)

---

## [3.0.0]

A rebuild around a single provider-neutral agent runtime.

### Added
- One agent loop with streaming tool use, cancellation, bounded recovery and a completion cycle that validates changes with the project's own checks.
- Providers: DeepSeek, Kimi, OpenAI and Anthropic behind one contract (capabilities, canonical events, normalized errors and usage), with a shared contract test suite and a provider-neutral evaluation harness.
- Workspace abstraction with safe file/search/patch/shell/git tools, conservative command classification, and permission modes (Ask, Auto Edit, Full Auto) with real approvals.
- Context engine: token budgeting, deterministic session summary, compaction, repository awareness.
- Validation engine: project detection, focused-then-broad plans, failure classification, stale-evidence tracking.
- Chat-first UI: sessions, streaming activity, permission prompts, Stop, changed files, unified diffs, command and validation details, single-file revert, responsive layout.
- Durable sessions: autosave, hydration, interrupted-run handling, workspace reconciliation, schema migrations; file, Firestore and memory backends.
- Authenticated server (HTTP + Server-Sent Events) holding all provider credentials.

### Removed
- The former V1/V2 execution engines, task/cycle dashboards, feature flags, browser-side provider-key storage, the unauthenticated dev command bridge, and the associated services, components, tests and Python orchestration prototypes.

### Security
- Provider keys are server-side only; browser storage holds none, and keys left by earlier versions are deleted at startup.

---

# Earlier history

The entries below describe the former V1/V2 architecture and are kept for reference only.

## [2.0.0] — 2026-05-14

### Summary

V2 replaces the V1 nested-loop architecture with a deterministic Task State Machine, bounded remediation budgets, and explicit context budget enforcement. The V1 execution path (`src/services/agentLoop.js`) is retained as a fallback and continues to work for existing integrations.

---

### Added

**Core V2 execution pipeline (`src/core-v2/`)**

- `taskStateMachine.js` — 11-phase forward-only Task State Machine (TSM) with explicit allowed-transitions table. Phases: `idle → planning → plan_review → cycle_prep → cycle_exec → cycle_validate → completion_check → completion_confirm → done / failed / halted`. Throws `InvalidPhaseTransitionError` on invalid transitions.
- `taskRunner.js` — Main entry point (`runTask`). Orchestrates the TSM, cycle engine, context packer, loop guards, and quality signals.
- `planContract.js` — Plan validation and freezing (`createPlanContract`). Plan version `2026.1`. Throws `PlanValidationError` on invalid plans.
- `cycleEngine.js` — Per-cycle turn management, tool restriction enforcement, cycle completion parsing.
- `contextBudget.js` — Token budget enforcement with reserved tiers and dynamic allocation. Throws `ContextBudgetError` on overflow instead of silently pruning.
- `contextPacker.js` — Assembles per-turn context from budget tiers. Deterministic: same inputs → same context shape.
- `loopPrevention.js` — Loop guards: `tool_sequence_repeat`, `read_without_action`, `command_repeat`, `deliverable_retry_exhausted`. Each guard fires a `halted` phase with a typed `haltReason`.
- `remediationBudget.js` — 100-unit remediation budget per task with fixed cost table. Full audit trail. Exhaustion completes the task with warnings rather than forcing failure.
- `errorClassifier.js` — Classify-only error handling (replaces `bluswanRepairEngine.js`). 7 error categories, fatality check, LLM-formatted error context.
- `completionGate.js` — Two-tier completion: blocking gates (deliverables exist, no syntax errors, task-critical tests pass) + non-blocking quality signals.
- `qualitySignals.js` — Non-blocking quality signal collection: lint, type check, coverage delta, bundle size delta, dependency audit.
- `validator.js` — Validation suite for per-cycle deliverable verification.
- `telemetry.js` — Structured telemetry sink. All task events emitted with type, phase, timestamp, and task ID.
- `repoIndex.js` — Repository map builder for context assembly.

**V2 service layer (`src/services-v2/`)**

- `agentExecutor.js` — Tool executor for V2 pipeline. Implements all tool handlers referenced in `src/tools/`.

**V2 UI components (`src/components-v2/`)**

- `TaskLanesV2.jsx` — Task lane view using TSM phase state.
- `BudgetBar.jsx` — Real-time context and remediation budget visualization.
- `TelemetryPanel.jsx` — Live event stream from the telemetry sink.
- `FeatureFlagPanel.jsx` — Dev-only flag toggle panel (hidden in production builds).

**Configuration**

- `src/config/featureFlags.js` — Runtime feature flags (`useV2Engine`, `useV2UI`) controlled via URL params and localStorage. No build-time flags required.

**Tests**

- `src/core-v2/tests/` — Unit tests for all V2 core modules (state machine, budgets, loop guards, context packer, error classifier, quality signals).
- `tests/integration/migration.test.mjs` — Integration tests for V1/V2 routing and flag composition.
- `tests/benchmarks/benchmarkRunner.mjs` — Scripted LLM benchmark utilities (`createScriptedLLM`, `createMockExecutor`, `createMockFileSystem`, `createMockCallbacks`).

**Documentation**

- `docs/adr/` — 5 Architecture Decision Records covering TSM, bounded remediation, context budget enforcement, deprecating auto-repair, and quality signals vs. gates.
- `docs/contributing/getting-started.md` — Contributor setup guide, feature flag activation, adding tools and quality signals.
- `docs/contributing/debugging.md` — Telemetry export, event types, common failure modes, benchmark runner usage.
- `docs/api/public-api.md` — Stable public API reference for `runTask`, `createPlanContract`, and all exported types.

---

### Changed

- `README.md` — Updated to reflect V2 architecture: Task State Machine, bounded budgets, context enforcement, and feature-flag-controlled rollout.
- `src/core-v2/index.js` — Centralized public API entry point with `@stable` JSDoc tags on all exported symbols.

---

### Deprecated

- `src/services/agentLoop.js` — V1 agent loop. Retained for fallback routing (when `useV2Engine` flag is off). Will be removed in a future major version.
- `src/services/reliability/fsm.js` — V1 reliability FSM. Retained alongside `agentLoop.js`.

---

### Removed

- `bluswanRepairEngine.js` — 1,400-line auto-repair module with 40+ error codes. Replaced by `errorClassifier.js` (classify-only) and the LLM-driven remediation budget.

---

### Fixed

- Loop rate reduced from ~30% to 0% via structural TSM enforcement.
- Token waste on auto-remediation reduced from ~40% to ≤10%.
- False-positive rollback rate reduced from ~25% to 0% (auto-rollback removed).
- Context window collapse eliminated via explicit budget tiers and `ContextBudgetError`.

---

## [1.x] — Earlier

V1 releases are not documented in this changelog. See git history for V1 change details.
