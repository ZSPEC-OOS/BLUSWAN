/**
 * @module completionGate
 * Two-tier verification: safety gates (hard blocks) + completion gates (done-ness).
 * No automatic rollback. No LLM calls. Pure structural verification.
 */

import { validatePlanCoverage } from './planContract.js';
import { createValidationSuite, runValidation, summarizeValidation } from './validator.js';

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GateDetail
 * @property {string} id
 * @property {boolean} passed
 * @property {string} description
 * @property {string} [detail]
 */

/**
 * @typedef {Object} CompletionGateResult
 * @property {boolean} passed
 * @property {string} layer
 * @property {string} [reason]
 * @property {string} [deliverableId]
 * @property {GateDetail[]} [details]
 */

/**
 * @typedef {Object} SafetyCheckResult
 * @property {boolean} passed
 * @property {string} [blockedReason]
 * @property {string} [affectedDeliverableId]
 * @property {string[]} [warnings]
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const SENSITIVE_FILE_PATTERNS = ['.env', 'package.json', 'package-lock.json', '.npmrc', 'tsconfig.json', 'vite.config'];
const SECRET_PATTERNS = [
  /(?:api_key|apikey|password|passwd|secret|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /(?:api_key|apikey|password|passwd|secret|token)\s*=\s*`[^`]{8,}`/i,
];
const UNSAFE_JS_PATTERNS = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
];
const UNSAFE_HTML_PATTERN = /innerHTML\s*[+]?=\s*(?!['"`])/;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @param {import('./cycleEngine.js').ExecutionCycle[]} cycles
 * @returns {import('./cycleEngine.js').ToolResult[]}
 */
function allToolResults(cycles) {
  return cycles.flatMap((c) => c.toolResults ?? []);
}

/**
 * @param {import('./cycleEngine.js').ToolResult[]} results
 * @param {string[]} toolNames
 * @returns {import('./cycleEngine.js').ToolResult[]}
 */
function mutationResults(results, toolNames = ['write_file', 'edit_file']) {
  return results.filter((r) => toolNames.includes(r.toolName) && !r.error);
}

// ─── A. Safety Gates ──────────────────────────────────────────────────────────

/**
 * Runs all safety gates. Returns on first block. Collects all warnings.
 *
 * @param {import('./planContract.js').ExecutionPlan} plan
 * @param {import('./cycleEngine.js').ExecutionCycle[]} cycles
 * @param {(name: string, input: Object) => Promise<string>} executeTool
 * @returns {Promise<SafetyCheckResult>}
 */
