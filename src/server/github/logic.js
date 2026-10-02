// Pure helpers for the GitHub workflow: parsing, naming, classification. No I/O.

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(raw) {
  const s = { branch: null, detached: false, upstream: null, oid: null, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, clean: true, files: [], hasCommits: true }
  const tok = String(raw).split('\0'); 
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i]; if (!t) continue
    if (t.startsWith('# branch.oid ')) { s.oid = t.slice(13); s.hasCommits = s.oid !== '(initial)' }
    else if (t.startsWith('# branch.head ')) { const h = t.slice(14); s.detached = h === '(detached)'; s.branch = s.detached ? null : h }
    else if (t.startsWith('# branch.upstream ')) s.upstream = t.slice(18)
    else if (t.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(t); if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]) } }
    else if (t[0] === '1') { const p = t.split(' '); const xy = p[1]; add(p.slice(8).join(' '), xy) }
    else if (t[0] === '2') { const p = t.split(' '); const xy = p[1]; add(p.slice(9).join(' '), xy); i++ } // the next token is the original path
    else if (t[0] === 'u') { const p = t.split(' '); s.conflicts += 1; s.files.push({ path: p.slice(10).join(' '), index: 'U', worktree: 'U', conflict: true }) }
    else if (t[0] === '?') { s.untracked += 1; s.files.push({ path: t.slice(2), index: '?', worktree: '?', untracked: true }) }
  }
  function add(file, xy) {
    if (xy[0] !== '.') s.staged += 1
    if (xy[1] !== '.') s.unstaged += 1
    s.files.push({ path: file, index: xy[0], worktree: xy[1] })
  }
  s.clean = s.files.length === 0
  return s
}

const slug = (text, max = 40) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '')

/** `bluswan/<slug>`; a taken name gets -2, -3 … */
export function suggestBranchName(title, existing = []) {
  const base = `bluswan/${slug(title) || 'task'}`
  const taken = new Set(existing)
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  return `${base}-${Date.now()}`
}

const SENSITIVE = [/(^|\/)\.env(\..+)?$/i, /\.(pem|key|p12|pfx|keystore|jks)$/i, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /(^|\/)\.(npmrc|netrc|pypirc)$/i, /(^|\/)credentials?(\.[a-z]+)?$/i, /(^|\/)(service-?account|secrets?)[^/]*\.(json|ya?ml)$/i, /(^|\/)\.aws\//i]
const SAFE_ENV = /(^|\/)\.env\.(example|sample|template)$/i
/** Files BLUSWAN never stages automatically. */
export const isSensitivePath = (p) => !SAFE_ENV.test(p) && SENSITIVE.some(re => re.test(p))

const isTest = (p) => /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[a-z]+$/i.test(p)
const isDoc = (p) => /\.(md|mdx|txt|rst)$/i.test(p) || /(^|\/)docs?\//i.test(p)

/** Deterministic Conventional-Commit style suggestion; the user edits it. */
export function suggestCommitMessage(files, task) {
  const paths = files.map(f => f.path)
  if (!paths.length) return 'chore: update repository'
  const added = files.filter(f => f.index === 'A' || f.untracked).length
  let type = 'chore'
  if (paths.every(isTest)) type = 'test'
  else if (paths.every(isDoc)) type = 'docs'
  else if (/^(fix|repair|resolve|bug)/i.test(task ?? '')) type = 'fix'
  else if (/^refactor/i.test(task ?? '')) type = 'refactor'
  else if (/^(add|implement|create|build|support)/i.test(task ?? '') || (added && added === paths.length)) type = 'feat'
  else if (paths.some(p => !isTest(p) && !isDoc(p))) type = 'fix'
  let subject
  if (task && task.trim()) subject = task.trim().replace(/^(fix|add|implement|create|refactor|update)\s+/i, '').replace(/[.\s]+$/, '').slice(0, 60)
  if (!subject) {
    const first = paths[0]; const dir = first.includes('/') ? first.split('/').slice(0, 2).join('/') : first
    subject = paths.length === 1 ? `update ${first}` : `update ${dir} and ${paths.length - 1} more file${paths.length === 2 ? '' : 's'}`
  }
  return `${type}: ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`
}

export function derivePrState(pr) {
  if (pr.merged || pr.merged_at) return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.state === 'open') return pr.draft ? 'draft' : 'open'
  return 'unknown'
}

export function summarizeChecks(runs) {
  if (!runs.length) return { status: 'none', total: 0 }
  const bad = runs.filter(r => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion))
  if (runs.some(r => r.status && r.status !== 'completed')) return { status: 'running', total: runs.length, failed: bad.length }
  if (bad.length) return { status: 'failed', total: runs.length, failed: bad.length }
  return { status: 'passed', total: runs.length, failed: 0 }
}

/** Honest validation evidence for a pull request description. */
export function describeValidation(v) {
  if (!v || v.currentStatus === 'none' && !(v.results ?? []).length) return { status: 'not_run', lines: ['⚠ Validation was not run in this conversation.'] }
  if (v.currentStatus === 'stale' || v.mutationSeq > v.validatedSeq) return { status: 'stale', lines: ['⚠ Validation has not been run since the last code change.'] }
  const current = (v.results ?? []).filter(r => r.seq === v.mutationSeq && r.command)
  const lines = current.slice(-8).map(r => `${r.status === 'passed' ? '✓' : r.status === 'failed' || r.status === 'error' ? '✗' : '–'} ${r.command}${r.status === 'passed' ? '' : ` (${r.status})`}`)
  return { status: v.lastRoundStatus, lines: lines.length ? lines : [`Validation status: ${v.lastRoundStatus}`] }
}

/** Which call to action the workflow UI should lead with. */
export function stageOf({ s, task, pushed, remoteOk }) {
  if (!remoteOk) return 'remote_mismatch'
  if (s.conflicts) return 'conflicts'
  if (s.detached) return 'detached'
  if (s.isDefault) return s.clean ? 'ready_for_task' : 'protected_dirty'
  const pr = task?.pullRequest
  if (pr?.state === 'merged') return 'merged'
  if (pr?.state === 'closed') return 'closed_unmerged'
  if (pr) return 'waiting_for_merge'
  if (!s.clean) return 'has_changes'
  if (!task || task.workflowStatus === 'branch_created') return 'working'
  if (!pushed || s.ahead > 0) return 'ready_to_push'
  return 'ready_for_pr'
}
