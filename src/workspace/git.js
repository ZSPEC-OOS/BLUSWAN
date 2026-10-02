// Git access through the local `git` executable (no shell, argv only).
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WorkspaceError } from './errors.js'
import { summarizeDiff } from './diff.js'

const GIT_TIMEOUT_MS = 30_000
const MAX_UNTRACKED_DIFFS = 200

/** Environment for git subprocesses: inherited env minus repository-redirecting variables. */
export function sanitizedEnv(extra = {}) {
  const env = { ...process.env, ...extra, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[k]
  return env
}

function runGit(cwd, args, { okCodes = [0], maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['--literal-pathspecs', '-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      { cwd, env: sanitizedEnv(), encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr })
        if (err.code === 'ENOENT') return reject(new WorkspaceError('git_error', 'git executable not found'))
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          return reject(new WorkspaceError('output_limit_exceeded', 'git output exceeded the buffer limit'))
        }
        if (typeof err.code === 'number' && okCodes.includes(err.code)) return resolve({ code: err.code, stdout, stderr })
        const message = (stderr || err.message || '').trim().slice(0, 500)
        const code = /not a git repository/i.test(message) ? 'git_not_repository' : 'git_error'
        reject(new WorkspaceError(code, `git ${args[0]} failed: ${message}`))
      })
  })
}

function truncateAtLine(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  let cut = Buffer.from(text).subarray(0, maxBytes).toString('utf8')
  const nl = cut.lastIndexOf('\n')
  if (nl > 0) cut = cut.slice(0, nl + 1)
  return { text: cut, truncated: true }
}

export function parseStatusPorcelain(raw) {
  const tokens = raw.split('\0')
  const result = { staged: [], modified: [], deleted: [], untracked: [], conflicted: [], renamed: [], entries: [] }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.length < 4) continue
    const x = t[0]
    const y = t[1]
    const file = t.slice(3)
    if (x === 'R' || x === 'C') {
      result.renamed.push({ from: tokens[i + 1], to: file })
      i++
    }
    result.entries.push({ path: file, index: x, worktree: y })
    if (x === '?' && y === '?') { result.untracked.push(file); continue }
    if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { result.conflicted.push(file); continue }
    if (x !== ' ') result.staged.push(file)
    if (y === 'M' || y === 'T') result.modified.push(file)
    if (y === 'D') result.deleted.push(file)
  }
  return result
}


const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_COUNTED_FILE_BYTES = 2 * 1024 * 1024

/** Parses `git diff --numstat -z` (rename-aware): [{path, from?, additions, deletions, binary}]. */
export function parseNumstat(raw) {
  const out = []
  const tokens = raw.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i])
    if (!m) continue
    const binary = m[1] === '-'
    const entry = { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary }
    if (m[3] === '') { // rename/copy: the next two tokens are the old and new paths
      out.push({ ...entry, from: tokens[i + 1], path: tokens[i + 2] })
      i += 2
    } else out.push({ ...entry, path: m[3] })
  }
  return out
}

/** Kind of change for one porcelain entry. */
function classify({ index, worktree }) {
  if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')) return 'conflicted'
  if (index === '?' ) return 'untracked'
  if (index === 'R' || index === 'C') return 'renamed'
  if (index === 'A') return worktree === 'D' ? null : 'added'
  if (index === 'D' || worktree === 'D') return 'deleted'
  return 'modified'
}

async function countUntracked(root, rel) {
  try {
    const abs = path.join(root, rel)
    const st = await fs.stat(abs)
    if (!st.isFile()) return { additions: 0, deletions: 0, binary: false }
    if (st.size > MAX_COUNTED_FILE_BYTES) return { additions: 0, deletions: 0, binary: false, large: true }
    const buf = await fs.readFile(abs)
    if (buf.subarray(0, 8000).includes(0)) return { additions: 0, deletions: 0, binary: true }
    const text = buf.toString('utf8')
    const additions = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    return { additions, deletions: 0, binary: false }
  } catch {
    return { additions: 0, deletions: 0, binary: false }
  }
}

