import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runSafetyGates, runCompletionGates } from '../completionGate.js';
import { createPlanContract, markDeliverableComplete } from '../planContract.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePlan(deliverables, estimatedCycles = 1) {
  return createPlanContract({
    version: '2026.1',
    taskId: 'gate-test',
    goal: 'Test completion gates',
    estimatedCycles,
    deliverables: deliverables.map((d, i) => ({
      id: `deliv-${i + 1}`,
      completed: false,
      acceptanceCriteria: 'file exists and exports function',
      ...d,
    })),
    dependencies: [],
    validationSteps: [],
    contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
  });
}

function makeCycle(toolResults = [], status = 'completed') {
  return {
    cycleNumber: 1,
    goal: 'test',
    targetDeliverables: ['deliv-1'],
    allowedTools: ['write_file', 'read_file'],
    maxTurns: 25,
    turnsUsed: toolResults.length || 1,
    toolResults,
    status,
    remediationSpent: 0,
    completionProtocol: {
      completionToken: '<CYCLE_COMPLETE>',
      requiredSections: ['summary', 'deliverables_addressed', 'next_cycle_needed'],
    },
  };
}

function safeExecuteTool(name, input) {
  if (name === 'read_file') return Promise.resolve('const x = 1; // file exists');
  if (name === 'run_command') return Promise.resolve('Success: all tests passed');
  return Promise.resolve(`Success: ${name}`);
}

function failExecuteTool(name, input) {
  if (name === 'run_command') return Promise.resolve('FAIL: tests failed');
  return Promise.resolve(`Success: ${name}`);
}

// ─── Safety Gate Tests ────────────────────────────────────────────────────────

describe('runSafetyGates', () => {
  it('passes on safe file operations within plan deliverables', async () => {
    const plan = makePlan([{ type: 'file', path: 'src/foo.js', description: 'Create foo' }]);
    const cycle = makeCycle([
      { toolName: 'write_file', input: { path: 'src/foo.js', content: 'export const foo = () => {};' }, output: 'ok', turnNumber: 1 },
    ]);
    const result = await runSafetyGates(plan, [cycle], safeExecuteTool);
    assert.equal(result.passed, true);
  });

  it('blocks on hardcoded API key in written content', async () => {
    const plan = makePlan([{ type: 'file', path: 'src/config.js', description: 'Config' }]);
    const cycle = makeCycle([
      {
        toolName: 'write_file',
        input: { path: 'src/config.js', content: 'const api_key = "sk-abc123secretkey99";\nexport default api_key;' },
        output: 'ok',
        turnNumber: 1,
      },
    ]);
    const result = await runSafetyGates(plan, [cycle], safeExecuteTool);
    assert.equal(result.passed, false);
    assert.ok(result.blockedReason.includes('secret') || result.blockedReason.includes('api_key') || result.blockedReason.includes('hardcoded'));
  });

  it('blocks on large deletion without explicit deliverable', async () => {
    const plan = makePlan([{ type: 'file', path: 'src/new.js', description: 'New file' }]);
    const cycle = makeCycle([
      {
        toolName: 'edit_file',
        input: { path: 'src/other.js', old_str: 'old', new_str: 'new' },
        output: 'removed 120 lines from file',
        turnNumber: 1,
      },
    ]);
    const result = await runSafetyGates(plan, [cycle], safeExecuteTool);
    assert.equal(result.passed, false);
    assert.ok(result.blockedReason.toLowerCase().includes('delet') || result.blockedReason.includes('120'));
  });

  it('warns on large change when estimatedCycles was 1', async () => {
    const plan = makePlan([{ type: 'file', path: 'src/big.js', description: 'Big file' }]);
    const bigContent = 'const x = 1;\n'.repeat(600);
    const cycle = makeCycle([
      {
        toolName: 'write_file',
        input: { path: 'src/big.js', content: bigContent },
        output: 'ok',
        turnNumber: 1,
      },
    ]);
    const result = await runSafetyGates(plan, [cycle], safeExecuteTool);
    assert.equal(result.passed, true);
    assert.ok(result.warnings.some((w) => w.includes('Large change') || w.includes('split')));
  });
});

// ─── Completion Gate Tests ────────────────────────────────────────────────────

