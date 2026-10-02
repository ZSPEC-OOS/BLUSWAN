// Derives the visible conversation (messages, tool activity, notices, errors) purely from
// normalized runtime events. No provider-specific logic.

const LABELS = {
  read_file: i => `Reading ${i.path ?? 'file'}${i.startLine ? ` (lines ${i.startLine}-${i.endLine ?? 'end'})` : ''}`,
  read_many_files: i => `Reading ${Array.isArray(i.paths) ? i.paths.length : 'several'} files`,
  list_directory: i => `Listing ${i.path || 'repository root'}`,
  search_files: i => `Finding files "${i.query ?? ''}"`,
  grep: i => `Searching "${i.pattern ?? ''}"`,
  apply_patch: () => 'Applying patch',
  write_file: i => `Writing ${i.path ?? 'file'}`,
  delete_file: i => `Deleting ${i.path ?? 'file'}`,
  shell: i => `Running ${i.command ?? 'command'}`,
  git_status: () => 'Checking git status',
  git_diff: i => `Inspecting diff${i.path ? ` of ${i.path}` : ''}`,
}

const VALIDATION_LABEL = { test: 'tests', lint: 'lint', typecheck: 'type check', build: 'build', format_check: 'format check', custom: 'checks' }

export function describeToolCall(tool, inputSummary = {}) {
  return (LABELS[tool] ?? (() => `Running ${tool}`))(inputSummary)
}

/** @returns {{kind:string,id:string,text?:string,label?:string,status?:string,changed?:string[]}[]} */
export function buildTimeline(events) {
  const items = []
  const tools = new Map()
  for (const e of events) {
    switch (e.type) {
      case 'user.message':
        items.push({ kind: 'user', id: e.id, text: e.data.content })
        break
      case 'assistant.text.completed':
        if (e.data.text) items.push({ kind: 'assistant', id: e.id, text: e.data.text })
        break
      case 'tool.started': {
        const item = { kind: 'tool', id: e.data.toolCallId, label: describeToolCall(e.data.tool, e.data.inputSummary), status: 'running', changed: [] }
        tools.set(item.id, item)
        items.push(item)
        break
      }
      case 'tool.completed':
        if (tools.has(e.data.toolCallId)) tools.get(e.data.toolCallId).status = 'done'
        break
      case 'tool.failed':
        if (tools.has(e.data.toolCallId)) Object.assign(tools.get(e.data.toolCallId), { status: 'failed', error: e.data.error?.message })
        break
      case 'file.changed':
        tools.get(e.data.toolCallId)?.changed.push(`${e.data.action} ${e.data.path}`)
        break
      case 'validation.started': {
        const item = { kind: 'tool', id: e.data.validationId, label: `Running ${VALIDATION_LABEL[e.data.kind] ?? 'checks'}: ${e.data.command}`, status: 'running', changed: [] }
        tools.set(item.id, item)
        items.push(item)
        break
      }
      case 'validation.completed': {
        const item = tools.get(e.data.validationId)
        if (item) {
          item.status = e.data.status === 'passed' ? 'done' : ['failed', 'error'].includes(e.data.status) ? 'failed' : 'skipped'
          item.label = `${VALIDATION_LABEL[e.data.kind] ?? 'Checks'} ${e.data.status === 'passed' ? 'passed' : e.data.status}: ${e.data.command}`
          if (item.status === 'failed') item.error = e.data.summary
        }
        break
      }
      case 'completion.warning':
        items.push({ kind: 'notice', id: e.id, text: `Unverified claim: "${e.data.claim}" — ${e.data.problem}.` })
        break
      case 'provider.retry':
        items.push({ kind: 'notice', id: e.id, text: `Retrying request (attempt ${e.data.attempt}, ${e.data.reason})…` })
        break
      case 'session.cancelled':
        items.push({ kind: 'notice', id: e.id, text: 'Stopped. Completed changes were kept.' })
        break
      case 'session.failed':
        items.push({ kind: 'error', id: e.id, text: e.data.error?.message ?? 'The run failed.', code: e.data.error?.code })
        break
      default:
        break
    }
  }
  return items
}

/** Assistant text streamed since the last committed message. */
export function liveText(events) {
  let text = ''
  for (const e of events) {
    if (e.type === 'user.message' || e.type === 'assistant.text.completed') text = ''
    else if (e.type === 'assistant.text.delta') text += e.data.text ?? ''
  }
  return text
}