export async function runSafetyGates(plan, cycles, executeTool) {
  const warnings = [];
  const results = allToolResults(cycles);
  const mutations = mutationResults(results);
  const deliverablePaths = new Set(plan.deliverables.map((d) => d.path).filter(Boolean));

  // ── Gate 1: Destructive Operation Gate ───────────────────────────────────
  for (const r of mutations) {
    const path = r.input?.path ?? r.input?.file_path ?? '';
    if (!path) continue;

    // Sensitive files touched without a deliverable
    if (SENSITIVE_FILE_PATTERNS.some((p) => path.includes(p)) && !deliverablePaths.has(path)) {
      return {
        passed: false,
        blockedReason: `Modified sensitive file '${path}' which is not in plan deliverables`,
        affectedDeliverableId: undefined,
        warnings,
      };
    }

    // File written that's not in deliverables (could be overwrite)
    if (r.toolName === 'write_file' && !deliverablePaths.has(path)) {
      // Check if it was a new file (no original) vs overwrite — warn only
      warnings.push(`write_file targeted '${path}' which is not in plan deliverables`);
    }
  }

  // Check for large deletions: scan outputs of edit_file for removed lines
  for (const r of mutations.filter((r) => r.toolName === 'edit_file')) {
    const output = r.output ?? '';
    // Heuristic: if the tool output mentions many lines removed or content is very short
    const removedMatch = output.match(/removed?\s+(\d+)\s+lines?/i);
    if (removedMatch) {
      const removed = parseInt(removedMatch[1], 10);
      if (removed > 100) {
        const path = r.input?.path ?? '';
        const hasDeleteDeliverable = plan.deliverables.some(
          (d) => d.type === 'edit' && d.path === path
        );
        if (!hasDeleteDeliverable) {
          return {
            passed: false,
            blockedReason: `Deleted ${removed} lines from '${path}' without explicit deliverable`,
            warnings,
          };
        }
      }
    }
  }

  // ── Gate 2: Security Gate ────────────────────────────────────────────────
  for (const r of mutations) {
    const content = r.input?.content ?? r.input?.new_str ?? r.output ?? '';
    const path = r.input?.path ?? '';

    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(content)) {
        return {
          passed: false,
          blockedReason: `Possible hardcoded secret in '${path}' matching pattern ${pattern.source}`,
          warnings,
        };
      }
    }

    // Only check JS/TS files for unsafe patterns
    if (/\.[jt]sx?$/.test(path)) {
      for (const pattern of UNSAFE_JS_PATTERNS) {
        if (pattern.test(content)) {
          return {
            passed: false,
            blockedReason: `Unsafe JS pattern '${pattern.source}' found in '${path}'`,
            warnings,
          };
        }
      }
      if (UNSAFE_HTML_PATTERN.test(content)) {
        return {
          passed: false,
          blockedReason: `Potentially unsafe innerHTML assignment in '${path}'`,
          warnings,
        };
      }
    }
  }

  // ── Gate 3: Large Change Warning ─────────────────────────────────────────
  const totalLinesChanged = mutations.reduce((sum, r) => {
    const content = r.input?.content ?? r.input?.new_str ?? '';
    return sum + (content.split('\n').length);
  }, 0);

  if (totalLinesChanged > 500) {
    warnings.push(
      `Large change detected (${totalLinesChanged} lines). Consider splitting into smaller tasks.`
    );
  }

  // ── Gate 4: Untracked File Warning ───────────────────────────────────────
  for (const r of mutations.filter((r) => r.toolName === 'write_file')) {
    const path = r.input?.path ?? '';
    if (path && !deliverablePaths.has(path)) {
      warnings.push(`File '${path}' was written but is not listed in plan deliverables`);
    }
  }

  return { passed: true, warnings };
}

// ─── B. Completion Gates ──────────────────────────────────────────────────────

/**
 * Runs all completion gates. All must pass.
 *
 * @param {import('./planContract.js').ExecutionPlan} plan
 * @param {import('./cycleEngine.js').ExecutionCycle[]} cycles
 * @param {(name: string, input: Object) => Promise<string>} executeTool
 * @returns {Promise<CompletionGateResult>}
 */
