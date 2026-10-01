// Unified-diff parsing and in-memory application. Pure: no filesystem access.
//
// Supported: modify, create (--- /dev/null), delete (+++ /dev/null), multiple
// files and hunks, `\ No newline at end of file`, a/ b/ prefixes, git headers.
// Rejected: binary patches, renames/copies, duplicate targets, malformed hunks.
import { WorkspaceError } from './errors.js'

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const IGNORED_HEADERS = /^(diff --git |index |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index)/

function parseError(message, line) {
  return new WorkspaceError('patch_parse_error', line ? `${message} (patch line ${line})` : message)
}

function stripPrefix(raw, prefix) {
  const name = raw.split('\t')[0].trimEnd()
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/**
 * @typedef {{type:' '|'-'|'+', text:string}} HunkLine
 * @typedef {{oldStart:number,oldCount:number,newStart:number,newCount:number,lines:HunkLine[],noNewlineNew:boolean}} Hunk
 * @typedef {{path:string,op:'create'|'modify'|'delete',hunks:Hunk[]}} FilePatch
 * @returns {{files:FilePatch[], hunkCount:number}}
 */
export function parsePatch(patchText) {
  if (typeof patchText !== 'string' || patchText.trim() === '') throw parseError('Patch is empty')
  const lines = patchText.replace(/\r\n/g, '\n').split('\n')
  while (lines.length && (lines[lines.length - 1] === '' || /^```/.test(lines[lines.length - 1]))) lines.pop()
  while (lines.length && /^```/.test(lines[0])) lines.shift()

  const files = []
  const seen = new Set()
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line === '' || IGNORED_HEADERS.test(line)) { i++; continue }
    if (/^(rename|copy) (from|to) /.test(line)) throw parseError('Renames and copies are not supported', i + 1)
    if (/^(Binary files |GIT binary patch)/.test(line)) throw parseError('Binary patches are not supported', i + 1)
    if (!line.startsWith('--- ')) throw parseError(`Unexpected line outside a file section: ${line.slice(0, 80)}`, i + 1)
    if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw parseError('Expected "+++" header after "---" header', i + 2)

    const oldRaw = line.slice(4).split('\t')[0].trimEnd()
    const newRaw = lines[i + 1].slice(4).split('\t')[0].trimEnd()
    i += 2
    const isCreate = oldRaw === '/dev/null'
    const isDelete = newRaw === '/dev/null'
    if (isCreate && isDelete) throw parseError('Patch section has no target file', i)
    const oldPath = isCreate ? null : stripPrefix(oldRaw, 'a/')
    const newPath = isDelete ? null : stripPrefix(newRaw, 'b/')
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      throw parseError(`Ambiguous target (rename unsupported): ${oldPath} → ${newPath}`, i)
    }
    const filePath = newPath ?? oldPath
    if (!filePath) throw parseError('Patch section has an empty file path', i)
    if (seen.has(filePath)) throw parseError(`File appears more than once in patch: ${filePath}`, i)
    seen.add(filePath)

    const hunks = []
    while (i < lines.length && lines[i].startsWith('@@')) {
      const m = HUNK_HEADER.exec(lines[i])
      if (!m) throw parseError(`Malformed hunk header: ${lines[i].slice(0, 80)}`, i + 1)
      const hunk = {
        oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]),
        lines: [], noNewlineNew: false,
      }
      i++
      let oldLeft = hunk.oldCount
      let newLeft = hunk.newCount
      while (oldLeft > 0 || newLeft > 0) {
        if (i >= lines.length) throw parseError('Hunk ended before its declared line counts were satisfied', i)
        const l = lines[i]
        const c = l === '' ? ' ' : l[0]
        if (c === ' ') {
          if (oldLeft === 0 || newLeft === 0) throw parseError('Hunk has more lines than declared', i + 1)
          hunk.lines.push({ type: ' ', text: l.slice(1) }); oldLeft--; newLeft--
        } else if (c === '-') {
          if (oldLeft === 0) throw parseError('Hunk has more removed lines than declared', i + 1)
          hunk.lines.push({ type: '-', text: l.slice(1) }); oldLeft--
        } else if (c === '+') {
          if (newLeft === 0) throw parseError('Hunk has more added lines than declared', i + 1)
          hunk.lines.push({ type: '+', text: l.slice(1) }); newLeft--
        } else if (c === '\\') {
          // "\ No newline at end of file" is handled below; only valid after a line.
          if (hunk.lines.length === 0) throw parseError('Unexpected "\\" marker', i + 1)
          const prev = hunk.lines[hunk.lines.length - 1].type
          if (prev !== '-') hunk.noNewlineNew = true
        } else {
          throw parseError(`Invalid hunk line: ${l.slice(0, 80)}`, i + 1)
        }
        i++
      }
      while (i < lines.length && lines[i].startsWith('\\')) {
        const prev = hunk.lines[hunk.lines.length - 1]?.type
        if (prev && prev !== '-') hunk.noNewlineNew = true
        i++
      }
      hunks.push(hunk)
    }
    if (hunks.length === 0) throw parseError(`No hunks for ${filePath}`, i)
    files.push({ path: filePath, op: isCreate ? 'create' : isDelete ? 'delete' : 'modify', hunks })
  }
  if (files.length === 0) throw parseError('Patch contains no file changes')
  return { files, hunkCount: files.reduce((n, f) => n + f.hunks.length, 0) }
}

