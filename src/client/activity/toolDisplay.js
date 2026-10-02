// Readable names and labels for technical tool names. Display only; the runtime knows nothing of this.

export const TOOL_INFO = Object.freeze({
  read_file: { category: 'read', title: 'Read' },
  read_many_files: { category: 'read', title: 'Read files' },
  list_directory: { category: 'read', title: 'List directory' },
  search_files: { category: 'search', title: 'Search files' },
  grep: { category: 'search', title: 'Search code' },
  apply_patch: { category: 'modify', title: 'Modify files' },
  write_file: { category: 'modify', title: 'Write file' },
  delete_file: { category: 'modify', title: 'Delete file' },
  shell: { category: 'command', title: 'Run command' },
  git_status: { category: 'git', title: 'Check git status' },
  git_diff: { category: 'git', title: 'Inspect changes' },
})

export const toolInfo = (tool) => TOOL_INFO[tool] ?? { category: 'other', title: tool }

const clip = (s, n = 90) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Present-tense label while running, past-tense once finished. `inputSummary` is the redacted summary from events. */
export function toolLabel(tool, input = {}, done = false) {
  switch (tool) {
    case 'read_file': return `${done ? 'Read' : 'Reading'} ${input.path ?? 'file'}`
    case 'read_many_files': return `${done ? 'Read' : 'Reading'} ${plural(Array.isArray(input.paths) ? input.paths.filter(p => typeof p === 'string' && !p.startsWith('…')).length || input.paths.length : 0, 'file')}`
    case 'list_directory': return `${done ? 'Listed' : 'Listing'} ${input.path || 'repository root'}`
    case 'search_files': return `${done ? 'Searched files for' : 'Searching files for'} “${clip(input.query ?? '', 60)}”`
    case 'grep': return `${done ? 'Searched' : 'Searching'} “${clip(input.pattern ?? '', 60)}”`
    case 'apply_patch': return done ? 'Modified files' : 'Applying changes'
    case 'write_file': return `${done ? 'Wrote' : 'Writing'} ${input.path ?? 'file'}`
    case 'delete_file': return `${done ? 'Deleted' : 'Deleting'} ${input.path ?? 'file'}`
    case 'shell': return `${done ? 'Ran' : 'Running'} ${clip(input.command ?? 'command', 100)}`
    case 'git_status': return done ? 'Checked git status' : 'Checking git status'
    case 'git_diff': return `${done ? 'Inspected' : 'Inspecting'} changes${input.path ? ` in ${input.path}` : ''}`
    default: return `${done ? 'Ran' : 'Running'} ${tool}`
  }
}

const ACTION_VERB = { created: 'Created', modified: 'Modified', deleted: 'Deleted' }
export const fileActionLabel = (action, path) => `${ACTION_VERB[action] ?? 'Changed'} ${path}`

const VALIDATION_NAME = { test: 'Tests', lint: 'Lint', typecheck: 'Type check', build: 'Build', format_check: 'Format check', custom: 'Checks' }
export const validationName = (kind) => VALIDATION_NAME[kind] ?? 'Checks'

/** "Tests passed", "Build failed", "Lint unavailable", … */
export function validationLabel(kind, status, running = false) {
  const name = validationName(kind)
  if (running) return `Running ${name.toLowerCase()}`
  const word = { passed: 'passed', failed: 'failed', error: 'could not run', cancelled: 'cancelled', skipped: 'skipped', unavailable: 'unavailable' }[status] ?? status
  return `${name} ${word}`
}

/** One-line header for a group of consecutive activity items of the same category. */
export function groupHeader(category, items) {
  const done = items.every(i => i.status !== 'running')
  const paths = [...new Set(items.flatMap(i => i.paths ?? []))]
  switch (category) {
    case 'read': return `${done ? 'Read' : 'Reading'} ${plural(paths.length || items.length, 'file')}`
    case 'search': return `${done ? 'Searched' : 'Searching'} ${plural(items.length, 'time')}`
    case 'modify': {
      const files = [...new Set(items.flatMap(i => (i.files ?? []).map(f => f.path)))]
      return files.length ? `${done ? 'Changed' : 'Changing'} ${plural(files.length, 'file')}` : `${done ? 'Changed' : 'Changing'} files`
    }
    case 'command': return `${done ? 'Ran' : 'Running'} ${plural(items.length, 'command')}`
    case 'git': return done ? 'Inspected repository state' : 'Inspecting repository state'
    case 'validation': {
      const failed = items.filter(i => i.status === 'failed').length
      const passed = items.filter(i => i.status === 'done').length
      return !done ? 'Running checks' : failed ? `Checks: ${passed} passed, ${failed} failed` : `Checks: ${plural(passed, 'check')} passed`
    }
    default: return `${items.length} actions`
  }
}
