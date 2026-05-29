/**
 * @module planContract
 * Immutable execution plan schema, validation, and mutation helpers.
 * All mutations return new objects — never mutate in place.
 */

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ExecutionPlan
 * @property {string} version - Schema version, e.g. '2026.1'
 * @property {string} taskId - Unique task identifier
 * @property {string} goal - Original user request
 * @property {Deliverable[]} deliverables - What must exist when done
 * @property {Dependency[]} dependencies - What must be read before writing
 * @property {ValidationStep[]} validationSteps - How to verify completion
 * @property {number} estimatedCycles - Planner's estimate (1-3)
 * @property {ContextStrategy} contextStrategy - Context loading strategy
 */

/**
 * @typedef {Object} Deliverable
 * @property {string} id - Unique deliverable ID (e.g. 'deliv-1')
 * @property {'file'|'edit'|'test'|'command'} type
 * @property {string} [path] - File path or command string
 * @property {string} description - Human-readable description
 * @property {string} acceptanceCriteria - How to verify this is done
 * @property {boolean} completed - Status
 * @property {VerificationResult} [verificationResult] - Result after check
 */

/**
 * @typedef {Object} Dependency
 * @property {string} path - File path needed before execution
 * @property {string} reason - Why this dependency is needed
 */

/**
 * @typedef {Object} ValidationStep
 * @property {string} id
 * @property {string} description
 * @property {'command'|'lint'|'test'|'typecheck'|'manual'} type
 */

/**
 * @typedef {Object} ContextStrategy
 * @property {number} maxTokensPerCycle - Hard token cap per cycle
 * @property {string[]} [priorityFiles] - Files to always include
 * @property {boolean} includeRepoMap - Whether to include file tree
 */

/**
 * @typedef {Object} VerificationResult
 * @property {boolean} passed
 * @property {string} [reason] - If failed, why
 */

/**
 * @typedef {Object} PlanCoverageResult
 * @property {boolean} complete
 * @property {string[]} missing
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const PLAN_VERSION = '2026.1';
const MAX_ESTIMATED_CYCLES = 3;
const VALID_DELIVERABLE_TYPES = new Set(['file', 'edit', 'test', 'command']);
const VALID_VALIDATION_TYPES = new Set(['command', 'lint', 'test', 'typecheck', 'manual']);

// ─── Custom Errors ────────────────────────────────────────────────────────────

export class PlanValidationError extends Error {
  /**
   * @param {string} message
   * @param {string[]} details
   */
  constructor(message, details) {
    super(message);
    this.name = 'PlanValidationError';
    /** @type {string[]} */
    this.details = details;
  }
}

