// Structured, serializable session summary. Canonical state is the object below; text for the model
// is rendered from it. Updates are deterministic, incremental, and event-derived; the only optional
// model-assisted parts are `decisions`/`importantFacts` added at compaction time.
// The summary belongs to the session (session.contextSummary). Hidden reasoning is never stored.
import { defaultEstimator } from './tokenEstimator.js'

const CAPS = { decisions: 12, filesInspected: 40, commandsRun: 25, validations: 10, errors: 12, facts: 12, requests: 8, resolved: 5 }
const VALIDATION_RE = /\b(tests?|jest|vitest|mocha|pytest|lint|eslint|tsc|typecheck|type-check|build|check|ruff|mypy|flake8|clippy|go (?:test|vet|build)|cargo (?:test|check|build))\b/i
const CONSTRAINT_RE = /\b(do not|don't|dont|never|must not|should not|shouldn't|without (?:changing|modifying|breaking|touching|removing)|keep|preserve|only|make sure|ensure|avoid|stick to|rather than|instead of|no need to)\b/i

const squash = (s, n) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
const keepLast = (arr, n) => (arr.length > n ? arr.slice(arr.length - n) : arr)
const normCmd = (c) => c.trim().replace(/\s+/g, ' ')

export const isValidationCommand = (command) => VALIDATION_RE.test(command)

export function createSessionSummary(now = Date.now()) {
  return {
    goal: null, currentObjective: null, decisions: [], filesInspected: [], filesChanged: [], commandsRun: [],
    validations: [], unresolvedIssues: [], resolvedIssues: [], errorsEncountered: [], importantFacts: [], userRequests: [],
    revision: 0, lastCompactedMessageId: null, lastUpdatedAt: now,
  }
}

const touch = (s, now, patch) => ({ ...s, ...patch, lastUpdatedAt: now })

/** A file the user discarded changes for is no longer "changed"; earlier reads of it may be out of date. */
export function observeRevert(summary, { path, now = Date.now() }) {
  return touch(summary, now, {
    filesChanged: summary.filesChanged.filter(f => f.path !== path),
    filesInspected: summary.filesInspected.map(f => (f.path === path ? { ...f, modifiedSince: true, ranges: [] } : f)),
  })
}

/** Sentences of a user message that read as standing constraints or decisions. */
export function extractConstraints(text) {
  return text.split(/(?<=[.!?])\s+|\n+/).map(t => t.trim())
    .filter(t => t.length >= 8 && t.length <= 240 && CONSTRAINT_RE.test(t))
}

/** The first request becomes the goal; every request updates the current objective and may add decisions. */
export function observeUserMessage(summary, message, now = Date.now()) {
  const text = String(message.content)
  const decisions = [...summary.decisions]
  for (const t of extractConstraints(text)) {
    const existing = decisions.findIndex(d => d.text.toLowerCase() === t.toLowerCase())
    if (existing >= 0) decisions.splice(existing, 1) // re-stated: move to the end (latest wins)
    decisions.push({ text: t, messageId: message.id ?? null, at: now })
  }
  return touch(summary, now, {
    goal: summary.goal ?? squash(text, 500),
    currentObjective: squash(text, 500),
    decisions: keepLast(decisions, CAPS.decisions),
  })
}

