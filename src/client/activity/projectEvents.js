// Projects canonical runtime events into the conversation transcript: messages, grouped activity,
// permission prompts, notices, errors. Deterministic and incremental (O(1) per event); all activity is
// derived from real events, never from timers. One logical item (e.g. a tool call) is one row whose
// status changes, and one streamed response is one assistant entry.
import { toolInfo, toolLabel, fileActionLabel, validationLabel, groupHeader } from './toolDisplay.js'
import { friendlyError, friendlyToolError, technicalDetails } from './friendlyError.js'

const SUBDUED = new Set(['read', 'search', 'git'])

/** Converts runtime session status into the user-facing state. */
export const STATUS_LABEL = Object.freeze({ ready: 'Ready', working: 'Working', waiting: 'Waiting for approval', completed: 'Completed', stopped: 'Stopped', error: 'Error' })

/** Status of a session that has not produced events yet / from a runtime snapshot. */
export function statusFromRuntime(runtimeStatus) {
  return ({ running: 'working', waiting_permission: 'waiting', completed: 'completed', cancelled: 'stopped', error: 'error' })[runtimeStatus] ?? 'ready'
}

/** @returns {{push(event):void, getView():object, firstUserText():string|null}} */
export function createProjector() {
  let entries = []
  let version = 0
  let cached = null
  let status = 'ready'
  let lastAt = null
  let firstUser = null
  let thinking = false
  let lastOutcome = null
  let pending = null
  let seq = 0
  let openAssistant = -1
  let openGroup = -1
  const itemIndex = new Map() // toolCallId / validationId → { entry, item }

  const bump = () => { version++; cached = null }
  const closeAssistant = () => { openAssistant = -1 }
  const closeGroup = () => { openGroup = -1 }
  const closeAll = () => { closeAssistant(); closeGroup() }
  const add = (entry) => { entries.push(entry); bump(); return entries.length - 1 }
  const replace = (i, entry) => { entries[i] = entry; bump() }

  /** Updates one item inside its group entry immutably. */
  function updateItem(key, patch) {
    const ref = itemIndex.get(key)
    if (!ref) return null
    const idx = entries.indexOf(ref.entry)
    const items = ref.entry.items.map(i => (i.id === key ? { ...i, ...(typeof patch === 'function' ? patch(i) : patch) } : i))
    const next = { ...ref.entry, items }
    next.status = groupStatus(items)
    next.header = groupHeader(next.category, items)
    replace(idx, next)
    itemIndex.set(key, { entry: next })
    for (const i of items) itemIndex.set(i.id, { entry: next })
    if (openGroup === idx) openGroup = idx
    return next
  }

  function addItem(category, item, groupKey) {
    if (openGroup >= 0 && entries[openGroup]?.category === category) {
      const prev = entries[openGroup]
      const items = [...prev.items, item]
      const next = { ...prev, items, status: groupStatus(items), header: groupHeader(category, items) }
      replace(openGroup, next)
      for (const i of items) itemIndex.set(i.id, { entry: next })
    } else {
      closeAssistant()
      const entry = { kind: 'activity', id: `g:${groupKey}`, category, items: [item], status: groupStatus([item]), header: groupHeader(category, [item]) }
      openGroup = add(entry)
      itemIndex.set(item.id, { entry })
    }
  }

  function groupStatus(items) {
    if (items.some(i => i.status === 'running')) return 'running'
    if (items.some(i => i.status === 'failed')) return 'failed'
    if (items.every(i => i.status === 'skipped')) return 'skipped'
    return 'done'
  }

  function endRunningItems(to = 'stopped') {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e.kind === 'activity' && e.items.some(x => x.status === 'running')) {
        const items = e.items.map(x => (x.status === 'running' ? { ...x, status: to === 'stopped' ? 'skipped' : to, label: x.label } : x))
        const next = { ...e, items, status: groupStatus(items), header: groupHeader(e.category, items) }
        replace(i, next)
        for (const x of items) itemIndex.set(x.id, { entry: next })
      }
    }
  }

  function onToolStarted(d) {
    const info = toolInfo(d.tool)
    const input = d.inputSummary ?? {}
    const paths = [input.path, ...(Array.isArray(input.paths) ? input.paths : [])].filter(p => typeof p === 'string' && !p.startsWith('…'))
    addItem(info.category, {
      id: d.toolCallId, tool: d.tool, title: info.title, label: toolLabel(d.tool, input, false), status: 'running',
      paths, files: [], command: d.tool === 'shell' ? input.command : undefined, subdued: SUBDUED.has(info.category), details: [],
    }, d.toolCallId)
  }

  function onToolCompleted(d) {
    const out = d.outputSummary ?? {}
    const ref = itemIndex.get(d.toolCallId)
    const prev = ref?.entry.items.find(i => i.id === d.toolCallId)
    if (!prev) return
    let status = 'done'
    let label = toolLabel(d.tool, d.inputSummary ?? {}, true)
    const details = []
    if (d.tool === 'shell') {
      if (out.timedOut) { status = 'failed'; label = `${prev.command} timed out` }
      else if (out.exitCode !== 0) { status = 'failed'; label = `${prev.command} failed (exit ${out.exitCode})` }
      if (out.excerpt) details.push(out.excerpt)
      if (d.durationMs != null) details.push(`${(d.durationMs / 1000).toFixed(1)}s`)
    }
    if (d.tool === 'read_many_files' && out.paths) details.push(...out.paths)
    if (d.tool === 'read_file' && out.truncated) details.push('(truncated)')
    if (d.tool === 'grep') details.push(`${out.matches ?? 0} matches in ${out.files ?? 0} files`)
    if (d.tool === 'search_files') details.push(...(out.paths ?? []))
    if (d.tool === 'git_diff') details.push(`${out.files ?? 0} files (+${out.additions ?? 0} −${out.deletions ?? 0})`)
    if (d.tool === 'git_status') details.push(out.clean ? 'working tree clean' : `${out.changed ?? 0} changed`)
    if (['apply_patch', 'write_file', 'delete_file'].includes(d.tool) && prev.files.length) {
      label = prev.files.length === 1 ? fileActionLabel(prev.files[0].action, prev.files[0].path) : `Changed ${prev.files.length} files`
    }
    updateItem(d.toolCallId, { status, label, details: [...prev.details, ...details], paths: d.tool === 'read_many_files' && out.paths?.length ? out.paths : prev.paths })
  }

  function onToolFailed(d) {
    const prev = itemIndex.get(d.toolCallId)?.entry.items.find(i => i.id === d.toolCallId)
    if (!prev) return
    const blocked = /blocked by workspace safety policy/i.test(d.error?.message ?? '')
    const reason = blocked ? 'blocked by workspace safety policy' : friendlyToolError(d.error)
    updateItem(d.toolCallId, {
      status: 'failed', label: `${toolLabel(d.tool, d.inputSummary ?? {}, true)} — ${reason}`,
      error: d.error, details: [...prev.details, technicalDetails(d.error)],
    })
  }

  function onFileChanged(d) {
    const ref = itemIndex.get(d.toolCallId)
    const prev = ref?.entry.items.find(i => i.id === d.toolCallId)
    if (!prev) return
    const files = prev.files.some(f => f.path === d.path) ? prev.files.map(f => (f.path === d.path ? { path: d.path, action: d.action } : f)) : [...prev.files, { path: d.path, action: d.action }]
    updateItem(d.toolCallId, { files, paths: files.map(f => f.path), details: files.map(f => fileActionLabel(f.action, f.path)) })
  }

  function onValidationStarted(d) {
    addItem('validation', { id: d.validationId, tool: 'validation', title: 'Validation', kind: d.kind, scope: d.scope, command: d.command, label: validationLabel(d.kind, null, true), status: 'running', paths: [], files: [], details: [], subdued: false }, d.validationId)
  }

  function onValidationCompleted(d) {
    const status = d.status === 'passed' ? 'done' : ['failed', 'error'].includes(d.status) ? 'failed' : 'skipped'
    updateItem(d.validationId, (prev) => ({
      status, label: `${validationLabel(d.kind, d.status)}${d.status === 'passed' && d.summary && d.summary !== 'passed' ? ` — ${d.summary}` : ''}${d.status === 'failed' && d.summary ? ` — ${d.summary}` : ''}`,
      details: [`${d.command}${d.scope ? ` (${d.scope})` : ''}`, ...(d.summary ? [d.summary] : []), ...(d.durationMs != null ? [`${(d.durationMs / 1000).toFixed(1)}s`] : [])].filter(Boolean),
      durationMs: d.durationMs, summary: d.summary, rawStatus: d.status, kind: prev.kind,
    }))
  }

  function push(event) {
    const d = event.data ?? {}
    lastAt = event.timestamp ?? lastAt
    switch (event.type) {
      case 'user.message':
        closeAll()
        thinking = false
        firstUser ??= d.content
        add({ kind: 'user', id: `u:${d.messageId ?? ++seq}`, text: d.content, at: event.timestamp })
        status = 'working'
        break
      case 'session.updated':
        if (d.status === 'running') status = 'working'
        else if (d.status === 'waiting_permission') status = 'waiting'
        bump()
        break
      case 'assistant.reasoning.status':
        thinking = true
        bump()
        break
      case 'assistant.text.delta': {
        thinking = false
        if (openAssistant < 0) { closeGroup(); openAssistant = add({ kind: 'assistant', id: `a:${++seq}`, text: '', streaming: true, at: event.timestamp }) }
        replace(openAssistant, { ...entries[openAssistant], text: entries[openAssistant].text + (d.text ?? '') })
        break
      }
      case 'assistant.text.completed': {
        thinking = false
        if (openAssistant >= 0) {
          if ((d.text ?? '') === '') entries.splice(openAssistant, 1), bump()
          else replace(openAssistant, { ...entries[openAssistant], text: d.text, streaming: false, id: `a:${d.messageId ?? entries[openAssistant].id}` })
        } else if (d.text) {
          closeGroup()
          add({ kind: 'assistant', id: `a:${d.messageId ?? ++seq}`, text: d.text, streaming: false, at: event.timestamp })
        }
        closeAll()
        break
      }
      case 'tool.started': thinking = false; onToolStarted(d); break
      case 'tool.completed': onToolCompleted(d); break
      case 'tool.failed': onToolFailed(d); break
      case 'file.changed': onFileChanged(d); break
      case 'file.reverted':
        closeAll()
        add({ kind: 'notice', id: `n:${++seq}`, tag: 'revert', tone: 'subdued', text: `You reverted ${d.path}.`, path: d.path })
        break
      case 'validation.started': thinking = false; onValidationStarted(d); break
      case 'validation.completed': onValidationCompleted(d); break
      case 'permission.requested':
        closeAll()
        pending = d
        add({ kind: 'permission', id: `p:${d.id}`, request: d, status: 'pending', at: event.timestamp })
        status = 'waiting'
        break
      case 'permission.resolved': {
        const i = entries.findIndex(e => e.kind === 'permission' && e.request.id === d.id)
        if (i >= 0) replace(i, { ...entries[i], status: d.decision })
        if (pending?.id === d.id) pending = null
        if (status === 'waiting') status = 'working'
        break
      }
      case 'provider.retry': {
        const last = entries[entries.length - 1]
        if (last?.kind === 'notice' && last.tag === 'retry') replace(entries.length - 1, { ...last, count: last.count + 1, text: `Retried model request (${last.count + 1}×)` })
        else add({ kind: 'notice', id: `n:${++seq}`, tag: 'retry', tone: 'subdued', count: 1, text: 'Retried model request' })
        break
      }
      case 'completion.warning':
        add({ kind: 'notice', id: `n:${++seq}`, tag: 'claim', tone: 'warning', text: `Unverified: “${d.claim}” — ${d.problem}.` })
        break
      case 'session.completed': {
        closeAll()
        thinking = false
        status = 'completed'
        lastOutcome = d.outcome ?? null
        if (d.outcome) {
          const text = d.outcome === 'success' ? 'Completed' : d.outcome === 'warning' ? 'Completed with warnings' : d.outcome === 'failed' ? 'Validation incomplete' : 'Stopped'
          const detail = d.outcome === 'failed' && d.unresolvedFailures ? `${d.unresolvedFailures} check${d.unresolvedFailures === 1 ? '' : 's'} still failing` : undefined
          add({ kind: 'outcome', id: `o:${d.runId ?? ++seq}`, outcome: d.outcome, text, detail })
        }
        break
      }
      case 'session.cancelled':
        closeAll(); thinking = false; endRunningItems('stopped')
        status = 'stopped'; pending = null; lastOutcome = 'cancelled'
        add({ kind: 'outcome', id: `o:stop:${++seq}`, outcome: 'cancelled', text: 'Stopped', detail: 'Changes already made were kept.' })
        break
      case 'session.failed':
        closeAll(); thinking = false; endRunningItems('stopped')
        status = 'error'; pending = null; lastOutcome = 'failed'
        add({ kind: 'error', id: `e:${++seq}`, text: friendlyError(d.error), code: d.error?.code, details: technicalDetails(d.error), recoverable: ['rate_limit', 'network_error', 'provider_timeout', 'provider_error'].includes(d.error?.code) })
        break
      default:
        break // session.started, context.compacted, command.*: infrastructure, not conversation
    }
  }

  function getView() {
    if (cached) return cached
    let workingLabel = null
    if (status === 'working') {
      workingLabel = thinking ? 'Thinking…' : 'Working…'
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]
        if (e.kind === 'activity') { const run = [...e.items].reverse().find(x => x.status === 'running'); if (run) { workingLabel = `${run.label}…`.replace(/…+$/, '…'); break } }
        if (e.kind === 'assistant' && e.streaming) { workingLabel = 'Writing…'; break }
        if (e.kind === 'user') break
      }
    }
    cached = { version, entries: entries.slice(), status, workingLabel, pendingPermission: pending, lastOutcome, lastAt, streaming: openAssistant >= 0 }
    return cached
  }

  return { push, getView, firstUserText: () => firstUser, lastAt: () => lastAt }
}

/** Convenience: project a whole event list. */
export function projectEvents(events) {
  const p = createProjector()
  for (const e of events) p.push(e)
  return p.getView()
}
