// The GitHub workflow end to end against a fake GitHub (real local bare repositories, real git, real server).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { startServer } from '../main.js'
import { startFakeGithub, generateAppKey } from './testing/fakeGithub.js'
import { createGithubApi } from './api.js'
import { createAppAuth } from './appAuth.js'
import { clonePath, validateOwnerRepo, userKey } from './paths.js'
import { redactGithub } from './redact.js'
import { parseStatusV2, suggestBranchName, suggestCommitMessage, isSensitivePath, describeValidation, summarizeChecks } from './logic.js'
import { createCredentialStore } from '../../providers/credentials/credentialStore.js'
import { createFakeProvider } from '../../agent/testing/fakeProvider.js'
import { createError } from '../../protocol/schemas.js'
import crypto from 'node:crypto'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const until = async (pred, ms = 8000) => { const t0 = Date.now(); while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)) } }
const tmp = (p = 'blu-gh-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); cleanups.push(() => fs.rmSync(d, { recursive: true, force: true })); return d }
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString()
const TOKENS = { 'tok-alice': { id: 'alice', email: null }, 'tok-bob': { id: 'bob', email: null } }
const auth = { mode: 'test', verify: async (t) => { if (!TOKENS[t]) throw createError({ code: 'unauthenticated', message: 'Sign in.' }); return TOKENS[t] } }
const WEBHOOK = 'whsec-test-secret'

async function world({ repos, apiTimeout, hang, persistenceDir, root, fake: given } = {}) {
  const fake = given ?? await startFakeGithub({ repos })
  if (!given) cleanups.push(() => fake.close())
  const rootDir = root ?? tmp(); const data = persistenceDir ?? tmp('blu-data-')
  const seen = []
  const trace = async (url, init) => { const r = await fetch(url, init); seen.push(`${init?.method ?? 'GET'} ${url}`); return r }
  const api = createGithubApi({ apiUrl: fake.url, timeoutMs: apiTimeout ?? 15_000, fetch: trace })
  const appAuth = createAppAuth({ appId: '1', privateKey: generateAppKey(), api })
  const github = { settings: { configured: true, webhook: true, apiUrl: fake.url, webUrl: fake.url, slug: 'bluswan-test' }, api, webApi: api, appAuth,
    secrets: { clientId: 'cid', clientSecret: 'csecret-xyz', webhookSecret: WEBHOOK, stateSecret: 'csecret-xyz' }, cloneUrlOk: () => true }
  const creds = createCredentialStore({ deepseek: { apiKey: 'k', baseUrl: 'x', model: 'm' } })
  const start = async () => {
    const s = await startServer({ env: { BLUSWAN_PORT: '0', BLUSWAN_PERSISTENCE: 'file', BLUSWAN_DATA_DIR: data, BLUSWAN_WORKSPACE_ROOTS: rootDir }, heartbeatMs: 40,
      injected: { auth, credentials: creds, github, providerFactory: () => createFakeProvider({ id: 'deepseek', respond: hang ? () => new Promise(() => {}) : () => [] }) } })
    cleanups.push(() => s.close()); s.base = `http://127.0.0.1:${s.port}`; return s
  }
  let server = await start()
  const call = (token = 'tok-alice') => async (method, url, body) => {
    const res = await fetch(`${server.base}${url}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text(); return { status: res.status, text, json: text ? JSON.parse(text) : null }
  }
  const connect = async (token = 'tok-alice') => {
    const A = call(token); const { json } = await A('POST', '/api/github/connect')
    const state = decodeURIComponent(new URL(json.url).searchParams.get('state'))
    fake.allowCode(`code-${token}`)
    return { A, state, complete: (over = {}) => A('POST', '/api/github/connect/complete', { code: `code-${token}`, installationId: fake.installationId, state, ...over }) }
  }
  const connected = async (token = 'tok-alice') => { const c = await connect(token); const r = await c.complete(); assert.equal(r.status, 200, r.text); return c.A }
  return { fake, root: rootDir, data, github, call, connect, connected, seen, get server() { return server }, restart: async () => { await server.close(); server = await start(); return server } }
}
const repoDir = (w, user = 'alice', owner = 'acme', repo = 'widgets') => clonePath({ root: w.root, userId: user, owner, repo })
const cloneRepo = async (A, owner = 'acme', repo = 'widgets') => { const r = await A('POST', `/api/github/repositories/${owner}/${repo}/clone`); assert.equal(r.status, 201, r.text); return r.json.workspace }

describe('pure helpers', () => {
  it('clone paths are deterministic, lower-cased, opaque per user and always below the root', () => {
    const p = clonePath({ root: '/data/repos', userId: 'alice@example.com', owner: 'ZSPEC-OOS', repo: 'BLUSWAN' })
    assert.equal(p, path.join('/data/repos', 'users', userKey('alice@example.com'), 'github', 'zspec-oos', 'bluswan'))
    assert.doesNotMatch(p, /alice|example/)
  })
  it('rejects traversal and malformed owner/repo names', () => {
    for (const [o, r] of [['..', 'x'], ['a', '..'], ['a/b', 'c'], ['a', 'b/c'], ['a', '../etc'], ['', 'x'], ['-bad', 'x'], ['a', 'b\0c'], ['a', '.'], ['a'.repeat(40), 'x']]) assert.throws(() => validateOwnerRepo(o, r), (e) => e.code === 'invalid_request', `${o}/${r}`)
    assert.doesNotThrow(() => validateOwnerRepo('acme', 'my.repo_name-1'))
  })
  it('redacts tokens, authenticated URLs, authorization headers and private keys', () => {
    const pem = ['-----BEGIN RSA', 'PRIVATE KEY-----\nMIIabc\n-----END RSA', 'PRIVATE KEY-----'].join(' ')
    const text = [['gh', 'p_abcdefghijklmnopqrstuvwxyz0123'].join(''), ['gh', 's_abcdefghijklmnopqrstuvwxyz0123'].join(''), ['github', '_pat_11AAAAAAAAAAAAAAAAAAAA_bbbbbbbbbbbbbbbbbbbbbbbb'].join(''), 'https://x-access-token:' + ['gh', 's_secretsecretsecret1234'].join('') + '@github.com/o/r.git', 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0', 'http.https://github.com/.extraheader=AUTHORIZATION: basic abc123abc123 ' + pem].join(' ')
    const out = redactGithub(text)
    for (const leak of ['ghp_abc', 'ghs_abc', 'github_pat_11', 'ghs_secret', 'eC1hY2Nlc3Mt', 'abc123abc123', 'MIIabc']) assert.doesNotMatch(out, new RegExp(leak), leak)
  })
  it('parses porcelain v2 status including renames, conflicts, untracked and detached HEAD', () => {
    const raw = ['# branch.oid abc', '# branch.head feature/x', '# branch.upstream origin/feature/x', '# branch.ab +2 -1', '1 M. N... 100644 100644 100644 a b src/a.js', '1 .M N... 100644 100644 100644 a b src/b.js', '2 R. N... 100644 100644 100644 a b R100 new.js', 'old.js', 'u UU N... 1 2 3 4 a b c conflict.js', '? untracked.txt', ''].join('\0')
    const s = parseStatusV2(raw)
    assert.deepEqual([s.branch, s.upstream, s.ahead, s.behind, s.staged, s.unstaged, s.untracked, s.conflicts, s.clean], ['feature/x', 'origin/feature/x', 2, 1, 2, 1, 1, 1, false])
    assert.deepEqual(s.files.map(f => f.path), ['src/a.js', 'src/b.js', 'new.js', 'conflict.js', 'untracked.txt'])
    assert.equal(parseStatusV2('# branch.oid abc\0# branch.head (detached)\0').detached, true)
  })
  it('suggests branch names with collision suffixes and deterministic commit messages', () => {
    assert.equal(suggestBranchName('Fix login redirect!', []), 'bluswan/fix-login-redirect')
    assert.equal(suggestBranchName('Fix login redirect', ['bluswan/fix-login-redirect', 'bluswan/fix-login-redirect-2']), 'bluswan/fix-login-redirect-3')
    assert.equal(suggestBranchName('', []), 'bluswan/task')
    assert.match(suggestCommitMessage([{ path: 'tests/a.test.js', index: 'M' }]), /^test: /)
    assert.match(suggestCommitMessage([{ path: 'README.md', index: 'M' }]), /^docs: /)
    assert.match(suggestCommitMessage([{ path: 'src/a.js', index: 'M' }], 'Fix the login redirect'), /^fix: the login redirect$/)
    assert.match(suggestCommitMessage([{ path: 'src/a.js', index: 'A' }]), /^feat: update src\/a\.js$/)
  })
  it('recognizes sensitive files but allows example env files', () => {
    for (const p of ['.env', 'config/.env.production', 'id_rsa', 'certs/server.pem', 'a/b/service-account.json', '.npmrc', 'creds.key']) assert.equal(isSensitivePath(p), true, p)
    for (const p of ['.env.example', 'src/env.js', 'README.md', 'src/keyboard.js']) assert.equal(isSensitivePath(p), false, p)
  })
  it('describes validation honestly', () => {
    assert.equal(describeValidation(null).status, 'not_run')
    assert.match(describeValidation({ currentStatus: 'stale', mutationSeq: 2, validatedSeq: 1, results: [] }).lines[0], /since the last code change/)
    const ok = describeValidation({ currentStatus: 'passed', lastRoundStatus: 'passed', mutationSeq: 1, validatedSeq: 1, results: [{ command: 'npm test', status: 'passed', seq: 1 }, { command: 'old', status: 'failed', seq: 0 }] })
    assert.deepEqual(ok.lines, ['✓ npm test'])
  })
  it('summarizes check runs', () => {
    assert.equal(summarizeChecks([]).status, 'none')
    assert.equal(summarizeChecks([{ status: 'in_progress' }]).status, 'running')
    assert.equal(summarizeChecks([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }]).status, 'failed')
    assert.equal(summarizeChecks([{ status: 'completed', conclusion: 'success' }]).status, 'passed')
  })
})

describe('connection and repositories', () => {
  it('is inert and clear when GitHub is not configured; local use is unaffected', async () => {
    const s = await startServer({ env: { BLUSWAN_PORT: '0', BLUSWAN_PERSISTENCE: 'memory' } }); cleanups.push(() => s.close())
    const st = await (await fetch(`http://127.0.0.1:${s.port}/api/github/status`)).json()
    assert.equal(st.configured, false); assert.match(st.message, /not configured/)
    const r = await fetch(`http://127.0.0.1:${s.port}/api/github/repositories`); assert.equal(r.status, 503); assert.equal((await r.json()).error.code, 'github_not_configured')
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/bootstrap`)).status, 200)
  })
  it('connects only through a signed, user-bound, single-use state verified against the GitHub user', async () => {
    const w = await world(); const c = await w.connect()
    assert.equal((await w.call()('GET', '/api/github/status')).json.connected, false)
    assert.equal((await c.complete({ state: `${c.state.split('.')[0]}.forged` })).status, 403)
    const other = await w.connect('tok-bob'); // bob cannot complete alice's state
    assert.equal((await w.call('tok-bob')('POST', '/api/github/connect/complete', { code: 'code-tok-alice', installationId: w.fake.installationId, state: c.state })).status, 403)
    assert.equal((await c.complete({ code: 'wrong' })).json.error.code, 'github_auth_expired')
    assert.equal((await w.connect()).complete !== undefined, true)
    const ok = await (await w.connect()).complete({ installationId: 999 }); assert.equal(ok.status, 403) // installation not owned by that GitHub user
    const good = await w.connect(); const done = await good.complete(); assert.equal(done.status, 200); assert.equal(done.json.connected, true); assert.equal(done.json.login, 'octo')
    assert.equal((await good.complete()).status, 403, 'the state cannot be replayed')
    void other
  })
  it('lists, searches, filters and paginates repositories; flags clones; never returns credentials', async () => {
    const repos = Array.from({ length: 45 }, (_, i) => ({ owner: i % 2 ? 'acme' : 'zeta', name: `repo-${String(i).padStart(2, '0')}`, private: i % 3 === 0 }))
    const w = await world({ repos }); const A = await w.connected()
    const p1 = (await A('GET', '/api/github/repositories?perPage=20')).json
    assert.equal(p1.items.length, 20); assert.equal(p1.total, 45); assert.equal(p1.nextPage, 2); assert.deepEqual(p1.owners, ['acme', 'zeta'])
    assert.equal((await A('GET', '/api/github/repositories?perPage=20&page=3')).json.items.length, 5)
    assert.equal((await A('GET', '/api/github/repositories?q=repo-07')).json.items[0].fullName, 'acme/repo-07')
    assert.ok((await A('GET', '/api/github/repositories?owner=acme&perPage=100')).json.items.every(r => r.owner === 'acme'))
    assert.ok((await A('GET', '/api/github/repositories?visibility=private&perPage=100')).json.items.every(r => r.private))
    assert.doesNotMatch(JSON.stringify(p1), /ghs_|token|clone_url|cloneUrl/i)
  })
  it('normalizes GitHub API failures (401, 403, 404, 429, 500, timeout)', async () => {
    const w = await world({ apiTimeout: 300 }); const A = await w.connected()
    const cases = [[401, 'github_auth_expired', 401], [403, 'github_permission_denied', 403], [404, 'github_repository_not_found', 404], [429, 'github_rate_limited', 429], [500, 'github_api_error', 502]]
    for (const [status, code, http] of cases) {
      w.fake.failNext(/installation\/repositories/, status, { times: 1 })
      const r = await A('GET', '/api/github/repositories?refresh=1'); assert.equal(r.status, http, `${status}`); assert.equal(r.json.error.code, code)
    }
    w.fake.failNext(/installation\/repositories/, 403, { times: 1, message: 'API rate limit exceeded', headers: { 'x-ratelimit-remaining': '0' } })
    assert.equal((await A('GET', '/api/github/repositories?refresh=1')).json.error.code, 'github_rate_limited')
    w.fake.failNext(/installation\/repositories/, 200, { times: 1, hang: true })
    const t = await A('GET', '/api/github/repositories?refresh=1'); assert.equal(t.json.error.code, 'github_api_error'); assert.match(t.json.error.message, /respond in time/)
    assert.equal((await A('GET', '/api/github/repositories?refresh=1')).status, 200)
  })
  it('disconnect removes the connection but keeps clones and conversations', async () => {
    const w = await world(); const A = await w.connected(); const ws = await cloneRepo(A)
    assert.equal((await A('POST', '/api/github/disconnect')).json.connected, false)
    assert.equal((await A('GET', '/api/github/repositories')).json.error.code, 'github_not_connected')
    assert.ok(fs.existsSync(path.join(repoDir(w), '.git'))); assert.ok((await A('GET', '/api/workspaces')).json.workspaces.some(x => x.id === ws.id))
  })
})

describe('clone and reuse', () => {
  it('clones below the workspace root with progress, registers the workspace, keeps credentials out of .git, storage and responses', async () => {
    const w = await world(); const A = await w.connected()
    const stream = await fetch(`${w.server.base}/api/stream`, { headers: { Authorization: 'Bearer tok-alice' } }); const reader = stream.body.getReader(); let sse = ''
    const pump = (async () => { for (;;) { const { value, done } = await reader.read().catch(() => ({ done: true })); if (done) return; sse += new TextDecoder().decode(value) } })()
    const ws = await cloneRepo(A)
    const dir = repoDir(w); assert.ok(dir.startsWith(w.root + path.sep)); assert.ok(fs.existsSync(path.join(dir, '.git')))
    assert.equal(ws.github.owner, 'acme'); assert.equal(ws.github.defaultBranch, 'main'); assert.equal(ws.github.private, true)
    assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main')
    await until(() => sse.includes('Ready'))
    for (const step of ['Preparing workspace', 'Authenticating with GitHub', 'Cloning repository', 'Checking out main', 'Inspecting repository', 'Opening workspace', 'Ready']) assert.ok(sse.includes(step), step)
    assert.ok(w.fake.state.tokens > 0)
    const leaks = [fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'), sse, JSON.stringify(ws), ...fs.readdirSync(w.data, { recursive: true }).filter(f => fs.statSync(path.join(w.data, f)).isFile()).map(f => fs.readFileSync(path.join(w.data, f), 'utf8'))]
    for (const t of leaks) assert.doesNotMatch(t, /ghs_|x-access-token|extraheader/i)
    reader.cancel(); await pump
  })
  it('reuses an existing clone, survives a server restart, and refuses to overwrite a different repository', async () => {
    const w = await world(); const A = await w.connected(); const first = await cloneRepo(A)
    const again = await A('POST', '/api/github/repositories/acme/widgets/clone'); assert.equal(again.json.reused, true); assert.equal(again.json.workspace.id, first.id)
    await w.restart(); const B = w.call()
    const boot = (await B('GET', '/api/bootstrap')).json
    const ws = boot.workspaces.find(x => x.id === first.id); assert.ok(ws, 'workspace restored'); assert.equal(ws.github.repo, 'widgets')
    const open = await B('POST', '/api/github/repositories/acme/widgets/open'); assert.equal(open.json.workspace.id, first.id)
    assert.equal((await B('GET', `/api/workspaces/${first.id}/git`)).json.stage, 'ready_for_task')
    assert.equal((await B('GET', '/api/github/recent')).json.items[0].fullName, 'acme/widgets')
    // a different repository at that path
    const w2 = await world(); const A2 = await w2.connected(); const target = repoDir(w2); fs.mkdirSync(target, { recursive: true }); sh(target, 'init', '-q'); sh(target, 'remote', 'add', 'origin', '/somewhere/else.git')
    const conflict = await A2('POST', '/api/github/repositories/acme/widgets/clone'); assert.equal(conflict.status, 409); assert.equal(conflict.json.error.code, 'clone_conflict')
    assert.ok(fs.existsSync(path.join(target, '.git')), 'nothing was overwritten')
  })
  it('a failed clone leaves nothing registered or half-written and can be retried', async () => {
    const w = await world(); const A = await w.connected(); const repo = w.fake.state.repos.get('acme/widgets'); const good = repo.bare
    repo.bare = path.join(w.root, 'does-not-exist.git')
    const bad = await A('POST', '/api/github/repositories/acme/widgets/clone'); assert.ok(bad.status >= 400); assert.equal(bad.json.error.code, 'git_operation_failed')
    const parent = path.dirname(repoDir(w)); assert.deepEqual(fs.readdirSync(parent), [], 'no partial directory left')
    assert.equal((await A('GET', '/api/workspaces')).json.workspaces.length, 0)
    assert.equal((await A('GET', '/api/github/repositories')).json.items[0].cloned, false)
    repo.bare = good; assert.equal((await A('POST', '/api/github/repositories/acme/widgets/clone')).status, 201)
  })
  it('a cloned repository outside the allowed roots is impossible: traversal in owner/repo is rejected', async () => {
    const w = await world(); const A = await w.connected()
    for (const u of ['/api/github/repositories/..%2F..%2Fetc/passwd/clone', '/api/github/repositories/acme/..%2F..%2Fx/clone', '/api/github/repositories/acme/%2e%2e/clone']) {
      const r = await A('POST', u); assert.ok([400, 404].includes(r.status), u + r.status)
    }
    assert.equal((await A('GET', '/api/github/repositories/nobody/missing')).json.error.code, 'github_repository_not_found')
  })
})

async function taskFlow(w, A, { edit = true } = {}) {
  const ws = await cloneRepo(A); const dir = repoDir(w)
  const br = await A('POST', `/api/workspaces/${ws.id}/branches`, { task: 'Fix add function' }); assert.equal(br.status, 201, br.text)
  if (edit) fs.writeFileSync(path.join(dir, 'src/math.js'), 'export const add = (a, b) => a + b\n')
  return { ws, dir, branch: br.json.branch }
}

describe('branch → commit → push → pull request → merge → cleanup', () => {
  it('runs the whole lifecycle and returns to a clean default branch ready for the next task', async () => {
    const w = await world(); const A = await w.connected()
    const { ws, dir, branch } = await taskFlow(w, A)
    assert.equal(branch, 'bluswan/fix-add-function')
    let g = (await A('GET', `/api/workspaces/${ws.id}/git`)).json
    assert.equal(g.stage, 'has_changes'); assert.equal(g.state.unstaged, 1); assert.equal(g.state.branch, branch)
    const sug = (await A('GET', `/api/workspaces/${ws.id}/suggest-commit?task=Fix%20add%20function`)).json.message; assert.match(sug, /^fix: add function$/)
    const c = await A('POST', `/api/workspaces/${ws.id}/commit`, { message: sug }); assert.equal(c.status, 201, c.text); assert.deepEqual(c.json.files, ['src/math.js'])
    g = (await A('GET', `/api/workspaces/${ws.id}/git`)).json; assert.equal(g.stage, 'ready_to_push'); assert.equal(g.pushed, false)
    assert.equal(w.fake.hasRemoteBranch('acme', 'widgets', branch), false, 'commit is local only')
    const push = await A('POST', `/api/workspaces/${ws.id}/push`); assert.equal(push.status, 200, push.text)
    assert.ok(w.fake.hasRemoteBranch('acme', 'widgets', branch)); assert.equal(w.fake.remoteSha('acme', 'widgets', branch), sh(dir, 'rev-parse', 'HEAD').trim())
    assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', '@{u}').trim(), `origin/${branch}`)
    g = (await A('GET', `/api/workspaces/${ws.id}/git`)).json; assert.equal(g.stage, 'ready_for_pr')
    const draft = (await A('POST', `/api/workspaces/${ws.id}/pr-draft`, {})).json; assert.equal(draft.base, 'main'); assert.match(draft.body, /fix: add function/); assert.match(draft.body, /Validation was not run/)
    const pr = await A('POST', `/api/workspaces/${ws.id}/pull-requests`, { title: draft.title, body: draft.body }); assert.equal(pr.status, 201, pr.text); assert.equal(pr.json.pullRequest.number, 1); assert.equal(pr.json.pullRequest.state, 'open'); assert.match(pr.json.pullRequest.url, /^https:\/\/github\.com\/acme\/widgets\/pull\/1$/)
    const dup = await A('POST', `/api/workspaces/${ws.id}/pull-requests`, { title: 'again' }); assert.equal(dup.json.existing, true); assert.equal(dup.json.pullRequest.number, 1); assert.equal(w.fake.state.prs.length, 1)
    assert.equal((await A('GET', `/api/workspaces/${ws.id}/git`)).json.stage, 'waiting_for_merge')
    // not merged yet: cleanup must refuse and change nothing
    const early = await A('POST', `/api/workspaces/${ws.id}/cleanup`, {}); assert.equal(early.json.error.code, 'pull_request_not_merged'); assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), branch)
    w.fake.setChecks(w.fake.remoteSha('acme', 'widgets', branch), [{ status: 'completed', conclusion: 'success' }])
    w.fake.merge(1)
    const st = (await A('GET', `/api/workspaces/${ws.id}/pull-requests/current`)).json; assert.equal(st.pullRequest.state, 'merged'); assert.ok(st.pullRequest.mergeCommitSha); assert.equal(st.pullRequest.checks.status, 'passed')
    assert.equal((await A('GET', `/api/workspaces/${ws.id}/git`)).json.stage, 'merged')
    const done = await A('POST', `/api/workspaces/${ws.id}/cleanup`, {}); assert.equal(done.status, 200, done.text); assert.equal(done.json.done, true); assert.equal(done.json.localDeleted, true); assert.equal(done.json.remoteDeleted, true)
    assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main'); assert.equal(sh(dir, 'status', '--porcelain').trim(), '')
    assert.equal(sh(dir, 'branch', '--list', branch).trim(), ''); assert.equal(w.fake.hasRemoteBranch('acme', 'widgets', branch), false)
    assert.match(fs.readFileSync(path.join(dir, 'src/math.js'), 'utf8'), /a \+ b/)
    g = (await A('GET', `/api/workspaces/${ws.id}/git`)).json; assert.equal(g.stage, 'ready_for_task')
    const tasks = (await A('GET', `/api/workspaces/${ws.id}/tasks`)).json.tasks; assert.equal(tasks[0].workflowStatus, 'completed_merged'); assert.ok(tasks[0].history.map(h => h.type).includes('branch_pushed')); assert.equal(tasks[0].pullRequest.number, 1)
    // continue: a new task starts from the refreshed default branch
    const next = await A('POST', `/api/workspaces/${ws.id}/branches`, { task: 'Add subtract' }); assert.equal(next.status, 201); assert.equal(next.json.branch, 'bluswan/add-subtract')
    assert.equal((await A('GET', `/api/workspaces/${ws.id}/tasks`)).json.tasks.length, 2, 'the finished task stays in history')
  })
  it('squash merges need an explicit confirmation before a forced local delete, and only when the tip is what GitHub merged', async () => {
    const w = await world(); const A = await w.connected(); const { ws, dir, branch } = await taskFlow(w, A)
    await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix: add' }); await A('POST', `/api/workspaces/${ws.id}/push`)
    await A('POST', `/api/workspaces/${ws.id}/pull-requests`, { title: 'Fix add' }); w.fake.merge(1, { method: 'squash', deleteBranch: true })
    const first = await A('POST', `/api/workspaces/${ws.id}/cleanup`, {}); assert.equal(first.json.needsConfirmation, 'force_delete')
    assert.notEqual(sh(dir, 'branch', '--list', branch).trim(), '', 'nothing was deleted yet')
    const second = await A('POST', `/api/workspaces/${ws.id}/cleanup`, { confirmForceDelete: true }); assert.equal(second.json.done, true, second.text); assert.equal(sh(dir, 'branch', '--list', branch).trim(), '')
  })
  it('a branch whose tip differs from what GitHub merged is kept', async () => {
    const w = await world(); const A = await w.connected(); const { ws, dir, branch } = await taskFlow(w, A)
    await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix: add' }); await A('POST', `/api/workspaces/${ws.id}/push`)
    await A('POST', `/api/workspaces/${ws.id}/pull-requests`, { title: 'Fix add' }); w.fake.merge(1, { method: 'squash' })
    fs.writeFileSync(path.join(dir, 'extra.txt'), 'later work\n'); sh(dir, 'add', '-A'); sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'unpushed extra')
    const r = await A('POST', `/api/workspaces/${ws.id}/cleanup`, { confirmForceDelete: true }); assert.equal(r.status, 409)
    assert.notEqual(sh(dir, 'branch', '--list', branch).trim(), ''); assert.equal(sh(dir, 'show', `${branch}:extra.txt`), 'later work\n', 'the commit is still on the kept branch')
  })
  it('handles a remote branch that GitHub already deleted after the merge', async () => {
    const w = await world(); const A = await w.connected(); const { ws, dir, branch } = await taskFlow(w, A)
    await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix: add' }); await A('POST', `/api/workspaces/${ws.id}/push`)
    await A('POST', `/api/workspaces/${ws.id}/pull-requests`, { title: 'Fix add' }); w.fake.merge(1, { deleteBranch: true })
    const r = await A('POST', `/api/workspaces/${ws.id}/cleanup`, {}); assert.equal(r.json.done, true); assert.equal(r.json.remoteDeleted, false); assert.ok(r.json.notes.includes('Remote branch already removed.'))
    assert.equal(sh(dir, 'branch', '--list', branch).trim(), '')
  })
  it('a pull request closed without merging is never reported as merged and cannot be cleaned up', async () => {
    const w = await world(); const A = await w.connected(); const { ws, branch } = await taskFlow(w, A)
    await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix: add' }); await A('POST', `/api/workspaces/${ws.id}/push`)
    await A('POST', `/api/workspaces/${ws.id}/pull-requests`, { title: 'Fix add' }); w.fake.closePr(1)
    const st = (await A('GET', `/api/workspaces/${ws.id}/pull-requests/current`)).json; assert.equal(st.pullRequest.state, 'closed'); assert.equal(st.pullRequest.merged, false)
    assert.equal((await A('GET', `/api/workspaces/${ws.id}/git`)).json.stage, 'closed_unmerged')
    assert.equal((await A('POST', `/api/workspaces/${ws.id}/cleanup`, {})).json.error.code, 'pull_request_not_merged')
    assert.equal((await A('GET', `/api/workspaces/${ws.id}/git`)).json.state.branch, branch)
  })
  it('abandoning needs confirmation when work would be lost, then removes only the local branch', async () => {
    const w = await world(); const A = await w.connected(); const { ws, dir, branch } = await taskFlow(w, A)
    await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix: add' })
    const ask = await A('POST', `/api/workspaces/${ws.id}/abandon`, {}); assert.equal(ask.json.needsConfirmation, 'abandon'); assert.match(ask.json.risks.join(' '), /unpushed/)
    assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), branch)
    const ok = await A('POST', `/api/workspaces/${ws.id}/abandon`, { confirm: true }); assert.equal(ok.json.abandoned, branch); assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main')
  })
  for (const def of ['master', 'develop']) {
    it(`works with a default branch named ${def}`, async () => {
      const w = await world({ repos: [{ owner: 'acme', name: 'widgets', defaultBranch: def }] }); const A = await w.connected(); const { ws, dir, branch } = await taskFlow(w, A)
      assert.equal((await A('GET', `/api/workspaces/${ws.id}/git`)).json.github.defaultBranch, def)
      await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix: add' }); await A('POST', `/api/workspaces/${ws.id}/push`)
      const pr = await A('POST', `/api/workspaces/${ws.id}/pull-requests`, { title: 'Fix add' }); assert.equal(pr.json.pullRequest.base, def)
      w.fake.merge(1); const done = await A('POST', `/api/workspaces/${ws.id}/cleanup`, {}); assert.equal(done.json.done, true); assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), def); void branch
    })
  }
})

describe('safeguards', () => {
  it('refuses unsafe operations: dirty tree, detached HEAD, conflicts, default-branch commits and pushes', async () => {
    const w = await world(); const A = await w.connected(); const ws = await cloneRepo(A); const dir = repoDir(w)
    fs.writeFileSync(path.join(dir, 'README.md'), 'dirty\n')
    const dirty = await A('POST', `/api/workspaces/${ws.id}/branches`, { task: 'x' }); assert.equal(dirty.json.error.code, 'git_dirty_working_tree'); assert.match(dirty.json.error.message, /1 unstaged/)
    assert.equal((await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'm' })).json.error.code, 'protected_branch')
    assert.equal((await A('POST', `/api/workspaces/${ws.id}/push`)).json.error.code, 'protected_branch')
    assert.equal((await A('GET', `/api/workspaces/${ws.id}/git`)).json.stage, 'protected_dirty')
    sh(dir, 'checkout', '--', 'README.md')
    sh(dir, 'checkout', '-q', '--detach')
    assert.equal((await A('GET', `/api/workspaces/${ws.id}/git`)).json.stage, 'detached')
    assert.equal((await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'm' })).json.error.code, 'git_detached_head')
    assert.equal((await A('POST', `/api/workspaces/${ws.id}/sync`)).json.error.code, 'git_detached_head')
    sh(dir, 'checkout', '-q', 'main')
    // conflicts
    const br = (await A('POST', `/api/workspaces/${ws.id}/branches`, { task: 'conflict' })).json.branch
    fs.writeFileSync(path.join(dir, 'src/math.js'), 'export const add = (a, b) => a + b // mine\n'); await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'mine' })
    w.fake.pushCommit('acme', 'widgets', 'main', 'src/math.js', 'export const add = (a, b) => a * b // theirs\n'); sh(dir, 'fetch', '-q', 'origin')
    try { sh(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', 'origin/main') } catch { /* conflicts expected */ }
    assert.equal((await A('GET', `/api/workspaces/${ws.id}/git`)).json.stage, 'conflicts')
    for (const [m, u, b] of [['POST', 'sync'], ['POST', 'commit', { message: 'x' }], ['POST', 'checkout', { branch: 'main' }], ['POST', 'cleanup', {}]]) assert.equal((await A(m, `/api/workspaces/${ws.id}/${u}`, b)).json.error.code, m === 'POST' && u === 'cleanup' ? 'pull_request_not_merged' : 'git_conflicts', u)
    void br
  })
  it('refuses to change branches or pull while changes are uncommitted, and while the agent is running', async () => {
    const w = await world({ hang: true }); const A = await w.connected(); const { ws, dir, branch } = await taskFlow(w, A)
    const s = (await A('POST', '/api/sessions', { workspaceId: ws.id })).json.session.id
    await A('POST', `/api/sessions/${s}/messages`, { content: 'work' })
    await until(async () => (await A('GET', `/api/sessions/${s}`)).json.session.status === 'running')
    const busy = await A('POST', `/api/workspaces/${ws.id}/checkout`, { branch: 'main' }); assert.equal(busy.json.error.code, 'session_busy'); assert.match(busy.json.error.message, /Stop the current task/)
    assert.equal((await A('POST', `/api/workspaces/${ws.id}/branches`, { task: 'other' })).json.error.code, 'session_busy')
    await A('POST', `/api/sessions/${s}/cancel`); await until(async () => (await A('GET', `/api/sessions/${s}`)).json.session.status !== 'running')
    assert.equal((await A('POST', `/api/workspaces/${ws.id}/checkout`, { branch: 'main' })).json.error.code, 'git_dirty_working_tree')
    assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), branch)
  })
  it('never stages sensitive files and says which were skipped', async () => {
    const w = await world(); const A = await w.connected(); const { ws, dir } = await taskFlow(w, A)
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n'); fs.writeFileSync(path.join(dir, 'server.pem'), 'x\n')
    const c = await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix' }); assert.deepEqual(c.json.files, ['src/math.js'])
    assert.equal(sh(dir, 'ls-files', '.env', 'server.pem').trim(), ''); assert.match(sh(dir, 'status', '--porcelain'), /\?\? \.env/)
    const only = await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'again', paths: ['.env'] }); assert.equal(only.status, 400)
  })
  it('does not run repository hooks and does not sign or prompt', async () => {
    const w = await world(); const A = await w.connected(); const { ws, dir } = await taskFlow(w, A)
    fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\ntouch /tmp/blu-hook-ran-$$\nexit 1\n', { mode: 0o755 })
    const c = await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix' }); assert.equal(c.status, 201, c.text)
  })
  it('refuses to push when origin no longer matches the connected repository, and never rewrites it', async () => {
    const w = await world(); const A = await w.connected(); const { ws, dir } = await taskFlow(w, A)
    await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix' })
    sh(dir, 'remote', 'set-url', 'origin', path.join(w.root, 'elsewhere.git'))
    const r = await A('POST', `/api/workspaces/${ws.id}/push`); assert.equal(r.json.error.code, 'git_remote_mismatch')
    assert.equal(sh(dir, 'remote', 'get-url', 'origin').trim(), path.join(w.root, 'elsewhere.git'))
    assert.equal((await A('GET', `/api/workspaces/${ws.id}/git`)).json.stage, 'remote_mismatch')
  })
  it('push rejections are reported and never retried with force', async () => {
    const w = await world(); const A = await w.connected(); const { ws, dir, branch } = await taskFlow(w, A)
    await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix' }); await A('POST', `/api/workspaces/${ws.id}/push`)
    w.fake.pushCommit('acme', 'widgets', branch, 'other.txt', 'remote work\n')
    fs.writeFileSync(path.join(dir, 'local.txt'), 'local\n'); await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'local work' })
    const before = w.fake.remoteSha('acme', 'widgets', branch)
    const r = await A('POST', `/api/workspaces/${ws.id}/push`); assert.equal(r.json.error.code, 'git_push_rejected'); assert.match(r.json.error.message, /never force-pushes/i)
    assert.equal(w.fake.remoteSha('acme', 'widgets', branch), before, 'the remote branch is untouched')
    const sync = await A('POST', `/api/workspaces/${ws.id}/sync`); assert.equal(sync.json.error.code, 'git_branch_diverged')
    w.fake.rejectPushes('acme', 'widgets')
    const prot = await A('POST', `/api/workspaces/${ws.id}/push`); assert.equal(prot.json.error.code, 'git_push_rejected')
  })
  it('sync reports up to date, pulled commits, and remote changes without overwriting local work', async () => {
    const w = await world(); const A = await w.connected(); const { ws, dir, branch } = await taskFlow(w, A)
    await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix' }); await A('POST', `/api/workspaces/${ws.id}/push`)
    assert.equal((await A('POST', `/api/workspaces/${ws.id}/sync`)).json.status, 'up_to_date')
    w.fake.pushCommit('acme', 'widgets', branch, 'remote.txt', 'r\n')
    const pulled = (await A('POST', `/api/workspaces/${ws.id}/sync`)).json; assert.equal(pulled.status, 'pulled'); assert.equal(pulled.pulled, 1); assert.ok(fs.existsSync(path.join(dir, 'remote.txt')))
    w.fake.pushCommit('acme', 'widgets', branch, 'remote2.txt', 'r\n'); fs.writeFileSync(path.join(dir, 'wip.txt'), 'wip\n')
    assert.equal((await A('POST', `/api/workspaces/${ws.id}/sync`)).json.status, 'pulled', 'untracked files do not block a fast-forward')
    fs.writeFileSync(path.join(dir, 'src/math.js'), 'edited\n'); w.fake.pushCommit('acme', 'widgets', branch, 'remote3.txt', 'r\n')
    const blocked = await A('POST', `/api/workspaces/${ws.id}/sync`); assert.equal(blocked.json.error.code, 'git_dirty_working_tree'); assert.equal(fs.readFileSync(path.join(dir, 'src/math.js'), 'utf8'), 'edited\n')
  })
  it('rejects overlapping operations on one repository', async () => {
    const w = await world(); const A = await w.connected(); const { ws } = await taskFlow(w, A)
    await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix' })
    const results = await Promise.all([A('POST', `/api/workspaces/${ws.id}/push`), A('POST', `/api/workspaces/${ws.id}/push`)])
    const codes = results.map(r => r.json.error?.code ?? 'ok').sort(); assert.deepEqual(codes, ['ok', 'operation_in_progress'])
  })
  it('lists branches with current, merged and remote-only entries and tracks a remote branch on checkout', async () => {
    const w = await world(); const A = await w.connected(); const { ws, dir } = await taskFlow(w, A)
    w.fake.pushCommit('acme', 'widgets', 'feature/remote-only', 'f.txt', 'f\n')
    await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix' }); await A('POST', `/api/workspaces/${ws.id}/push`); sh(dir, 'fetch', '-q', 'origin')
    const b = (await A('GET', `/api/workspaces/${ws.id}/branches`)).json
    assert.equal(b.current, 'bluswan/fix-add-function'); assert.ok(b.branches.find(x => x.name === 'main' && x.scope === 'local' && x.isDefault)); assert.ok(b.branches.find(x => x.name === 'feature/remote-only' && x.scope === 'remote'))
    sh(dir, 'checkout', '-q', 'bluswan/fix-add-function')
    const co = await A('POST', `/api/workspaces/${ws.id}/checkout`, { branch: 'feature/remote-only' }); assert.equal(co.status, 200, co.text)
    assert.equal(sh(dir, 'rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/feature/remote-only')
    assert.equal((await A('POST', `/api/workspaces/${ws.id}/checkout`, { branch: '--evil' })).status, 400)
    assert.equal((await A('POST', `/api/workspaces/${ws.id}/checkout`, { branch: 'nope' })).status, 404)
  })
  it('removes only the local copy, with confirmation when work would be lost, and never touches GitHub', async () => {
    const w = await world(); const A = await w.connected(); const { ws, dir } = await taskFlow(w, A)
    const ask = await A('POST', `/api/workspaces/${ws.id}/remove-local`, {}); assert.equal(ask.json.needsConfirmation, 'remove'); assert.ok(fs.existsSync(dir))
    const ok = await A('POST', `/api/workspaces/${ws.id}/remove-local`, { confirm: true }); assert.equal(ok.json.removed, true); assert.equal(fs.existsSync(dir), false)
    assert.ok(w.fake.hasRemoteBranch('acme', 'widgets', 'main'))
    assert.equal((await A('GET', '/api/github/repositories')).json.items[0].cloned, false)
    assert.equal((await A('POST', '/api/github/repositories/acme/widgets/clone')).status, 201, 'can be cloned again')
  })
})

describe('ownership, webhooks, agent context, local-only workspaces', () => {
  it('another user can neither see nor operate on a workspace by id or guess a clone location', async () => {
    const w = await world(); const A = await w.connected(); const ws = await cloneRepo(A); const B = await w.connected('tok-bob')
    for (const [m, u, b] of [['GET', 'git'], ['GET', 'branches'], ['POST', 'branches', { task: 'x' }], ['POST', 'commit', { message: 'x' }], ['POST', 'push'], ['POST', 'pull-requests', { title: 'x' }], ['POST', 'cleanup', {}], ['POST', 'remove-local', { confirm: true }], ['GET', 'commits'], ['POST', 'sync']]) {
      const r = await B(m, `/api/workspaces/${ws.id}/${u}`, b); assert.equal(r.status, 404, `${u}: ${r.text}`)
    }
    assert.equal((await B('GET', '/api/workspaces')).json.workspaces.length, 0)
    const own = await cloneRepo(B); assert.notEqual(own.id, ws.id); assert.ok(fs.existsSync(repoDir(w, 'alice'))); assert.ok(fs.existsSync(repoDir(w, 'bob')))
    assert.notEqual(repoDir(w, 'alice'), repoDir(w, 'bob'))
    assert.equal((await B('POST', '/api/github/disconnect')).json.connected, false); assert.ok(fs.existsSync(repoDir(w, 'alice')), 'alice is unaffected')
    assert.equal((await w.call('tok-alice')('GET', '/api/github/status')).json.connected, true)
  })
  it('webhooks require a valid signature, update the pull request and notify connected browsers', async () => {
    const w = await world(); const A = await w.connected(); const { ws, branch } = await taskFlow(w, A)
    await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'fix' }); await A('POST', `/api/workspaces/${ws.id}/push`); await A('POST', `/api/workspaces/${ws.id}/pull-requests`, { title: 'Fix add' })
    const stream = await fetch(`${w.server.base}/api/stream`, { headers: { Authorization: 'Bearer tok-alice' } }); const reader = stream.body.getReader(); let sse = ''
    const pump = (async () => { for (;;) { const { value, done } = await reader.read().catch(() => ({ done: true })); if (done) return; sse += new TextDecoder().decode(value) } })()
    w.fake.merge(1)
    const payload = JSON.stringify({ action: 'closed', installation: { id: w.fake.installationId }, repository: { full_name: 'acme/widgets' }, pull_request: { number: 1 } })
    const sig = (body, secret = WEBHOOK) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`
    const post = (body, signature) => fetch(`${w.server.base}/api/github/webhook`, { method: 'POST', headers: { 'X-GitHub-Event': 'pull_request', 'X-Hub-Signature-256': signature, 'Content-Type': 'application/json' }, body })
    assert.equal((await post(payload, sig(payload, 'wrong'))).status, 401); assert.equal((await post(payload, 'sha256=abc')).status, 401)
    assert.equal((await fetch(`${w.server.base}/api/github/webhook`, { method: 'POST', body: payload })).status, 401)
    const ok = await post(payload, sig(payload)); assert.equal(ok.status, 202)
    await until(() => sse.includes('"event":"pull_request"')); reader.cancel(); await pump
    const task = (await A('GET', `/api/workspaces/${ws.id}/tasks`)).json.tasks.find(t => t.taskBranch === branch); assert.equal(task.pullRequest.state, 'merged')
  })
  it('the agent is told the branch workflow; local-only workspaces get no GitHub notes', async () => {
    const w = await world(); const A = await w.connected(); const { ws, branch } = await taskFlow(w, A)
    const user = { id: 'alice', email: null }
    const notes = await w.server.service.github.agentNotes(user, ws.id)
    assert.match(notes, /acme\/widgets/); assert.match(notes, new RegExp(branch)); assert.match(notes, /Do not run git push --force, git reset --hard, git branch -D/); assert.match(notes, /Do not commit or push/)
    const local = tmp('blu-local-'); sh(local, 'init', '-q'); const lw = (await w.call()('POST', '/api/workspaces', { root: path.join(w.root) }))
    void lw; assert.equal(await w.server.service.github.agentNotes(user, 'no-such-workspace'), '')
  })
  it('a local-only repository keeps working: status, branches, commit — and GitHub-only actions say so', async () => {
    const w = await world(); const A = w.call(); const dir = path.join(w.root, 'plain'); fs.mkdirSync(dir); sh(dir, 'init', '-q', '-b', 'main'); sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 't'); fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'init')
    const ws = (await A('POST', '/api/workspaces', { root: dir })).json
    const g = (await A('GET', `/api/workspaces/${ws.id}/git`)).json; assert.equal(g.stage, 'local'); assert.equal(g.github, null); assert.equal(g.state.branch, 'main')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'b\n'); assert.equal((await A('POST', `/api/workspaces/${ws.id}/commit`, { message: 'change' })).status, 201)
    assert.equal((await A('POST', `/api/workspaces/${ws.id}/push`)).json.error.code, 'github_not_connected')
  })
})

