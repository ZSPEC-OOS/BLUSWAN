/**
 * @module taskRunner
 * Main orchestrator. Wires state machine, cycles, context, loop prevention,
 * and completion gates into a single async pipeline.
 */

import { createTaskState, transition, isTerminal } from './taskStateMachine.js';
import { buildRepoIndex, getFileContent, invalidateFile } from './repoIndex.js';
import { createCycle, checkCycleCompletion, enforceToolRestriction, recordTurn as recordCycleTurn, summarizeCycle } from './cycleEngine.js';
import { createContextBudget } from './contextBudget.js';
import { packCycleContext } from './contextPacker.js';
import { validatePlanCoverage, createPlanContract, markDeliverableComplete, PlanValidationError } from './planContract.js';
import { createLoopGuard, createTaskLoopGuard, checkToolSequence, checkFileRead, checkCommandRepeat, checkDeliverableProgress, checkDeliverableRetry, recordFailedDeliverable, recordTurn as recordLoopTurn } from './loopPrevention.js';
import { classifyError, isFatal, formatErrorForLLM } from './errorClassifier.js';
import { runSafetyGates, runCompletionGates } from './completionGate.js';
import { runQualitySignals } from './qualitySignals.js';
import { createTelemetrySink } from './telemetry.js';

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} TaskSpec
 * @property {string} taskId
 * @property {string} goal
 * @property {import('./planContract.js').ExecutionPlan} [plan]
 * @property {Object} [options]
 * @property {number} [options.maxCycles=3]
 * @property {number} [options.maxTurnsPerCycle=25]
 * @property {number} [options.contextWindow=128000]
 * @property {number} [options.remediationBudget=100]
 * @property {boolean} [options.requirePlanReview=false]
 * @property {boolean} [options.requireCompletionConfirm=false]
 */

/**
 * @typedef {Object} TaskResult
 * @property {import('./taskStateMachine.js').TaskPhase} phase
 * @property {import('./planContract.js').ExecutionPlan} plan
 * @property {import('./cycleEngine.js').ExecutionCycle[]} cycles
 * @property {import('./completionGate.js').CompletionGateResult} [completionGate]
 * @property {import('./completionGate.js').SafetyCheckResult} [safetyCheck]
 * @property {string} [failureReason]
 * @property {string} [haltReason]
 * @property {number} totalTokensUsed
 * @property {number} totalTurnsUsed
 * @property {number} totalTimeMs
 */

/**
 * @typedef {Object} TaskCallbacks
 * @property {(phase: string) => void} onPhaseChange
 * @property {(cycle: import('./cycleEngine.js').ExecutionCycle) => void} onCycleStart
 * @property {(cycle: import('./cycleEngine.js').ExecutionCycle, result: Object) => void} onCycleEnd
 * @property {(plan: import('./planContract.js').ExecutionPlan) => Promise<'approve'|'edit'|'reject'>} onPlanReview
 * @property {(state: Object, gateResult: Object) => Promise<'continue'|'accept'|'halt'>} onCompletionCheck
 * @property {(event: {type: string, data: any}) => void} onEvent
 * @property {(error: import('./errorClassifier.js').ClassifiedError) => void} onError
 * @property {(messages: Object[]) => Promise<string>} callLLM
 * @property {(name: string, input: Object) => Promise<string>} executeTool
 * @property {((report: Object) => void) | undefined} [onTelemetryFlush] - Optional; called when telemetry is flushed
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_OPTIONS = {
  maxCycles: 3,
  maxTurnsPerCycle: 25,
  contextWindow: 128000,
  remediationBudget: 100,
  requirePlanReview: false,
  requireCompletionConfirm: false,
  repoUrl: null,
  branch: null,
  token: null,
};

const BASE_ALLOWED_TOOLS = ['read_file', 'read_many_files', 'list_directory', 'search_files', 'grep'];

// ─── Telemetry Helpers ────────────────────────────────────────────────────────

/**
 * Extracts safe metadata from tool input (no file contents, no secrets).
 * @param {string} name
 * @param {Object} input
 * @returns {Object}
 */
