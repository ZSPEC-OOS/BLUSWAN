// Workspace path validation. All tool-supplied paths are workspace-relative,
// POSIX-style, and must stay inside the workspace root (including after
// symlink resolution).
import path from 'node:path'
import fs from 'node:fs/promises'
import { WorkspaceError } from './errors.js'

const PROTECTED_SEGMENTS = new Set(['.git'])

function outside(input) {
  return new WorkspaceError('path_outside_workspace', `Path is outside the workspace: ${String(input).slice(0, 200)}`)
}

/**
 * Pure normalization to a canonical workspace-relative path ('' = root).
 * `./src//App.jsx` → `src/App.jsx`. Backslashes are treated as separators so a
 * Windows-style traversal cannot slip through. Absolute paths are always rejected.
 */
export function normalizeRelativePath(input, { allowRoot = true } = {}) {
  if (typeof input !== 'string') throw new WorkspaceError('invalid_input', 'Path must be a string')
  if (input.includes('\0')) throw new WorkspaceError('invalid_input', 'Path contains a NUL byte')
  if (input.startsWith('/') || input.startsWith('\\') || /^[A-Za-z]:/.test(input)) throw outside(input)
  const stack = []
  for (const seg of input.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (stack.length === 0) throw outside(input)
      stack.pop()
    } else {
      stack.push(seg)
    }
  }
  if (stack.length === 0 && !allowRoot) throw new WorkspaceError('invalid_input', 'Path must not be empty')
  return stack.join('/')
}

/** Repository internals (.git) are never mutated through workspace tools. */
export function isProtectedPath(rel) {
  return PROTECTED_SEGMENTS.has(rel.split('/')[0].toLowerCase())
}

export function assertMutablePath(rel) {
  if (isProtectedPath(rel)) throw new WorkspaceError('permission_denied', `Path is protected and cannot be modified: ${rel}`)
}

function isWithin(rootReal, candidate) {
  return candidate === rootReal || candidate.startsWith(rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep)
}

/**
 * Resolves a normalized relative path to an absolute path, verifying that the
 * deepest existing ancestor (after symlink resolution) stays inside `rootReal`.
 * With `followFinal: false` the last component itself is not resolved, so a
 * symlink can be addressed (e.g. deleted) without following it.
 */
export async function resolveInWorkspace(rootReal, rel, { followFinal = true } = {}) {
  if (rel === '') return rootReal
  const abs = path.join(rootReal, ...rel.split('/'))
  let probe = followFinal ? abs : path.dirname(abs)
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      if (!isWithin(rootReal, real)) throw outside(rel)
      return abs
    } catch (e) {
      if (e instanceof WorkspaceError) throw e
      if (e.code === 'ELOOP') throw outside(rel)
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e
      // A dangling symlink is not traversable but may point anywhere; refuse it.
      try {
        if ((await fs.lstat(probe)).isSymbolicLink()) throw outside(rel)
      } catch (le) {
        if (le instanceof WorkspaceError) throw le
      }
      const parent = path.dirname(probe)
      if (parent === probe) return abs
      probe = parent
    }
  }
}

/** Absolute path → workspace-relative POSIX path. */
export function toWorkspaceRelative(rootReal, abs) {
  return path.relative(rootReal, abs).split(path.sep).join('/')
}