describe('configuration and GitHub App authentication', () => {
  const FULL = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', GITHUB_APP_CLIENT_ID: 'c', GITHUB_APP_CLIENT_SECRET: 's3cret', GITHUB_APP_SLUG: 'bluswan', GITHUB_APP_WEBHOOK_SECRET: 'w' }
  it('is optional, all-or-nothing, validated, and never copies secret values into settings', async () => {
    const { parseServerConfig } = await import('../config.js')
    assert.equal(parseServerConfig({}).settings.github.configured, false); assert.equal(parseServerConfig({}).ok, true)
    const partial = parseServerConfig({ GITHUB_APP_ID: '1' }); assert.equal(partial.ok, false); assert.match(partial.errors[0], /GITHUB_APP_PRIVATE_KEY/)
    const ok = parseServerConfig(FULL); assert.equal(ok.ok, true); assert.equal(ok.settings.github.configured, true); assert.equal(ok.settings.github.webhook, true)
    assert.doesNotMatch(JSON.stringify(ok), /s3cret|BEGIN/)
    assert.match(parseServerConfig({ ...FULL, GITHUB_APP_PRIVATE_KEY: 'nonsense' }).errors.join(), /PEM/)
    assert.match(parseServerConfig({ ...FULL, GITHUB_API_URL: 'http://api.example.com' }).errors.join(), /https/)
    assert.equal(parseServerConfig({ ...FULL, GITHUB_API_URL: 'http://127.0.0.1:9999' }).ok, true, 'loopback http is allowed for local fakes')
    assert.match(parseServerConfig({ ...FULL, GITHUB_APP_WEBHOOK_SECRET: '' }).warnings.join(), /webhook/i)
  })
  it('signs a short-lived RS256 JWT and caches installation tokens until shortly before expiry', async () => {
    const fake = await startFakeGithub(); cleanups.push(() => fake.close())
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' })
    let t = Date.now(); const auth = createAppAuth({ appId: 77, privateKey: pem.replace(/\n/g, '\\n'), api: createGithubApi({ apiUrl: fake.url }), now: () => t })
    const [h, p, sig] = auth.jwt().split('.'); const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
    assert.equal(JSON.parse(Buffer.from(h, 'base64url').toString()).alg, 'RS256'); assert.equal(claims.iss, '77'); assert.ok(claims.exp - claims.iat <= 10 * 60 + 60)
    assert.equal(crypto.createVerify('RSA-SHA256').update(`${h}.${p}`).verify(pair.publicKey, Buffer.from(sig, 'base64url')), true)
    const a = await auth.installationToken(1); const b = await auth.installationToken(1); assert.equal(a, b); assert.equal(fake.state.tokens, 1)
    t += 59 * 60_000; await auth.installationToken(1); assert.equal(fake.state.tokens, 2, 'refreshed before it expires')
  })
  it('webhook endpoint does not exist unless a webhook secret is configured', async () => {
    const w = await world(); w.github.settings.webhook = false; await w.restart()
    const r = await fetch(`${w.server.base}/api/github/webhook`, { method: 'POST', body: '{}' }); assert.equal(r.status, 404)
  })
})