function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return {};
  const safe = {};
  if (input.path) safe.path = input.path;
  if (input.file_path) safe.path = input.file_path;
  if (input.command) safe.command = String(input.command).slice(0, 120);
  if (input.url) safe.url = input.url;
  if (input.query) safe.query = String(input.query).slice(0, 80);
  return safe;
}
const NEVER_ALLOWED = new Set(['spawn_agent', 'revert_file']);

// ─── Planning Prompt ──────────────────────────────────────────────────────────

const PLAN_PROMPT = (goal) => `You are a software planning assistant. Generate an execution plan for the following task.

Task goal: ${goal}

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "version": "2026.1",
  "taskId": "auto-<timestamp>",
  "goal": "<goal>",
  "deliverables": [
    {
      "id": "deliv-1",
      "type": "edit",
      "path": "<path>",
      "description": "<description>",
      "acceptanceCriteria": "<criteria>",
      "completed": false
    }
  ],
  "dependencies": [],
  "validationSteps": [],
  "contextStrategy": {
    "maxTokensPerCycle": 80000,
    "includeRepoMap": true,
    "priorityFiles": []
  }
}

Rules:
- deliverable IDs must be unique
- version must be "2026.1"
- each deliverable must have id, type, description, and acceptanceCriteria
- type must be exactly one of: "file" (create new file), "edit" (modify existing file), "test" (run tests), "command" (run shell command)`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @param {import('./planContract.js').Deliverable[]} deliverables
 * @param {number} maxPerCycle
 * @returns {string[]} deliverable IDs for next cycle
 */
export function groupDeliverables(deliverables, maxPerCycle = 3) {
  const remaining = deliverables.filter((d) => !d.completed);
  if (remaining.length === 0) return [];

  // Group by path prefix (directory), then by type
  const byDir = new Map();
  for (const d of remaining) {
    const dir = d.path ? d.path.split('/').slice(0, -1).join('/') : '__root__';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(d);
  }

  // Pick the largest group first, up to maxPerCycle
  const groups = [...byDir.values()].sort((a, b) => b.length - a.length);
  const chosen = groups[0].slice(0, maxPerCycle);
  return chosen.map((d) => d.id);
}

/**
 * @param {import('./planContract.js').Deliverable[]} deliverables
 * @returns {string[]}
 */
export function getAllowedTools(deliverables) {
  const tools = new Set(BASE_ALLOWED_TOOLS);
  for (const d of deliverables) {
    if (d.type === 'file') tools.add('write_file');
    if (d.type === 'edit') tools.add('edit_file');
    if (d.type === 'test' || d.type === 'command') tools.add('run_command');
  }
  for (const t of NEVER_ALLOWED) tools.delete(t);
  return [...tools];
}

/**
 * Parses tool calls from an LLM message string.
 * Looks for JSON blocks or <tool> tags. Intentionally simple.
 *
 * @param {string} message
 * @returns {Array<{name: string, input: Object}>}
 */
export function parseToolCalls(message) {
  const calls = [];

  // Try JSON blocks: ```json { "tool": "name", "input": {...} } ```
  const jsonBlockRe = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  let m;
  while ((m = jsonBlockRe.exec(message)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj.tool && typeof obj.tool === 'string') {
        calls.push({ name: obj.tool, input: obj.input ?? obj.parameters ?? {} });
      }
    } catch { /* skip malformed */ }
  }

  // Try <tool_use> XML-ish blocks
  const toolUseRe = /<tool_use>\s*<name>([\w_]+)<\/name>\s*<input>([\s\S]*?)<\/input>\s*<\/tool_use>/g;
  while ((m = toolUseRe.exec(message)) !== null) {
    try {
      calls.push({ name: m[1], input: JSON.parse(m[2]) });
    } catch { /* skip */ }
  }

  return calls;
}

/**
 * Updates plan deliverables based on what was successfully done in a cycle.
 *
 * @param {import('./planContract.js').ExecutionPlan} plan
 * @param {import('./cycleEngine.js').ExecutionCycle} cycle
 * @returns {import('./planContract.js').ExecutionPlan}
 */
