// Tool observations: compact, deterministic descriptions of tool results, computed once when the
// result is recorded and stored on the tool message (`meta`). Older tool results are replaced by
// their compact form so the full text is not resent forever; the full result stays in the session.
import { extractSymbols } from './fileFacts.js'

const MAX_COMPACT_CHARS = 700
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const list = (items, max = 4) => (items.length > max ? `${items.slice(0, max).join(', ')} (+${items.length - max} more)` : items.join(', '))

/** Lines of command output that carry the failure (assertions, errors), else the tail. */
export function failureExcerpt(text, maxLines = 6, maxChars = 500) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean)
  const key = lines.filter(l => /(fail|error|expected|assert|not ok|✗|✖|exception|cannot|undefined is not|typeerror|referenceerror)/i.test(l))
  const picked = (key.length ? key : lines.slice(-3)).slice(0, maxLines)
  return clip(picked.join(' | '), maxChars)
}

export function isPassFail(result) {
  return result.ok && result.tool === 'shell' ? (result.output.exitCode === 0 ? 'PASSED' : 'FAILED') : null
}

/**
 * @param {{name:string,input:object}} call
 * @param {{ok:boolean,tool:string,output:*,error:*}} result
 * @returns {{ok:boolean, errorCode?:string, compact:string, paths:string[], hits:string[], changed:{path:string,action:string}[]}}
 */
export function describeObservation(call, result) {
  const base = { ok: result.ok, paths: [], hits: [], changed: [] }
  const input = call.input ?? {}
  if (!result.ok) {
    const e = result.error
    const what = input.path ?? input.query ?? input.pattern ?? input.command ?? ''
    const paths = typeof input.path === 'string' ? [input.path] : []
    return { ...base, paths, errorCode: e.code, compact: clip(`${result.tool}${what ? ` ${clip(String(what), 80)}` : ''} failed [${e.code}]: ${e.message.split('\n')[0]}`, MAX_COMPACT_CHARS) }
  }
  const o = result.output ?? {}
  switch (result.tool) {
    case 'read_file': {
      const symbols = extractSymbols(o.content ?? '', 8)
      return { ...base, paths: [o.path], compact: clip(`Read ${o.path} lines ${o.startLine}–${o.endLine} of ${o.totalLines}${o.truncated ? ' (truncated)' : ''}.${symbols.length ? ` Defines: ${symbols.join(', ')}.` : ''}`, MAX_COMPACT_CHARS) }
    }
    case 'read_many_files': {
      const ok = o.files.filter(f => f.ok)
      const bad = o.files.filter(f => !f.ok)
      const parts = ok.map(f => `${f.path} (${f.startLine}–${f.endLine}/${f.totalLines})`)
      return { ...base, paths: ok.map(f => f.path), compact: clip(`Read ${ok.length} files: ${list(parts, 6)}.${bad.length ? ` Failed: ${list(bad.map(f => `${f.path} [${f.error.code}]`))}.` : ''}`, MAX_COMPACT_CHARS) }
    }
    case 'grep': {
      const files = [...new Set(o.matches.map(m => m.path))]
      return { ...base, hits: files, compact: clip(`Search "${clip(String(input.pattern ?? ''), 60)}" matched ${o.matches.length}${o.truncated ? '+' : ''} locations across ${files.length} files.${files.length ? ` Most relevant: ${list(files, 4)}.` : ''}`, MAX_COMPACT_CHARS) }
    }
    case 'search_files': {
      const files = o.matches.map(m => m.path)
      return { ...base, hits: files, compact: clip(`File search "${clip(String(input.query ?? ''), 60)}": ${files.length}${o.truncated ? '+' : ''} matches${files.length ? ` — ${list(files, 5)}` : ''}.`, MAX_COMPACT_CHARS) }
    }
    case 'list_directory':
      return { ...base, compact: `Listed ${o.path || 'repository root'}: ${o.entries.length} entries${o.truncated ? '+' : ''}.` }
    case 'shell': {
      const status = o.timedOut ? 'TIMED OUT' : o.exitCode === 0 ? 'PASSED' : 'FAILED'
      const excerpt = o.exitCode === 0 ? '' : ` ${failureExcerpt(`${o.stderr}\n${o.stdout}`)}`
      return { ...base, compact: clip(`$ ${clip(o.command, 120)} → exit ${o.exitCode ?? 'none'} (${status}).${excerpt}`, MAX_COMPACT_CHARS) }
    }
    case 'git_diff':
      return { ...base, paths: o.files.map(f => f.path), compact: clip(`git diff${input.staged ? ' --staged' : ''}: ${o.files.length} files (+${o.additions} −${o.deletions})${o.files.length ? ` — ${list(o.files.map(f => f.path), 6)}` : ''}.`, MAX_COMPACT_CHARS) }
    case 'git_status': {
      const groups = [['modified', o.modified], ['staged', o.staged], ['deleted', o.deleted], ['untracked', o.untracked]].filter(([, l]) => l.length)
      return { ...base, compact: clip(`git status on ${o.branch}: ${o.clean ? 'clean' : groups.map(([k, l]) => `${k} ${list(l, 3)}`).join('; ')}.`, MAX_COMPACT_CHARS) }
    }
    case 'apply_patch':
      return { ...base, paths: o.changedFiles, changed: o.files.map(f => ({ path: f.path, action: f.change })), compact: clip(`Applied patch (${o.appliedHunks} hunks): ${o.files.map(f => `${f.change} ${f.path}`).join(', ')}.`, MAX_COMPACT_CHARS) }
    case 'write_file':
      return { ...base, paths: [o.path], changed: [{ path: o.path, action: o.created ? 'created' : 'modified' }], compact: `${o.created ? 'Created' : 'Overwrote'} ${o.path} (${o.bytesWritten} bytes).` }
    case 'delete_file':
      return { ...base, paths: [o.path], changed: [{ path: o.path, action: 'deleted' }], compact: `Deleted ${o.path}.` }
    default:
      return { ...base, compact: clip(`${result.tool} completed.`, MAX_COMPACT_CHARS) }
  }
}

/** Compact form of a recorded tool message (falls back to a clipped copy for messages without meta). */
export function compactToolContent(message, maxFallbackChars = 400) {
  return message.meta?.compact ?? clip(message.content.replace(/\s+/g, ' '), maxFallbackChars)
}

/** Superseded: the file was modified after this read, so its old content must not be trusted. */
export function supersededContent(message, paths) {
  return `${message.meta?.compact ?? 'Read result'} [Superseded: ${list(paths, 3)} modified afterwards — re-read for current content.]`
}

/** Shrinks large string arguments (file bodies, patches) in an old assistant tool call; keeps it valid JSON. */
export function compactToolCall(call, maxString = 300) {
  if (!call.input || typeof call.input !== 'object') return call
  const input = {}
  for (const [k, v] of Object.entries(call.input)) {
    input[k] = typeof v === 'string' && v.length > maxString ? `${v.slice(0, 200)}…[${v.length - 200} chars omitted]` : v
  }
  return { ...call, input }
}