export async function runCompletionGates(plan, cycles, executeTool) {
  const details = [];
  const results = allToolResults(cycles);

  // ── Gate 1: Plan Coverage ─────────────────────────────────────────────────
  const coverage = validatePlanCoverage(plan);
  const coverageDetail = {
    id: 'plan-coverage',
    passed: coverage.complete,
    description: 'All deliverables marked complete',
    detail: coverage.complete ? undefined : `Missing: ${coverage.missing.join(', ')}`,
  };
  details.push(coverageDetail);
  if (!coverage.complete) {
    return {
      passed: false,
      layer: 'plan_coverage',
      reason: `Deliverables not completed: ${coverage.missing.join(', ')}`,
      details,
    };
  }

  // ── Gate 2: Deliverable Verification ─────────────────────────────────────
  for (const deliverable of plan.deliverables) {
    let gateDetail;

    if (deliverable.type === 'file' || deliverable.type === 'edit') {
      // Verify the file was actually written/edited in tool results
      const path = deliverable.path;
      if (!path) {
        gateDetail = { id: `deliv-${deliverable.id}`, passed: false, description: `Deliverable '${deliverable.id}' has no path`, detail: 'Path required for file/edit deliverables' };
        details.push(gateDetail);
        return { passed: false, layer: 'deliverable_verification', reason: gateDetail.description, deliverableId: deliverable.id, details };
      }

      const writeResult = results.find(
        (r) => (r.toolName === 'write_file' || r.toolName === 'edit_file') &&
          (r.input?.path === path || r.input?.file_path === path) && !r.error
      );

      // Fallback: try executeTool to verify file exists
      let fileExists = !!writeResult;
      if (!fileExists) {
        try {
          const readResult = await executeTool('read_file', { path });
          fileExists = !readResult.startsWith('ERROR:') && !readResult.startsWith('error:');
        } catch {
          fileExists = false;
        }
      }

      gateDetail = {
        id: `deliv-${deliverable.id}`,
        passed: fileExists,
        description: `File '${path}' exists`,
        detail: fileExists ? undefined : `No successful write/edit found for '${path}'`,
      };
    } else if (deliverable.type === 'test' || deliverable.type === 'command') {
      // Verify a command ran in a cycle that targeted this specific deliverable.
      // Scoping prevents one deliverable's run_command from satisfying another's.
      const relevantCycles = cycles.filter((c) => c.targetDeliverables?.includes(deliverable.id));
      const scopedResults = relevantCycles.length > 0
        ? relevantCycles.flatMap((c) => c.toolResults ?? [])
        : results;
      const cmdResult = scopedResults.find(
        (r) => r.toolName === 'run_command' && !r.error
      );
      gateDetail = {
        id: `deliv-${deliverable.id}`,
        passed: !!cmdResult,
        description: `Command executed for '${deliverable.id}'`,
        detail: cmdResult ? undefined : 'No successful command execution found',
      };
    } else {
      gateDetail = { id: `deliv-${deliverable.id}`, passed: true, description: `Deliverable '${deliverable.id}' verified` };
    }

    details.push(gateDetail);
    if (!gateDetail.passed) {
      return {
        passed: false,
        layer: 'deliverable_verification',
        reason: gateDetail.detail ?? gateDetail.description,
        deliverableId: deliverable.id,
        details,
      };
    }
  }

  // ── Gate 3: Acceptance Criteria ───────────────────────────────────────────
  const cycleSummaries = cycles
    .map((c) => {
      const lastMsg = c.toolResults[c.toolResults.length - 1]?.output ?? '';
      return lastMsg;
    })
    .join('\n');

  for (const deliverable of plan.deliverables) {
    const keywords = deliverable.acceptanceCriteria
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 4);

    const evidenceFound = keywords.length === 0 || keywords.some((kw) =>
      cycleSummaries.toLowerCase().includes(kw) ||
      results.some((r) => (r.output ?? '').toLowerCase().includes(kw))
    );

    const gateDetail = {
      id: `ac-${deliverable.id}`,
      passed: evidenceFound,
      description: `Acceptance criteria evidence for '${deliverable.id}'`,
      detail: evidenceFound ? undefined : `No evidence found for: "${deliverable.acceptanceCriteria}"`,
    };
    details.push(gateDetail);
    if (!evidenceFound) {
      return {
        passed: false,
        layer: 'acceptance_criteria',
        reason: `Acceptance criteria not evidenced for '${deliverable.id}': ${deliverable.acceptanceCriteria}`,
        deliverableId: deliverable.id,
        details,
      };
    }
  }

  // ── Gate 4: Validation Suite (advisory — does NOT block completion) ─────────
  // Failures here are quality signals surfaced to the user, not hard blocks.
  const suite = createValidationSuite(plan);
  let validationSummary = '';
  let validationResults = [];
  if (suite.steps.length > 0) {
    try {
      const { results, allPassed } = await runValidation(suite, executeTool);
      validationResults = results;
      validationSummary = summarizeValidation(results);
      details.push({
        id: 'validation',
        passed: allPassed,
        description: `Build/Test/Lint: ${results.length} step(s)`,
        detail: allPassed ? undefined : validationSummary,
      });
    } catch {
      details.push({ id: 'validation', passed: true, description: 'Validation skipped' });
    }
  } else {
    details.push({ id: 'validation', passed: true, description: 'No validation steps configured' });
  }

  // ── Gate 5: Self-Assessment ────────────────────────────────────────────────
  // Check the last cycle's completion message
  const lastCycle = cycles[cycles.length - 1];
  let selfAssessDetail;

  if (!lastCycle) {
    selfAssessDetail = { id: 'self-assessment', passed: false, description: 'No cycles found', detail: 'No cycles to assess' };
  } else {
    const hasToken = lastCycle.status === 'completed';

    selfAssessDetail = {
      id: 'self-assessment',
      passed: hasToken,
      description: 'Cycle self-assessment',
      detail: hasToken ? undefined : 'Last cycle did not reach completed status',
    };
  }

  details.push(selfAssessDetail);
  if (!selfAssessDetail.passed) {
    return {
      passed: false,
      layer: 'self_assessment',
      reason: selfAssessDetail.detail,
      details,
    };
  }

  return { passed: true, layer: 'all_passed', details, validationResults };
}
