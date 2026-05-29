import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLoopGuard,
  createTaskLoopGuard,
  hashToolSequence,
  checkToolSequence,
  checkFileRead,
  checkDeliverableProgress,
  checkCommandRepeat,
  recordTurn,
  getLoopReport,
  checkDeliverableRetry,
} from '../loopPrevention.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const READ_CALL = (path) => ({ toolName: 'read_file', input: { path } });
const WRITE_CALL = (path) => ({ toolName: 'write_file', input: { path } });
const RUN_CALL = (cmd) => ({ toolName: 'run_command', input: { command: cmd } });

const OK_WRITE = (path) => ({ toolName: 'write_file', input: { path }, output: 'ok', turnNumber: 1 });
const OK_RUN = (cmd) => ({ toolName: 'run_command', input: { command: cmd }, output: 'ok', turnNumber: 1 });
const OK_READ = (path) => ({ toolName: 'read_file', input: { path }, output: 'content', turnNumber: 1 });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('hashToolSequence', () => {
  it('ignores argument details — matches on toolName + path only', () => {
    const call1 = [{ toolName: 'read_file', input: { path: 'src/a.js', startLine: 1, endLine: 50 } }];
    const call2 = [{ toolName: 'read_file', input: { path: 'src/a.js', startLine: 100, endLine: 200 } }];
    assert.equal(hashToolSequence(call1), hashToolSequence(call2));
  });

  it('distinguishes different tools or paths', () => {
    const call1 = [{ toolName: 'read_file', input: { path: 'a.js' } }];
    const call2 = [{ toolName: 'write_file', input: { path: 'a.js' } }];
    const call3 = [{ toolName: 'read_file', input: { path: 'b.js' } }];
    assert.notEqual(hashToolSequence(call1), hashToolSequence(call2));
    assert.notEqual(hashToolSequence(call1), hashToolSequence(call3));
  });
});

describe('checkToolSequence', () => {
  it('allows first occurrence (count is 0, not yet seen)', () => {
    const guard = createLoopGuard();
    const result = checkToolSequence(guard, [READ_CALL('a.js')]);
    assert.equal(result.shouldHalt, false);
  });

  it('does not halt on second occurrence (count becomes 1, limit is 2)', () => {
    let guard = createLoopGuard();
    const calls = [READ_CALL('a.js')];
    guard = recordTurn(guard, calls, [OK_READ('a.js')]);
    const result = checkToolSequence(guard, calls);
    assert.equal(result.shouldHalt, false);
  });

  it('halts on 3rd identical sequence (count reaches maxSequenceRepeats=2)', () => {
    let guard = createLoopGuard();
    const calls = [READ_CALL('a.js')];

    // Record twice to push count to 2
    guard = recordTurn(guard, calls, [OK_READ('a.js')]);
    guard = recordTurn(guard, calls, [OK_READ('a.js')]);

    const result = checkToolSequence(guard, calls);
    assert.equal(result.shouldHalt, true);
    assert.equal(result.guardType, 'tool_sequence_repeat');
  });
});

describe('checkFileRead', () => {
  it('allows first read', () => {
    const guard = createLoopGuard();
    const result = checkFileRead(guard, 'src/a.js');
    assert.equal(result.shouldHalt, false);
  });

  it('allows second read without edit (count=1, limit=5)', () => {
    let guard = createLoopGuard();
    guard = recordTurn(guard, [READ_CALL('a.js')], [OK_READ('a.js')]);
    const result = checkFileRead(guard, 'a.js');
    assert.equal(result.shouldHalt, false);
  });

  it('halts on 5th read of same file without edit', () => {
    let guard = createLoopGuard();
    // Read four times first (count reaches 4)
    guard = recordTurn(guard, [READ_CALL('a.js')], [OK_READ('a.js')]);
    guard = recordTurn(guard, [READ_CALL('a.js')], [OK_READ('a.js')]);
    guard = recordTurn(guard, [READ_CALL('a.js')], [OK_READ('a.js')]);
    guard = recordTurn(guard, [READ_CALL('a.js')], [OK_READ('a.js')]);
    // 5th check: count+1=5 >= maxReadsBeforeAction=5 → halt
    const result = checkFileRead(guard, 'a.js');
    assert.equal(result.shouldHalt, true);
    assert.equal(result.guardType, 'read_without_action');
  });

  it('resets after editing file', () => {
    let guard = createLoopGuard();
    guard = recordTurn(guard, [READ_CALL('a.js')], [OK_READ('a.js')]);
    guard = recordTurn(guard, [READ_CALL('a.js')], [OK_READ('a.js')]);
    guard = recordTurn(guard, [WRITE_CALL('a.js')], [OK_WRITE('a.js')]);
    // After edit, read count should be cleared
    const result = checkFileRead(guard, 'a.js');
    assert.equal(result.shouldHalt, false);
  });
});

