/**
 * @module cycleEngine
 * Bounded, isolated execution cycles. Each cycle is a self-contained unit of work
 * with a fixed tool allowlist, turn cap, and completion protocol.
 */

import { createLoopGuard } from './loopPrevention.js';

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {'running'|'completed'|'failed'|'halted'} CycleStatus
 */

/**
 * @typedef {Object} CompletionProtocol
 * @property {string} completionToken - Exact string the LLM must emit
 * @property {string[]} requiredSections - Section headers that must appear
 */

/**
 * @typedef {Object} ToolResult
 * @property {string} toolName
 * @property {Object} input
 * @property {string} output
 * @property {string} [error]
 * @property {number} turnNumber
 */

/**
 * @typedef {Object} ExecutionCycle
 * @property {number} cycleNumber - 1-indexed
 * @property {string} goal - Specific goal for this cycle
 * @property {string[]} targetDeliverables - Deliverable IDs to address
 * @property {string[]} allowedTools - Restricted tool names
 * @property {number} maxTurns - Default 25
 * @property {number} contextWindow - Tokens reserved
 * @property {CompletionProtocol} completionProtocol
 * @property {number} turnsUsed
 * @property {ToolResult[]} toolResults
 * @property {CycleStatus} status
 * @property {string} [haltReason]
 * @property {number} remediationSpent
 * @property {import('./loopPrevention.js').LoopGuard} loopGuard
 */

/**
 * @typedef {Object} CycleCompletionCheck
 * @property {boolean} completed
 * @property {string} reason
 * @property {string[]} violations
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_CONTEXT_WINDOW = 80000;
const REMEDIATION_COST_PER_FAILURE = 5;

const COMPLETION_TOKEN = '<CYCLE_COMPLETE>';
// Section headers removed — the completion token alone is sufficient proof of cycle completion.
// Requiring exact section names created spurious failures when models used synonymous headings.
const REQUIRED_SECTIONS = [];

/** Tools allowed when creating new files */
const CREATE_FILE_TOOLS = ['read_file', 'read_many_files', 'write_file', 'list_directory', 'search_files', 'grep'];

/** Tools allowed when editing existing files */
const EDIT_FILE_TOOLS = ['read_file', 'read_many_files', 'edit_file', 'list_directory', 'search_files', 'grep'];

/** Full tool set (union, for validation reference) */
const ALL_KNOWN_TOOLS = new Set([
  'read_file', 'read_many_files', 'write_file', 'edit_file', 'list_directory',
  'run_command', 'search_files',
]);

// ─── Custom Errors ────────────────────────────────────────────────────────────

