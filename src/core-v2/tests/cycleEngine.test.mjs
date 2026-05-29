import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCycle,
  checkCycleCompletion,
  enforceToolRestriction,
  recordTurn,
  summarizeCycle,
  ToolNotAllowedError,
} from '../cycleEngine.js';
import { createPlanContract } from '../planContract.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePlan(types = ['file']) {
  const deliverables = types.map((type, i) => ({
    id: `deliv-${i + 1}`,
    type,
    description: `Deliverable ${i + 1}`,
    acceptanceCriteria: 'exists',
    path: `src/file-${i + 1}.js`,
  }));
  return createPlanContract({
    version: '2026.1',
    taskId: 'cycle-test',
    goal: 'Test cycle',
    estimatedCycles: Math.max(1, Math.ceil(types.length / 3)),
    deliverables,
    dependencies: [],
    validationSteps: [],
    contextStrategy: { maxTokensPerCycle: 80000, includeRepoMap: true },
  });
}

const VALID_COMPLETION_MSG = `
summary
deliverables_addressed
next_cycle_needed
<CYCLE_COMPLETE>
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createCycle', () => {
  it('sets correct defaults', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);

    assert.equal(cycle.cycleNumber, 1);
    assert.equal(cycle.maxTurns, 25);
    assert.equal(cycle.turnsUsed, 0);
    assert.equal(cycle.status, 'running');
    assert.equal(cycle.remediationSpent, 0);
    assert.deepEqual(cycle.toolResults, []);
    assert.equal(cycle.completionProtocol.completionToken, '<CYCLE_COMPLETE>');
    assert.deepEqual(cycle.completionProtocol.requiredSections, []);
  });

  it('restricts tools to write_file set for file-creation deliverables', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    assert.ok(cycle.allowedTools.includes('write_file'));
    assert.ok(!cycle.allowedTools.includes('edit_file'));
  });

  it('restricts tools to edit_file set for edit deliverables', () => {
    const plan = makePlan(['edit']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    assert.ok(cycle.allowedTools.includes('edit_file'));
    assert.ok(!cycle.allowedTools.includes('write_file'));
  });

  it('derives goal from deliverable descriptions', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    assert.ok(cycle.goal.includes('Deliverable 1'));
  });
});

describe('checkCycleCompletion', () => {
  it('passes with valid completion token and required sections', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const cycleWithTurn = recordTurn(
      cycle,
      [{ toolName: 'write_file', input: { path: 'src/file-1.js' } }],
      [{ output: 'ok' }],
      ''
    );
    const result = checkCycleCompletion(cycleWithTurn, VALID_COMPLETION_MSG);
    assert.equal(result.completed, true);
    assert.deepEqual(result.violations, []);
  });

  it('fails without completion token', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const cycleWithTurn = recordTurn(
      cycle,
      [{ toolName: 'write_file', input: { path: 'src/file-1.js' } }],
      [{ output: 'ok' }],
      ''
    );
    const result = checkCycleCompletion(cycleWithTurn, 'summary deliverables_addressed next_cycle_needed');
    assert.equal(result.completed, false);
    assert.ok(result.violations.some((v) => v.includes('<CYCLE_COMPLETE>')));
  });

  it('completes with only the token — section headers no longer required', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const cycleWithTurn = recordTurn(
      cycle,
      [{ toolName: 'write_file', input: { path: 'src/file-1.js' } }],
      [{ output: 'ok' }],
      ''
    );
    // Token alone is sufficient proof of completion
    const result = checkCycleCompletion(cycleWithTurn, '<CYCLE_COMPLETE>');
    assert.equal(result.completed, true);
    assert.deepEqual(result.violations, []);
  });

  it('fails when no tool results recorded', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const result = checkCycleCompletion(cycle, VALID_COMPLETION_MSG);
    assert.equal(result.completed, false);
    assert.ok(result.violations.some((v) => v.includes('No tool results')));
  });
});

describe('enforceToolRestriction', () => {
  it('allows permitted tools without throwing', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    assert.doesNotThrow(() => enforceToolRestriction(cycle, 'write_file'));
    assert.doesNotThrow(() => enforceToolRestriction(cycle, 'read_file'));
  });

  it('throws ToolNotAllowedError for disallowed tools', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    assert.throws(
      () => enforceToolRestriction(cycle, 'edit_file'),
      (err) => {
        assert.ok(err instanceof ToolNotAllowedError);
        assert.equal(err.toolName, 'edit_file');
        return true;
      }
    );
  });
});

describe('recordTurn', () => {
  it('increments turnsUsed', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const updated = recordTurn(
      cycle,
      [{ toolName: 'write_file', input: { path: 'src/foo.js' } }],
      [{ output: 'written' }],
      'Done'
    );
    assert.equal(updated.turnsUsed, 1);
  });

  it('tracks remediation cost on tool failure', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const updated = recordTurn(
      cycle,
      [
        { toolName: 'write_file', input: { path: 'src/foo.js' } },
        { toolName: 'write_file', input: { path: 'src/bar.js' } },
      ],
      [
        { output: 'written' },
        { output: '', error: 'permission denied' },
      ],
      'Partial'
    );
    // 1 failure × 5 cost = 5
    assert.equal(updated.remediationSpent, 5);
  });

  it('does not mutate the original cycle', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const updated = recordTurn(
      cycle,
      [{ toolName: 'write_file', input: { path: 'src/foo.js' } }],
      [{ output: 'ok' }],
      ''
    );
    assert.equal(cycle.turnsUsed, 0);
    assert.equal(updated.turnsUsed, 1);
  });
});

describe('summarizeCycle', () => {
  it('returns string of 500 chars or fewer', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const summary = summarizeCycle(cycle);
    assert.ok(typeof summary === 'string');
    assert.ok(summary.length <= 500, `Summary too long: ${summary.length} chars`);
  });

  it('includes cycle number and status', () => {
    const plan = makePlan(['file']);
    const cycle = createCycle(plan, 1, ['deliv-1']);
    const summary = summarizeCycle(cycle);
    assert.ok(summary.includes('Cycle 1'));
    assert.ok(summary.includes('running'));
  });
});