export function createGit({ root, rootReal = root, limits }) {
  const run = (args, opts) => runGit(root, args, opts)

  async function isRepository() {
    try {
      const { stdout } = await run(['rev-parse', '--show-toplevel'])
      return (await fs.realpath(stdout.trim())) === rootReal
    } catch (e) {
      if (e.code === 'git_not_repository' || e.code === 'git_error') return false
      throw e
    }
  }

  async function requireRepository() {
    if (!(await isRepository())) {
      throw new WorkspaceError('git_not_repository', 'Workspace root is not the top level of a git repository')
    }
  }

  async function info() {
    if (!(await isRepository())) return { isGitRepository: false, branch: null, headSha: null }
    const branchRes = await run(['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [0, 1] })
    const headRes = await run(['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] })
    return {
      isGitRepository: true,
      branch: branchRes.code === 0 ? branchRes.stdout.trim() : 'HEAD',
      headSha: headRes.code === 0 ? headRes.stdout.trim() : null,
    }
  }

  async function status() {
    await requireRepository()
    const [{ branch, headSha }, res] = await Promise.all([
      info(), run(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ])
    const parsed = parseStatusPorcelain(res.stdout)
    return { branch, headSha, clean: parsed.entries.length === 0, ...parsed }
  }

  /** Untracked files are included in unstaged diffs (as additions) so the diff reflects the full working tree. */
  async function diff({ path: rel = '', staged = false, includeUntracked = true, againstHead = false, alsoPaths = [] } = {}) {
    await requireRepository()
    const pathArgs = rel ? ['--', rel, ...alsoPaths] : []
    const base = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
    // `againstHead` compares the working tree (staged and unstaged together) with HEAD: the review view.
    let against = []
    if (againstHead && !staged) against = [(await info()).headSha ?? EMPTY_TREE]
    let text = (await run([...base, ...(staged ? ['--cached'] : []), ...against, ...pathArgs])).stdout

    if (!staged && includeUntracked) {
      const { untracked } = parseStatusPorcelain(
        (await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...pathArgs])).stdout)
      for (const file of untracked.slice(0, MAX_UNTRACKED_DIFFS)) {
        if (Buffer.byteLength(text) > limits.maxDiffBytes * 2) break
        const res = await run([...base, '--no-index', '--', '/dev/null', file], { okCodes: [0, 1] })
        text += res.stdout
      }
    }
    const summary = summarizeDiff(text)
    const cut = truncateAtLine(text, limits.maxDiffBytes)
    return {
      diff: cut.text, truncated: cut.truncated, staged,
      files: summary.files, additions: summary.additions, deletions: summary.deletions,
    }
  }

  /**
   * Authoritative changed-file list: `git status` for the kind of change, `git diff --numstat HEAD` for
   * line counts (rename-aware), and a direct line count for untracked files.
   */
  async function changes() {
    await requireRepository()
    const st = await status()
    const base = st.headSha ?? EMPTY_TREE
    const [numRaw] = await Promise.all([run(['diff', '--numstat', '-z', '--no-color', '--no-ext-diff', '--no-textconv', base, '--']).then(r => r.stdout)])
    const counts = new Map(parseNumstat(numRaw).map(c => [c.path, c]))
    const files = []
    for (const e of st.entries) {
      const status_ = classify(e)
      if (!status_) continue
      const renamed = st.renamed.find(r => r.to === e.path)
      let c = counts.get(e.path) ?? { additions: 0, deletions: 0, binary: false }
      if (status_ === 'untracked' && files.filter(f => f.status === 'untracked').length < MAX_UNTRACKED_DIFFS) c = await countUntracked(rootReal, e.path)
      files.push({
        path: e.path, status: status_, ...(renamed ? { from: renamed.from } : {}),
        additions: c.additions, deletions: c.deletions, binary: !!c.binary, ...(c.large ? { large: true } : {}),
        staged: e.index !== ' ' && e.index !== '?', untracked: status_ === 'untracked',
      })
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    return {
      branch: st.branch, headSha: st.headSha, clean: files.length === 0, files,
      additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
    }
  }

  /**
   * Discards uncommitted changes of one path (index and working tree) so it matches HEAD. A file that does not
   * exist in HEAD (new or untracked) is removed. Never touches other paths, never resets or cleans broadly.
   * @returns {Promise<{path:string, action:'restored'|'removed', previous:string}>}
   */
  async function restoreFile(rel) {
    await requireRepository()
    if (!rel || rel === '.git' || rel.startsWith('.git/')) throw new WorkspaceError('invalid_input', 'Cannot revert this path')
    const res = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']) // whole status: rename pairs need both paths
    const parsed = parseStatusPorcelain(res.stdout)
    const entry = parsed.entries.find(e => e.path === rel)
    if (!entry) throw new WorkspaceError('nothing_to_revert', `${rel} has no uncommitted changes`)
    const kind = classify(entry)
    if (kind === 'conflicted') throw new WorkspaceError('revert_conflict', `${rel} has merge conflicts; resolve them in git`)
    if (kind === 'untracked') {
      await fs.rm(path.join(rootReal, rel), { force: true })
      return { path: rel, action: 'removed', previous: kind }
    }
    if (kind === 'renamed') {
      const from = parsed.renamed.find(r => r.to === rel)?.from
      await run(['rm', '-f', '-q', '--', rel])
      if (from) await run(['restore', '--source=HEAD', '--staged', '--worktree', '--', from])
      return { path: rel, action: 'restored', previous: kind }
    }
    if (entry.index === 'A') { // exists only in the index/working tree: not in HEAD
      await run(['rm', '-f', '-q', '--', rel])
      return { path: rel, action: 'removed', previous: kind }
    }
    await run(['restore', '--source=HEAD', '--staged', '--worktree', '--', rel])
    return { path: rel, action: 'restored', previous: kind }
  }

  return { isRepository, info, status, diff, changes, restoreFile, run }

}
