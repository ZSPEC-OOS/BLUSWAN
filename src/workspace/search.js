// Path discovery and content search over the file index. Pure Node, deterministic.
import fs from 'node:fs/promises'
import path from 'node:path'
import { WorkspaceError } from './errors.js'

export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

const inScope = (file, scope) => scope === '' || file === scope || file.startsWith(`${scope}/`)

/**
 * Filename/path discovery. Plain queries are case-insensitive substring matches
 * scored by where they hit; queries containing * or ? are globs (matched against
 * the basename when they contain no '/'). Ties break alphabetically.
 */
export function searchPaths(files, query, { scope = '', limit = 100 } = {}) {
  const q = query.trim()
  if (q === '') throw new WorkspaceError('invalid_input', 'query must not be empty')
  const isGlob = /[*?]/.test(q)
  const matcher = isGlob ? globToRegExp(q) : null
  const needle = q.toLowerCase()
  const scored = []
  for (const file of files) {
    if (!inScope(file, scope)) continue
    const base = file.slice(file.lastIndexOf('/') + 1)
    let score = 0
    if (isGlob) {
      if (matcher.test(q.includes('/') ? file : base)) score = 50
    } else {
      const b = base.toLowerCase()
      const f = file.toLowerCase()
      if (b === needle) score = 100
      else if (b.startsWith(needle)) score = 80
      else if (b.includes(needle)) score = 60
      else if (f.includes(needle)) score = 40
    }
    if (score > 0) scored.push({ path: file, score: score - Math.min(file.split('/').length, 9) / 10 })
  }
  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { matches: scored.slice(0, limit), total: scored.length, truncated: scored.length > limit }
}

function buildMatcher(pattern, { regex, caseSensitive }) {
  const source = regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return new RegExp(source, caseSensitive ? '' : 'i')
  } catch (e) {
    throw new WorkspaceError('invalid_input', `Invalid regular expression: ${e.message}`)
  }
}

/** Line-oriented content search. Skips binary and oversized files. */
export async function grepFiles({ root, files, pattern, scope = '', regex = false, caseSensitive = false, limit, limits }) {
  if (typeof pattern !== 'string' || pattern === '') throw new WorkspaceError('invalid_input', 'pattern must not be empty')
  const matcher = buildMatcher(pattern, { regex, caseSensitive })
  const matches = []
  let truncated = false
  let filesSearched = 0
  outer:
  for (const file of files) {
    if (!inScope(file, scope)) continue
    const abs = path.join(root, ...file.split('/'))
    let buf
    try {
      const st = await fs.stat(abs)
      if (st.size > limits.maxGrepFileBytes) continue
      buf = await fs.readFile(abs)
    } catch { continue }
    if (buf.subarray(0, 8000).includes(0)) continue
    filesSearched++
    const lines = buf.toString('utf8').split('\n')
    for (let n = 0; n < lines.length; n++) {
      const m = matcher.exec(lines[n])
      if (!m) continue
      if (matches.length >= limit) { truncated = true; break outer }
      const text = lines[n].replace(/\r$/, '')
      matches.push({
        path: file, line: n + 1, column: m.index + 1,
        text: text.length > limits.maxGrepLineLength ? `${text.slice(0, limits.maxGrepLineLength)}…` : text,
      })
    }
  }
  return { matches, truncated, filesSearched }
}