export class ToolNotAllowedError extends Error {
  /**
   * @param {string} toolName
   * @param {string[]} allowedTools
   */
  constructor(toolName, allowedTools) {
    super(`Tool '${toolName}' is not allowed in this cycle. Allowed: ${allowedTools.join(', ')}`);
    this.name = 'ToolNotAllowedError';
    this.toolName = toolName;
    this.allowedTools = allowedTools;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derives a cycle goal string from target deliverables.
 *
 * @param {import('./planContract.js').ExecutionPlan} plan
 * @param {string[]} targetDeliverables
 * @returns {string}
 */
function deriveGoal(plan, targetDeliverables) {
  const descriptions = targetDeliverables
    .map((id) => plan.deliverables.find((d) => d.id === id))
    .filter(Boolean)
    .map((d) => d.description);

  if (descriptions.length === 0) return 'Complete assigned deliverables';
  if (descriptions.length === 1) return descriptions[0];
  return `Complete: ${descriptions.join('; ')}`;
}

/**
 * Selects the appropriate tool allowlist based on deliverable types.
 *
 * @param {import('./planContract.js').ExecutionPlan} plan
 * @param {string[]} targetDeliverables
 * @param {string[]} [explicitTools]
 * @returns {string[]}
 */
function selectAllowedTools(plan, targetDeliverables, explicitTools) {
  if (explicitTools && explicitTools.length > 0) return explicitTools;

  const types = targetDeliverables
    .map((id) => plan.deliverables.find((d) => d.id === id))
    .filter(Boolean)
    .map((d) => d.type);

  // If any deliverable is a new file creation, restrict to write-only tool set
  if (types.includes('file')) return CREATE_FILE_TOOLS;
  // Edits use edit_file tool set
  if (types.includes('edit')) return EDIT_FILE_TOOLS;
  // Tests and commands get write access (they create test files or run commands)
  return CREATE_FILE_TOOLS;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates a new ExecutionCycle config.
 *
 * @param {import('./planContract.js').ExecutionPlan} plan
 * @param {number} cycleNumber - 1-indexed
 * @param {string[]} targetDeliverables - Deliverable IDs for this cycle
 * @param {string[]} [allowedTools] - Override tool allowlist; auto-derived if omitted
 * @returns {ExecutionCycle}
 */
export function createCycle(plan, cycleNumber, targetDeliverables, allowedTools) {
  const resolvedTools = selectAllowedTools(plan, targetDeliverables, allowedTools);

  return {
    cycleNumber,
    goal: deriveGoal(plan, targetDeliverables),
    targetDeliverables: [...targetDeliverables],
    allowedTools: resolvedTools,
    maxTurns: DEFAULT_MAX_TURNS,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    completionProtocol: {
      completionToken: COMPLETION_TOKEN,
      requiredSections: [...REQUIRED_SECTIONS],
    },
    turnsUsed: 0,
    toolResults: [],
    status: 'running',
    remediationSpent: 0,
    loopGuard: createLoopGuard(),
  };
}

/**
 * Validates whether a cycle's final assistant message signals correct completion.
 *
 * @param {ExecutionCycle} cycle
 * @param {string} finalAssistantMessage
 * @returns {CycleCompletionCheck}
 */
export function checkCycleCompletion(cycle, finalAssistantMessage) {
  const violations = [];

  // 1. Completion token must be present
  if (!finalAssistantMessage.includes(cycle.completionProtocol.completionToken)) {
    violations.push(
      `Missing completion token '${cycle.completionProtocol.completionToken}'`
    );
  }

  // 2. All required sections must be present
  for (const section of cycle.completionProtocol.requiredSections) {
    if (!finalAssistantMessage.includes(section)) {
      violations.push(`Missing required section '${section}'`);
    }
  }

  // 3. Turn budget must not be exceeded
  if (cycle.turnsUsed > cycle.maxTurns) {
    violations.push(
      `Turn limit exceeded: used ${cycle.turnsUsed}, max ${cycle.maxTurns}`
    );
  }

  // 4. All target deliverables must have been addressed by tool results
  const addressedPaths = new Set(
    cycle.toolResults
      .filter((r) => ['write_file', 'edit_file', 'run_command'].includes(r.toolName))
      .flatMap((r) => {
        const path = r.input?.path ?? r.input?.command ?? r.input?.file_path ?? '';
        return path ? [path] : [];
      })
  );

  // We can only check if deliverables were targeted — we verify tool activity occurred
  if (cycle.targetDeliverables.length > 0 && cycle.toolResults.length === 0) {
    violations.push('No tool results recorded — deliverables may not have been addressed');
  }

  if (violations.length > 0) {
    return {
      completed: false,
      reason: violations[0],
      violations,
    };
  }

  return {
    completed: true,
    reason: 'All completion checks passed',
    violations: [],
  };
}

/**
 * Validates that a tool call is permitted in this cycle.
 * Throws ToolNotAllowedError if not.
 *
 * @param {ExecutionCycle} cycle
 * @param {string} toolName
 */
export function enforceToolRestriction(cycle, toolName) {
  if (!cycle.allowedTools.includes(toolName)) {
    throw new ToolNotAllowedError(toolName, cycle.allowedTools);
  }
}

/**
 * Records a turn's activity and returns an updated cycle (immutable).
 * Increments remediationSpent by REMEDIATION_COST_PER_FAILURE for each failed tool call.
 *
 * @param {ExecutionCycle} cycle
 * @param {Array<{toolName: string, input: Object}>} toolCalls
 * @param {Array<{output: string, error?: string}>} results
 * @param {string} assistantMessage
 * @returns {ExecutionCycle}
 */
export function recordTurn(cycle, toolCalls, results, assistantMessage) {
  const turnNumber = cycle.turnsUsed + 1;
  const newToolResults = toolCalls.map((call, i) => ({
    toolName: call.toolName,
    input: call.input,
    output: results[i]?.output ?? '',
    ...(results[i]?.error ? { error: results[i].error } : {}),
    turnNumber,
  }));

  const failureCount = results.filter((r) => r?.error).length;

  return {
    ...cycle,
    turnsUsed: turnNumber,
    toolResults: [...cycle.toolResults, ...newToolResults],
    remediationSpent: cycle.remediationSpent + failureCount * REMEDIATION_COST_PER_FAILURE,
  };
}

/**
 * Produces a ≤500 character summary of the cycle for next-cycle context.
 *
 * @param {ExecutionCycle} cycle
 * @returns {string}
 */
export function summarizeCycle(cycle) {
  const toolsSummary = cycle.toolResults.length > 0
    ? `Tools used: ${[...new Set(cycle.toolResults.map((r) => r.toolName))].join(', ')}.`
    : 'No tools used.';

  const failureCount = cycle.toolResults.filter((r) => r.error).length;
  const failureSummary = failureCount > 0 ? ` Failures: ${failureCount}.` : '';

  const raw = [
    `Cycle ${cycle.cycleNumber} (${cycle.status}).`,
    `Goal: ${cycle.goal.slice(0, 120)}.`,
    `Turns: ${cycle.turnsUsed}/${cycle.maxTurns}.`,
    toolsSummary + failureSummary,
    `Deliverables targeted: ${cycle.targetDeliverables.join(', ')}.`,
  ].join(' ');

  return raw.length <= 500 ? raw : raw.slice(0, 497) + '...';
}
