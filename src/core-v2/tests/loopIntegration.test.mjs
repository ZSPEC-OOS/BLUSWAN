import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLoopGuard,
  createTaskLoopGuard,
  checkToolSequence,
  checkFileRead,
  checkCommandRepeat,
  checkDeliverableProgress,
  checkDeliverableRetry,
  recordFailedDeliverable,
  recordTurn,
  getLoopReport,
} from '../loopPrevention.js';
import { makeExecutor } from '../../services-v2/agentExecutor.js';

// ─── recordFailedDeliverable ──────────────────────────────────────────────────

describe('recordFailedDeliverable', () => {
  it('increments the failure count for a deliverable', () => {
    const guard = createTaskLoopGuard();
    const updated = recordFailedDeliverable(guard, 'deliv-1');
    assert.equal(updated.failedDeliverableRetries.get('deliv-1'), 1);
  });

  it('does not mutate the original guard', () => {
    const guard = createTaskLoopGuard();
    recordFailedDeliverable(guard, 'deliv-1');
    assert.equal(guard.failedDeliverableRetries.has('deliv-1'), false);
  });

  it('increments independently per deliverable', () => {
    let guard = createTaskLoopGuard();
    guard = recordFailedDeliverable(guard, 'deliv-1');
    guard = recordFailedDeliverable(guard, 'deliv-1');
    guard = recordFailedDeliverable(guard, 'deliv-2');
    assert.equal(guard.failedDeliverableRetries.get('deliv-1'), 2);
    assert.equal(guard.failedDeliverableRetries.get('deliv-2'), 1);
  });
});

// ─── checkDeliverableRetry cross-cycle ───────────────────────────────────────

describe('checkDeliverableRetry after recordFailedDeliverable', () => {
  it('does not halt before max retries', () => {
    let guard = createTaskLoopGuard(); // maxFailedDeliverableRetries = 2
    guard = recordFailedDeliverable(guard, 'deliv-1'); // count = 1
    const { result } = checkDeliverableRetry(guard, 'deliv-1'); // count becomes 2
    // checkDeliverableRetry increments too — count reaches 2 = max → halts
    // This is expected: one record + one check == two failures
    assert.equal(result.shouldHalt, true);
    assert.equal(result.guardType, 'deliverable_retry_exhausted');
  });

  it('different deliverables tracked independently', () => {
    let guard = createTaskLoopGuard();
    guard = recordFailedDeliverable(guard, 'deliv-1');
    const { result } = checkDeliverableRetry(guard, 'deliv-2');
    assert.equal(result.shouldHalt, false);
  });
});

// ─── checkToolSequence halt ───────────────────────────────────────────────────

describe('checkToolSequence halt', () => {
  it('halts when the same tool sequence is repeated past the limit', () => {
    let guard = createLoopGuard(); // maxSequenceRepeats = 2
    const calls = [{ toolName: 'read_file', input: { path: 'a.js' } }];

    // Two identical sequences fill the guard
    guard = recordTurn(guard, calls, []);
    guard = recordTurn(guard, calls, []);

    const check = checkToolSequence(guard, calls);
    assert.equal(check.shouldHalt, true);
    assert.equal(check.guardType, 'tool_sequence_repeat');
  });

  it('does not halt for distinct sequences', () => {
    let guard = createLoopGuard();
    const callsA = [{ toolName: 'read_file', input: { path: 'a.js' } }];
    const callsB = [{ toolName: 'read_file', input: { path: 'b.js' } }];

    guard = recordTurn(guard, callsA, []);
    guard = recordTurn(guard, callsB, []);

    assert.equal(checkToolSequence(guard, callsA).shouldHalt, false);
    assert.equal(checkToolSequence(guard, callsB).shouldHalt, false);
  });
});

// ─── checkFileRead halt ───────────────────────────────────────────────────────

describe('checkFileRead halt', () => {
  it('halts when the same file is read past maxReadsBeforeAction', () => {
    let guard = createLoopGuard(); // maxReadsBeforeAction = 5
    const calls = [{ toolName: 'read_file', input: { path: 'src/x.js' } }];

    // Record four reads without any edit (count reaches 4)
    guard = recordTurn(guard, calls, []);
    guard = recordTurn(guard, calls, []);
    guard = recordTurn(guard, calls, []);
    guard = recordTurn(guard, calls, []);

    // Fifth read triggers the guard (count + 1 = 5 >= 5)
    const check = checkFileRead(guard, 'src/x.js');
    assert.equal(check.shouldHalt, true);
    assert.equal(check.guardType, 'read_without_action');
  });

  it('does not halt after file is edited', () => {
    let guard = createLoopGuard();
    const readCalls = [{ toolName: 'read_file', input: { path: 'src/x.js' } }];
    const editCalls = [{ toolName: 'edit_file', input: { path: 'src/x.js' } }];

    guard = recordTurn(guard, readCalls, []);
    guard = recordTurn(guard, editCalls, []);
    guard = recordTurn(guard, readCalls, []);

    const check = checkFileRead(guard, 'src/x.js');
    assert.equal(check.shouldHalt, false);
  });
});

