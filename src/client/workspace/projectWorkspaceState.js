// Pure projection of runtime review state into what the workspace panels render.
// Inputs are canonical data (workspace state from git/session, validation state, command log, conversation
// entries); output is view data only. Nothing here talks to the runtime.
import { validationName } from '../activity/toolDisplay.js'

export const CHANGE_LETTER = Object.freeze({ modified: 'M', added: 'A', untracked: 'A', deleted: 'D', renamed: 'R', conflicted: '!' })
export const CHANGE_LABEL = Object.freeze({ modified: 'Modified', added: 'Added', untracked: 'New file', deleted: 'Deleted', renamed: 'Renamed', conflicted: 'Conflict' })

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

/** Per-check rows: only checks that actually ran; a pass from before the latest change is "stale", never "passed". */
export function projectValidation(validation) {
  if (!validation || !validation.results?.length) return { state: 'none', rows: [], unresolved: [] }
  const latest = new Map()
  for (const r of validation.results) latest.set(`${r.kind}|${r.command}`, r) // later results replace earlier ones
  const rows = [...latest.values()].map((r) => {
    const stale = r.seq !== validation.mutationSeq && r.status !== 'cancelled'
    return {
      id: r.id, kind: r.kind, name: validationName(r.kind), command: r.command, scope: r.scope,
      status: stale ? 'stale' : r.status, ranStatus: r.status, summary: r.summary ?? '', durationMs: r.durationMs ?? null,
      diagnostics: r.diagnostics ?? null, relatedFiles: r.relatedFiles ?? [], stale, completedAt: r.completedAt ?? null,
    }
  })
  const anyStale = rows.some(r => r.stale)
  return { state: anyStale || validation.mutationSeq > validation.validatedSeq ? 'stale' : 'current', rows, unresolved: validation.unresolved ?? [] }
}

/** Shell and validation commands from the conversation, grouped by the user request that caused them. */
export function projectCommands(entries, commandMeta = []) {
  const meta = new Map(commandMeta.map(c => [c.id, c]))
  const groups = []
  let group = null
  const open = (title, id) => { group = { id, title, commands: [] }; groups.push(group) }
  for (const e of entries) {
    if (e.kind === 'user') { group = null; open(clip(e.text, 70) || 'Request', e.id); continue }
    if (e.kind !== 'activity') continue
    for (const item of e.items) {
      if (item.tool !== 'shell' && item.tool !== 'validation') continue
      if (!group) open('This conversation', 'g0')
      const m = meta.get(item.id)
      group.commands.push({
        id: item.id, source: item.tool === 'validation' ? 'validation' : 'shell',
        command: m?.command ?? item.command ?? '', status: item.status === 'running' ? 'running' : (m?.status ?? (item.status === 'failed' ? 'failed' : item.status === 'skipped' ? 'cancelled' : 'passed')),
        exitCode: m?.exitCode ?? null, durationMs: m?.durationMs ?? null, timedOut: !!m?.timedOut, cancelled: !!m?.cancelled || item.status === 'skipped',
        truncated: !!m?.truncated, label: item.label, logged: !!m,
      })
    }
  }
  return groups.filter(g => g.commands.length)
}

/** Map conversation file activity to paths, for "open this file's diff" links. */
export const fileActivityPaths = (item) => (item.files ?? []).map(f => f.path)

/**
 * @param {{state:object|null, validation:object|null, entries:object[], commandMeta:object[], ui:{selectedPath:string|null}}} input
 */
export function projectWorkspaceState({ state, entries = [], commandMeta = [], ui = {} }) {
  const files = (state?.files ?? []).map(f => ({
    ...f, letter: CHANGE_LETTER[f.status] ?? 'M', label: CHANGE_LABEL[f.status] ?? 'Modified',
    deleted: f.status === 'deleted', canOpen: f.status !== 'deleted',
  }))
  const validation = projectValidation(state?.validation)
  const selected = files.find(f => f.path === ui.selectedPath) ?? null
  return {
    source: state?.source ?? 'none',
    gitBacked: state?.source === 'git',
    repository: state?.repository ?? null,
    revision: state?.revision ?? 0,
    changedFiles: files,
    diffSummary: { files: files.length, additions: state?.summary?.additions ?? null, deletions: state?.summary?.deletions ?? null },
    validation,
    commands: projectCommands(entries, commandMeta),
    selectedFile: selected,
    error: state?.error ?? null,
  }
}

/** Neighbouring changed file for next/previous navigation (wraps). */
export function neighbourPath(files, current, delta) {
  if (!files.length) return null
  const i = files.findIndex(f => f.path === current)
  const next = i < 0 ? (delta > 0 ? 0 : files.length - 1) : (i + delta + files.length) % files.length
  return files[next].path
}