export function updateDeliverablesFromCycle(plan, cycle) {
  let updated = plan;
  for (const deliverable of plan.deliverables) {
    if (deliverable.completed) continue;
    const path = deliverable.path;
    const results = cycle.toolResults ?? [];

    let done = false;
    if (deliverable.type === 'file') {
      done = results.some((r) => r.toolName === 'write_file' && (r.input?.path === path) && !r.error);
    } else if (deliverable.type === 'edit') {
      done = results.some((r) => r.toolName === 'edit_file' && (r.input?.path === path || r.input?.file_path === path) && !r.error);
    } else if (deliverable.type === 'test' || deliverable.type === 'command') {
      done = results.some((r) => r.toolName === 'run_command' && !r.error);
    }

    if (done) {
      updated = markDeliverableComplete(updated, deliverable.id, { passed: true });
    }
  }
  return updated;
}

// ─── Cycle Turn Loop ──────────────────────────────────────────────────────────

/**
 * Runs the inner turn loop for a single cycle.
 *
 * @param {import('./cycleEngine.js').ExecutionCycle} cycle
 * @param {{messages: Object[]}} context
 * @param {TaskCallbacks} callbacks
 * @param {import('./contextBudget.js').ContextBudget} budget
 * @param {import('./planContract.js').Deliverable[]} deliverables
 * @param {import('./repoIndex.js').RepoIndex|null} [repoIndex]
 * @param {import('./telemetry.js').TelemetrySink} [telemetry]
 * @returns {Promise<{status: string, turnsUsed: number, cycle: import('./cycleEngine.js').ExecutionCycle, finalMessage?: string, haltReason?: string}>}
 */
