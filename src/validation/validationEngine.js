// The validation engine: answers three questions cleanly.
//   What checks are available?          → detect()   (project descriptor + safe discovered commands)
//   What checks should run now?         → plan()     (deterministic policy over what changed)
//   What do we know about the workspace → state       (session.validation; see validationState.js)
// It provides evidence; it never decides how to fix anything and makes no model calls.
import { detectProject } from './projectDetector.js'
import { discoverValidationCommands } from './commandDiscovery.js'
import { planValidation, classifyChange } from './changedFileStrategy.js'
import { applyRound, applySkip, createValidationState } from './validationState.js'
import { classifyFailure } from './failureClassifier.js'
import { stripAnsi } from './resultParser.js'
import { runTestStep } from './testRunner.js'
import { runLintStep } from './lintRunner.js'
import { runTypecheckStep } from './typecheckRunner.js'
import { runBuildStep } from './buildRunner.js'
import { runValidationStep } from './runner.js'
import { resolveValidationConfig } from '../config/runtimeConfig.js'

const RUNNERS = { test: runTestStep, lint: runLintStep, typecheck: runTypecheckStep, build: runBuildStep }
const genericRunner = ({ step, config, ...rest }) => runValidationStep({ ...rest, step, timeoutMs: config.defaultLintTimeoutMs })

/** @param {{config?:object, now?:()=>number, newId?:()=>string}} [options] */
export function createValidationEngine({ config = {}, now = () => Date.now(), newId = () => globalThis.crypto.randomUUID().slice(0, 8) } = {}) {
  const cfg = resolveValidationConfig(config)
  const detected = new WeakMap() // workspace → { project, commands, byKind }
  let counter = 0

  /** Project descriptor and discovered commands (cached per workspace until a manifest changes). */
  async function detect(workspace) {
    if (!detected.has(workspace)) {
      const project = await detectProject(workspace)
      const { commands, byKind } = discoverValidationCommands(project)
      project.validationCommands = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v?.command ?? null]))
      detected.set(workspace, { project, commands, byKind })
    }
    return detected.get(workspace)
  }

  /** Call when a manifest/config file changed so commands are rediscovered. */
  function invalidate(workspace, paths = []) {
    if (!paths.length || paths.some(p => ['config', 'dependency'].includes(classifyChange(p)))) detected.delete(workspace)
  }

  /**
   * @param {{workspace:object, state?:object, userInstructions?:string[], roundsUsed?:number}} args
   * @returns {Promise<{decision:object, project:object, commands:object[]}>}
   */
  async function plan({ workspace, state, userInstructions = [], roundsUsed = 0 }) {
    const { project, commands, byKind } = await detect(workspace)
    const { files } = await workspace.listFiles()
    const decision = planValidation({
      project, byKind, changed: state?.dirtyFiles ?? [], fileSet: new Set(files), config: cfg, userInstructions, state, roundsUsed,
    })
    return { decision, project, commands }
  }

  /**
   * Runs the planned steps in order, stopping at the first failure so evidence arrives quickly.
   * @param {{workspace:object, decision:object, state:object, signal?:AbortSignal, emit?:(type:string,data:object)=>void}} args
   * @returns {Promise<{results:object[], state:object}>}
   */
  async function run({ workspace, decision, state, signal, emit = () => {} }) {
    const results = []
    for (const step of decision.commands) {
      if (signal?.aborted) break
      const id = `val_${now().toString(36)}_${++counter}_${newId()}`
      emit('validation.started', { validationId: id, kind: step.kind, command: step.command, scope: step.scope })
      const runner = RUNNERS[step.kind] ?? genericRunner
      const result = await runner({ workspace, step, config: cfg, signal, id, now, maxOutputChars: Math.min(cfg.maxValidationOutputBytes, 4_000) })
      emit('validation.completed', { validationId: id, kind: step.kind, command: step.command, scope: step.scope, status: result.status, durationMs: result.durationMs, summary: result.summary })
      results.push(result)
      if (['failed', 'error', 'cancelled'].includes(result.status)) break // evidence arrives at the first real problem
    }
    return { results, state: applyRound(state ?? createValidationState(), results, { now: now(), decision }) }
  }

  /** Records a deliberate skip (user instruction, nothing available, docs only, …) with its reason. */
  const skip = (state, reason) => applySkip(state ?? createValidationState(), reason, { now: now() })

  const SHELL_KIND = [['typecheck', /\b(tsc|typecheck|type-check|mypy|cargo check|pyright)\b/i], ['lint', /\b(lint|eslint|ruff|flake8|pylint|clippy|go vet)\b/i],
    ['build', /\b(build|compile)\b/i], ['test', /\b(tests?|jest|vitest|mocha|pytest|cargo test|go test)\b/i]]

  /**
   * Turns a check the agent ran through the shell tool into a validation result (or null when the
   * command is not a recognizable check). Scope is "broad" when it is the project's own command.
   */
  async function fromShell(workspace, call, toolResult) {
    const command = String(call.input?.command ?? '').trim().replace(/\s+/g, ' ')
    const kind = SHELL_KIND.find(([, re]) => re.test(command))?.[0]
    if (!kind || toolResult.tool !== 'shell') return null
    const { byKind } = await detect(workspace)
    const scope = byKind[kind]?.command === command ? 'broad' : 'focused'
    const t = now()
    const base = { id: `val_shell_${++counter}`, kind, command, scope, startedAt: t, completedAt: t, relatedFiles: [], source: 'agent_shell' }
    if (!toolResult.ok) {
      const code = toolResult.error.code
      const run = toolResult.output
      return { ...base, status: code === 'command_cancelled' ? 'cancelled' : 'failed', exitCode: null, durationMs: run?.durationMs ?? 0, summary: code === 'command_timeout' ? 'timed out' : toolResult.error.message,
        diagnostics: code === 'command_timeout' ? classifyFailure({ kind, exitCode: null, timedOut: true }) : null, outputTruncated: !!run?.truncated }
    }
    const o = toolResult.output
    const passed = o.exitCode === 0
    const d = passed ? null : classifyFailure({ kind, exitCode: o.exitCode, stdout: o.stdout, stderr: o.stderr, root: workspace.root })
    return { ...base, status: passed ? 'passed' : d.category === 'command_not_found' ? 'unavailable' : 'failed', exitCode: o.exitCode, durationMs: o.durationMs ?? 0,
      summary: passed ? 'passed' : d.summary, diagnostics: d, outputTruncated: !!o.truncated, outputExcerpt: stripAnsi(`${o.stderr}\n${o.stdout}`).trim().slice(-1500) }
  }

  async function debug({ workspace, state, userInstructions, roundsUsed }) {
    const { decision, project, commands } = await plan({ workspace, state, userInstructions, roundsUsed })
    return { project, discoveredCommands: commands, state, policyDecision: decision }
  }

  return { detect, plan, run, skip, fromShell, invalidate, debug, config: cfg }
}
