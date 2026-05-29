/**
 * @module taskStateMachine
 * Forward-only deterministic state machine for task execution.
 * No backward transitions. No restarts. Phase history is append-only.
 */

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {'idle'|'planning'|'plan_review'|'cycle_prep'|'cycle_exec'|'cycle_validate'|'completion_check'|'completion_confirm'|'done'|'failed'|'halted'} TaskPhase
 */

/**
 * @typedef {Object} ContextBudget
 * @property {number} maxTokensPerCycle
 * @property {number} [usedTokens]
 */

/**
 * @typedef {Object} RemediationBudget
 * @property {number} maxSpend
 * @property {number} [spent]
 */

/**
 * @typedef {Object} CompletionGateResult
 * @property {boolean} passed
 * @property {string} [reason]
 * @property {string} checkedAt
 */

/**
 * @typedef {Object} PhaseHistoryEntry
 * @property {TaskPhase} phase
 * @property {string} at - ISO timestamp
 */

/**
 * @typedef {Object} TaskState
 * @property {TaskPhase} phase
 * @property {import('./planContract.js').ExecutionPlan} plan
 * @property {import('./cycleEngine.js').ExecutionCycle[]} cycles
 * @property {number} currentCycle - 0-indexed, -1 if not started
 * @property {number} maxCycles - HARD LIMIT
 * @property {CompletionGateResult[]} completionGates
 * @property {ContextBudget} contextBudget
 * @property {RemediationBudget} remediationBudget
 * @property {PhaseHistoryEntry[]} phaseHistory
 * @property {string} [haltReason]
 */

// ─── Phase Transition Graph ───────────────────────────────────────────────────

/** @type {Map<TaskPhase, Set<TaskPhase>>} */
const ALLOWED_TRANSITIONS = new Map([
  ['idle',              new Set(['planning', 'halted'])],
  ['planning',          new Set(['plan_review', 'halted'])],
  ['plan_review',       new Set(['cycle_prep', 'halted'])],
  ['cycle_prep',        new Set(['cycle_exec', 'halted'])],
  ['cycle_exec',        new Set(['cycle_validate', 'halted'])],
  ['cycle_validate',    new Set(['cycle_prep', 'completion_check', 'failed', 'halted'])],
  ['completion_check',  new Set(['completion_confirm', 'failed', 'halted'])],
  ['completion_confirm',new Set(['done', 'halted'])],
  ['done',              new Set()],
  ['failed',            new Set()],
  ['halted',            new Set()],
]);

const TERMINAL_PHASES = new Set(['done', 'failed', 'halted']);

// ─── Custom Errors ────────────────────────────────────────────────────────────