// ─── Validation Helpers ───────────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string|null}
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${field} must be a non-empty string`;
  }
  return null;
}

/**
 * @param {unknown} rawPlan
 * @returns {string[]} List of validation failure messages
 */
function collectValidationErrors(rawPlan) {
  const errors = [];

  if (!rawPlan || typeof rawPlan !== 'object') {
    return ['plan must be a non-null object'];
  }

  // required string fields
  for (const field of ['taskId', 'goal']) {
    const err = requireString(rawPlan[field], field);
    if (err) errors.push(err);
  }

  // deliverables
  if (!Array.isArray(rawPlan.deliverables) || rawPlan.deliverables.length === 0) {
    errors.push('deliverables must be a non-empty array');
  } else {
    const deliverableIds = new Set();
    rawPlan.deliverables.forEach((d, i) => {
      const prefix = `deliverables[${i}]`;
      if (!d || typeof d !== 'object') {
        errors.push(`${prefix} must be an object`);
        return;
      }
      const idErr = requireString(d.id, `${prefix}.id`);
      if (idErr) {
        errors.push(idErr);
      } else if (deliverableIds.has(d.id)) {
        errors.push(`duplicate deliverable id '${d.id}'`);
      } else {
        deliverableIds.add(d.id);
      }

      if (!VALID_DELIVERABLE_TYPES.has(d.type)) {
        errors.push(`${prefix}.type must be one of: ${[...VALID_DELIVERABLE_TYPES].join(', ')}`);
      }

      const descErr = requireString(d.description, `${prefix}.description`);
      if (descErr) errors.push(descErr);

      const acErr = requireString(d.acceptanceCriteria, `${prefix}.acceptanceCriteria`);
      if (acErr) errors.push(acErr);
    });

  }

  // dependencies (optional, but if present must be valid)
  if (rawPlan.dependencies !== undefined) {
    if (!Array.isArray(rawPlan.dependencies)) {
      errors.push('dependencies must be an array');
    } else {
      const depPaths = new Set();
      rawPlan.dependencies.forEach((dep, i) => {
        const prefix = `dependencies[${i}]`;
        if (!dep || typeof dep !== 'object') {
          errors.push(`${prefix} must be an object`);
          return;
        }
        const pathErr = requireString(dep.path, `${prefix}.path`);
        if (pathErr) {
          errors.push(pathErr);
        } else if (depPaths.has(dep.path)) {
          errors.push(`duplicate dependency path '${dep.path}'`);
        } else {
          depPaths.add(dep.path);
        }
        const reasonErr = requireString(dep.reason, `${prefix}.reason`);
        if (reasonErr) errors.push(reasonErr);
      });
    }
  }

  // validationSteps (optional)
  if (rawPlan.validationSteps !== undefined) {
    if (!Array.isArray(rawPlan.validationSteps)) {
      errors.push('validationSteps must be an array');
    } else {
      rawPlan.validationSteps.forEach((vs, i) => {
        const prefix = `validationSteps[${i}]`;
        if (!vs || typeof vs !== 'object') {
          errors.push(`${prefix} must be an object`);
          return;
        }
        const idErr = requireString(vs.id, `${prefix}.id`);
        if (idErr) errors.push(idErr);
        const descErr = requireString(vs.description, `${prefix}.description`);
        if (descErr) errors.push(descErr);
        if (!VALID_VALIDATION_TYPES.has(vs.type)) {
          errors.push(`${prefix}.type must be one of: ${[...VALID_VALIDATION_TYPES].join(', ')}`);
        }
      });
    }
  }

  // contextStrategy (optional)
  if (rawPlan.contextStrategy !== undefined) {
    const cs = rawPlan.contextStrategy;
    if (!cs || typeof cs !== 'object') {
      errors.push('contextStrategy must be an object');
    } else {
      if (typeof cs.maxTokensPerCycle !== 'number' || cs.maxTokensPerCycle <= 0) {
        errors.push('contextStrategy.maxTokensPerCycle must be a positive number');
      }
      if (typeof cs.includeRepoMap !== 'boolean') {
        errors.push('contextStrategy.includeRepoMap must be a boolean');
      }
      if (cs.priorityFiles !== undefined && !Array.isArray(cs.priorityFiles)) {
        errors.push('contextStrategy.priorityFiles must be an array');
      }
    }
  }

  return errors;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Creates and validates an ExecutionPlan from a raw object.
 * Throws PlanValidationError if the plan is invalid.
 *
 * @param {unknown} rawPlan
 * @returns {Readonly<ExecutionPlan>}
 * @since 2.0.0
 * @stable
 */
const DELIVERABLE_TYPE_ALIASES = {
  remove: 'edit', modify: 'edit', update: 'edit',
  create: 'file', add: 'file',
  run: 'command', execute: 'command',
  spec: 'test',
};

function normalizeDeliverableType(type) {
  if (typeof type !== 'string') return type;
  if (VALID_DELIVERABLE_TYPES.has(type)) return type;
  // Handle literal "file|edit|test|command" — pick first valid token
  if (type.includes('|')) {
    for (const part of type.split('|')) {
      const t = part.trim();
      if (VALID_DELIVERABLE_TYPES.has(t)) return t;
    }
  }
  return DELIVERABLE_TYPE_ALIASES[type.toLowerCase()] ?? type;
}

export function createPlanContract(rawPlan) {
  // Auto-correct version so a stale LLM output doesn't fail the whole plan
  if (rawPlan && typeof rawPlan === 'object' && rawPlan.version !== PLAN_VERSION) {
    rawPlan = { ...rawPlan, version: PLAN_VERSION };
  }

  // Auto-correct deliverable types before strict validation
  if (rawPlan && Array.isArray(rawPlan.deliverables)) {
    rawPlan = {
      ...rawPlan,
      deliverables: rawPlan.deliverables.map((d) =>
        d && typeof d === 'object' ? { ...d, type: normalizeDeliverableType(d.type) } : d
      ),
    };
  }

  const errors = collectValidationErrors(rawPlan);
  if (errors.length > 0) {
    throw new PlanValidationError(
      `Plan validation failed with ${errors.length} error(s)`,
      errors
    );
  }

  // Normalise: ensure deliverables have completed=false if not set
  const normalised = {
    ...rawPlan,
    dependencies: rawPlan.dependencies ?? [],
    validationSteps: rawPlan.validationSteps ?? [],
    deliverables: rawPlan.deliverables.map((d) => ({
      completed: false,
      ...d,
    })),
    contextStrategy: rawPlan.contextStrategy ?? {
      maxTokensPerCycle: 80000,
      includeRepoMap: true,
      priorityFiles: [],
    },
  };

  return Object.freeze(normalised);
}

/**
 * Checks whether all deliverables are complete.
 *
 * @param {ExecutionPlan} plan
 * @returns {PlanCoverageResult}
 */
export function validatePlanCoverage(plan) {
  const missing = [];
  for (const d of plan.deliverables) {
    if (!d.completed && !d.verificationResult) {
      missing.push(d.id);
    }
  }
  return { complete: missing.length === 0, missing };
}

/**
 * Returns a new plan with the specified deliverable marked complete.
 * Does not mutate the original plan.
 *
 * @param {ExecutionPlan} plan
 * @param {string} deliverableId
 * @param {VerificationResult} result
 * @returns {ExecutionPlan}
 */
export function markDeliverableComplete(plan, deliverableId, result) {
  const deliverables = plan.deliverables.map((d) =>
    d.id === deliverableId
      ? { ...d, completed: true, verificationResult: result }
      : d
  );
  return { ...plan, deliverables };
}
