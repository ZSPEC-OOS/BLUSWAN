/**
 * @module loopPrevention
 * Structural loop prevention — makes loops impossible, not just detectable.
 * All guards are forward-only and return new objects (immutable updates).
 */

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} LoopGuard
 * @property {Map<string, number>} seenToolSequences
 * @property {Map<string, number>} readWithoutAction
 * @property {number} turnsWithoutDeliverableProgress
 * @property {Set<string>} filesReadThisCycle
 * @property {Set<string>} filesEditedThisCycle
 * @property {Set<string>} commandsRunThisCycle
 * @property {number} maxSequenceRepeats
 * @property {number} maxReadsBeforeAction
 * @property {number} maxIdleTurns
 */

/**
 * @typedef {Object} LoopCheckResult
 * @property {boolean} shouldHalt
 * @property {string} [reason]
 * @property {string} [guardType]
 */

/**
 * @typedef {Object} TaskLoopGuard
 * @property {Map<string, number>} failedDeliverableRetries
 * @property {number} maxFailedDeliverableRetries
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_SEQUENCE_REPEATS   = 2;
const MAX_READS_BEFORE_ACTION = 5;  // raised from 3 — models legitimately re-read files during iterative edits
const MAX_IDLE_TURNS          = 20; // raised from 8 — exploration (listing, reading) is not a loop
const MAX_DELIVERABLE_RETRIES = 2;

const MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'run_command']);

// ─── Guard Creation ───────────────────────────────────────────────────────────

/**
 * Initializes a fresh LoopGuard for a single cycle.
 * @returns {LoopGuard}
 */
export function createLoopGuard() {
  return {
    seenToolSequences: new Map(),
    readWithoutAction: new Map(),
    turnsWithoutDeliverableProgress: 0,
    filesReadThisCycle: new Set(),
    filesEditedThisCycle: new Set(),
    commandsRunThisCycle: new Set(),
    maxSequenceRepeats: MAX_SEQUENCE_REPEATS,
    maxReadsBeforeAction: MAX_READS_BEFORE_ACTION,
    maxIdleTurns: MAX_IDLE_TURNS,
  };
}

/**
 * Initializes a TaskLoopGuard that tracks failures across cycles.
 * @returns {TaskLoopGuard}
 */