// ─── checkCommandRepeat halt ──────────────────────────────────────────────────

describe('checkCommandRepeat halt', () => {
  it('halts when the same command is run a second time', () => {
    let guard = createLoopGuard();
    const calls = [{ toolName: 'run_command', input: { command: 'npm test' } }];
    guard = recordTurn(guard, calls, []);

    const check = checkCommandRepeat(guard, 'npm test');
    assert.equal(check.shouldHalt, true);
    assert.equal(check.guardType, 'command_repeat');
  });

  it('does not halt for the first command run', () => {
    const guard = createLoopGuard();
    const check = checkCommandRepeat(guard, 'npm test');
    assert.equal(check.shouldHalt, false);
  });
});

// ─── checkDeliverableProgress halt ───────────────────────────────────────────

describe('checkDeliverableProgress halt', () => {
  it('halts when no progress for maxIdleTurns consecutive turns', () => {
    let guard = createLoopGuard(); // maxIdleTurns = 20
    // Record 20 turns with no mutation tool results
    for (let i = 0; i < 20; i++) {
      guard = recordTurn(guard, [], [{ toolName: 'read_file', output: 'content' }]);
    }
    const check = checkDeliverableProgress(guard, []);
    assert.equal(check.shouldHalt, true);
    assert.equal(check.guardType, 'idle_turns');
  });

  it('resets idle count after a successful write', () => {
    let guard = createLoopGuard();
    for (let i = 0; i < 5; i++) {
      guard = recordTurn(guard, [], [{ toolName: 'read_file', output: 'x' }]);
    }
    // A successful write resets the counter
    guard = recordTurn(guard, [], [{ toolName: 'write_file', output: 'wrote file' }]);
    assert.equal(guard.turnsWithoutDeliverableProgress, 0);
    assert.equal(checkDeliverableProgress(guard, []).shouldHalt, false);
  });
});

// ─── getLoopReport ────────────────────────────────────────────────────────────

describe('getLoopReport', () => {
  it('reports no loops when guard is clean', () => {
    const guard = createLoopGuard();
    const report = getLoopReport(guard);
    assert.ok(report.includes('No loop patterns detected'));
  });

  it('reports repeated reads in the report', () => {
    let guard = createLoopGuard();
    const calls = [{ toolName: 'read_file', input: { path: 'bad.js' } }];
    guard = recordTurn(guard, calls, []);
    guard = recordTurn(guard, calls, []);
    guard = recordTurn(guard, calls, []);
    const report = getLoopReport(guard);
    assert.ok(report.includes('bad.js'));
  });
});

// ─── toolCache in makeExecutor ────────────────────────────────────────────────

describe('makeExecutor toolCache', () => {
  it('returns cached result with [CACHED] suffix on second identical call', async () => {
    let callCount = 0;
    const exec = makeExecutor({
      fsRead: async () => { callCount++; return 'file content'; },
    });

    const first = await exec('read_file', { path: 'src/a.js' });
    const second = await exec('read_file', { path: 'src/a.js' });

    assert.equal(callCount, 1, 'fsRead should only be called once');
    assert.ok(first.includes('file content'));
    assert.ok(second.includes('file content'));
    assert.ok(second.includes('[CACHED]'));
  });

  it('does NOT use cache for different inputs', async () => {
    let callCount = 0;
    const exec = makeExecutor({
      fsRead: async () => { callCount++; return 'content'; },
    });

    await exec('read_file', { path: 'a.js' });
    await exec('read_file', { path: 'b.js' });

    assert.equal(callCount, 2);
  });

  it('invalidates cache entries for a path when write_file is called', async () => {
    let callCount = 0;
    const files = { 'src/a.js': 'original' };
    const exec = makeExecutor({
      fsRead: async (p) => { callCount++; return files[p] ?? 'missing'; },
      fsWrite: async (p, c) => { files[p] = c; },
    });

    await exec('read_file', { path: 'src/a.js' });  // cache miss — count=1
    await exec('read_file', { path: 'src/a.js' });  // cache hit — count=1
    await exec('write_file', { path: 'src/a.js', content: 'updated' });
    await exec('read_file', { path: 'src/a.js' });  // cache miss after invalidation — count=2

    assert.equal(callCount, 2, 'fsRead should be called twice (before and after write)');
  });

  it('does not cache ERROR: results', async () => {
    let callCount = 0;
    const exec = makeExecutor({
      fsRead: async () => { callCount++; throw new Error('read failed'); },
    });

    const r1 = await exec('read_file', { path: 'bad.js' });
    const r2 = await exec('read_file', { path: 'bad.js' });

    // Both calls should hit fsRead since error results aren't cached
    assert.equal(callCount, 2);
    assert.ok(r1.startsWith('ERROR:'));
    assert.ok(r2.startsWith('ERROR:'));
    assert.ok(!r2.includes('[CACHED]'));
  });
});