describe('runCompletionGates', () => {
  it('passes when all deliverables complete and file exists', async () => {
    let plan = makePlan([{ type: 'file', path: 'src/foo.js', description: 'Create foo' }]);
    plan = markDeliverableComplete(plan, 'deliv-1', { passed: true });
    const cycle = makeCycle([
      { toolName: 'write_file', input: { path: 'src/foo.js', content: 'const x = 1;' }, output: 'file exists and exports function', turnNumber: 1 },
    ]);
    const result = await runCompletionGates(plan, [cycle], safeExecuteTool);
    assert.equal(result.passed, true);
    assert.equal(result.layer, 'all_passed');
    assert.ok(Array.isArray(result.details));
  });

  it('fails plan_coverage when deliverable not marked complete', async () => {
    const plan = makePlan([{ type: 'file', path: 'src/foo.js', description: 'Create foo' }]);
    // Not marking complete
    const cycle = makeCycle([]);
    const result = await runCompletionGates(plan, [cycle], safeExecuteTool);
    assert.equal(result.passed, false);
    assert.equal(result.layer, 'plan_coverage');
    assert.ok(result.reason.includes('deliv-1'));
  });

  it('fails deliverable_verification when file not written and read fails', async () => {
    let plan = makePlan([{ type: 'file', path: 'src/missing.js', description: 'Missing file' }]);
    plan = markDeliverableComplete(plan, 'deliv-1', { passed: true });
    const cycle = makeCycle([]); // no write_file tool result
    // executeTool that fails reads
    const failRead = async (name) => name === 'read_file' ? 'ERROR: not found' : 'ok';
    const result = await runCompletionGates(plan, [cycle], failRead);
    assert.equal(result.passed, false);
    assert.equal(result.layer, 'deliverable_verification');
    assert.equal(result.deliverableId, 'deliv-1');
  });

  it('fails acceptance_criteria when no evidence in tool outputs', async () => {
    let plan = makePlan([{
      type: 'file', path: 'src/auth.js', description: 'Auth module',
      acceptanceCriteria: 'exports authenticate function with JWT validation',
    }]);
    plan = markDeliverableComplete(plan, 'deliv-1', { passed: true });
    const cycle = makeCycle([
      { toolName: 'write_file', input: { path: 'src/auth.js', content: 'const x = 1;' }, output: 'done', turnNumber: 1 },
    ]);
    // executeTool returns file content with no mention of authenticate/JWT/validation
    const noEvidenceTool = async (name) => name === 'read_file' ? 'const x = 1;' : 'ok';
    const result = await runCompletionGates(plan, [cycle], noEvidenceTool);
    assert.equal(result.passed, false);
    assert.equal(result.layer, 'acceptance_criteria');
  });

  it('does NOT block on validation failure (advisory only)', async () => {
    let plan = makePlan([{ type: 'file', path: 'src/foo.js', description: 'Foo', acceptanceCriteria: 'ok' }]);
    plan = markDeliverableComplete(plan, 'deliv-1', { passed: true });
    const cycle = makeCycle([
      { toolName: 'write_file', input: { path: 'src/foo.js', content: 'ok' }, output: 'ok done', turnNumber: 1 },
    ]);
    const result = await runCompletionGates(plan, [cycle], failExecuteTool);
    assert.equal(result.passed, true, 'Validation failure should not block completion');
    assert.equal(result.layer, 'all_passed');
  });

  it('returns details array with all gate results', async () => {
    const plan = makePlan([{ type: 'file', path: 'src/foo.js', description: 'Foo' }]);
    const cycle = makeCycle([]);
    const result = await runCompletionGates(plan, [cycle], safeExecuteTool);
    assert.ok(Array.isArray(result.details));
    assert.ok(result.details.length > 0);
    assert.ok(result.details.every((d) => 'id' in d && 'passed' in d && 'description' in d));
  });

  it('command deliverable: only verifies against cycles that targeted it, not any run_command', async () => {
    // Two test-type deliverables in separate cycles. deliv-1 is targeted by cycle 1 (which has a
    // successful run_command); deliv-2 is targeted by cycle 2 (which has NO run_command).
    // Before the fix, the single run_command in cycle 1 would have verified both deliverables.
    let plan = createPlanContract({
      version: '2026.1',
      taskId: 'cross-contamination-test',
      goal: 'Run two test suites',
      estimatedCycles: 2,
      deliverables: [
        { id: 'deliv-1', type: 'test', description: 'Run unit tests', acceptanceCriteria: 'tests pass', completed: true },
        { id: 'deliv-2', type: 'test', description: 'Run e2e tests', acceptanceCriteria: 'e2e pass', completed: true },
      ],
      dependencies: [],
      validationSteps: [],
      contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: false },
    });

    const cycle1 = {
      cycleNumber: 1,
      goal: 'unit tests',
      targetDeliverables: ['deliv-1'],
      allowedTools: ['run_command'],
      maxTurns: 25,
      turnsUsed: 1,
      status: 'completed',
      remediationSpent: 0,
      completionProtocol: { completionToken: '<CYCLE_COMPLETE>', requiredSections: [] },
      toolResults: [
        { toolName: 'run_command', input: { command: 'npm test' }, output: 'e2e pass tests pass', error: undefined, turnNumber: 1 },
      ],
    };
    const cycle2 = {
      cycleNumber: 2,
      goal: 'e2e tests',
      targetDeliverables: ['deliv-2'],
      allowedTools: ['run_command'],
      maxTurns: 25,
      turnsUsed: 1,
      status: 'completed',
      remediationSpent: 0,
      completionProtocol: { completionToken: '<CYCLE_COMPLETE>', requiredSections: [] },
      toolResults: [], // no run_command — deliv-2 should FAIL verification
    };

    const result = await runCompletionGates(plan, [cycle1, cycle2], safeExecuteTool);
    assert.equal(result.passed, false, 'deliv-2 should fail: its cycle ran no command');
    assert.equal(result.layer, 'deliverable_verification');
    assert.equal(result.deliverableId, 'deliv-2');
  });

  it('safety block does not roll back — plan remains unmodified', async () => {
    let plan = makePlan([{ type: 'file', path: 'src/foo.js', description: 'Foo' }]);
    plan = markDeliverableComplete(plan, 'deliv-1', { passed: true });
    const cycle = makeCycle([
      {
        toolName: 'write_file',
        input: { path: 'src/config.js', content: 'const token = "hardcoded-secret-xyz123";\n' },
        output: 'ok',
        turnNumber: 1,
      },
    ]);
    const safetyResult = await runSafetyGates(plan, [cycle], safeExecuteTool);
    assert.equal(safetyResult.passed, false);
    // Plan is still intact — safety gate does NOT modify or rollback
    assert.equal(plan.deliverables[0].completed, true);
    assert.equal(plan.taskId, 'gate-test');
  });
});