export function mergeRanges(ranges) {
  const sorted = ranges.filter(r => r[0] > 0 && r[1] >= r[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out = []
  for (const [a, b] of sorted) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

function noteRead(summary, { path, startLine, endLine }, now) {
  const files = [...summary.filesInspected]
  const i = files.findIndex(f => f.path === path)
  const prev = i >= 0 ? files[i] : { path, ranges: [], readCount: 0, repeatReads: 0, lastReadAt: now, modifiedSince: false }
  const covered = !prev.modifiedSince && prev.ranges.some(([a, b]) => a <= startLine && b >= endLine)
  const next = {
    ...prev, ranges: mergeRanges([...(prev.modifiedSince ? [] : prev.ranges), [startLine, endLine]]),
    readCount: prev.readCount + 1, repeatReads: prev.repeatReads + (covered ? 1 : 0), lastReadAt: now, modifiedSince: false,
  }
  if (i >= 0) files.splice(i, 1)
  files.push(next)
  return keepLast(files, CAPS.filesInspected)
}

function noteChange(summary, { path, action }, now) {
  const changed = summary.filesChanged.filter(f => f.path !== path)
  changed.push({ path, action, changedAt: now, validatedSinceChange: false })
  const inspected = summary.filesInspected.map(f => (f.path === path ? { ...f, modifiedSince: true, ranges: [] } : f))
  // a deleted/changed file invalidates the pass status of nothing else, but its own validation is pending
  return { filesChanged: changed, filesInspected: inspected }
}

function noteError(summary, call, result, now) {
  const key = `${result.tool}:${call.input?.path ?? call.input?.query ?? call.input?.pattern ?? ''}`
  const errors = [...summary.errorsEncountered, {
    tool: result.tool, code: result.error.code, message: squash(result.error.message.split('\n')[0], 160), at: now, key, resolved: false,
  }]
  return keepLast(errors, CAPS.errors)
}

function resolveErrorsFor(summary, call, tool) {
  const key = `${tool}:${call.input?.path ?? call.input?.query ?? call.input?.pattern ?? ''}`
  return summary.errorsEncountered.map(e => (e.key === key && !e.resolved ? { ...e, resolved: true } : e))
}

function noteCommand(summary, call, result, now) {
  const command = normCmd(call.input?.command ?? '')
  const out = result.output
  const exitCode = result.ok ? out.exitCode : null
  const status = !result.ok ? (result.error.code === 'command_timeout' ? 'timeout' : result.error.code === 'command_cancelled' ? 'cancelled' : 'error')
    : exitCode === 0 ? 'passed' : 'failed'
  const relatedFiles = summary.filesChanged.map(f => f.path)
  const record = { command, exitCode, status, timestamp: now, relatedFiles }
  const patch = { commandsRun: keepLast([...summary.commandsRun, record], CAPS.commandsRun) }

  if (isValidationCommand(command)) {
    patch.validations = keepLast([...summary.validations.filter(v => v.command !== command), record], CAPS.validations)
    if (status === 'passed') {
      patch.filesChanged = summary.filesChanged.map(f => ({ ...f, validatedSinceChange: true }))
      const solved = summary.unresolvedIssues.filter(i => i.command === command)
      patch.unresolvedIssues = summary.unresolvedIssues.filter(i => i.command !== command)
      patch.resolvedIssues = keepLast([...summary.resolvedIssues, ...solved.map(i => ({ ...i, resolvedAt: now }))], CAPS.resolved)
    } else if (status !== 'cancelled') {
      const excerpt = result.ok ? squash(`${out.stderr}\n${out.stdout}`.split('\n').filter(l => /(fail|error|expected|assert|not ok|✗|exception)/i.test(l)).slice(0, 6).join(' | ') || out.stderr || out.stdout, 500) : result.error.message
      const issue = { id: `cmd:${command}`, kind: 'validation_failure', command, message: excerpt, since: summary.unresolvedIssues.find(i => i.command === command)?.since ?? now }
      patch.unresolvedIssues = [...summary.unresolvedIssues.filter(i => i.command !== command), issue]
    }
  }
  return patch
}

/**
 * Folds one tool result into the summary.
 * @param {object} summary
 * @param {{call:{name:string,input:object}, result:{ok:boolean,tool:string,output:*,error:*}, now?:number}} obs
 */
export function observeToolResult(summary, { call, result, now = Date.now() }) {
  let s = summary
  if (!result.ok) {
    s = touch(s, now, { errorsEncountered: noteError(s, call, result, now) })
    if (result.tool === 'shell') s = touch(s, now, noteCommand(s, call, result, now))
    return s
  }
  const o = result.output
  switch (result.tool) {
    case 'read_file':
      s = touch(s, now, { filesInspected: noteRead(s, o, now), errorsEncountered: resolveErrorsFor(s, call, 'read_file') })
      break
    case 'read_many_files':
      for (const f of o.files.filter(x => x.ok)) s = touch(s, now, { filesInspected: noteRead(s, f, now) })
      break
    case 'apply_patch':
      for (const f of o.files) s = touch(s, now, noteChange(s, { path: f.path, action: f.change }, now))
      break
    case 'write_file':
      s = touch(s, now, noteChange(s, { path: o.path, action: o.created ? 'created' : 'modified' }, now))
      break
    case 'delete_file':
      s = touch(s, now, noteChange(s, { path: o.path, action: 'deleted' }, now))
      break
    case 'shell':
      s = touch(s, now, noteCommand(s, call, result, now))
      break
    default:
      break
  }
  return s
}

/** Records history folded out of the provider context: bumps the revision and keeps a digest of earlier requests. */
export function observeFolded(summary, messages, now = Date.now()) {
  if (!messages.length) return summary
  const requests = [...summary.userRequests]
  for (const m of messages) if (m.role === 'user') requests.push({ id: m.id, text: squash(m.content, 200) })
  return touch(summary, now, {
    userRequests: keepLast(requests, CAPS.requests),
    lastCompactedMessageId: messages[messages.length - 1].id,
    revision: summary.revision + 1,
  })
}

/** Merges optional model-assisted additions (already validated: arrays of short strings). */
export function applySummarizerPatch(summary, patch, now = Date.now()) {
  const decisions = [...summary.decisions]
  for (const t of patch.decisions ?? []) {
    if (!decisions.some(d => d.text.toLowerCase() === t.toLowerCase())) decisions.push({ text: squash(t, 240), messageId: null, at: now })
  }
  const facts = [...summary.importantFacts]
  for (const f of patch.importantFacts ?? []) if (!facts.includes(f)) facts.push(squash(f, 240))
  return touch(summary, now, {
    decisions: keepLast(decisions, CAPS.decisions), importantFacts: keepLast(facts, CAPS.facts),
  })
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const rangeText = (ranges) => ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')

function sections(s) {
  const core = []
  if (s.goal) core.push(['Goal', [s.goal]])
  if (s.currentObjective && s.currentObjective !== s.goal) core.push(['Current objective', [s.currentObjective]])
  if (s.decisions.length) core.push(['Decisions and constraints (later entries override earlier ones)', s.decisions.map(d => `- ${d.text}`)])
  if (s.filesChanged.length) {
    core.push(['Files changed', s.filesChanged.map(f => `- ${f.path} (${f.action}${f.validatedSinceChange ? ', validated since' : ', not validated since'})`)])
  }
  if (s.unresolvedIssues.length) core.push(['Unresolved issues', s.unresolvedIssues.map(i => `- ${i.command ? `\`${i.command}\` failing: ` : ''}${i.message}`)])
  if (s.validations.length) {
    core.push(['Validation', s.validations.map(v => `- \`${v.command}\`: ${v.status}${v.exitCode !== null && v.exitCode !== 0 ? ` (exit ${v.exitCode})` : ''}`)])
  }
  const extra = []
  if (s.filesInspected.length) {
    extra.push(['Files inspected', s.filesInspected.map(f => `- ${f.path}${f.modifiedSince ? ' (modified since read)' : f.ranges.length ? ` lines ${rangeText(f.ranges)}` : ''}${f.repeatReads ? ` — re-read ${f.repeatReads}x unchanged` : ''}`)])
  }
  if (s.commandsRun.length) extra.push(['Recent commands', keepLast(s.commandsRun, 6).map(c => `- \`${c.command}\` → ${c.status}`)])
  const open = s.errorsEncountered.filter(e => !e.resolved)
  if (open.length) extra.push(['Recent errors', keepLast(open, 4).map(e => `- ${e.tool} [${e.code}]: ${e.message}`)])
  if (s.importantFacts.length) extra.push(['Important facts', s.importantFacts.map(f => `- ${f}`)])
  if (s.resolvedIssues.length) extra.push(['Resolved earlier', s.resolvedIssues.map(i => `- \`${i.command}\` now passes`)])
  if (s.userRequests.length) extra.push(['Earlier requests', s.userRequests.map(r => `- ${r.text}`)])
  return { core, extra }
}

const text = (parts) => parts.map(([title, lines]) => (lines.length === 1 && !lines[0].startsWith('- ') ? `${title}:\n${lines[0]}` : `${title}:\n${lines.join('\n')}`)).join('\n')

/**
 * Renders the summary for the model within a token budget. Levels: 'full' → 'core' (essential state only)
 * → 'minimal' (goal, objective, changed files, unresolved issues).
 * @returns {{text:string, tokens:number, level:string}|null} null when there is nothing to say
 */
export function renderSummary(summary, { estimator = defaultEstimator, maxTokens = 2500, level } = {}) {
  if (!summary || (!summary.goal && !summary.filesChanged.length && !summary.unresolvedIssues.length)) return null
  const { core, extra } = sections(summary)
  const minimalKeys = new Set(['Goal', 'Current objective', 'Files changed', 'Unresolved issues'])
  const variants = {
    full: [...core, ...extra],
    core,
    minimal: core.filter(([t]) => minimalKeys.has(t)),
  }
  const order = level ? [level] : ['full', 'core', 'minimal']
  for (const lv of order) {
    const body = `SESSION SUMMARY (revision ${summary.revision})\n${text(variants[lv])}`
    const tokens = estimator.estimateTokens(body)
    if (tokens <= maxTokens) return { text: body, tokens, level: lv }
    if (lv === order[order.length - 1]) { // even the smallest variant is too big: hard-clip it
      const clipped = `${body.slice(0, Math.floor(maxTokens * 3))}\n…`
      return { text: clipped, tokens: estimator.estimateTokens(clipped), level: lv }
    }
  }
  return null
}
