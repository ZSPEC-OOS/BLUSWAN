// An in-process fake of the parts of GitHub that BLUSWAN uses, backed by real local bare repositories, so the whole
// workflow (clone, fetch, push, pull request, merge, branch deletion) runs offline with real git.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const run = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).toString()
const ID = { name: 'Fake', email: 'fake@example.com' }
const commitArgs = ['-c', `user.name=${ID.name}`, '-c', `user.email=${ID.email}`, '-c', 'commit.gpgsign=false']

export function generateAppKey() {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
}

/**
 * @param {{repos?:{owner:string,name:string,private?:boolean,defaultBranch?:string,files?:Record<string,string>}[], installationId?:number, login?:string}} options
 */
export async function startFakeGithub({ repos = [{ owner: 'acme', name: 'widgets', private: true }], installationId = 4242, login = 'octo' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blu-fakegh-'))
  const state = { repos: new Map(), prs: [], nextPr: 1, fail: [], calls: [], checks: new Map(), tokens: 0, pushRejections: new Set(), codes: new Map() }
  const key = (o, r) => `${o}/${r}`.toLowerCase()

  function seed(spec) {
    const bare = path.join(dir, 'remotes', spec.owner, `${spec.name}.git`)
    fs.mkdirSync(path.dirname(bare), { recursive: true })
    const branch = spec.defaultBranch ?? 'main'
    run(dir, 'init', '-q', '--bare', '-b', branch, bare)
    const work = fs.mkdtempSync(path.join(dir, 'seed-'))
    run(work, 'clone', '-q', bare, '.')
    run(work, 'checkout', '-q', '-b', branch)
    for (const [f, c] of Object.entries(spec.files ?? { 'README.md': `# ${spec.name}\n`, 'src/math.js': 'export const add = (a, b) => a - b\n', 'package.json': '{"name":"widgets","type":"module","scripts":{"test":"node --test"}}\n' })) {
      fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), c)
    }
    run(work, 'add', '-A'); run(work, ...commitArgs, 'commit', '-q', '-m', 'initial'); run(work, 'push', '-q', 'origin', branch)
    fs.rmSync(work, { recursive: true, force: true })
    state.repos.set(key(spec.owner, spec.name), { ...spec, bare, defaultBranch: branch, id: 1000 + state.repos.size, updatedAt: new Date().toISOString() })
  }
  repos.forEach(seed)

  const repoJson = (r) => ({ id: r.id, name: r.name, full_name: `${r.owner}/${r.name}`, private: !!r.private, default_branch: r.defaultBranch, html_url: `https://github.com/${r.owner}/${r.name}`, clone_url: r.bare, owner: { login: r.owner }, updated_at: r.updatedAt, fork: false })
  const hasBranch = (r, b) => { try { run(r.bare, 'rev-parse', '--verify', '-q', `refs/heads/${b}`); return true } catch { return false } }
  const sha = (r, b) => run(r.bare, 'rev-parse', `refs/heads/${b}`).trim()
  const prJson = (p) => {
    const r = state.repos.get(p.repo)
    return { number: p.number, title: p.title, body: p.body, state: p.state, draft: p.draft, merged: !!p.merged_at, merged_at: p.merged_at ?? null, merge_commit_sha: p.merge_commit_sha ?? null,
      html_url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}`, head: { ref: p.head, sha: hasBranch(r, p.head) ? sha(r, p.head) : p.headSha, repo: { full_name: `${r.owner}/${r.name}` } }, base: { ref: p.base }, user: { login } }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'); const p = url.pathname
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    state.calls.push(`${req.method} ${p}`)
    const send = (status, json, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(json)) }
    const injected = state.fail.find(f => f.re.test(`${req.method} ${p}`))
    if (injected) {
      if (injected.times !== undefined && --injected.times <= 0) state.fail.splice(state.fail.indexOf(injected), 1)
      if (injected.hang) return // never answers (timeout test)
      return send(injected.status, { message: injected.message ?? 'injected failure' }, injected.headers)
    }
    let m
    if (req.method === 'POST' && (m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p))) { state.tokens += 1; return send(201, { token: `ghs_fake${String(state.tokens).padStart(24, '0')}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }) }
    if (req.method === 'POST' && p === '/login/oauth/access_token') {
      const code = body?.code; if (!state.codes.has(code)) return send(200, { error: 'bad_verification_code' })
      return send(200, { access_token: 'ghu_fakeusertoken0000000000000000', token_type: 'bearer' })
    }
    if (p === '/user/installations') return send(200, { total_count: 1, installations: [{ id: installationId, account: { login, type: 'User' } }] })
    if (p === '/user') return send(200, { login })
    if (p === '/installation/repositories') {
      const per = Number(url.searchParams.get('per_page') ?? 30); const page = Number(url.searchParams.get('page') ?? 1)
      const all = [...state.repos.values()]
      return send(200, { total_count: all.length, repositories: all.slice((page - 1) * per, page * per).map(repoJson) })
    }
    if ((m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p))) {
      const r = state.repos.get(key(m[1], m[2])); if (!r) return send(404, { message: 'Not Found' })
      const rest = m[3] ?? ''
      if (rest === '') return send(200, repoJson(r))
      if (rest === '/pulls' && req.method === 'GET') {
        const head = url.searchParams.get('head')?.split(':').pop(); const base = url.searchParams.get('base'); const st = url.searchParams.get('state') ?? 'open'
        return send(200, state.prs.filter(x => x.repo === key(m[1], m[2]) && (st === 'all' || x.state === st) && (!head || x.head === head) && (!base || x.base === base)).map(prJson))
      }
      if (rest === '/pulls' && req.method === 'POST') {
        if (!hasBranch(r, body.head)) return send(422, { message: 'Validation Failed: head branch not found' })
        const pr = { repo: key(m[1], m[2]), number: state.nextPr++, title: body.title, body: body.body ?? '', head: body.head, base: body.base, draft: !!body.draft, state: 'open', headSha: sha(r, body.head) }
        state.prs.push(pr); return send(201, prJson(pr))
      }
      if ((m = /^\/pulls\/(\d+)$/.exec(rest))) { const pr = state.prs.find(x => x.repo === key(...p.split('/').slice(2, 4)) && x.number === Number(m[1])); return pr ? send(200, prJson(pr)) : send(404, { message: 'Not Found' }) }
      if ((m = /^\/commits\/([^/]+)\/check-runs$/.exec(rest))) return send(200, { total_count: (state.checks.get(m[1]) ?? []).length, check_runs: state.checks.get(m[1]) ?? [] })
      if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) return hasBranch(r, decodeURIComponent(m[1])) ? send(200, { ref: `refs/heads/${decodeURIComponent(m[1])}` }) : send(404, { message: 'Not Found' })
      if (req.method === 'DELETE' && (m = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) { const b = decodeURIComponent(m[1]); if (!hasBranch(r, b)) return send(422, { message: 'Reference does not exist' }); run(r.bare, 'update-ref', '-d', `refs/heads/${b}`); res.writeHead(204); return res.end() }
    }
    return send(404, { message: 'Not Found' })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`

  return {
    url, dir, installationId, login, state,
    allowCode(code) { state.codes.set(code, true) },
    failNext(re, status, extra = {}) { state.fail.push({ re, status, ...extra }) },
    clearFailures() { state.fail.length = 0 },
    bare: (owner, name) => state.repos.get(key(owner, name)).bare,
    /** Simulates someone else (or the GitHub merge button) changing the remote. */
    merge(number, { method = 'merge', deleteBranch = false } = {}) {
      const pr = state.prs.find(x => x.number === number); const r = state.repos.get(pr.repo)
      const work = fs.mkdtempSync(path.join(dir, 'merge-'))
      run(work, 'clone', '-q', r.bare, '.'); run(work, 'checkout', '-q', pr.base)
      if (method === 'squash') { run(work, 'merge', '--squash', `origin/${pr.head}`); run(work, ...commitArgs, 'commit', '-q', '-m', `${pr.title} (#${number})`) } else run(work, ...commitArgs, 'merge', '--no-ff', '-q', '-m', `Merge pull request #${number}`, `origin/${pr.head}`)
      const mergeSha = run(work, 'rev-parse', 'HEAD').trim(); run(work, 'push', '-q', 'origin', pr.base); fs.rmSync(work, { recursive: true, force: true })
      pr.headSha = sha(r, pr.head); pr.state = 'closed'; pr.merged_at = new Date().toISOString(); pr.merge_commit_sha = mergeSha
      if (deleteBranch) run(r.bare, 'update-ref', '-d', `refs/heads/${pr.head}`)
      return mergeSha
    },
    closePr(number) { const pr = state.prs.find(x => x.number === number); pr.state = 'closed' },
    pushCommit(owner, name, branch, file, content, message = 'external change') {
      const r = state.repos.get(key(owner, name)); const work = fs.mkdtempSync(path.join(dir, 'ext-'))
      run(work, 'clone', '-q', r.bare, '.'); try { run(work, 'checkout', '-q', branch) } catch { run(work, 'checkout', '-q', '-b', branch) }
      fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true }); fs.writeFileSync(path.join(work, file), content)
      run(work, 'add', '-A'); run(work, ...commitArgs, 'commit', '-q', '-m', message); run(work, 'push', '-q', 'origin', branch); fs.rmSync(work, { recursive: true, force: true })
    },
    deleteRemoteBranch(owner, name, branch) { run(state.repos.get(key(owner, name)).bare, 'update-ref', '-d', `refs/heads/${branch}`) },
    hasRemoteBranch: (owner, name, b) => hasBranch(state.repos.get(key(owner, name)), b),
    remoteSha: (owner, name, b) => sha(state.repos.get(key(owner, name)), b),
    setChecks(shaValue, runs) { state.checks.set(shaValue, runs) },
    /** Makes the remote refuse the next push of a branch (a pre-receive hook in the bare repository). */
    rejectPushes(owner, name) {
      const hook = path.join(state.repos.get(key(owner, name)).bare, 'hooks', 'pre-receive'); fs.mkdirSync(path.dirname(hook), { recursive: true })
      fs.writeFileSync(hook, '#!/bin/sh\necho "remote: error: GH006: Protected branch update failed" >&2\nexit 1\n', { mode: 0o755 })
    },
    async close() { await new Promise(r => { server.closeAllConnections?.(); server.close(r) }); fs.rmSync(dir, { recursive: true, force: true }) },
  }
}
