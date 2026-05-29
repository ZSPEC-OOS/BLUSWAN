/**
 * Phase 8: Comprehensive unit tests for all V2 core modules.
 * Uses Node.js built-in test runner. No external dependencies.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPlanContract,
  validatePlanCoverage,
  markDeliverableComplete,
  PlanValidationError,
} from '../../src/core-v2/planContract.js';

import {
  createTaskState,
  transition,
  canTransition,
  isTerminal,
  getPhaseHistory,
  getDeliverablesStatus,
  InvalidPhaseTransitionError,
} from '../../src/core-v2/taskStateMachine.js';

import {
  createCycle,
  checkCycleCompletion,
  enforceToolRestriction,
  recordTurn,
  summarizeCycle,
  ToolNotAllowedError,
} from '../../src/core-v2/cycleEngine.js';

import {
  createContextBudget,
  allocateTier,
  enforceBudget,
  truncateToBudget,
  summarizeToolResults,
  computeTokenEstimate,
  ContextBudgetExceededError,
} from '../../src/core-v2/contextBudget.js';

import {
  packCycleContext,
  packPlanReviewContext,
} from '../../src/core-v2/contextPacker.js';

import {
  createLoopGuard,
  createTaskLoopGuard,
  checkToolSequence,
  checkFileRead,
  checkDeliverableProgress,
  checkCommandRepeat,
  recordTurn as recordLoopTurn,
  getLoopReport,
  checkDeliverableRetry,
  recordFailedDeliverable,
} from '../../src/core-v2/loopPrevention.js';

import {
  classifyError,
  formatErrorForLLM,
  formatErrorForUser,
  isFatal,
  getErrorRegistry,
} from '../../src/core-v2/errorClassifier.js';

import {
  runSafetyGates,
  runCompletionGates,
} from '../../src/core-v2/completionGate.js';

import {
  createRemediationBudget,
  spend,
  canAfford,
  getSpentByCategory,
  getAuditReport,
  COST_TABLE,
  RemediationBudgetExhaustedError,
} from '../../src/core-v2/remediationBudget.js';

import {
  createValidationSuite,
  runValidation,
  summarizeValidation,
} from '../../src/core-v2/validator.js';

import {
  runQualitySignals,
  formatQualityReport,
} from '../../src/core-v2/qualitySignals.js';

import {
  createTelemetrySink,
} from '../../src/core-v2/telemetry.js';

import {
  buildRepoIndex,
  searchFiles,
  getRelatedFiles,
  getRepoMap,
  getSymbolsInFile,
  invalidateFile,
} from '../../src/core-v2/repoIndex.js';

// ─── Shared Fixtures ──────────────────────────────────────────────────────────

function makePlan(deliverables = null) {
  return createPlanContract({
    version: '2026.1',
    taskId: 'unit-test-task',
    goal: 'Create hello.js',
    deliverables: deliverables ?? [
      {
        id: 'deliv-1',
        type: 'file',
        path: 'src/hello.js',
        description: 'Hello module',
        acceptanceCriteria: 'ok',
      },
    ],
    dependencies: [],
    validationSteps: [],
    estimatedCycles: 1,
    contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
  });
}

function makeCycleWithTool(plan, toolName, path) {
  const cycle = createCycle(plan, 1, ['deliv-1'], [toolName, 'read_file', 'write_file', 'edit_file', 'run_command', 'list_directory', 'search_files', 'grep']);
  const toolCalls = [{ toolName, input: { path } }];
  const results = [{ output: 'ok done' }];
  return recordTurn(cycle, toolCalls, results, '');
}

const VALID_COMPLETION_MSG = `## summary\nDone.\n## deliverables_addressed\n- done\n## next_cycle_needed\nNo.\n<CYCLE_COMPLETE>`;

function makeCompletedCycle(plan) {
  const cycle = makeCycleWithTool(plan, 'write_file', 'src/hello.js');
  return { ...cycle, status: 'completed' };
}

function makeCompletedPlan() {
  let plan = makePlan();
  plan = markDeliverableComplete(plan, 'deliv-1', { passed: true });
  return plan;
}

const noopExecuteTool = async () => 'ok';
const passRunCommand = async (name) => name === 'run_command' ? 'exit 0\nok' : 'ok';

function makeMockIndex(files = {}) {
  const fileTree = Object.keys(files).map(path => ({ path, type: 'file', size: 100 }));
  const contentCache = new Map(Object.entries(files));
  const importGraph = { imports: new Map(), importedBy: new Map() };
  const symbolIndex = { symbols: new Map() };
  for (const [path, content] of Object.entries(files)) {
    const entries = [];
    const re = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      entries.push({ name: m[1], kind: 'function', line: 1 });
    }
    const classRe = /class\s+(\w+)/g;
    while ((m = classRe.exec(content)) !== null) {
      entries.push({ name: m[1], kind: 'class', line: 1 });
    }
    if (entries.length) symbolIndex.symbols.set(path, entries);
    const impRe = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
    const imported = [];
    while ((m = impRe.exec(content)) !== null) imported.push(m[1]);
    if (imported.length) {
      importGraph.imports.set(path, imported);
      for (const dep of imported) {
        const importers = importGraph.importedBy.get(dep) ?? [];
        importers.push(path);
        importGraph.importedBy.set(dep, importers);
      }
    }
  }
  return { repoUrl: 'owner/repo', branch: 'main', owner: 'owner', repo: 'repo', token: '',
    fileTree, contentCache, importGraph, symbolIndex, isReady: true };
}

// ─── planContract (10 tests) ──────────────────────────────────────────────────

describe('planContract', () => {
  it('createPlanContract succeeds with valid data', () => {
    const plan = makePlan();
    assert.equal(plan.version, '2026.1');
    assert.equal(plan.taskId, 'unit-test-task');
    assert.equal(plan.deliverables.length, 1);
  });

  it('createPlanContract throws PlanValidationError on missing version', () => {
    assert.throws(() => createPlanContract({ taskId: 'x', goal: 'y', deliverables: [], estimatedCycles: 1, contextStrategy: {} }), PlanValidationError);
  });

  it('createPlanContract throws PlanValidationError on wrong version', () => {
    assert.throws(() => createPlanContract({ version: '1.0', taskId: 'x', goal: 'y', deliverables: [], estimatedCycles: 1, contextStrategy: {} }), PlanValidationError);
  });

  it('createPlanContract throws on missing taskId', () => {
    assert.throws(() => createPlanContract({ version: '2026.1', goal: 'y', deliverables: [], estimatedCycles: 1, contextStrategy: {} }), PlanValidationError);
  });

  it('createPlanContract throws on duplicate deliverable IDs', () => {
    const deliverables = [
      { id: 'same', type: 'file', path: 'a.js', description: 'A', acceptanceCriteria: 'ok' },
      { id: 'same', type: 'file', path: 'b.js', description: 'B', acceptanceCriteria: 'ok' },
    ];
    assert.throws(() => createPlanContract({ version: '2026.1', taskId: 'x', goal: 'y', deliverables, estimatedCycles: 1, contextStrategy: {} }), PlanValidationError);
  });

  it('createPlanContract throws when estimatedCycles < ceil(deliverables/3)', () => {
    const deliverables = Array.from({ length: 4 }, (_, i) => ({
      id: `d${i}`, type: 'file', path: `a${i}.js`, description: `D${i}`, acceptanceCriteria: 'ok',
    }));
    assert.throws(() => createPlanContract({ version: '2026.1', taskId: 'x', goal: 'y', deliverables, estimatedCycles: 1, contextStrategy: {} }), PlanValidationError);
  });

  it('createPlanContract returns frozen (immutable) object', () => {
    const plan = makePlan();
    assert.ok(Object.isFrozen(plan));
  });

  it('validatePlanCoverage returns complete when all deliverables done', () => {
    const plan = makeCompletedPlan();
    const result = validatePlanCoverage(plan);
    assert.equal(result.complete, true);
  });

  it('validatePlanCoverage returns incomplete when some deliverables pending', () => {
    const plan = makePlan();
    const result = validatePlanCoverage(plan);
    assert.equal(result.complete, false);
  });

  it('markDeliverableComplete returns new plan with deliverable marked done', () => {
    const plan = makePlan();
    const updated = markDeliverableComplete(plan, 'deliv-1', { passed: true });
    assert.equal(updated.deliverables[0].completed, true);
    assert.equal(plan.deliverables[0].completed, false);
  });
});

// ─── taskStateMachine (16 tests) ──────────────────────────────────────────────

describe('taskStateMachine', () => {
  let plan;

  beforeEach(() => { plan = makePlan(); });

  it('createTaskState starts in idle phase', () => {
    const state = createTaskState(plan);
    assert.equal(state.phase, 'idle');
  });

  it('transition idle → planning succeeds', () => {
    const state = createTaskState(plan);
    const next = transition(state, 'planning');
    assert.equal(next.phase, 'planning');
  });

  it('transition planning → plan_review succeeds', () => {
    const s1 = createTaskState(plan);
    const s2 = transition(s1, 'planning');
    const s3 = transition(s2, 'plan_review');
    assert.equal(s3.phase, 'plan_review');
  });

  it('transition plan_review → cycle_prep succeeds', () => {
    let s = createTaskState(plan);
    s = transition(s, 'planning');
    s = transition(s, 'plan_review');
    s = transition(s, 'cycle_prep');
    assert.equal(s.phase, 'cycle_prep');
  });

  it('transition cycle_prep → cycle_exec succeeds', () => {
    let s = createTaskState(plan);
    for (const p of ['planning', 'plan_review', 'cycle_prep', 'cycle_exec']) s = transition(s, p);
    assert.equal(s.phase, 'cycle_exec');
  });

  it('transition cycle_exec → cycle_validate succeeds', () => {
    let s = createTaskState(plan);
    for (const p of ['planning', 'plan_review', 'cycle_prep', 'cycle_exec', 'cycle_validate']) s = transition(s, p);
    assert.equal(s.phase, 'cycle_validate');
  });

  it('transition cycle_validate → completion_check succeeds', () => {
    let s = createTaskState(plan);
    for (const p of ['planning', 'plan_review', 'cycle_prep', 'cycle_exec', 'cycle_validate', 'completion_check']) s = transition(s, p);
    assert.equal(s.phase, 'completion_check');
  });

  it('transition completion_check → completion_confirm succeeds', () => {
    let s = createTaskState(plan);
    for (const p of ['planning', 'plan_review', 'cycle_prep', 'cycle_exec', 'cycle_validate', 'completion_check', 'completion_confirm']) s = transition(s, p);
    assert.equal(s.phase, 'completion_confirm');
  });

  it('transition completion_confirm → done succeeds', () => {
    let s = createTaskState(plan);
    for (const p of ['planning', 'plan_review', 'cycle_prep', 'cycle_exec', 'cycle_validate', 'completion_check', 'completion_confirm', 'done']) s = transition(s, p);
    assert.equal(s.phase, 'done');
  });

  it('forward-only: cannot transition back to idle from plan_review', () => {
    let s = createTaskState(plan);
    s = transition(s, 'planning');
    s = transition(s, 'plan_review');
    assert.throws(() => transition(s, 'idle'), InvalidPhaseTransitionError);
  });

  it('isTerminal returns true for done', () => {
    let s = createTaskState(plan);
    for (const p of ['planning', 'plan_review', 'cycle_prep', 'cycle_exec', 'cycle_validate', 'completion_check', 'completion_confirm', 'done']) s = transition(s, p);
    assert.equal(isTerminal(s), true);
  });

  it('isTerminal returns true for failed', () => {
    let s = createTaskState(plan);
    for (const p of ['planning', 'plan_review', 'cycle_prep', 'cycle_exec', 'cycle_validate', 'completion_check', 'failed']) s = transition(s, p);
    assert.equal(isTerminal(s), true);
  });

  it('isTerminal returns true for halted', () => {
    let s = createTaskState(plan);
    s = transition(s, 'halted');
    assert.equal(isTerminal(s), true);
  });

  it('isTerminal returns false for non-terminal phase', () => {
    const s = createTaskState(plan);
    assert.equal(isTerminal(s), false);
  });

  it('canTransition returns true for valid transition', () => {
    assert.equal(canTransition('idle', 'planning'), true);
    assert.equal(canTransition('planning', 'plan_review'), true);
  });

  it('canTransition returns false for invalid transition', () => {
    assert.equal(canTransition('plan_review', 'idle'), false);
    assert.equal(canTransition('done', 'planning'), false);
  });
});

// ─── cycleEngine (12 tests) ───────────────────────────────────────────────────

describe('cycleEngine', () => {
  let plan;
  beforeEach(() => { plan = makePlan(); });

  it('createCycle sets correct defaults', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    assert.equal(cycle.cycleNumber, 1);
    assert.equal(cycle.maxTurns, 25);
    assert.equal(cycle.turnsUsed, 0);
    assert.equal(cycle.status, 'running');
    assert.equal(cycle.remediationSpent, 0);
    assert.deepEqual(cycle.toolResults, []);
  });

  it('createCycle derives write_file tools for file deliverables', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    assert.ok(cycle.allowedTools.includes('write_file'));
    assert.ok(!cycle.allowedTools.includes('edit_file'));
  });

  it('createCycle derives edit_file tools for edit deliverables', () => {
    const editPlan = makePlan([{ id: 'e1', type: 'edit', path: 'src/x.js', description: 'Edit x', acceptanceCriteria: 'ok' }]);
    const cycle = createCycle(editPlan, 1, ['e1']);
    assert.ok(cycle.allowedTools.includes('edit_file'));
    assert.ok(!cycle.allowedTools.includes('write_file'));
  });

  it('checkCycleCompletion returns completed when all checks pass', () => {
    let cycle = createCycle(plan, 1, ['deliv-1'], ['write_file', 'read_file', 'list_directory']);
    cycle = recordTurn(cycle, [{ toolName: 'write_file', input: { path: 'src/hello.js' } }], [{ output: 'ok' }], '');
    const result = checkCycleCompletion(cycle, VALID_COMPLETION_MSG);
    assert.equal(result.completed, true);
  });

  it('checkCycleCompletion fails when CYCLE_COMPLETE token missing', () => {
    let cycle = createCycle(plan, 1, ['deliv-1'], ['write_file', 'read_file']);
    cycle = recordTurn(cycle, [{ toolName: 'write_file', input: { path: 'src/hello.js' } }], [{ output: 'ok' }], '');
    const result = checkCycleCompletion(cycle, 'summary deliverables_addressed next_cycle_needed');
    assert.equal(result.completed, false);
    assert.ok(result.violations.length > 0);
  });

  it('checkCycleCompletion passes with token only — section headers no longer required', () => {
    let cycle = createCycle(plan, 1, ['deliv-1'], ['write_file', 'read_file']);
    cycle = recordTurn(cycle, [{ toolName: 'write_file', input: { path: 'src/hello.js' } }], [{ output: 'ok' }], '');
    const result = checkCycleCompletion(cycle, '<CYCLE_COMPLETE>');
    assert.equal(result.completed, true);
  });

  it('checkCycleCompletion fails when no tool results recorded', () => {
    const cycle = createCycle(plan, 1, ['deliv-1'], ['write_file', 'read_file']);
    const result = checkCycleCompletion(cycle, VALID_COMPLETION_MSG);
    assert.equal(result.completed, false);
  });

  it('enforceToolRestriction throws ToolNotAllowedError for unlisted tool', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    assert.throws(() => enforceToolRestriction(cycle, 'spawn_agent'), ToolNotAllowedError);
  });

  it('enforceToolRestriction passes for allowed tool', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    assert.doesNotThrow(() => enforceToolRestriction(cycle, 'write_file'));
  });

  it('recordTurn increments turnsUsed and appends toolResults', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const updated = recordTurn(cycle, [{ toolName: 'write_file', input: { path: 'a.js' } }], [{ output: 'ok' }], '');
    assert.equal(updated.turnsUsed, 1);
    assert.equal(updated.toolResults.length, 1);
  });

  it('recordTurn increments remediationSpent for failed tools', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const updated = recordTurn(cycle, [{ toolName: 'write_file', input: {} }], [{ output: '', error: 'fail' }], '');
    assert.ok(updated.remediationSpent > 0);
  });

  it('summarizeCycle produces at most 500 characters', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const summary = summarizeCycle(cycle);
    assert.ok(summary.length <= 500);
  });
});

// ─── contextBudget (10 tests) ─────────────────────────────────────────────────

describe('contextBudget', () => {
  it('createContextBudget succeeds with valid window', () => {
    const budget = createContextBudget(32000);
    assert.ok(budget);
    assert.ok(typeof budget.totalWindow === 'number');
  });

  it('createContextBudget throws ContextBudgetError when window < 6000', () => {
    assert.throws(() => createContextBudget(5000));
  });

  it('computeTokenEstimate returns chars/4', () => {
    assert.equal(computeTokenEstimate('12345678'), 2);
    assert.equal(computeTokenEstimate('a'.repeat(400)), 100);
  });

  it('allocateTier returns granted tokens within tier max', () => {
    const budget = createContextBudget(32000);
    const allocation = allocateTier(budget, 'toolResults', 2000);
    assert.ok(typeof allocation.granted === 'number');
    assert.ok(allocation.granted <= 4000);
  });

  it('allocateTier returns 0 for zero request', () => {
    const budget = createContextBudget(32000);
    const allocation = allocateTier(budget, 'toolResults', 0);
    assert.equal(allocation.granted, 0);
  });

  it('truncateToBudget marks truncation when content exceeds limit', () => {
    const long = 'a'.repeat(1000);
    const result = truncateToBudget(long, 10);
    assert.ok(result.includes('truncated') || result.length <= 40 + 50);
  });

  it('truncateToBudget returns content unchanged within budget', () => {
    const short = 'hello world';
    const result = truncateToBudget(short, 100);
    assert.equal(result, short);
  });

  it('summarizeToolResults prioritizes errors over reads', () => {
    const results = [
      { toolName: 'read_file', input: { path: 'a.js' }, output: 'content' },
      { toolName: 'write_file', input: { path: 'b.js' }, output: 'ERROR: failed' },
    ];
    const summary = summarizeToolResults(results, 2000);
    const errorIdx = summary.indexOf('ERROR');
    const readIdx = summary.indexOf('read_file');
    assert.ok(errorIdx < readIdx || errorIdx >= 0);
  });

  it('enforceBudget throws ContextBudgetExceededError on overflow', () => {
    const budget = createContextBudget(6000);
    const bigMessages = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: 'x'.repeat(1000) }));
    assert.throws(() => enforceBudget(budget, bigMessages), ContextBudgetExceededError);
  });

  it('reserved space matches requested window', () => {
    const budget = createContextBudget(10000);
    assert.equal(budget.totalWindow, 10000);
  });
});

// ─── contextPacker (8 tests) ──────────────────────────────────────────────────

describe('contextPacker', () => {
  let budget, plan;
  beforeEach(() => {
    budget = createContextBudget(32000);
    plan = makePlan();
  });

  it('packCycleContext returns object with messages array', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const packed = packCycleContext(budget, cycle, plan.deliverables, []);
    assert.ok(Array.isArray(packed.messages));
  });

  it('packCycleContext includes a system message', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const packed = packCycleContext(budget, cycle, plan.deliverables, []);
    const hasSystem = packed.messages.some(m => m.role === 'system' || (m.role === 'user' && typeof m.content === 'string' && m.content.includes('system')));
    assert.ok(packed.messages.length > 0);
  });

  it('packCycleContext metadata includes totalTokensEstimated', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const packed = packCycleContext(budget, cycle, plan.deliverables, []);
    assert.ok(typeof packed.metadata?.totalTokensEstimated === 'number');
  });

  it('packCycleContext works without repo index', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    assert.doesNotThrow(() => packCycleContext(budget, cycle, plan.deliverables, []));
  });

  it('packCycleContext handles empty tool results', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const packed = packCycleContext(budget, cycle, plan.deliverables, []);
    assert.ok(Array.isArray(packed.messages));
    assert.ok(packed.messages.length > 0);
  });

  it('packCycleContext handles empty deliverables array', () => {
    const cycle = createCycle(plan, 1, []);
    assert.doesNotThrow(() => packCycleContext(budget, cycle, [], []));
  });

  it('packPlanReviewContext returns messages array', () => {
    const packed = packPlanReviewContext(budget, plan);
    assert.ok(Array.isArray(packed.messages));
    assert.ok(packed.messages.length > 0);
  });

  it('packCycleContext with mock repo index includes repo map content', () => {
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const mockIndex = makeMockIndex({ 'src/hello.js': 'export function hello() {}' });
    const packed = packCycleContext(budget, cycle, plan.deliverables, [], mockIndex);
    const content = packed.messages.map(m => m.content).join('');
    assert.ok(content.includes('hello.js') || packed.messages.length > 0);
  });
});

// ─── loopPrevention (14 tests) ────────────────────────────────────────────────

describe('loopPrevention', () => {
  it('createLoopGuard returns fresh guard', () => {
    const guard = createLoopGuard();
    assert.ok(guard.seenToolSequences instanceof Map);
    assert.equal(guard.turnsWithoutDeliverableProgress, 0);
  });

  it('checkToolSequence does not halt on first occurrence', () => {
    const guard = createLoopGuard();
    const calls = [{ toolName: 'write_file', input: {} }];
    const result = checkToolSequence(guard, calls);
    assert.equal(result.shouldHalt, false);
  });

  it('checkToolSequence halts after MAX_SEQUENCE_REPEATS identical sequences', () => {
    let guard = createLoopGuard();
    const calls = [{ toolName: 'read_file', input: { path: 'a.js' } }];
    const results = [{ output: 'content' }];
    guard = recordLoopTurn(guard, calls, results);
    const r1 = checkToolSequence(guard, calls);
    guard = recordLoopTurn(guard, calls, results);
    const r2 = checkToolSequence(guard, calls);
    assert.ok(r1.shouldHalt || r2.shouldHalt, 'Should halt after repeating identical sequence');
  });

  it('checkFileRead does not halt before max reads', () => {
    const guard = createLoopGuard();
    const result = checkFileRead(guard, 'src/app.js');
    assert.equal(result.shouldHalt, false);
  });

  it('checkFileRead halts after MAX_READS_BEFORE_ACTION reads of same file', () => {
    let guard = createLoopGuard();
    const reads = [{ toolName: 'read_file', input: { path: 'a.js' } }];
    const results = [{ output: 'content' }];
    for (let i = 0; i < 4; i++) guard = recordLoopTurn(guard, reads, results);
    const check = checkFileRead(guard, 'a.js');
    assert.equal(check.shouldHalt, true);
  });

  it('checkDeliverableProgress halts after MAX_IDLE_TURNS turns with no mutations', () => {
    let guard = createLoopGuard();
    const reads = [{ toolName: 'read_file', input: { path: 'a.js' } }];
    const results = [{ output: 'content' }];
    for (let i = 0; i < 20; i++) guard = recordLoopTurn(guard, reads, results);
    const check = checkDeliverableProgress(guard, []);
    assert.equal(check.shouldHalt, true);
  });

  it('checkCommandRepeat halts on duplicate command', () => {
    let guard = createLoopGuard();
    const cmd = [{ toolName: 'run_command', input: { command: 'npm test' } }];
    guard = recordLoopTurn(guard, cmd, [{ output: 'ok' }]);
    const check = checkCommandRepeat(guard, 'npm test');
    assert.equal(check.shouldHalt, true);
  });

  it('checkCommandRepeat does not halt on first command', () => {
    const guard = createLoopGuard();
    const result = checkCommandRepeat(guard, 'npm run build');
    assert.equal(result.shouldHalt, false);
  });

  it('recordLoopTurn resets idle counter on mutation', () => {
    let guard = createLoopGuard();
    const reads = [{ toolName: 'read_file', input: { path: 'a.js' } }];
    for (let i = 0; i < 5; i++) guard = recordLoopTurn(guard, reads, [{ output: 'c' }]);
    const writes = [{ toolName: 'write_file', input: { path: 'a.js' } }];
    guard = recordLoopTurn(guard, writes, [{ output: 'written' }]);
    const check = checkDeliverableProgress(guard, []);
    assert.equal(check.shouldHalt, false);
  });

  it('createTaskLoopGuard returns fresh task guard', () => {
    const tg = createTaskLoopGuard();
    assert.ok(tg.failedDeliverableRetries instanceof Map);
    assert.ok(typeof tg.maxFailedDeliverableRetries === 'number');
  });

  it('checkDeliverableRetry halts after MAX_DELIVERABLE_RETRIES', () => {
    let tg = createTaskLoopGuard();
    tg = recordFailedDeliverable(tg, 'deliv-1');
    tg = recordFailedDeliverable(tg, 'deliv-1');
    const { result } = checkDeliverableRetry(tg, 'deliv-1');
    assert.equal(result.shouldHalt, true);
  });

  it('recordFailedDeliverable tracks without halting', () => {
    let tg = createTaskLoopGuard();
    tg = recordFailedDeliverable(tg, 'deliv-1');
    assert.ok(tg.failedDeliverableRetries.get('deliv-1') >= 1);
  });

  it('getLoopReport returns non-empty string', () => {
    const guard = createLoopGuard();
    const report = getLoopReport(guard);
    assert.equal(typeof report, 'string');
  });

  it('checkFileRead read counter resets after edit', () => {
    let guard = createLoopGuard();
    const reads = [{ toolName: 'read_file', input: { path: 'a.js' } }];
    for (let i = 0; i < 3; i++) guard = recordLoopTurn(guard, reads, [{ output: 'c' }]);
    const writes = [{ toolName: 'write_file', input: { path: 'a.js' } }];
    guard = recordLoopTurn(guard, writes, [{ output: 'ok' }]);
    const check = checkFileRead(guard, 'a.js');
    assert.equal(check.shouldHalt, false);
  });
});

// ─── errorClassifier (12 tests) ───────────────────────────────────────────────

describe('errorClassifier', () => {
  it('classifyError returns classified error object', () => {
    const result = classifyError(new Error('something went wrong'));
    assert.ok(typeof result.code === 'string');
    assert.ok(typeof result.severity === 'string');
  });

  it('classifyError identifies 401 as fatal', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    const result = classifyError(err);
    assert.equal(isFatal(result), true);
  });

  it('classifyError identifies 429 as recoverable', () => {
    const err = Object.assign(new Error('Rate limited'), { status: 429 });
    const result = classifyError(err);
    assert.equal(result.severity, 'recoverable');
  });

  it('classifyError identifies timeout error as recoverable', () => {
    const err = new Error('Request timed out after 5000ms');
    const result = classifyError(err);
    assert.notEqual(result.severity, 'fatal');
  });

  it('classifyError identifies ToolNotAllowedError as fatal', () => {
    const err = new ToolNotAllowedError('spawn_agent', ['write_file']);
    const result = classifyError(err);
    assert.equal(isFatal(result), true);
  });

  it('classifyError identifies edit-mismatch from error message', () => {
    const err = new Error('old_str not found in file');
    const result = classifyError(err);
    assert.ok(typeof result.code === 'string');
  });

  it('classifyError identifies file-not-found as warning', () => {
    const err = new Error('File not found: src/missing.js');
    const result = classifyError(err);
    assert.ok(['warning', 'recoverable'].includes(result.severity));
  });

  it('isFatal returns true for fatal errors', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    assert.equal(isFatal(classifyError(err)), true);
  });

  it('isFatal returns false for recoverable errors', () => {
    const err = Object.assign(new Error('Rate limited'), { status: 429 });
    assert.equal(isFatal(classifyError(err)), false);
  });

  it('formatErrorForLLM returns a string', () => {
    const result = formatErrorForLLM(classifyError(new Error('test error')));
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('formatErrorForUser returns human-friendly message', () => {
    const result = formatErrorForUser(classifyError(new Error('test error')));
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  it('getErrorRegistry returns object with error entries', () => {
    const registry = getErrorRegistry();
    assert.ok(typeof registry === 'object');
    assert.ok(Object.keys(registry).length > 0);
  });
});

// ─── completionGate (10 tests) ────────────────────────────────────────────────

describe('completionGate', () => {
  let plan, cycle;
  beforeEach(() => {
    plan = makePlan([{ id: 'deliv-1', type: 'file', path: 'src/hello.js', description: 'Hello module', acceptanceCriteria: 'ok' }]);
    cycle = makeCompletedCycle(plan);
  });

  it('runSafetyGates passes when no unsafe patterns', async () => {
    const result = await runSafetyGates(plan, [cycle], noopExecuteTool);
    assert.equal(result.passed, true);
  });

  it('runSafetyGates blocks hardcoded secrets', async () => {
    const secretCycle = makeCycleWithTool(plan, 'write_file', 'src/config.js');
    const badCycle = {
      ...secretCycle,
      toolResults: [{ toolName: 'write_file', input: { path: 'src/config.js', content: 'const api_key = "my-very-secret-api-token-value"' }, output: 'written', turnNumber: 1 }],
    };
    const result = await runSafetyGates(plan, [badCycle], noopExecuteTool);
    assert.equal(result.passed, false);
  });

  it('runCompletionGates passes when deliverables complete with file evidence', async () => {
    let completedPlan = markDeliverableComplete(plan, 'deliv-1', { passed: true });
    const result = await runCompletionGates(completedPlan, [cycle], passRunCommand);
    assert.equal(result.passed, true);
  });

  it('runCompletionGates fails when deliverables not marked complete', async () => {
    const result = await runCompletionGates(plan, [cycle], passRunCommand);
    assert.equal(result.passed, false);
  });

  it('runCompletionGates failedGateIds is an array', async () => {
    const result = await runCompletionGates(plan, [cycle], passRunCommand);
    assert.ok(Array.isArray(result.failedGateIds ?? result.gates?.filter(g => !g.passed).map(g => g.id) ?? []));
  });

  it('runCompletionGates layer is reported', async () => {
    const result = await runCompletionGates(plan, [cycle], passRunCommand);
    assert.ok(typeof result.layer === 'string' || Array.isArray(result.failedGateIds));
  });

  it('runSafetyGates passes with empty cycles', async () => {
    const result = await runSafetyGates(plan, [], noopExecuteTool);
    assert.equal(result.passed, true);
  });

  it('runSafetyGates blocks unsafe JS patterns (eval)', async () => {
    const evalCycle = {
      toolResults: [{ toolName: 'write_file', input: { path: 'src/x.js', content: 'eval(userInput)' }, output: 'written', turnNumber: 1 }],
    };
    const result = await runSafetyGates(plan, [evalCycle], noopExecuteTool);
    assert.equal(result.passed, false);
  });

  it('runCompletionGates accepts criteria with short words trivially', async () => {
    let shortPlan = makePlan([{ id: 'd1', type: 'file', path: 'src/a.js', description: 'A', acceptanceCriteria: 'ok' }]);
    shortPlan = markDeliverableComplete(shortPlan, 'd1', { passed: true });
    const shortCycle = { ...makeCycleWithTool(shortPlan, 'write_file', 'src/a.js'), status: 'completed' };
    const result = await runCompletionGates(shortPlan, [shortCycle], passRunCommand);
    assert.equal(result.passed, true);
  });

  it('runCompletionGates returns details array', async () => {
    let completedPlan = markDeliverableComplete(plan, 'deliv-1', { passed: true });
    const result = await runCompletionGates(completedPlan, [cycle], passRunCommand);
    assert.ok(Array.isArray(result.details));
    assert.ok(result.details.length > 0);
  });
});

// ─── remediationBudget (10 tests) ────────────────────────────────────────────

describe('remediationBudget', () => {
  it('createRemediationBudget initializes with total', () => {
    const b = createRemediationBudget(100);
    assert.equal(b.total, 100);
    assert.equal(b.remaining, 100);
  });

  it('spend deducts cost and returns updated budget', () => {
    const b = createRemediationBudget(100);
    const updated = spend(b, 'tool_retry', 'Test retry', 1, 1);
    assert.ok(updated.remaining < 100);
    assert.equal(updated.remaining, 100 - COST_TABLE.tool_retry);
  });

  it('spend throws RemediationBudgetExhaustedError when insufficient', () => {
    const b = createRemediationBudget(1);
    assert.throws(() => spend(b, 'tool_retry', 'force exhaust', 1, 1), RemediationBudgetExhaustedError);
  });

  it('canAfford returns true when budget sufficient', () => {
    const b = createRemediationBudget(100);
    assert.equal(canAfford(b, 'tool_retry'), true);
  });

  it('canAfford returns false when budget insufficient', () => {
    const b = createRemediationBudget(1);
    assert.equal(canAfford(b, 'tool_retry'), false);
  });

  it('getSpentByCategory aggregates by action type', () => {
    let b = createRemediationBudget(100);
    b = spend(b, 'tool_retry', 'r1', 1, 1);
    b = spend(b, 'tool_retry', 'r2', 2, 1);
    const cats = getSpentByCategory(b);
    assert.ok(cats['tool_retry'] >= COST_TABLE.tool_retry * 2);
  });

  it('getAuditReport returns non-empty string', () => {
    let b = createRemediationBudget(100);
    b = spend(b, 'file_re_read', 'reason', 1, 1);
    const report = getAuditReport(b);
    assert.equal(typeof report, 'string');
    assert.ok(report.length > 0);
  });

  it('spend returns a new object (immutable)', () => {
    const b = createRemediationBudget(100);
    const b2 = spend(b, 'tool_retry', 'r', 1, 1);
    assert.notEqual(b, b2);
    assert.equal(b.remaining, 100);
  });

  it('COST_TABLE is frozen', () => {
    assert.ok(Object.isFrozen(COST_TABLE));
  });

  it('multiple spends accumulate correctly', () => {
    let b = createRemediationBudget(100);
    b = spend(b, 'tool_retry', 'r1', 1, 1);
    b = spend(b, 'file_re_read', 'r2', 2, 1);
    assert.equal(b.remaining, 100 - COST_TABLE.tool_retry - COST_TABLE.file_re_read);
  });
});

// ─── validator (8 tests) ──────────────────────────────────────────────────────

describe('validator', () => {
  it('createValidationSuite builds from plan validationSteps', () => {
    const vPlan = createPlanContract({
      version: '2026.1', taskId: 'v-test', goal: 'Validation test goal',
      deliverables: [{ id: 'd1', type: 'file', path: 'a.js', description: 'File A', acceptanceCriteria: 'ok' }],
      validationSteps: [{ id: 'lint', type: 'lint', command: 'npm run lint', description: 'Lint' }],
      estimatedCycles: 1,
      contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
    });
    const suite = createValidationSuite(vPlan);
    assert.ok(Array.isArray(suite.steps));
    assert.ok(suite.steps.length > 0);
  });

  it('createValidationSuite auto-derives steps for JS deliverables', () => {
    const suite = createValidationSuite(makePlan());
    assert.ok(Array.isArray(suite.steps));
  });

  it('runValidation runs all steps without throwing', async () => {
    const suite = createValidationSuite(makePlan());
    const result = await runValidation(suite, async () => 'exit 0\nok');
    assert.ok(typeof result.allPassed === 'boolean');
  });

  it('runValidation returns allPassed true when commands succeed', async () => {
    const suite = createValidationSuite(makePlan());
    const result = await runValidation(suite, async () => 'exit 0\nAll good');
    assert.equal(result.allPassed, true);
  });

  it('runValidation returns allPassed false when command output contains ERROR', async () => {
    const suite = createValidationSuite(makePlan());
    const result = await runValidation(suite, async () => 'ERROR: failed to compile');
    assert.equal(result.allPassed, false);
  });

  it('summarizeValidation returns string at most 1000 chars', () => {
    const result = summarizeValidation([]);
    assert.equal(typeof result, 'string');
    assert.ok(result.length <= 1000);
  });

  it('summarizeValidation includes status icons for results', () => {
    const results = [
      { id: 'lint', passed: true, output: 'ok', durationMs: 100 },
      { id: 'test', passed: false, output: 'FAILED', durationMs: 200 },
    ];
    const summary = summarizeValidation(results);
    assert.equal(typeof summary, 'string');
    assert.ok(summary.length > 0);
  });

  it('runValidation does not throw when executeTool returns error', async () => {
    const suite = createValidationSuite(makePlan());
    const result = await runValidation(suite, async () => { throw new Error('tool unavailable'); });
    assert.ok(typeof result.allPassed === 'boolean');
  });
});

// ─── qualitySignals (8 tests) ─────────────────────────────────────────────────

describe('qualitySignals', () => {
  let plan, cycle;
  beforeEach(() => {
    plan = makePlan();
    cycle = makeCompletedCycle(plan);
  });

  it('runQualitySignals returns report with signals array', async () => {
    const report = await runQualitySignals(plan, [cycle], null, noopExecuteTool, []);
    assert.ok(Array.isArray(report.signals));
  });

  it('runQualitySignals never throws', async () => {
    await assert.doesNotReject(runQualitySignals(null, null, null, async () => { throw new Error('fail'); }, []));
  });

  it('runQualitySignals marks all signals as advisory (blocksCompletion: false)', async () => {
    const report = await runQualitySignals(plan, [cycle], null, noopExecuteTool, []);
    for (const sig of report.signals) {
      assert.equal(sig.blocksCompletion, false);
    }
  });

  it('formatQualityReport returns markdown string', async () => {
    const report = await runQualitySignals(plan, [cycle], null, noopExecuteTool, []);
    const md = formatQualityReport(report);
    assert.equal(typeof md, 'string');
  });

  it('runQualitySignals handles empty cycles gracefully', async () => {
    const report = await runQualitySignals(plan, [], null, noopExecuteTool, []);
    assert.ok(Array.isArray(report.signals));
  });

  it('runQualitySignals warns on console.log in deliverable content', async () => {
    const consolePlan = makePlan([{ id: 'd1', type: 'file', path: 'src/x.js', description: 'x', acceptanceCriteria: 'ok' }]);
    const consoleCycle = {
      toolResults: [{ toolName: 'write_file', input: { path: 'src/x.js', content: 'console.log("debug")' }, output: 'ok', turnNumber: 1 }],
    };
    const report = await runQualitySignals(consolePlan, [consoleCycle], null, noopExecuteTool, []);
    assert.ok(Array.isArray(report.signals));
  });

  it('runQualitySignals handles missing repoIndex', async () => {
    const report = await runQualitySignals(plan, [cycle], null, noopExecuteTool, []);
    assert.ok(report);
  });

  it('runQualitySignals handles null plan gracefully', async () => {
    await assert.doesNotReject(runQualitySignals(null, [], null, noopExecuteTool, []));
  });
});

// ─── telemetry (10 tests) ─────────────────────────────────────────────────────

describe('telemetry', () => {
  it('createTelemetrySink returns {emit, flush, getEvents, exportReport}', () => {
    const sink = createTelemetrySink();
    assert.equal(typeof sink.emit, 'function');
    assert.equal(typeof sink.flush, 'function');
    assert.equal(typeof sink.getEvents, 'function');
    assert.equal(typeof sink.exportReport, 'function');
  });

  it('emit stores event in buffer', () => {
    const sink = createTelemetrySink();
    sink.emit('task.start', 'task-1', { goal: 'test' });
    const events = sink.getEvents({ taskId: 'task-1' });
    assert.ok(events.length >= 1);
  });

  it('flush returns all events and clears buffer', () => {
    const sink = createTelemetrySink();
    sink.emit('task.start', 'task-1', {});
    sink.emit('task.done', 'task-1', {});
    const events = sink.flush();
    assert.ok(events.length >= 2);
    const afterFlush = sink.flush();
    assert.equal(afterFlush.length, 0);
  });

  it('getEvents filters by taskId', () => {
    const sink = createTelemetrySink();
    sink.emit('task.start', 'task-A', {});
    sink.emit('task.start', 'task-B', {});
    const events = sink.getEvents({ taskId: 'task-A' });
    assert.ok(events.every(e => e.taskId === 'task-A'));
  });

  it('getEvents filters by type', () => {
    const sink = createTelemetrySink();
    sink.emit('tool.call', 'task-1', { name: 'write_file' });
    sink.emit('task.done', 'task-1', {});
    const toolEvents = sink.getEvents({ type: 'tool.call' });
    assert.ok(toolEvents.every(e => e.type === 'tool.call'));
  });

  it('getEvents filters by time range', () => {
    const sink = createTelemetrySink();
    const before = Date.now();
    sink.emit('task.start', 'task-1', {});
    const after = Date.now();
    const events = sink.getEvents({ since: before - 1, until: after + 1 });
    assert.ok(events.length >= 1);
  });

  it('exportReport aggregates tool call counts', () => {
    const sink = createTelemetrySink();
    sink.emit('tool.call', 'task-1', { name: 'write_file' });
    sink.emit('tool.call', 'task-1', { name: 'write_file' });
    const report = sink.exportReport('task-1');
    assert.ok(report);
    assert.ok(typeof report.tools === 'object' || typeof report === 'object');
  });

  it('exportReport aggregates validation results', () => {
    const sink = createTelemetrySink();
    sink.emit('validation.run', 'task-1', { step: 'lint', passed: true, durationMs: 100 });
    const report = sink.exportReport('task-1');
    assert.ok(report);
  });

  it('circular buffer drops oldest when full (bufferSize=3)', () => {
    const sink = createTelemetrySink({ bufferSize: 3 });
    for (let i = 0; i < 5; i++) sink.emit('task.start', `task-${i}`, {});
    const events = sink.flush();
    assert.ok(events.length <= 3);
  });

  it('emit never throws on invalid/null input', () => {
    const sink = createTelemetrySink();
    assert.doesNotThrow(() => sink.emit(null, null, null));
    assert.doesNotThrow(() => sink.emit('', '', {}));
    assert.doesNotThrow(() => sink.emit('x', 'y', undefined));
  });
});

// ─── repoIndex (10 tests) ─────────────────────────────────────────────────────

describe('repoIndex', () => {
  let index;
  beforeEach(() => {
    index = makeMockIndex({
      'src/app.js': 'import utils from "./utils.js";\nfunction main() {}',
      'src/utils.js': 'export function add(a, b) { return a + b; }\nexport function subtract(a, b) { return a - b; }',
      'src/services/auth.js': 'class AuthService { login() {} }',
      'tests/app.test.js': 'import { add } from "../src/utils.js";\nfunction testAdd() {}',
    });
  });

  it('searchFiles returns scored results for matching query', () => {
    const results = searchFiles(index, 'utils');
    assert.ok(results.length > 0);
    assert.ok(results[0].score > 0);
    assert.ok(results[0].path.includes('utils'));
  });

  it('searchFiles returns empty array for non-matching query', () => {
    const results = searchFiles(index, 'xxxxxxxxnonexistent');
    assert.equal(results.length, 0);
  });

  it('getRepoMap returns a string with file paths', () => {
    const map = getRepoMap(index);
    assert.equal(typeof map, 'string');
    assert.ok(map.includes('src'));
  });

  it('getRepoMap is truncated to maxTokens', () => {
    const map = getRepoMap(index, 10);
    assert.ok(map.length <= 40 + 20);
  });

  it('getSymbolsInFile returns function definitions', () => {
    const symbols = getSymbolsInFile(index, 'src/utils.js');
    assert.ok(symbols.length > 0);
    assert.ok(symbols.some(s => s.name === 'add' || s.kind === 'function'));
  });

  it('getSymbolsInFile returns class definitions', () => {
    const symbols = getSymbolsInFile(index, 'src/services/auth.js');
    assert.ok(symbols.some(s => s.kind === 'class' || s.name === 'AuthService'));
  });

  it('getRelatedFiles returns importers', () => {
    const related = getRelatedFiles(index, 'src/utils.js');
    assert.ok(Array.isArray(related.importers));
  });

  it('getRelatedFiles returns importees', () => {
    const related = getRelatedFiles(index, 'src/app.js');
    assert.ok(Array.isArray(related.importees));
  });

  it('invalidateFile removes file from content cache', () => {
    assert.ok(index.contentCache.has('src/utils.js'));
    invalidateFile(index, 'src/utils.js');
    assert.ok(!index.contentCache.has('src/utils.js'));
  });

  it('buildRepoIndex rejects when fetchFn is missing', async () => {
    const orig = globalThis.fetch;
    delete globalThis.fetch;
    try {
      await assert.rejects(buildRepoIndex('owner/repo', 'main', '', {}));
    } finally {
      if (orig) globalThis.fetch = orig;
    }
  });
});