describe('checkDeliverableProgress', () => {
  it('does not halt on idle turn when count is low', () => {
    const guard = createLoopGuard();
    // No mutations in results
    const result = checkDeliverableProgress(guard, [OK_READ('a.js')]);
    assert.equal(result.shouldHalt, false);
  });

  it('increments idleTurns when no mutation occurs', () => {
    let guard = createLoopGuard();
    for (let i = 0; i < 7; i++) {
      guard = recordTurn(guard, [READ_CALL('a.js')], [OK_READ('a.js')]);
    }
    // After 7 turns, turnsWithoutDeliverableProgress should be 7
    assert.equal(guard.turnsWithoutDeliverableProgress, 7);
  });

  it('halts after 20 idle turns', () => {
    let guard = createLoopGuard();
    for (let i = 0; i < 20; i++) {
      guard = recordTurn(guard, [READ_CALL('a.js')], [OK_READ('a.js')]);
    }
    // Now check with another idle result — turnsWithoutDeliverableProgress=20, 20+1=21 >= 20 → halt
    const result = checkDeliverableProgress(guard, [OK_READ('a.js')]);
    assert.equal(result.shouldHalt, true);
    assert.equal(result.guardType, 'idle_turns');
  });

  it('resets idle counter when mutation occurs', () => {
    let guard = createLoopGuard();
    for (let i = 0; i < 5; i++) {
      guard = recordTurn(guard, [READ_CALL('a.js')], [OK_READ('a.js')]);
    }
    assert.equal(guard.turnsWithoutDeliverableProgress, 5);
    guard = recordTurn(guard, [WRITE_CALL('a.js')], [OK_WRITE('a.js')]);
    assert.equal(guard.turnsWithoutDeliverableProgress, 0);
  });
});

describe('checkCommandRepeat', () => {
  it('allows first command run', () => {
    const guard = createLoopGuard();
    const result = checkCommandRepeat(guard, 'npm test');
    assert.equal(result.shouldHalt, false);
  });

  it('halts on exact command repeat within same cycle', () => {
    let guard = createLoopGuard();
    guard = recordTurn(guard, [RUN_CALL('npm test')], [OK_RUN('npm test')]);
    const result = checkCommandRepeat(guard, 'npm test');
    assert.equal(result.shouldHalt, true);
    assert.equal(result.guardType, 'command_repeat');
  });

  it('allows different commands', () => {
    let guard = createLoopGuard();
    guard = recordTurn(guard, [RUN_CALL('npm test')], [OK_RUN('npm test')]);
    const result = checkCommandRepeat(guard, 'npm build');
    assert.equal(result.shouldHalt, false);
  });
});

describe('recordTurn', () => {
  it('updates all tracking sets', () => {
    const guard = createLoopGuard();
    const updated = recordTurn(
      guard,
      [READ_CALL('a.js'), WRITE_CALL('b.js'), RUN_CALL('echo hi')],
      [OK_READ('a.js'), OK_WRITE('b.js'), OK_RUN('echo hi')]
    );
    assert.ok(updated.filesReadThisCycle.has('a.js'));
    assert.ok(updated.filesEditedThisCycle.has('b.js'));
    assert.ok(updated.commandsRunThisCycle.has('echo hi'));
  });

  it('does not mutate original guard', () => {
    const guard = createLoopGuard();
    recordTurn(guard, [READ_CALL('a.js')], [OK_READ('a.js')]);
    assert.equal(guard.filesReadThisCycle.size, 0);
  });
});

describe('getLoopReport', () => {
  it('includes specific file name for read-without-action', () => {
    let guard = createLoopGuard();
    guard = recordTurn(guard, [READ_CALL('src/important.js')], [OK_READ('src/important.js')]);
    guard = recordTurn(guard, [READ_CALL('src/important.js')], [OK_READ('src/important.js')]);
    guard = recordTurn(guard, [READ_CALL('src/important.js')], [OK_READ('src/important.js')]);
    const report = getLoopReport(guard);
    assert.ok(report.includes('src/important.js'));
  });

  it('includes command name for repeated commands', () => {
    let guard = createLoopGuard();
    guard = recordTurn(guard, [RUN_CALL('npm test')], [OK_RUN('npm test')]);
    guard = recordTurn(guard, [RUN_CALL('npm test')], [OK_RUN('npm test')]);
    const report = getLoopReport(guard);
    // The repeated command should be mentioned somewhere in the report
    assert.ok(report.includes('npm test') || report.includes('same tool sequence'));
  });
});

describe('checkDeliverableRetry (cross-cycle)', () => {
  it('does not halt on first failure', () => {
    const taskGuard = createTaskLoopGuard();
    const { result } = checkDeliverableRetry(taskGuard, 'deliv-1');
    assert.equal(result.shouldHalt, false);
  });

  it('halts after 2 failed retries of the same deliverable', () => {
    let taskGuard = createTaskLoopGuard();
    ({ taskGuard } = checkDeliverableRetry(taskGuard, 'deliv-1'));
    const { result } = checkDeliverableRetry(taskGuard, 'deliv-1');
    assert.equal(result.shouldHalt, true);
    assert.equal(result.guardType, 'deliverable_retry_exhausted');
  });

  it('tracks different deliverables independently', () => {
    let taskGuard = createTaskLoopGuard();
    ({ taskGuard } = checkDeliverableRetry(taskGuard, 'deliv-1'));
    const { result } = checkDeliverableRetry(taskGuard, 'deliv-2');
    assert.equal(result.shouldHalt, false);
  });
});