export class InvalidPhaseTransitionError extends Error {
  /**
   * @param {TaskPhase} from
   * @param {TaskPhase} to
   */
  constructor(from, to) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = 'InvalidPhaseTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class MaxCyclesExceededError extends Error {
  /** @param {number} maxCycles */
  constructor(maxCycles) {
    super(`Cannot begin new cycle: maxCycles (${maxCycles}) already reached`);
    this.name = 'MaxCyclesExceededError';
    this.maxCycles = maxCycles;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** @returns {string} */
function now() {
  return new Date().toISOString();
}

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * @param {TaskPhase} fromPhase
 * @param {TaskPhase} toPhase
 * @returns {boolean}
 */
export function canTransition(fromPhase, toPhase) {
  const allowed = ALLOWED_TRANSITIONS.get(fromPhase);
  return allowed ? allowed.has(toPhase) : false;
}

/**
 * Returns a new state with the phase advanced.
 * Throws InvalidPhaseTransitionError on illegal transitions.
 *
 * @param {TaskState} state
 * @param {TaskPhase} nextPhase
 * @returns {TaskState}
 */
export function transition(state, nextPhase) {
  if (!canTransition(state.phase, nextPhase)) {
    throw new InvalidPhaseTransitionError(state.phase, nextPhase);
  }
  return {
    ...state,
    phase: nextPhase,
    phaseHistory: [
      ...state.phaseHistory,
      { phase: nextPhase, at: now() },
    ],
  };
}

/**
 * @param {TaskState} state
 * @returns {PhaseHistoryEntry[]}
 */
export function getPhaseHistory(state) {
  return state.phaseHistory.slice();
}

/**
 * @param {TaskState} state
 * @returns {boolean}
 */
export function isTerminal(state) {
  return TERMINAL_PHASES.has(state.phase);
}

/**
 * @param {TaskState} state
 * @returns {Array<{id: string, completed: boolean, inCurrentCycle: boolean}>}
 */
export function getDeliverablesStatus(state) {
  const currentCycleDeliverables = state.currentCycle >= 0 && state.cycles[state.currentCycle]
    ? new Set(state.cycles[state.currentCycle].targetDeliverables)
    : new Set();

  return state.plan.deliverables.map((d) => ({
    id: d.id,
    completed: d.completed,
    inCurrentCycle: currentCycleDeliverables.has(d.id),
  }));
}

/**
 * Creates initial task state in the 'idle' phase.
 *
 * @param {import('./planContract.js').ExecutionPlan} plan
 * @param {Object} [options]
 * @param {number} [options.maxCycles=3]
 * @param {ContextBudget} [options.contextBudget]
 * @param {RemediationBudget} [options.remediationBudget]
 * @returns {TaskState}
 */
export function createTaskState(plan, options = {}) {
  const maxCycles = options.maxCycles ?? 3;
  return {
    phase: 'idle',
    plan,
    cycles: [],
    currentCycle: -1,
    maxCycles,
    completionGates: [],
    contextBudget: options.contextBudget ?? { maxTokensPerCycle: 80000, usedTokens: 0 },
    remediationBudget: options.remediationBudget ?? { maxSpend: 100, spent: 0 },
    phaseHistory: [{ phase: 'idle', at: now() }],
  };
}

// ─── TaskStateMachine Class ───────────────────────────────────────────────────

export class TaskStateMachine {
  /** @param {TaskState} initialState */
  constructor(initialState) {
    /** @type {TaskState} */
    this._state = initialState;
  }

  /** @returns {TaskState} */
  get state() {
    return this._state;
  }

  /**
   * Transitions idle → planning → plan_review.
   * @param {import('./planContract.js').ExecutionPlan} plan
   * @returns {TaskState}
   */
  start(plan) {
    this._state = transition(this._state, 'planning');
    this._state = { ...this._state, plan };
    this._state = transition(this._state, 'plan_review');
    return this._state;
  }

  /**
   * Transitions plan_review or cycle_validate → cycle_prep → cycle_exec.
   * Attaches the cycle to the state.
   *
   * @param {import('./cycleEngine.js').ExecutionCycle} cycle
   * @returns {TaskState}
   */
  beginCycle(cycle) {
    const nextCycleIndex = this._state.currentCycle + 1;
    if (nextCycleIndex >= this._state.maxCycles) {
      throw new MaxCyclesExceededError(this._state.maxCycles);
    }

    this._state = transition(this._state, 'cycle_prep');
    this._state = {
      ...this._state,
      currentCycle: nextCycleIndex,
      cycles: [...this._state.cycles, cycle],
    };
    this._state = transition(this._state, 'cycle_exec');
    return this._state;
  }

  /**
   * Transitions cycle_exec → cycle_validate.
   * Updates the current cycle's result.
   *
   * @param {Partial<import('./cycleEngine.js').ExecutionCycle>} cycleResult
   * @returns {TaskState}
   */
  endCycle(cycleResult) {
    const cycles = this._state.cycles.map((c, i) =>
      i === this._state.currentCycle ? { ...c, ...cycleResult } : c
    );
    this._state = transition(this._state, 'cycle_validate');
    this._state = { ...this._state, cycles };
    return this._state;
  }

  /**
   * Transitions cycle_validate → completion_check → completion_confirm or failed.
   *
   * @param {CompletionGateResult} gateResult
   * @returns {TaskState}
   */
  runCompletionGate(gateResult) {
    this._state = transition(this._state, 'completion_check');
    this._state = {
      ...this._state,
      completionGates: [...this._state.completionGates, gateResult],
    };

    if (gateResult.passed) {
      this._state = transition(this._state, 'completion_confirm');
    } else {
      this._state = transition(this._state, 'failed');
    }
    return this._state;
  }

  /**
   * Halts from any non-terminal phase.
   *
   * @param {string} reason
   * @returns {TaskState}
   */
  halt(reason) {
    if (isTerminal(this._state)) return this._state;
    this._state = transition(this._state, 'halted');
    this._state = { ...this._state, haltReason: reason };
    return this._state;
  }

  /**
   * Factory: creates a TaskStateMachine pre-loaded with a plan, at idle.
   *
   * @param {import('./planContract.js').ExecutionPlan} plan
   * @param {Object} [options]
   * @returns {TaskStateMachine}
   */
  static create(plan, options = {}) {
    return new TaskStateMachine(createTaskState(plan, options));
  }
}