async function runCycleTurns(cycle, context, callbacks, budget, deliverables, repoIndex = null, telemetry = null) {
  let loopGuard = cycle.loopGuard ?? createLoopGuard();
  let currentCycle = cycle;
  let currentContext = context;

  for (let turn = 1; turn <= cycle.maxTurns; turn++) {
    // Call LLM
    let assistantMessage;
    try {
      assistantMessage = await callbacks.callLLM(currentContext.messages);
    } catch (err) {
      const classified = classifyError(err);
      callbacks.onError(classified);
      if (isFatal(classified)) {
        return { status: 'failed', haltReason: classified.explanation, turnsUsed: turn, cycle: currentCycle };
      }
      continue;
    }

    // Parse tool calls
    const toolCalls = parseToolCalls(assistantMessage);

    // Check completion token
    if (assistantMessage.includes(currentCycle.completionProtocol.completionToken)) {
      const completionCheck = checkCycleCompletion(currentCycle, assistantMessage);
      if (completionCheck.completed) {
        return { status: 'completed', turnsUsed: turn, cycle: currentCycle, finalMessage: assistantMessage };
      }
    }

    // Execute tools
    const toolResults = [];
    for (const tc of toolCalls) {
      // Loop guard: check file reads
      if (tc.name === 'read_file' || tc.name === 'read_many_files') {
        const path = tc.input?.path ?? '';
        const readCheck = checkFileRead(loopGuard, path);
        if (readCheck.shouldHalt) {
          callbacks.onEvent({ type: 'loop_guard', data: readCheck });
          telemetry?.emit('loop.guard_trigger', cycle.taskId ?? '', { guardType: readCheck.guardType, reason: readCheck.reason }, { cycleNumber: cycle.cycleNumber, turnNumber: turn });
          return { status: 'halted', haltReason: readCheck.reason, guardType: readCheck.guardType, turnsUsed: turn, cycle: currentCycle };
        }
      }
      if (tc.name === 'run_command') {
        const cmd = tc.input?.command ?? '';
        const cmdCheck = checkCommandRepeat(loopGuard, cmd);
        if (cmdCheck.shouldHalt) {
          callbacks.onEvent({ type: 'loop_guard', data: cmdCheck });
          telemetry?.emit('loop.guard_trigger', cycle.taskId ?? '', { guardType: cmdCheck.guardType, reason: cmdCheck.reason }, { cycleNumber: cycle.cycleNumber, turnNumber: turn });
          return { status: 'halted', haltReason: cmdCheck.reason, guardType: cmdCheck.guardType, turnsUsed: turn, cycle: currentCycle };
        }
      }

      // Tool restriction
      try {
        enforceToolRestriction(currentCycle, tc.name);
      } catch (err) {
        const classified = classifyError(err);
        callbacks.onError(classified);
        toolResults.push({ toolName: tc.name, input: tc.input, output: '', error: classified.explanation, turnNumber: turn });
        continue;
      }

      // Execute
      let output;
      const toolStart = Date.now();
      telemetry?.emit('tool.call', cycle.taskId ?? '', { name: tc.name, inputSummary: summarizeInput(tc.name, tc.input) }, { cycleNumber: cycle.cycleNumber, turnNumber: turn });
      try {
        output = await callbacks.executeTool(tc.name, tc.input);
        const durationMs = Date.now() - toolStart;
        telemetry?.emit('tool.result', cycle.taskId ?? '', { name: tc.name, durationMs, isError: (output ?? '').startsWith('ERROR:') }, { cycleNumber: cycle.cycleNumber, turnNumber: turn });
      } catch (err) {
        const classified = classifyError(err);
        callbacks.onError(classified);
        output = `ERROR: ${classified.explanation}`;
        telemetry?.emit('tool.error', cycle.taskId ?? '', { name: tc.name, durationMs: Date.now() - toolStart, error: classified.explanation }, { cycleNumber: cycle.cycleNumber, turnNumber: turn });
      }

      toolResults.push({ toolName: tc.name, input: tc.input, output: output ?? '', turnNumber: turn });

      if ((output ?? '').startsWith('ERROR:')) {
        const classified = classifyError(new Error(output));
        callbacks.onError(classified);
      }

      // Repo index maintenance
      if (repoIndex) {
        if ((tc.name === 'write_file' || tc.name === 'edit_file') && tc.input?.path) {
          invalidateFile(repoIndex, tc.input.path);
        } else if (tc.name === 'read_file' && tc.input?.path && !(output ?? '').startsWith('ERROR:')) {
          // Pre-warm content cache so Tier 5 can use it synchronously
          if (!repoIndex.contentCache.has(tc.input.path)) {
            repoIndex.contentCache.set(tc.input.path, output ?? '');
          }
        }
      }
    }

    // Normalize { name, input } → { toolName, input } for cycleEngine / loopPrevention
    const normalizedCalls = toolCalls.map((tc) => ({ toolName: tc.name, input: tc.input }));

    // Record in cycle and loop guard
    currentCycle = recordCycleTurn(currentCycle, normalizedCalls, toolResults, assistantMessage);
    loopGuard = recordLoopTurn(loopGuard, normalizedCalls, toolResults);
    currentCycle = { ...currentCycle, loopGuard };

    // Check sequence repeats after recording
    if (normalizedCalls.length > 0) {
      const seqCheck = checkToolSequence(loopGuard, normalizedCalls);
      if (seqCheck.shouldHalt) {
        callbacks.onEvent({ type: 'loop_guard', data: seqCheck });
        telemetry?.emit('loop.guard_trigger', cycle.taskId ?? '', { guardType: seqCheck.guardType, reason: seqCheck.reason }, { cycleNumber: cycle.cycleNumber, turnNumber: turn });
        return { status: 'halted', haltReason: seqCheck.reason, guardType: seqCheck.guardType, turnsUsed: turn, cycle: currentCycle };
      }
    }

    // Repack context for next turn (pass repoIndex if available for Tier 4+5)
    currentContext = packCycleContext(budget, currentCycle, deliverables, currentCycle.toolResults, repoIndex);

    callbacks.onEvent({ type: 'turn_complete', data: { turn, turnsUsed: currentCycle.turnsUsed } });
  }

  return { status: 'failed', haltReason: 'Max turns exceeded', turnsUsed: cycle.maxTurns, cycle: currentCycle };
}

