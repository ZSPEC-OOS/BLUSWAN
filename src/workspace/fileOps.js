// Filesystem operations for a workspace root. All inputs are workspace-relative.
import fs from 'node:fs/promises'
import path from 'node:path'
import { WorkspaceError } from './errors.js'
import { normalizeRelativePath, assertMutablePath } from './pathSafety.js'

const typeOf = d => (d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'directory' : d.isFile() ? 'file' : 'other')

function int(name, v, min = 1) {
  if (v === undefined || v === null) return undefined
  if (!Number.isInteger(v) || v < min) throw new WorkspaceError('invalid_input', `${name} must be an integer >= ${min}`)
  return v
}

async function statOrThrow(fn, abs, rel) {
  try { return await fn(abs) } catch (e) {
    if (e.code === 'ENOENT') throw new WorkspaceError('file_not_found', `File not found: ${rel}`)
    if (e.code === 'ENOTDIR') throw new WorkspaceError('not_a_directory', `A parent of ${rel} is not a directory`)
    throw e
  }
}

export function createFileOps({ resolve, limits, index }) {
  async function readFile(p, { startLine, endLine, maxBytes } = {}) {
    const rel = normalizeRelativePath(p, { allowRoot: false })
    const start = int('startLine', startLine) ?? 1
    const end = int('endLine', endLine)
    if (end !== undefined && end < start) throw new WorkspaceError('invalid_input', 'endLine must be >= startLine')
    const budget = Math.min(maxBytes ?? limits.maxReadBytes, limits.maxReadBytes)

    const abs = await resolve(rel)
    const st = await statOrThrow(fs.stat, abs, rel)
    if (!st.isFile()) throw new WorkspaceError('not_a_file', `Not a file: ${rel}`)
    if (st.size > limits.maxFileBytes) {
      throw new WorkspaceError('output_limit_exceeded', `File too large (${st.size} bytes, limit ${limits.maxFileBytes}): ${rel}`)
    }
    const buf = await fs.readFile(abs)
    if (buf.subarray(0, 8000).includes(0)) throw new WorkspaceError('binary_file', `Binary file: ${rel}`)

    const text = buf.toString('utf8')
    const endsWithNewline = text.endsWith('\n')
    const all = text === '' ? [] : (endsWithNewline ? text.slice(0, -1) : text).split('\n')
    const totalLines = all.length
    if (totalLines > 0 && start > totalLines) {
      throw new WorkspaceError('invalid_input', `startLine ${start} is beyond end of file (${totalLines} lines): ${rel}`)
    }

    const last = Math.min(end ?? totalLines, totalLines)
    const picked = []
    let bytes = 0
    let truncated = false
    let lastIncluded = start - 1
    for (let n = start; n <= last; n++) {
      const line = all[n - 1]
      const cost = Buffer.byteLength(line) + 1
      if (bytes + cost > budget) {
        truncated = true
        if (picked.length === 0) {
          picked.push(Buffer.from(line).subarray(0, budget).toString('utf8'))
          lastIncluded = n
        }
        break
      }
      picked.push(line)
      bytes += cost
      lastIncluded = n
    }
    const cutMidLine = truncated && picked.length === 1 && lastIncluded === start && Buffer.byteLength(all[start - 1]) + 1 > budget
    const reachesEnd = lastIncluded === totalLines
    const content = picked.join('\n') + (picked.length && !cutMidLine && (!reachesEnd || endsWithNewline) ? '\n' : '')
    return {
      path: rel, content, startLine: totalLines === 0 ? 0 : start, endLine: lastIncluded < start ? 0 : lastIncluded,
      totalLines, truncated,
      ...(truncated && lastIncluded < totalLines ? { nextStartLine: lastIncluded + 1 } : {}),
    }
  }

  async function writeFile(p, content) {
    const rel = normalizeRelativePath(p, { allowRoot: false })
    assertMutablePath(rel)
    if (typeof content !== 'string') throw new WorkspaceError('invalid_input', 'content must be a string')
    const bytesWritten = Buffer.byteLength(content)
    if (bytesWritten > limits.maxWriteBytes) {
      throw new WorkspaceError('output_limit_exceeded', `Content exceeds ${limits.maxWriteBytes} bytes`)
    }
    const abs = await resolve(rel)
    let existing = null
    try { existing = await fs.lstat(abs) } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e }
    if (existing && !existing.isFile() && !existing.isSymbolicLink()) throw new WorkspaceError('not_a_file', `Not a file: ${rel}`)
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content)
    } catch (e) {
      if (e.code === 'ENOTDIR' || e.code === 'EEXIST') throw new WorkspaceError('not_a_directory', `A parent of ${rel} is not a directory`)
      if (e.code === 'EISDIR') throw new WorkspaceError('not_a_file', `Not a file: ${rel}`)
      throw e
    }
    index.invalidate()
    return { path: rel, created: !existing, overwritten: !!existing, bytesWritten }
  }

  async function deleteFile(p) {
    const rel = normalizeRelativePath(p, { allowRoot: false })
    assertMutablePath(rel)
    const abs = await resolve(rel, { followFinal: false })
    const st = await statOrThrow(fs.lstat, abs, rel)
    if (st.isDirectory()) throw new WorkspaceError('not_a_file', `Refusing to delete a directory: ${rel}`)
    await fs.unlink(abs)
    index.invalidate()
    return { path: rel, deleted: true }
  }

  async function stat(p) {
    const rel = normalizeRelativePath(p)
    const abs = await resolve(rel, { followFinal: false })
    const st = await statOrThrow(fs.lstat, abs, rel || '.')
    return {
      path: rel, size: st.size, mtimeMs: st.mtimeMs,
      type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
    }
  }

  async function exists(p) {
    try { await stat(p); return true } catch (e) {
      if (e.code === 'file_not_found' || e.code === 'not_a_directory') return false
      throw e
    }
  }

  async function listDirectory(p = '', { depth = 1 } = {}) {
    const rel = normalizeRelativePath(p)
    if (!Number.isInteger(depth) || depth < 1 || depth > limits.maxDirectoryDepth) {
      throw new WorkspaceError('invalid_input', `depth must be an integer between 1 and ${limits.maxDirectoryDepth}`)
    }
    const abs = await resolve(rel)
    const st = await statOrThrow(fs.stat, abs, rel || '.')
    if (!st.isDirectory()) throw new WorkspaceError('not_a_directory', `Not a directory: ${rel}`)

    const entries = []
    let truncated = false
    async function walk(relDir, level) {
      const dirents = await fs.readdir(path.join(abs, relDir.slice(rel.length).replace(/^\//, '')), { withFileTypes: true })
      dirents.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1
        const bd = b.isDirectory() ? 0 : 1
        return ad - bd || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      })
      for (const d of dirents) {
        if (entries.length >= limits.maxDirectoryEntries) { truncated = true; return }
        const childRel = relDir === '' ? d.name : `${relDir}/${d.name}`
        const type = typeOf(d)
        const ignored = type === 'directory' && index.isIgnoredName(d.name)
        entries.push({ name: d.name, path: childRel, type, ...(ignored ? { ignored: true } : {}) })
        if (type === 'directory' && !ignored && level < depth) await walk(childRel, level + 1)
        if (truncated) return
      }
    }
    await walk(rel, 1)
    return { path: rel, entries, truncated }
  }

  return { readFile, writeFile, deleteFile, stat, exists, listDirectory }
}
