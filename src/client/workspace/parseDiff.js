// Structured parsing of git unified diffs: files → hunks → typed lines. Pure and defensive: anything that does
// not look like a diff yields `{ files: [], malformed: true, raw }` so the viewer can fall back to plain text.

const FILE_RE = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/**
 * @typedef {{type:'context'|'add'|'del'|'meta', text:string, oldNo:number|null, newNo:number|null}} DiffLine
 * @typedef {{header:string, section:string, oldStart:number, newStart:number, lines:DiffLine[]}} Hunk
 * @typedef {{path:string, oldPath:string, status:'modified'|'added'|'deleted'|'renamed', binary:boolean, hunks:Hunk[],
 *            additions:number, deletions:number, renamedFrom?:string}} DiffFile
 */

/** @returns {{files:DiffFile[], truncated:boolean, malformed:boolean, raw?:string}} */
export function parseDiff(text, { truncated = false } = {}) {
  const src = String(text ?? '')
  if (src.trim() === '') return { files: [], truncated, malformed: false }
  const files = []
  let file = null
  let hunk = null
  let oldNo = 0
  let newNo = 0
  for (const line of src.split('\n')) {
    const fm = FILE_RE.exec(line)
    if (fm) {
      file = { path: fm[2], oldPath: fm[1], status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0 }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (!hunk) { // extended header lines
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.renamedFrom = line.slice(12) }
      else if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) file.binary = true
      else if (line.startsWith('--- ') && line.includes('/dev/null')) file.status = file.status === 'renamed' ? 'renamed' : 'added'
      else if (line.startsWith('+++ ') && line.includes('/dev/null')) file.status = 'deleted'
    }
    const hm = HUNK_RE.exec(line)
    if (hm) {
      oldNo = Number(hm[1]); newNo = Number(hm[3])
      hunk = { header: line.replace(/ ?[^@]*$/, '').trim() || line, section: hm[5] ?? '', oldStart: oldNo, newStart: newNo, lines: [] }
      hunk.header = `@@ -${hm[1]}${hm[2] !== undefined ? `,${hm[2]}` : ''} +${hm[3]}${hm[4] !== undefined ? `,${hm[4]}` : ''} @@`
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (line.startsWith('\\')) { hunk.lines.push({ type: 'meta', text: line.slice(2) || 'No newline at end of file', oldNo: null, newNo: null }); continue }
    const c = line[0]
    if (c === '+') { hunk.lines.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ }); file.additions++ }
    else if (c === '-') { hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null }); file.deletions++ }
    else if (c === ' ') hunk.lines.push({ type: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    // anything else (blank trailing line) is ignored
  }
  if (!files.length) return { files: [], truncated, malformed: true, raw: src }
  if (truncated) { // a cut diff may end mid-hunk; keep what parsed
    return { files, truncated: true, malformed: false }
  }
  return { files, truncated, malformed: false }
}

/** Total rendered lines, for deciding whether to collapse/virtualize. */
export const countLines = (files) => files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length + 1, 1), 0)