// ─── Plan Generation ──────────────────────────────────────────────────────────

/**
 * @param {string} goal
 * @param {TaskCallbacks} callbacks
 * @returns {Promise<import('./planContract.js').ExecutionPlan>}
 */
async function generatePlan(goal, callbacks) {
  const prompt = PLAN_PROMPT(goal);
  const messages = [{ role: 'user', content: prompt }];
  const response = await callbacks.callLLM(messages);

  // Extract JSON — strip markdown if present
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new PlanValidationError('LLM did not return valid JSON for plan', ['No JSON object found in response']);
  }

  let rawPlan;
  try {
    rawPlan = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new PlanValidationError('LLM returned malformed JSON', [err.message]);
  }

  // Auto-fill taskId if missing
  if (!rawPlan.taskId) rawPlan.taskId = `auto-${Date.now()}`;

  return createPlanContract(rawPlan);
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Runs a complete task from plan to completion.
 *
 * @param {TaskSpec} taskSpec
 * @param {TaskCallbacks} callbacks
 * @returns {Promise<TaskResult>}
 * @since 2.0.0
 * @stable
 */
export async function runTask(taskSpec, callbacks) {
  const startTime = Date.now();
  const opts = { ...DEFAULT_OPTIONS, ...(taskSpec.options ?? {}) };
  // onTelemetryFlush is optional — guard so callers that don't provide it don't break the sink
  const telemetryOpts = callbacks.onTelemetryFlush ? { onFlush: callbacks.onTelemetryFlush } : {};
  const telemetry = createTelemetrySink(telemetryOpts);
  telemetry.emit('task.start', taskSpec.taskId, { goal: taskSpec.goal });
  let contextBudget;
  try {
    contextBudget = createContextBudget(opts.contextWindow);
  } catch (err) {
    return {
      phase: 'failed',
      plan: taskSpec.plan ?? null,
      cycles: [],
      failureReason: `Context budget error: ${err.message}`,
      totalTokensUsed: 0,
      totalTurnsUsed: 0,
      totalTimeMs: Date.now() - startTime,
    };
  }

  let state = createTaskState(taskSpec.plan ?? /** placeholder */ { deliverables: [] }, {
    maxCycles: opts.maxCycles,
  });

  callbacks.onPhaseChange(state.phase);

  // ── Planning phase ────────────────────────────────────────────────────────
  let plan = taskSpec.plan ?? null;

  if (!plan) {
    const prevPhase = state.phase;
    state = transition(state, 'planning');
    telemetry.emit('task.phase_change', taskSpec.taskId, { from: prevPhase, to: state.phase });
    callbacks.onPhaseChange(state.phase);

    try {
      plan = await generatePlan(taskSpec.goal, callbacks);
    } catch (err) {
      const classified = classifyError(err);
      callbacks.onError(classified);
      return {
        phase: 'failed',
        plan: null,
        cycles: [],
        failureReason: `Plan generation failed: ${err.message}`,
        totalTokensUsed: 0,
        totalTurnsUsed: 0,
        totalTimeMs: Date.now() - startTime,
      };
    }

    state = { ...state, plan };
    state = transition(state, 'plan_review');
    callbacks.onPhaseChange(state.phase);

    if (opts.requirePlanReview) {
      const review = await callbacks.onPlanReview(state.plan);
      if (review === 'reject') {
        return {
          phase: 'failed',
          plan: state.plan,
          cycles: [],
          failureReason: 'Plan rejected by user',
          totalTokensUsed: 0,
          totalTurnsUsed: 0,
          totalTimeMs: Date.now() - startTime,
        };
      }
    }
  } else {
    // Pre-generated plan: still walk through planning → plan_review
    state = transition(state, 'planning');
    callbacks.onPhaseChange(state.phase);
    state = { ...state, plan };
    state = transition(state, 'plan_review');
    callbacks.onPhaseChange(state.phase);

    if (opts.requirePlanReview) {
      const review = await callbacks.onPlanReview(state.plan);
      if (review === 'reject') {
        return {
          phase: 'failed',
          plan: state.plan,
          cycles: [],
          failureReason: 'Plan rejected by user',
          totalTokensUsed: 0,
          totalTurnsUsed: 0,
          totalTimeMs: Date.now() - startTime,
        };
      }
    }
  }

  // ── Cycle execution ───────────────────────────────────────────────────────
  const allCycles = [];
  let totalTurnsUsed = 0;
  let totalTokensUsed = 0;
  let taskLoopGuard = createTaskLoopGuard();

  // Build repo index once per task (discarded after task completes)
  let repoIndex = null;
  if (opts.repoUrl && opts.branch) {
    try {
      repoIndex = await buildRepoIndex(opts.repoUrl, opts.branch, opts.token ?? '', opts._repoIndexOptions);
      callbacks.onEvent({ type: 'repo_index_ready', data: { files: repoIndex.fileTree.length } });
    } catch (err) {
      callbacks.onEvent({ type: 'repo_index_error', data: { message: err.message } });
      // Non-fatal: continue without repoIndex
    }
  }

  while (state.currentCycle + 1 < state.maxCycles) {
    const remaining = state.plan.deliverables.filter((d) => !d.completed);
    if (remaining.length === 0) break;

    const targetIds = groupDeliverables(remaining, 3);
    const targetDeliverables = state.plan.deliverables.filter((d) => targetIds.includes(d.id));
    const allowedTools = getAllowedTools(targetDeliverables);

    // Cycle numbers are 1-indexed (human-facing). currentCycle is about to become
    // currentCycle+1, so the 1-based number is (currentCycle+1)+1 = currentCycle+2.
    let cycle = createCycle(state.plan, state.currentCycle + 2, targetIds, allowedTools);

    state = transition(state, 'cycle_prep');
    callbacks.onPhaseChange(state.phase);

    const packed = packCycleContext(contextBudget, cycle, state.plan.deliverables, [], repoIndex);
    totalTokensUsed += packed.metadata.totalTokensEstimated;

    state = {
      ...state,
      currentCycle: state.currentCycle + 1,
      cycles: [...state.cycles, cycle],
    };
    state = transition(state, 'cycle_exec');
    callbacks.onPhaseChange(state.phase);
    callbacks.onCycleStart(cycle);
    telemetry.emit('task.cycle_start', taskSpec.taskId, { cycleNumber: cycle.cycleNumber, targetDeliverables: targetIds });

    const cycleRunResult = await runCycleTurns(
      cycle, packed, callbacks, contextBudget, state.plan.deliverables, repoIndex, telemetry
    );

    totalTurnsUsed += cycleRunResult.turnsUsed;
    const finishedCycle = { ...cycleRunResult.cycle, status: cycleRunResult.status };
    allCycles.push(finishedCycle);
    telemetry.emit('task.cycle_end', taskSpec.taskId, { cycleNumber: cycle.cycleNumber, status: cycleRunResult.status, turnsUsed: cycleRunResult.turnsUsed, haltReason: cycleRunResult.haltReason });

    state = transition(state, 'cycle_validate');
    callbacks.onPhaseChange(state.phase);
    callbacks.onCycleEnd(finishedCycle, cycleRunResult);

    // Update plan deliverables
    state = { ...state, plan: updateDeliverablesFromCycle(state.plan, finishedCycle) };

    // Cross-cycle retry check: halt if any target deliverable keeps failing
    if (cycleRunResult.status !== 'completed') {
      for (const delivId of targetIds) {
        const deliv = state.plan.deliverables.find((d) => d.id === delivId && !d.completed);
        if (deliv) {
          const { taskGuard: updatedGuard, result } = checkDeliverableRetry(taskLoopGuard, delivId);
          taskLoopGuard = updatedGuard;
          if (result.shouldHalt) {
            state = transition(state, 'halted');
            callbacks.onPhaseChange(state.phase);
            return {
              phase: 'halted',
              plan: state.plan,
              cycles: allCycles,
              haltReason: result.reason,
              guardType: result.guardType,
              totalTokensUsed,
              totalTurnsUsed,
              totalTimeMs: Date.now() - startTime,
            };
          }
        }
      }
    }

    if (cycleRunResult.status === 'halted') {
      state = transition(state, 'halted');
      callbacks.onPhaseChange(state.phase);
      return {
        phase: 'halted',
        plan: state.plan,
        cycles: allCycles,
        haltReason: cycleRunResult.haltReason,
        guardType: cycleRunResult.guardType,
        totalTokensUsed,
        totalTurnsUsed,
        totalTimeMs: Date.now() - startTime,
      };
    }

    const coverage = validatePlanCoverage(state.plan);
    if (coverage.complete) break;
  }

  // ── Completion check ──────────────────────────────────────────────────────
  state = transition(state, 'completion_check');
  callbacks.onPhaseChange(state.phase);

  const safetyCheck = await runSafetyGates(state.plan, allCycles, callbacks.executeTool);

  if (!safetyCheck.passed) {
    state = transition(state, 'failed');
    callbacks.onPhaseChange(state.phase);
    return {
      phase: 'failed',
      plan: state.plan,
      cycles: allCycles,
      safetyCheck,
      failureReason: `Safety gate blocked: ${safetyCheck.blockedReason}`,
      totalTokensUsed,
      totalTurnsUsed,
      totalTimeMs: Date.now() - startTime,
    };
  }

  const completionGate = await runCompletionGates(state.plan, allCycles, callbacks.executeTool);

  if (!completionGate.passed) {
    state = transition(state, 'failed');
    callbacks.onPhaseChange(state.phase);
    return {
      phase: 'failed',
      plan: state.plan,
      cycles: allCycles,
      completionGate,
      safetyCheck,
      failureReason: `Completion gate failed: ${completionGate.reason}`,
      totalTokensUsed,
      totalTurnsUsed,
      totalTimeMs: Date.now() - startTime,
    };
  }

  // ── completion_confirm (always required before done) ──────────────────────
  state = transition(state, 'completion_confirm');
  callbacks.onPhaseChange(state.phase);

  if (opts.requireCompletionConfirm) {
    const confirm = await callbacks.onCompletionCheck(state, completionGate);
    if (confirm === 'halt') {
      state = transition(state, 'halted');
      callbacks.onPhaseChange(state.phase);
      return {
        phase: 'halted',
        plan: state.plan,
        cycles: allCycles,
        haltReason: 'User halted at completion',
        totalTokensUsed,
        totalTurnsUsed,
        totalTimeMs: Date.now() - startTime,
      };
    }
  }

  state = transition(state, 'done');
  callbacks.onPhaseChange(state.phase);

  // Emit validation step results as telemetry
  for (const vr of completionGate.validationResults ?? []) {
    telemetry.emit('validation.run', taskSpec.taskId, { step: vr.id, passed: vr.passed, durationMs: vr.durationMs });
  }

  // Run quality signals post-completion (advisory only — never blocks)
  let qualityReport = null;
  try {
    qualityReport = await runQualitySignals(
      state.plan,
      allCycles,
      repoIndex,
      callbacks.executeTool,
      completionGate.validationResults ?? []
    );
    for (const sig of qualityReport.signals ?? []) {
      telemetry.emit('quality.signal', taskSpec.taskId, { name: sig.id, status: sig.status });
    }
    callbacks.onEvent({ type: 'quality_report', data: qualityReport });
  } catch {
    // Non-fatal — quality signals must never block task completion
  }

  const totalTimeMs = Date.now() - startTime;
  telemetry.emit('task.done', taskSpec.taskId, { durationMs: totalTimeMs });

  return {
    phase: 'done',
    plan: state.plan,
    cycles: allCycles,
    completionGate,
    safetyCheck,
    qualityReport,
    totalTokensUsed,
    totalTurnsUsed,
    totalTimeMs,
    telemetryReport: telemetry.exportReport(taskSpec.taskId),
  };
}