function matchesAt(lines, at, expected, loose) {
  for (let k = 0; k < expected.length; k++) {
    const a = lines[at + k]
    const b = expected[k]
    if (loose ? a.trimEnd() !== b.trimEnd() : a !== b) return false
  }
  return true
}

function locate(lines, expected, preferred, minIndex, loose) {
  const max = lines.length - expected.length
  for (let d = 0; d <= lines.length; d++) {
    for (const at of d === 0 ? [preferred] : [preferred + d, preferred - d]) {
      if (at >= minIndex && at <= max && matchesAt(lines, at, expected, loose)) return at
    }
  }
  return -1
}

/**
 * Applies one file's hunks to `content` (use '' for create). Throws
 * patch_apply_failed if any hunk's context does not match.
 */
export function applyFilePatch(content, filePatch) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content === '' ? [] : content.replace(/\r?\n$/, '').split(/\r?\n/)
  let endsWithNewline = content === '' ? true : /\n$/.test(content)
  let cursor = 0
  let delta = 0

  filePatch.hunks.forEach((hunk, n) => {
    const expected = hunk.lines.filter(l => l.type !== '+').map(l => l.text)
    const nominal = (hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1) + delta
    let at
    if (expected.length === 0) {
      at = Math.min(Math.max(nominal, cursor), lines.length)
    } else {
      const preferred = Math.max(nominal, cursor)
      at = locate(lines, expected, preferred, cursor, false)
      if (at < 0) at = locate(lines, expected, preferred, cursor, true)
    }
    if (at < 0) {
      throw new WorkspaceError('patch_apply_failed',
        `Hunk ${n + 1} of ${filePatch.path} does not apply: context not found near line ${hunk.oldStart}`, {
          details: {
            path: filePatch.path, hunk: n + 1,
            expected: expected.slice(0, 6),
            found: lines.slice(Math.max(0, nominal), Math.max(0, nominal) + 6),
          },
        })
    }
    // Context lines keep the file's own text (they may match only loosely).
    let src = at
    const replacement = []
    for (const l of hunk.lines) {
      if (l.type === ' ') replacement.push(lines[src++])
      else if (l.type === '-') src++
      else replacement.push(l.text)
    }
    if (at + expected.length === lines.length) endsWithNewline = !hunk.noNewlineNew
    lines.splice(at, expected.length, ...replacement)
    cursor = at + replacement.length
    delta += replacement.length - expected.length
  })

  if (filePatch.op === 'delete' && lines.length > 0) {
    throw new WorkspaceError('patch_apply_failed',
      `Deletion patch for ${filePatch.path} does not remove the entire file`, { details: { path: filePatch.path } })
  }
  return lines.length === 0 ? '' : lines.join(eol) + (endsWithNewline ? eol : '')
}