export function createTaskLoopGuard() {
  return {
    failedDeliverableRetries: new Map(),
    maxFailedDeliverableRetries: MAX_DELIVERABLE_RETRIES,
  };
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Returns a canonical hash of tool calls. Ignores argument details —
 * two read_file calls on the same path with different line ranges hash identically.
 *
 * @param {Array<{toolName: string, input: Object}>} toolCalls
 * @returns {string}
 */
export function hashToolSequence(toolCalls) {
  return toolCalls
    .map((c) => {
      const path = c.input?.path ?? c.input?.file_path ?? c.input?.command ?? '';
      return `${c.toolName}:${path}`;
    })
    .join('|');
}

// ─── Per-Turn Checks ─────────────────────────────────────────────────────────

/**
 * Checks whether the current tool sequence has been seen too many times.
 *
 * @param {LoopGuard} guard
 * @param {Array<{toolName: string, input: Object}>} toolCalls
 * @returns {LoopCheckResult}
 */
export function checkToolSequence(guard, toolCalls) {
  const hash = hashToolSequence(toolCalls);
  const count = (guard.seenToolSequences.get(hash) ?? 0);
  if (count >= guard.maxSequenceRepeats) {
    return {
      shouldHalt: true,
      reason: `Tool sequence repeated ${count + 1} times: ${hash}`,
      guardType: 'tool_sequence_repeat',
    };
  }
  return { shouldHalt: false };
}

/**
 * Checks whether a file is being read repeatedly without being edited.
 *
 * @param {LoopGuard} guard
 * @param {string} path
 * @returns {LoopCheckResult}
 */
export function checkFileRead(guard, path) {
  const alreadyRead  = guard.filesReadThisCycle.has(path);
  const wasEdited    = guard.filesEditedThisCycle.has(path);

  if (alreadyRead && !wasEdited) {
    const count = guard.readWithoutAction.get(path) ?? 0;
    if (count + 1 >= guard.maxReadsBeforeAction) {
      return {
        shouldHalt: true,
        reason: `File '${path}' read ${count + 1} times without being edited`,
        guardType: 'read_without_action',
      };
    }
  }
  return { shouldHalt: false };
}

/**
 * Checks whether the cycle is making deliverable progress.
 *
 * @param {LoopGuard} guard
 * @param {import('./cycleEngine.js').ToolResult[]} toolResults
 * @returns {LoopCheckResult}
 */
export function checkDeliverableProgress(guard, toolResults) {
  const hasAction = toolResults.some((r) => MUTATION_TOOLS.has(r.toolName) && !r.error);
  if (!hasAction) {
    const idleTurns = guard.turnsWithoutDeliverableProgress + 1;
    if (idleTurns >= guard.maxIdleTurns) {
      return {
        shouldHalt: true,
        reason: `No deliverable progress for ${idleTurns} consecutive turns`,
        guardType: 'idle_turns',
      };
    }
  }
  return { shouldHalt: false };
}

/**
 * Checks whether a command has already been run this cycle.
 *
 * @param {LoopGuard} guard
 * @param {string} command
 * @returns {LoopCheckResult}
 */
export function checkCommandRepeat(guard, command) {
  if (guard.commandsRunThisCycle.has(command)) {
    return {
      shouldHalt: true,
      reason: `Command already run this cycle: '${command}'`,
      guardType: 'command_repeat',
    };
  }
  return { shouldHalt: false };
}

// ─── State Update ─────────────────────────────────────────────────────────────

/**
 * Records a completed turn into the guard and returns updated guard.
 * Does not mutate the original.
 *
 * @param {LoopGuard} guard
 * @param {Array<{toolName: string, input: Object}>} toolCalls
 * @param {import('./cycleEngine.js').ToolResult[]} toolResults
 * @returns {LoopGuard}
 */
export function recordTurn(guard, toolCalls, toolResults) {
  const seenToolSequences = new Map(guard.seenToolSequences);
  const readWithoutAction = new Map(guard.readWithoutAction);
  const filesReadThisCycle = new Set(guard.filesReadThisCycle);
  const filesEditedThisCycle = new Set(guard.filesEditedThisCycle);
  const commandsRunThisCycle = new Set(guard.commandsRunThisCycle);

  // Update sequence hash
  const hash = hashToolSequence(toolCalls);
  seenToolSequences.set(hash, (seenToolSequences.get(hash) ?? 0) + 1);

  // Track file reads and edits
  for (const call of toolCalls) {
    const path = call.input?.path ?? call.input?.file_path ?? '';

    if (call.toolName === 'read_file' || call.toolName === 'read_many_files') {
      if (path) {
        filesReadThisCycle.add(path);
        if (!filesEditedThisCycle.has(path)) {
          readWithoutAction.set(path, (readWithoutAction.get(path) ?? 0) + 1);
        }
      }
    } else if (call.toolName === 'edit_file' || call.toolName === 'write_file') {
      if (path) {
        filesEditedThisCycle.add(path);
        readWithoutAction.delete(path); // reset once edited
      }
    } else if (call.toolName === 'run_command') {
      const cmd = call.input?.command ?? '';
      if (cmd) commandsRunThisCycle.add(cmd);
    }
  }

  // Track idle turns
  const hasProgress = toolResults.some((r) => MUTATION_TOOLS.has(r.toolName) && !r.error);
  const turnsWithoutDeliverableProgress = hasProgress
    ? 0
    : guard.turnsWithoutDeliverableProgress + 1;

  return {
    ...guard,
    seenToolSequences,
    readWithoutAction,
    filesReadThisCycle,
    filesEditedThisCycle,
    commandsRunThisCycle,
    turnsWithoutDeliverableProgress,
  };
}

// ─── Reporting ────────────────────────────────────────────────────────────────

/**
 * Produces a human-readable loop detection report.
 *
 * @param {LoopGuard} guard
 * @returns {string}
 */
export function getLoopReport(guard) {
  const parts = [];

  // Repeated sequences
  for (const [seq, count] of guard.seenToolSequences) {
    if (count >= guard.maxSequenceRepeats) {
      parts.push(`You used the same tool sequence ${count + 1} times in a row: ${seq}`);
    }
  }

  // Repeated reads without action
  for (const [path, count] of guard.readWithoutAction) {
    if (count >= guard.maxReadsBeforeAction) {
      parts.push(`You read '${path}' ${count + 1} times without editing it`);
    }
  }

  // Repeated commands
  if (guard.commandsRunThisCycle.size > 0) {
    // We can only report what was repeated if we see it in seenToolSequences
    // The commandsRunThisCycle set shows all unique commands run
    for (const cmd of guard.commandsRunThisCycle) {
      const cmdSeq = `run_command:${cmd}`;
      for (const [seq, count] of guard.seenToolSequences) {
        if (seq.includes(cmdSeq) && count >= 1) {
          parts.push(`You ran the same command twice: '${cmd}'`);
        }
      }
    }
  }

  // Idle turns
  if (guard.turnsWithoutDeliverableProgress >= guard.maxIdleTurns) {
    parts.push(
      `No deliverable progress for ${guard.turnsWithoutDeliverableProgress} consecutive turns`
    );
  }

  return parts.length > 0
    ? parts.join('\n')
    : 'No loop patterns detected.';
}

// ─── Cross-Cycle Guard ────────────────────────────────────────────────────────

/**
 * Records a deliverable failure without checking the retry limit.
 * Returns the updated guard; does not halt.
 *
 * @param {TaskLoopGuard} taskGuard
 * @param {string} deliverableId
 * @returns {TaskLoopGuard}
 */
export function recordFailedDeliverable(taskGuard, deliverableId) {
  const retries = new Map(taskGuard.failedDeliverableRetries);
  retries.set(deliverableId, (retries.get(deliverableId) ?? 0) + 1);
  return { ...taskGuard, failedDeliverableRetries: retries };
}

/**
 * Records a deliverable failure and checks retry limit.
 *
 * @param {TaskLoopGuard} taskGuard
 * @param {string} deliverableId
 * @returns {{ taskGuard: TaskLoopGuard, result: LoopCheckResult }}
 */
export function checkDeliverableRetry(taskGuard, deliverableId) {
  const retries = new Map(taskGuard.failedDeliverableRetries);
  const count = (retries.get(deliverableId) ?? 0) + 1;
  retries.set(deliverableId, count);

  const updatedGuard = { ...taskGuard, failedDeliverableRetries: retries };

  if (count >= taskGuard.maxFailedDeliverableRetries) {
    return {
      taskGuard: updatedGuard,
      result: {
        shouldHalt: true,
        reason: `Deliverable '${deliverableId}' has failed ${count} times — different approach needed`,
        guardType: 'deliverable_retry_exhausted',
      },
    };
  }

  return { taskGuard: updatedGuard, result: { shouldHalt: false } };
}
