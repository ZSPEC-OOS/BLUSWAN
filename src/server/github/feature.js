// The GitHub-driven coding workflow, server side: connection, repository browsing, clone, task branches, commit,
// push, pull requests, merge detection and cleanup. GitHub is the source of truth; the browser only ever receives
// repository, branch and pull-request descriptions — never a credential.
//
// Structure: every user-triggered operation goes through `operation()` (per-workspace lock, progress events over SSE,
// cancellation, structured log line). Git runs through ./gitRunner.js (no shell, hooks disabled, token only in the
// child's environment). Records live under the owning user's path via the persistence adapter's feature documents.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createError, isBluswanError } from '../../protocol/schemas.js'
import { createLogger } from '../../utils/logger.js'
import { git, bounded, TIMEOUTS } from './gitRunner.js'
import { clonePath, prepareCloneDir, isOwnedClone, normalizeRemote, repoKey, validateOwnerRepo, userKey } from './paths.js'
import { redactGithub } from './redact.js'
import { parseStatusV2, suggestBranchName, suggestCommitMessage, isSensitivePath, derivePrState, summarizeChecks, describeValidation, stageOf } from './logic.js'

const log = createLogger('github')
const MAX_HISTORY = 60

export function createGithubFeature({
  ctxOf, persistence, settings, secrets = {}, api, webApi = api, appAuth, openWorkspace, roots, activeContexts = async () => [],
  cloneUrlOk, identity = { name: 'BLUSWAN', email: 'bluswan@users.noreply.github.com' }, now = () => Date.now(), listCacheMs = 60_000,
}) {
  const configured = !!settings?.configured
  const webUrl = settings?.webUrl ?? 'https://github.com'
  const locks = new Map() // `${userId}|${key}` → operation id
  const ops = new Map() // operation id → { controller, userId }
  const listCache = new Map() // userId → { at, items }
  const usedStates = new Map() // nonce → expiry (replay protection for the connect callback)
  const need = () => { if (!configured) throw createError({ code: 'github_not_configured', message: 'GitHub integration is not configured on this server.' }) }

  // ─── records ──────────────────────────────────────────────────────────────────────────────────────────────────
  const loadConnection = (user) => persistence.getDoc(user.id, 'github_connection', 'main')
  async function requireConnection(user) {
    need(); const c = await loadConnection(user)
    if (!c?.installations?.length) throw createError({ code: 'github_not_connected', message: 'Connect your GitHub account first.' })
    return c
  }
  const repoDocs = (user) => persistence.listDocs(user.id, 'github_repos')
  const getRepoDoc = (user, owner, repo) => persistence.getDoc(user.id, 'github_repos', repoKey(owner, repo))
  const saveRepoDoc = (user, doc) => persistence.putDoc(user.id, 'github_repos', repoKey(doc.owner, doc.repo), { ...doc, updatedAt: now() })
  const taskId = (wsId, branch) => `${String(wsId).replace(/[^A-Za-z0-9_.-]/g, '_')}__${branch.replace(/[^A-Za-z0-9._-]/g, '_')}__${crypto.createHash('sha1').update(branch).digest('hex').slice(0, 6)}`
  const getTask = (user, wsId, branch) => persistence.getDoc(user.id, 'github_tasks', taskId(wsId, branch))
  async function saveTask(user, wsId, branch, patch, event) {
    const prev = (await getTask(user, wsId, branch)) ?? { workspaceId: wsId, taskBranch: branch, sessionIds: [], history: [], workflowStatus: 'branch_created', createdAt: now() }
    const { _revision, _id, ...rest } = prev
    const next = { ...rest, ...patch, history: event ? [...(rest.history ?? []), { type: event.type, at: now(), detail: event.detail ?? null }].slice(-MAX_HISTORY) : rest.history, updatedAt: now() }
    await persistence.putDoc(user.id, 'github_tasks', taskId(wsId, branch), next)
    return next
  }
  const clean = (doc) => { if (!doc) return null; const { _revision, _id, ...rest } = doc; return rest }

  // ─── operations: locks, progress, cancellation ────────────────────────────────────────────────────────────────
  const hashUser = (id) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 8)
  async function operation(user, ctx, { name, key, workspaceId = null, repo = null, mutates = false }, fn) {
    const lockKey = `${user.id}|${key}`
    if (locks.has(lockKey)) throw createError({ code: 'operation_in_progress', message: 'Another repository operation is still running. Wait for it to finish.', retryable: true })
    if (mutates && workspaceId) {
      const busy = ctx.runtime.listSessions().some(s => s.workspaceId === workspaceId && (s.status === 'running' || s.status === 'waiting_permission'))
      if (busy) throw createError({ code: 'session_busy', message: 'Stop the current task before changing branches or repository state.' })
    }
    const id = crypto.randomUUID(); const controller = new AbortController()
    locks.set(lockKey, id); ops.set(id, { controller, userId: user.id })
    const op = { id, name, workspaceId, repo, status: 'running', steps: [], startedAt: now() }
    const emit = () => ctx.broadcast({ kind: 'operation', operation: { ...op, steps: [...op.steps] } })
    const progress = (step, status = 'running', detail = null) => {
      const last = op.steps.at(-1)
      if (last && last.step === step) { last.status = status; if (detail) last.detail = detail } else { if (last && last.status === 'running') last.status = 'done'; op.steps.push({ step, status, ...(detail ? { detail } : {}) }) }
      emit()
    }
    emit()
    const t0 = now(); let result = 'ok'
    try {
      const value = await fn({ progress, signal: controller.signal, operationId: id })
      for (const s of op.steps) if (s.status === 'running') s.status = 'done'
      op.status = 'done'; return value
    } catch (e) {
      result = isBluswanError(e) ? e.code : 'error'
      const last = op.steps.at(-1); if (last?.status === 'running') last.status = 'failed'
      op.status = 'failed'; op.error = isBluswanError(e) ? { code: e.code, message: e.message } : { code: 'git_operation_failed', message: 'The operation failed.' }
      throw e
    } finally {
      locks.delete(lockKey); ops.delete(id); emit()
      log.info('github operation', { op: name, repo, user: hashUser(user.id), ms: now() - t0, result })
    }
  }
  const tokenOf = async (installationId) => appAuth.installationToken(installationId)
  const G = (ws, args, opts = {}) => git(ws.root, args, { webUrl, identity, ...opts })

  // ─── connection ───────────────────────────────────────────────────────────────────────────────────────────────
  const sign = (payload) => crypto.createHmac('sha256', secrets.stateSecret ?? '').update(payload).digest('base64url')
  const feature = {
    configured,
    webhookEnabled: !!(settings?.webhook && secrets.webhookSecret),

    async status(user) {
      if (!configured) return { configured: false, connected: false, message: 'GitHub integration is not configured on this server.' }
      const c = await loadConnection(user)
      if (!c?.installations?.length) return { configured: true, connected: false }
      const repos = await repoDocs(user)
      return { configured: true, connected: true, login: c.login ?? null, installations: c.installations.map(i => ({ id: i.id, account: i.account, accountType: i.accountType })), clonedRepositories: repos.filter(r => r.cloned).length, webhook: this.webhookEnabled, manageUrl: `${webUrl}/apps/${settings.slug}/installations/new` }
    },

    /** A signed, expiring, single-use state value binds the GitHub round trip to this BLUSWAN user. */
    async connectUrl(user) {
      need()
      const nonce = crypto.randomBytes(12).toString('base64url'); const exp = now() + 15 * 60_000
      const payload = Buffer.from(JSON.stringify({ u: user.id, n: nonce, e: exp })).toString('base64url')
      const state = `${payload}.${sign(payload)}`
      return { url: `${webUrl}/apps/${encodeURIComponent(settings.slug)}/installations/new?state=${encodeURIComponent(state)}` }
    },

    /** Called by the signed-in browser after GitHub redirects back: verifies state, the GitHub user's code, and the installation. */
    async completeConnection(user, { code, installationId, state }) {
      need()
      const [payload, sig] = String(state ?? '').split('.')
      const good = !!(payload && sig) && safeEqual(sign(payload), sig)
      let data = null; try { data = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()) } catch { /* invalid */ }
      if (!good || !data || data.u !== user.id || data.e < now() || usedStates.has(data.n)) throw createError({ code: 'forbidden', message: 'This GitHub connection request is invalid, expired or belongs to another account. Start again.' })
      usedStates.set(data.n, data.e); for (const [n, e] of usedStates) if (e < now()) usedStates.delete(n)
      if (!code || !installationId) throw createError({ code: 'invalid_request', message: 'GitHub did not return an authorization code. Enable "Request user authorization during installation" on the GitHub App.' })
      // The user token exists only for these two calls and is discarded.
      const tokenRes = await webApi.request('POST', '/login/oauth/access_token', { accept: 'application/json', body: { client_id: secrets.clientId, client_secret: secrets.clientSecret, code } }).catch(() => null)
      const userToken = tokenRes?.json?.access_token
      if (!userToken) throw createError({ code: 'github_auth_expired', message: 'GitHub did not accept the authorization. Start the connection again.' })
      const inst = (await api.request('GET', '/user/installations', { token: userToken })).json.installations ?? []
      const mine = inst.find(i => String(i.id) === String(installationId))
      if (!mine) throw createError({ code: 'github_permission_denied', message: 'That installation does not belong to your GitHub account.' })
      const login = (await api.request('GET', '/user', { token: userToken }).catch(() => ({ json: {} }))).json.login ?? mine.account?.login ?? null
      const prev = (await loadConnection(user)) ?? { installations: [] }
      const installations = [...prev.installations.filter(i => String(i.id) !== String(mine.id)), { id: mine.id, account: mine.account?.login ?? null, accountType: mine.account?.type ?? null }]
      await persistence.putDoc(user.id, 'github_connection', 'main', { installations, login, connectedAt: prev.connectedAt ?? now(), updatedAt: now() })
      listCache.delete(user.id)
      return feature.status(user)
    },

    /** Removes BLUSWAN's record of the connection. Local clones and sessions stay. Uninstalling the app on GitHub revokes access there. */
    async disconnect(user) {
      need(); const c = await loadConnection(user)
      for (const i of c?.installations ?? []) appAuth.forget(i.id)
      await persistence.deleteDoc(user.id, 'github_connection', 'main'); listCache.delete(user.id)
      return { connected: false }
    },

    // ─── repositories ─────────────────────────────────────────────────────────────────────────────────────────────
    async listRepositories(user, { page = 1, perPage = 30, q = '', owner = '', visibility = '', refresh = false } = {}) {
      const c = await requireConnection(user)
      let entry = listCache.get(user.id)
      if (refresh || !entry || now() - entry.at > listCacheMs) {
        const items = []
        for (const inst of c.installations) {
          const token = await tokenOf(inst.id)
          for (let p = 1; p <= 10; p++) { // at most 1,000 repositories per installation are indexed per refresh
            const r = (await api.request('GET', '/installation/repositories', { token, query: { per_page: 100, page: p } })).json
            items.push(...r.repositories.map(x => ({ owner: x.owner.login, repo: x.name, fullName: x.full_name, private: !!x.private, defaultBranch: x.default_branch, htmlUrl: x.html_url, updatedAt: x.updated_at, installationId: inst.id, repositoryId: x.id, fork: !!x.fork })))
            if (r.repositories.length < 100) break
          }
        }
        entry = { at: now(), items }; listCache.set(user.id, entry)
      }
      const local = new Map((await repoDocs(user)).map(d => [repoKey(d.owner, d.repo), d]))
      const needle = String(q).trim().toLowerCase()
      let rows = entry.items.filter(r => (!needle || r.fullName.toLowerCase().includes(needle)) && (!owner || r.owner.toLowerCase() === String(owner).toLowerCase()) && (!visibility || (visibility === 'private') === r.private))
      rows = rows.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      const owners = [...new Set(entry.items.map(r => r.owner))].sort()
      const size = Math.min(100, Math.max(1, perPage)); const start = (Math.max(1, page) - 1) * size
      return {
        items: rows.slice(start, start + size).map(r => { const d = local.get(repoKey(r.owner, r.repo)); return { ...r, cloned: !!d?.cloned, workspaceId: d?.cloned ? d.workspaceId : null, lastOpenedAt: d?.lastOpenedAt ?? null } }),
        total: rows.length, page, perPage: size, nextPage: start + size < rows.length ? page + 1 : null, owners, indexedAt: entry.at,
      }
    },

    async recent(user) {
      const docs = (await repoDocs(user)).filter(d => d.cloned && d.lastOpenedAt).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, 8)
      return { items: docs.map(d => ({ owner: d.owner, repo: d.repo, fullName: `${d.owner}/${d.repo}`, workspaceId: d.workspaceId, defaultBranch: d.defaultBranch, lastOpenedAt: d.lastOpenedAt })) }
    },

    /** Proves the connected installations can see this repository and returns its (browser-safe) metadata. */
    async repository(user, owner, repo) {
      validateOwnerRepo(owner, repo); const c = await requireConnection(user)
      let lastError = null
      for (const inst of c.installations) {
        try {
          const token = await tokenOf(inst.id)
          const r = (await api.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token })).json
          if (!cloneUrlOk(r.clone_url, { owner: r.owner.login, repo: r.name })) throw createError({ code: 'forbidden', message: 'GitHub returned a clone address BLUSWAN does not trust.' })
          const d = await getRepoDoc(user, r.owner.login, r.name)
          return { info: { owner: r.owner.login, repo: r.name, fullName: r.full_name, private: !!r.private, defaultBranch: r.default_branch, htmlUrl: r.html_url, cloneUrl: r.clone_url, repositoryId: r.id, installationId: inst.id, fork: !!r.fork }, local: d ? { cloned: !!d.cloned, workspaceId: d.workspaceId } : { cloned: false } }
        } catch (e) { lastError = e; if (e.code !== 'github_repository_not_found' && e.code !== 'github_permission_denied') throw e }
      }
      throw lastError ?? createError({ code: 'github_repository_not_found', message: 'GitHub could not find that repository.' })
    },

    // ─── clone / open ─────────────────────────────────────────────────────────────────────────────────────────────
    async clone(user, owner, repo) {
      const ctx = await ctxOf(user)
      return operation(user, ctx, { name: 'clone', key: `repo:${repoKey(owner, repo)}`, repo: `${owner}/${repo}` }, async ({ progress, signal }) => {
        progress('Preparing workspace')
        progress('Authenticating with GitHub')
        const { info } = await feature.repository(user, owner, repo)
        const token = await tokenOf(info.installationId)
        const root = roots[0]
        const dest = clonePath({ root, userId: user.id, owner: info.owner, repo: info.repo })
        const existing = await fs.stat(dest).catch(() => null)
        let reused = false
        if (existing) {
          const origin = await git(dest, ['remote', 'get-url', 'origin'], { okCodes: [0, 1, 2, 128] }).catch(() => null)
          const url = origin?.code === 0 ? origin.stdout.trim() : null
          if (!url || normalizeRemote(url) !== normalizeRemote(info.cloneUrl)) throw createError({ code: 'clone_conflict', message: 'A different repository already exists at the location BLUSWAN uses for this clone. Nothing was changed.' })
          progress('Reusing existing clone'); reused = true
          await git(dest, ['fetch', '--prune', 'origin'], { token, webUrl, signal, timeoutMs: TIMEOUTS.network }).catch(() => null)
        } else {
          const target = await prepareCloneDir({ root, dest })
          const partial = `${target}.partial-${crypto.randomBytes(4).toString('hex')}`
          progress('Cloning repository')
          try {
            await git(null, ['clone', '--', info.cloneUrl, partial], { token, webUrl, signal, timeoutMs: TIMEOUTS.clone })
            progress(`Checking out ${info.defaultBranch}`)
            await git(partial, ['checkout', info.defaultBranch], { signal })
            await fs.rename(partial, target) // only a complete clone ever appears at the real path
          } catch (e) {
            await fs.rm(partial, { recursive: true, force: true }).catch(() => {}) // never leave an incomplete clone registered or visible
            throw e
          }
        }
        progress('Inspecting repository')
        progress('Opening workspace')
        const ws = await openWorkspace(user, dest)
        const prev = await getRepoDoc(user, info.owner, info.repo)
        await saveRepoDoc(user, { ...clean(prev), owner: info.owner, repo: info.repo, repositoryId: info.repositoryId, defaultBranch: info.defaultBranch, htmlUrl: info.htmlUrl, cloneUrl: info.cloneUrl, installationId: info.installationId, workspaceId: ws.id, cloned: true, private: info.private, fork: info.fork, upstream: null, lastOpenedAt: now(), createdAt: prev?.createdAt ?? now() })
        listCache.delete(user.id)
        progress('Ready')
        return { workspace: { ...ws, github: githubMeta({ ...info, workspaceId: ws.id }) }, reused }
      })
    },

    /** Reopens an already cloned repository (also after a server restart). */
    async open(user, owner, repo) {
      need(); const d = await getRepoDoc(user, owner, repo)
      if (!d?.cloned) throw createError({ code: 'not_found', message: 'That repository has not been cloned yet.' })
      const ws = await openWorkspace(user, clonePath({ root: roots[0], userId: user.id, owner: d.owner, repo: d.repo }))
      await saveRepoDoc(user, { ...clean(d), workspaceId: ws.id, lastOpenedAt: now() })
      return { workspace: { ...ws, github: githubMeta(d) } }
    },

    /** Adds `github` metadata (no credentials) to workspace descriptors. */
    async decorate(user, list) {
      if (!configured) return list
      const docs = await repoDocs(user).catch(() => [])
      const by = new Map(docs.filter(d => d.cloned).map(d => [d.workspaceId, d]))
      return list.map(w => (by.has(w.id) ? { ...w, github: githubMeta(by.get(w.id)) } : w))
    },
  }

  // ─── workspace-scoped helpers ─────────────────────────────────────────────────────────────────────────────────
  async function resolveWs(user, wsId, { githubRequired = false } = {}) {
    const ctx = await ctxOf(user)
    const ws = ctx.workspaces.getWorkspace(wsId)
    if (!ws) throw createError({ code: 'workspace_not_found', message: 'That repository is not connected.' })
    const doc = configured ? (await repoDocs(user)).find(d => d.workspaceId === wsId && d.cloned) ?? null : null
    if (githubRequired && !doc) throw createError({ code: 'github_not_connected', message: 'This repository is not linked to GitHub.' })
    return { ctx, ws, doc }
  }
  async function readState(ws, doc) {
    const out = await G(ws, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'])
    const s = parseStatusV2(out.stdout)
    s.files = s.files.map(f => ({ ...f, sensitive: isSensitivePath(f.path) }))
    s.defaultBranch = doc?.defaultBranch ?? null
    s.isDefault = !!doc && !s.detached && s.branch === doc.defaultBranch
    return s
  }
  async function originMatches(ws, doc) {
    if (!doc) return true
    const o = await G(ws, ['remote', 'get-url', 'origin'], { okCodes: [0, 2, 128, 1] }).catch(() => null)
    return o?.code === 0 && normalizeRemote(o.stdout.trim()) === normalizeRemote(doc.cloneUrl)
  }
  async function requireOrigin(ws, doc) {
    if (!(await originMatches(ws, doc))) throw createError({ code: 'git_remote_mismatch', message: 'Repository remote does not match the connected GitHub repository. BLUSWAN will not change the remote.' })
  }
  const dirtyError = (s) => createError({ code: 'git_dirty_working_tree', message: `The working tree has uncommitted changes (${s.staged} staged, ${s.unstaged} unstaged, ${s.untracked} untracked). Commit them first, or discard them yourself, then try again. BLUSWAN will not stash or discard silently.` })
  function assertSafe(s, { allowDirty = false, allowDetached = false } = {}) {
    if (s.conflicts) throw createError({ code: 'git_conflicts', message: `${s.conflicts} file${s.conflicts === 1 ? ' has' : 's have'} conflicts. Resolve them in Git first.` })
    if (s.detached && !allowDetached) throw createError({ code: 'git_detached_head', message: 'The repository is on a detached HEAD. Create a branch from this commit or switch to the default branch first.' })
    if (!allowDirty && !s.clean) throw dirtyError(s)
  }
  async function tokenFor(doc) { return doc ? tokenOf(doc.installationId) : undefined }
  async function remoteBranchExists(ws, branch) {
    return (await G(ws, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { okCodes: [0, 1] })).code === 0
  }
  async function localBranchExists(ws, branch) {
    return (await G(ws, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { okCodes: [0, 1] })).code === 0
  }
  const fetchOrigin = async (ws, doc, signal) => G(ws, ['fetch', '--prune', 'origin'], { token: await tokenFor(doc), signal, timeoutMs: TIMEOUTS.network })
  async function ffDefault(ws, doc, signal) {
    const def = doc.defaultBranch
    if (await localBranchExists(ws, def)) await G(ws, ['checkout', def], { signal }); else await G(ws, ['checkout', '-b', def, '--track', `origin/${def}`], { signal })
    const r = await G(ws, ['merge', '--ff-only', `origin/${def}`], { signal, okCodes: [0, 128, 1] })
    if (r.code !== 0) throw createError({ code: 'git_branch_diverged', message: `Your local ${def} has commits that are not on GitHub, so it cannot be fast-forwarded. BLUSWAN will not rewrite it.` })
  }
  async function stateWithTask(user, wsId) {
    const { ctx, ws, doc } = await resolveWs(user, wsId)
    const s = await readState(ws, doc)
    const task = doc && !s.detached ? clean(await getTask(user, wsId, s.branch)) : null
    return { ctx, ws, doc, s, task }
  }

  // ─── git workflow ─────────────────────────────────────────────────────────────────────────────────────────────
  Object.assign(feature, {
    /** Everything the workflow UI needs about a workspace in one call. */
    async git(user, wsId) {
      const { ws, doc, s, task } = await stateWithTask(user, wsId)
      const remoteOk = await originMatches(ws, doc)
      const pushed = !!task?.pushed && !s.detached && (await remoteBranchExists(ws, s.branch))
      return {
        github: doc ? githubMeta(doc) : null, state: s, task, remoteMatches: remoteOk, pushed,
        stage: doc ? stageOf({ s, task, pushed, remoteOk }) : 'local',
      }
    },

    async branches(user, wsId) {
      const { ws, doc } = await resolveWs(user, wsId)
      const s = await readState(ws, doc)
      const fmt = '%(refname)%00%(objectname:short)%00%(upstream:short)'
      const refs = (await G(ws, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes/origin'])).stdout.split('\n').filter(Boolean).map(l => l.split('\0'))
      const mergedInto = doc ? new Set((await G(ws, ['branch', '--merged', `${doc.defaultBranch}`, '--format=%(refname:short)'], { okCodes: [0, 128, 1] })).stdout.split('\n').filter(Boolean)) : new Set()
      const local = refs.filter(r => r[0].startsWith('refs/heads/')).map(r => ({ name: r[0].slice(11), scope: 'local', sha: r[1], upstream: r[2] || null, current: !s.detached && r[0].slice(11) === s.branch, merged: mergedInto.has(r[0].slice(11)), isDefault: doc?.defaultBranch === r[0].slice(11) }))
      const names = new Set(local.map(b => b.name))
      const remote = refs.filter(r => r[0].startsWith('refs/remotes/origin/') && !r[0].endsWith('/HEAD')).map(r => r[0].slice(20)).filter(n => !names.has(n)).map(name => ({ name, scope: 'remote', current: false, merged: null, isDefault: doc?.defaultBranch === name }))
      return { current: s.detached ? null : s.branch, detached: s.detached, defaultBranch: doc?.defaultBranch ?? null, branches: [...local, ...remote] }
    },

    suggestBranch(title, existing = []) { return { name: suggestBranchName(title, existing) } },

    async createBranch(user, wsId, { name, task: title, sessionId = null } = {}) {
      const { ctx, ws, doc } = await resolveWs(user, wsId, { githubRequired: true })
      return operation(user, ctx, { name: 'create-branch', key: `ws:${wsId}`, workspaceId: wsId, repo: `${doc.owner}/${doc.repo}`, mutates: true }, async ({ progress, signal }) => {
        progress('Checking repository state'); await requireOrigin(ws, doc)
        assertSafe(await readState(ws, doc), { allowDetached: true })
        progress('Fetching latest from GitHub'); await fetchOrigin(ws, doc, signal)
        progress(`Updating ${doc.defaultBranch}`); await ffDefault(ws, doc, signal)
        const existing = (await G(ws, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin'])).stdout.split('\n').map(x => x.replace(/^origin\//, ''))
        let branch = String(name ?? '').trim()
        if (branch) {
          if ((await git(null, ['check-ref-format', '--branch', branch], { okCodes: [0, 1, 128] })).code !== 0 || branch.startsWith('-')) throw createError({ code: 'invalid_request', message: 'That is not a valid branch name.' })
          if (existing.includes(branch)) throw createError({ code: 'branch_exists', message: `A branch named ${branch} already exists.` })
        } else branch = suggestBranchName(title, existing)
        progress(`Creating ${branch}`); await G(ws, ['checkout', '-b', branch, doc.defaultBranch], { signal })
        const t = await saveTask(user, wsId, branch, { owner: doc.owner, repo: doc.repo, baseBranch: doc.defaultBranch, taskBranch: branch, remoteBranch: null, pushed: false, workflowStatus: 'branch_created', title: title ?? null, pullRequest: null, sessionIds: sessionId ? [sessionId] : [] }, { type: 'branch_created', detail: branch })
        ctx.broadcast({ kind: 'github', event: 'branch', workspaceId: wsId })
        return { branch, task: clean(t) }
      })
    },

    async checkout(user, wsId, { branch } = {}) {
      const { ctx, ws, doc } = await resolveWs(user, wsId)
      return operation(user, ctx, { name: 'checkout', key: `ws:${wsId}`, workspaceId: wsId, repo: doc ? `${doc.owner}/${doc.repo}` : null, mutates: true }, async ({ progress, signal }) => {
        if (typeof branch !== 'string' || branch.startsWith('-') || (await git(null, ['check-ref-format', '--branch', branch], { okCodes: [0, 1, 128] })).code !== 0) throw createError({ code: 'invalid_request', message: 'That is not a valid branch name.' })
        progress('Checking repository state'); assertSafe(await readState(ws, doc), { allowDetached: true })
        if (!(await localBranchExists(ws, branch))) {
          if (doc) { progress('Fetching latest from GitHub'); await fetchOrigin(ws, doc, signal) }
          if (!(await remoteBranchExists(ws, branch))) throw createError({ code: 'not_found', message: `There is no branch named ${branch}.` })
          progress(`Tracking origin/${branch}`); await G(ws, ['checkout', '-b', branch, '--track', `origin/${branch}`], { signal })
        } else { progress(`Switching to ${branch}`); await G(ws, ['checkout', branch], { signal }) }
        ctx.broadcast({ kind: 'github', event: 'branch', workspaceId: wsId })
        return { branch }
      })
    },

    async sync(user, wsId) {
      const { ctx, ws, doc } = await resolveWs(user, wsId, { githubRequired: true })
      return operation(user, ctx, { name: 'sync', key: `ws:${wsId}`, workspaceId: wsId, repo: `${doc.owner}/${doc.repo}`, mutates: true }, async ({ progress, signal }) => {
        await requireOrigin(ws, doc)
        let s = await readState(ws, doc); assertSafe(s, { allowDirty: true })
        progress('Fetching latest from GitHub'); await fetchOrigin(ws, doc, signal)
        const upstream = `origin/${s.branch}`
        if (!(await remoteBranchExists(ws, s.branch))) return { status: 'local_only', message: `${s.branch} has not been pushed yet.`, pulled: 0, state: await readState(ws, doc) }
        const ab = (await G(ws, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])).stdout.trim().split(/\s+/).map(Number)
        const [ahead, behind] = ab
        if (!behind) return { status: 'up_to_date', message: 'Already up to date.', pulled: 0, ahead, behind, state: await readState(ws, doc) }
        if (ahead) throw createError({ code: 'git_branch_diverged', message: `${s.branch} has diverged: ${ahead} local and ${behind} remote commits. Resolve this on GitHub or in a terminal; BLUSWAN will not merge or rebase automatically.` })
        if (s.staged || s.unstaged) throw createError({ code: 'git_dirty_working_tree', message: 'Local changes prevent pulling. Commit them first.' })
        progress(`Pulling ${behind} commit${behind === 1 ? '' : 's'}`); await G(ws, ['merge', '--ff-only', upstream], { signal })
        s = await readState(ws, doc)
        ctx.broadcast({ kind: 'github', event: 'sync', workspaceId: wsId })
        return { status: 'pulled', message: `Pulled ${behind} commit${behind === 1 ? '' : 's'}.`, pulled: behind, state: s }
      })
    },

    async commits(user, wsId, { limit = 15 } = {}) {
      const { ws } = await resolveWs(user, wsId)
      const out = await G(ws, ['log', `-n${Math.min(50, Math.max(1, limit))}`, '--format=%H%x1f%an%x1f%ct%x1f%s'], { okCodes: [0, 128] })
      return { commits: out.stdout.split('\n').filter(Boolean).map(l => { const [sha, author, ct, subject] = l.split('\x1f'); return { sha, short: sha.slice(0, 7), author, at: Number(ct) * 1000, subject } }) }
    },

    async suggestCommit(user, wsId, { task } = {}) {
      const { ws } = await resolveWs(user, wsId)
      const files = parseStatusV2((await G(ws, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z'])).stdout).files
      return { message: suggestCommitMessage(files, task) }
    },

    async commit(user, wsId, { message, paths = null } = {}) {
      const { ctx, ws, doc } = await resolveWs(user, wsId)
      return operation(user, ctx, { name: 'commit', key: `ws:${wsId}`, workspaceId: wsId, repo: doc ? `${doc.owner}/${doc.repo}` : null, mutates: true }, async ({ progress }) => {
        const msg = String(message ?? '').trim()
        if (!msg || msg.length > 5000) throw createError({ code: 'invalid_request', message: 'Write a commit message (up to 5,000 characters).' })
        const s = await readState(ws, doc); assertSafe(s, { allowDirty: true })
        if (s.isDefault) throw createError({ code: 'protected_branch', message: `${s.branch} is the default branch. Create a task branch before committing.` })
        const chosen = (Array.isArray(paths) && paths.length ? paths : s.files.map(f => f.path))
        const known = new Set(s.files.map(f => f.path))
        const skippedSensitive = chosen.filter(isSensitivePath)
        const stage = chosen.filter(p => known.has(p) && !isSensitivePath(p))
        if (!stage.length) throw createError({ code: 'invalid_request', message: skippedSensitive.length ? 'The only changed files look sensitive (keys, .env). BLUSWAN will not commit them automatically.' : 'There is nothing to commit.' })
        progress('Staging changes'); await G(ws, ['reset', '-q'], { okCodes: [0, 1] }) // index only; the working tree is untouched
        await G(ws, ['add', '-A', '--', ...stage])
        progress('Creating commit'); await G(ws, ['commit', '-q', '--no-verify', '-m', msg])
        const sha = (await G(ws, ['rev-parse', 'HEAD'])).stdout.trim()
        if (doc) await saveTask(user, wsId, s.branch, { workflowStatus: 'committed' }, { type: 'commit_created', detail: sha.slice(0, 7) })
        ctx.broadcast({ kind: 'github', event: 'commit', workspaceId: wsId })
        return { sha, short: sha.slice(0, 7), files: stage, skippedSensitive }
      })
    },

    async push(user, wsId) {
      const { ctx, ws, doc } = await resolveWs(user, wsId, { githubRequired: true })
      return operation(user, ctx, { name: 'push', key: `ws:${wsId}`, workspaceId: wsId, repo: `${doc.owner}/${doc.repo}` }, async ({ progress, signal }) => {
        await requireOrigin(ws, doc)
        const s = await readState(ws, doc); assertSafe(s, { allowDirty: true })
        if (s.isDefault) throw createError({ code: 'protected_branch', message: `${s.branch} is the default branch; BLUSWAN does not push to it. Use a task branch and a pull request.` })
        progress(`Pushing ${s.branch}`)
        const out = await G(ws, ['push', '-u', 'origin', `refs/heads/${s.branch}:refs/heads/${s.branch}`], { token: await tokenFor(doc), signal, timeoutMs: TIMEOUTS.network })
        await saveTask(user, wsId, s.branch, { owner: doc.owner, repo: doc.repo, baseBranch: doc.defaultBranch, taskBranch: s.branch, remoteBranch: s.branch, pushed: true, workflowStatus: 'pushed' }, { type: 'branch_pushed', detail: s.branch })
        ctx.broadcast({ kind: 'github', event: 'push', workspaceId: wsId })
        return { branch: s.branch, output: bounded(out.stderr) }
      })
    },

    // ─── pull requests ────────────────────────────────────────────────────────────────────────────────────────────
    async prDraft(user, wsId, { sessionId = null, base } = {}) {
      const { ctx, ws, doc } = await resolveWs(user, wsId, { githubRequired: true })
      const s = await readState(ws, doc)
      const baseBranch = base || doc.defaultBranch
      const log = await G(ws, ['log', `origin/${baseBranch}..HEAD`, '--format=%s', '-n', '20'], { okCodes: [0, 128] })
      const subjects = log.stdout.split('\n').filter(Boolean)
      const session = sessionId ? ctx.runtime.getSession(sessionId) : null
      const validation = describeValidation(session?.validation)
      const task = clean(await getTask(user, wsId, s.branch))
      const title = task?.title ? task.title.slice(0, 120) : (subjects.length === 1 ? subjects[0] : s.branch.replace(/^bluswan\//, '').replace(/[-_]+/g, ' '))
      const body = ['## Summary', ...(subjects.length ? subjects.map(x => `- ${x}`) : ['- (no commits yet)']), '', '## Validation', ...validation.lines, '', '_Created with BLUSWAN._'].join('\n')
      return { head: s.branch, base: baseBranch, title, body, validation: { status: validation.status, lines: validation.lines } }
    },

    async createPullRequest(user, wsId, { title, body = '', base, draft = false } = {}) {
      const { ctx, ws, doc } = await resolveWs(user, wsId, { githubRequired: true })
      return operation(user, ctx, { name: 'create-pr', key: `ws:${wsId}`, workspaceId: wsId, repo: `${doc.owner}/${doc.repo}` }, async ({ progress }) => {
        const s = await readState(ws, doc); assertSafe(s, { allowDirty: true })
        if (s.isDefault) throw createError({ code: 'protected_branch', message: 'Create a task branch first; pull requests come from task branches.' })
        const baseBranch = base || doc.defaultBranch
        if (!String(title ?? '').trim()) throw createError({ code: 'invalid_request', message: 'Give the pull request a title.' })
        if (!(await remoteBranchExists(ws, s.branch))) throw createError({ code: 'invalid_request', message: 'Push the branch to GitHub before creating a pull request.' })
        const token = await tokenFor(doc); const repoPath = `/repos/${encodeURIComponent(doc.owner)}/${encodeURIComponent(doc.repo)}`
        progress('Checking for an existing pull request')
        const open = (await api.request('GET', `${repoPath}/pulls`, { token, query: { state: 'open', head: `${doc.owner}:${s.branch}`, base: baseBranch } })).json
        let pr = open[0]; let existing = !!pr
        if (!pr) { progress('Creating pull request'); pr = (await api.request('POST', `${repoPath}/pulls`, { token, body: { title: String(title).slice(0, 250), body: String(body).slice(0, 60_000), head: s.branch, base: baseBranch, draft: !!draft } })).json }
        const summary = prSummary(pr, doc)
        const task = await saveTask(user, wsId, s.branch, { pullRequest: summary, workflowStatus: 'pr_open', baseBranch }, existing ? null : { type: 'pr_created', detail: `#${pr.number}` })
        ctx.broadcast({ kind: 'github', event: 'pull_request', workspaceId: wsId })
        return { pullRequest: summary, existing, task: clean(task) }
      })
    },

    /** Refreshes the task's pull request (state, merge info, checks). `branch` defaults to the current branch. */
    async pullRequestStatus(user, wsId, { branch } = {}) {
      const { ctx, ws, doc } = await resolveWs(user, wsId, { githubRequired: true })
      const s = await readState(ws, doc); const b = branch ?? s.branch
      const task = await getTask(user, wsId, b)
      if (!task?.pullRequest) return { pullRequest: null, task: clean(task) }
      return refreshPr(user, ctx, wsId, doc, b, task)
    },

    // ─── cleanup, abandon, removal ────────────────────────────────────────────────────────────────────────────────
    async cleanup(user, wsId, { branch, confirmForceDelete = false, deleteRemote = true } = {}) {
      const { ctx, ws, doc } = await resolveWs(user, wsId, { githubRequired: true })
      return operation(user, ctx, { name: 'cleanup', key: `ws:${wsId}`, workspaceId: wsId, repo: `${doc.owner}/${doc.repo}`, mutates: true }, async ({ progress, signal }) => {
        await requireOrigin(ws, doc)
        const before = await readState(ws, doc)
        // a retry (for example after confirming a forced delete) runs from the default branch: continue the task that is merged but not yet cleaned up
        const pending = before.isDefault ? (await persistence.listDocs(user.id, 'github_tasks', { limit: 200 })).filter(t => t.workspaceId === wsId && t.pullRequest && t.workflowStatus !== 'completed_merged' && t.workflowStatus !== 'abandoned').sort((a, b2) => b2.updatedAt - a.updatedAt)[0] : null
        const b = branch ?? pending?.taskBranch ?? before.branch
        if (!b || b === doc.defaultBranch) throw createError({ code: 'protected_branch', message: 'Only a completed task branch can be cleaned up, never the default branch.' })
        const task0 = await getTask(user, wsId, b)
        if (!task0?.pullRequest) throw createError({ code: 'pull_request_not_merged', message: 'This branch has no pull request. Create one, merge it on GitHub, then clean up.' })
        progress('Verifying the pull request is merged')
        const { task } = await refreshPr(user, ctx, wsId, doc, b, task0)
        if (task.pullRequest.state !== 'merged') throw createError({ code: 'pull_request_not_merged', message: `Pull request #${task.pullRequest.number} is not merged (${task.pullRequest.state}). Nothing was changed.` })
        progress('Checking the working tree'); assertSafe(before, { allowDetached: true })
        progress('Fetching latest from GitHub'); await fetchOrigin(ws, doc, signal)
        progress(`Switching to ${doc.defaultBranch}`); await ffDefault(ws, doc, signal)
        progress('Verifying the merged changes arrived')
        const mergeSha = task.pullRequest.mergeCommitSha
        const present = mergeSha ? (await G(ws, ['merge-base', '--is-ancestor', mergeSha, 'HEAD'], { okCodes: [0, 1, 128] })).code === 0 : false
        if (!present) throw createError({ code: 'git_branch_diverged', message: `The merge commit is not in local ${doc.defaultBranch} after syncing. The local branch was kept.` })
        let localDeleted = false; const notes = []
        if (await localBranchExists(ws, b)) {
          progress(`Deleting local branch ${b}`)
          const d = await G(ws, ['branch', '-d', b], { okCodes: [0, 1] })
          if (d.code === 0) localDeleted = true
          else {
            // squash/rebase merges leave the branch tip outside default's history, so `-d` refuses; allow `-D` only when the tip is exactly what GitHub merged and the user confirmed
            const tip = (await G(ws, ['rev-parse', `refs/heads/${b}`])).stdout.trim()
            if (tip !== task.pullRequest.headSha) throw createError({ code: 'git_dirty_working_tree', message: `Local branch ${b} has commits that were not part of the merged pull request. It was kept.` })
            if (!confirmForceDelete) return { needsConfirmation: 'force_delete', message: 'GitHub merged this pull request in a way Git cannot verify (squash or rebase). The local branch tip equals what GitHub merged, so it is safe to delete, but this needs your confirmation.', branch: b, steps: [] }
            await G(ws, ['branch', '-D', b]); localDeleted = true
          }
        }
        let remoteDeleted = false
        progress('Checking the remote branch')
        const refPath = `/repos/${encodeURIComponent(doc.owner)}/${encodeURIComponent(doc.repo)}/git/refs/heads/${b.split('/').map(encodeURIComponent).join('/')}`
        const token = await tokenFor(doc)
        const exists = await api.request('GET', refPath.replace('/git/refs/', '/git/ref/'), { token }).then(() => true, (e) => { if (e.code === 'github_repository_not_found') return false; throw e })
        if (!exists) notes.push('Remote branch already removed.')
        else if (deleteRemote && b === (task.remoteBranch ?? b)) { progress(`Deleting remote branch ${b}`); await api.request('DELETE', refPath, { token }); remoteDeleted = true } else notes.push('Remote branch kept.')
        await G(ws, ['fetch', '--prune', 'origin'], { token, signal, timeoutMs: TIMEOUTS.network, okCodes: [0, 1, 128] }).catch(() => null)
        progress('Verifying the repository')
        const after = await readState(ws, doc)
        const ab = (await G(ws, ['rev-list', '--left-right', '--count', `HEAD...origin/${doc.defaultBranch}`])).stdout.trim().split(/\s+/).map(Number)
        const verified = after.branch === doc.defaultBranch && after.clean && ab[0] === 0 && ab[1] === 0
        await saveTask(user, wsId, b, { workflowStatus: verified ? 'completed_merged' : 'pr_merged', cleanedAt: now() }, { type: 'cleaned_up', detail: notes.join(' ') || null })
        ctx.broadcast({ kind: 'github', event: 'cleanup', workspaceId: wsId })
        return { done: verified, branch: b, defaultBranch: doc.defaultBranch, localDeleted, remoteDeleted, notes, state: after }
      })
    },

    /** Abandon a task: switches back to the default branch and deletes the local task branch only when it is safe or confirmed. */
    async abandon(user, wsId, { branch, confirm = false, deleteRemote = false } = {}) {
      const { ctx, ws, doc } = await resolveWs(user, wsId, { githubRequired: true })
      return operation(user, ctx, { name: 'abandon', key: `ws:${wsId}`, workspaceId: wsId, repo: `${doc.owner}/${doc.repo}`, mutates: true }, async ({ progress, signal }) => {
        const s = await readState(ws, doc); const b = branch ?? s.branch
        if (!b || b === doc.defaultBranch) throw createError({ code: 'protected_branch', message: 'The default branch cannot be abandoned.' })
        assertSafe(s, { allowDetached: true })
        const task = await getTask(user, wsId, b)
        const unpushed = (await G(ws, ['rev-list', '--count', `${b}`, '--not', '--remotes=origin'], { okCodes: [0, 128] })).stdout.trim()
        const risks = []
        if (Number(unpushed) > 0) risks.push(`${unpushed} unpushed commit${unpushed === '1' ? '' : 's'}`)
        if (task?.pullRequest?.state === 'open' || task?.pullRequest?.state === 'draft') risks.push(`pull request #${task.pullRequest.number} is still open`)
        if (risks.length && !confirm) return { needsConfirmation: 'abandon', risks, message: `This task has ${risks.join(' and ')}. Abandoning discards the local branch.` }
        progress(`Switching to ${doc.defaultBranch}`); await ffDefault(ws, doc, signal).catch(async () => { await G(ws, ['checkout', doc.defaultBranch]) })
        progress(`Deleting local branch ${b}`)
        const d = await G(ws, ['branch', '-d', b], { okCodes: [0, 1] })
        if (d.code !== 0) { if (!confirm) return { needsConfirmation: 'abandon', risks: ['the branch has commits that are not merged'], message: 'The branch has unmerged commits. Abandoning discards them locally.' }; await G(ws, ['branch', '-D', b]) }
        if (deleteRemote && task?.remoteBranch === b) { progress('Deleting remote branch'); await api.request('DELETE', `/repos/${encodeURIComponent(doc.owner)}/${encodeURIComponent(doc.repo)}/git/refs/heads/${b.split('/').map(encodeURIComponent).join('/')}`, { token: await tokenFor(doc) }).catch(() => null) }
        await saveTask(user, wsId, b, { workflowStatus: 'abandoned' }, { type: 'abandoned', detail: b })
        return { abandoned: b }
      })
    },

    /** Removes only the local clone BLUSWAN created for this user. Never touches GitHub. */
    async removeLocalCopy(user, wsId, { confirm = false } = {}) {
      const { ctx, ws, doc } = await resolveWs(user, wsId, { githubRequired: true })
      return operation(user, ctx, { name: 'remove-local-copy', key: `ws:${wsId}`, workspaceId: wsId, repo: `${doc.owner}/${doc.repo}`, mutates: true }, async ({ progress }) => {
        const target = await fs.realpath(ws.root)
        if (!isOwnedClone({ root: await fs.realpath(roots[0]), userId: user.id, target })) throw createError({ code: 'forbidden', message: 'BLUSWAN only removes clones it created.' })
        const s = await readState(ws, doc)
        const risks = []; if (!s.clean) risks.push('uncommitted changes'); const unpushed = Number((await G(ws, ['rev-list', '--count', '--branches', '--not', '--remotes=origin'], { okCodes: [0, 128] })).stdout.trim() || 0); if (unpushed) risks.push(`${unpushed} unpushed commit${unpushed === 1 ? '' : 's'}`)
        if (risks.length && !confirm) return { needsConfirmation: 'remove', risks, message: `The local copy has ${risks.join(' and ')}. Removing it deletes them.` }
        progress('Removing the local copy')
        await ctx.workspaces.closeWorkspace(wsId); await ctx.workspaceRepo.remove(wsId).catch(() => {})
        await fs.rm(target, { recursive: true, force: true })
        await saveRepoDoc(user, { ...clean(doc), cloned: false, workspaceId: null })
        listCache.delete(user.id)
        return { removed: true }
      })
    },

    tasks: async (user, wsId) => { await resolveWs(user, wsId); return { tasks: (await persistence.listDocs(user.id, 'github_tasks', { limit: 200 })).filter(t => t.workspaceId === wsId).map(clean) } },
    allTasks: async (user) => ({ tasks: (await persistence.listDocs(user.id, 'github_tasks', { limit: 200 })).map(clean) }),

    /** Links a conversation to the task branch it is running on (best effort; used for history display). */
    async noteSession(user, sessionId, wsId) {
      if (!configured) return
      try {
        const { doc, s, task } = await stateWithTask(user, wsId)
        if (doc && task && !task.sessionIds.includes(sessionId)) await saveTask(user, wsId, s.branch, { sessionIds: [...task.sessionIds, sessionId] })
      } catch { /* history decoration must never affect a run */ }
    },

    cancel(user, operationId) {
      const op = ops.get(operationId)
      if (!op || op.userId !== user.id) throw createError({ code: 'not_found', message: 'That operation is not running.' })
      op.controller.abort(); return { cancelled: true }
    },

    /** Facts the coding agent needs about the branch workflow. Empty for local-only workspaces. */
    async agentNotes(user, workspaceId) {
      if (!configured || !workspaceId) return ''
      try {
        const { doc, s, task } = await stateWithTask(user, workspaceId)
        if (!doc) return ''
        const pr = task?.pullRequest
        return [
          'GIT WORKFLOW CONTEXT (managed by the user through BLUSWAN, not by you):',
          `- Repository: ${doc.owner}/${doc.repo}; current branch: ${s.detached ? '(detached HEAD)' : s.branch}; base branch: ${task?.baseBranch ?? doc.defaultBranch}.`,
          `- Branch pushed: ${task?.pushed ? 'yes' : 'no'}; pull request: ${pr ? `#${pr.number} (${pr.state})` : 'none'}${pr?.state === 'merged' ? ' — merged' : ''}.`,
          s.isDefault ? `- You are on the protected default branch. Do not make coding changes here; ask the user to create a task branch first.` : '- Make your changes on this task branch.',
          '- Do not run git push --force, git reset --hard, git branch -D, or delete branches. Do not commit or push: the user reviews the diff and commits and pushes from the interface.',
        ].join('\n')
      } catch { return '' }
    },

    // ─── webhooks ─────────────────────────────────────────────────────────────────────────────────────────────────
    verifyWebhook(rawBody, signature) {
      if (!secrets.webhookSecret || typeof signature !== 'string' || !signature.startsWith('sha256=')) return false
      const expected = `sha256=${crypto.createHmac('sha256', secrets.webhookSecret).update(rawBody).digest('hex')}`
      const a = Buffer.from(expected); const b = Buffer.from(signature)
      return a.length === b.length && crypto.timingSafeEqual(a, b)
    },

    /** Applies a verified webhook payload to every connected user it concerns and notifies their browsers. */
    async handleWebhook(event, payload) {
      const installationId = payload?.installation?.id; const full = payload?.repository?.full_name
      if (!installationId || !full) return { handled: 0 }
      let handled = 0
      for (const ctx of await activeContexts()) {
        const user = ctx.user
        const conn = await loadConnection(user).catch(() => null)
        if (!conn?.installations?.some(i => String(i.id) === String(installationId))) continue
        const docs = (await repoDocs(user)).filter(d => d.cloned && `${d.owner}/${d.repo}`.toLowerCase() === full.toLowerCase())
        for (const doc of docs) {
          if (event === 'pull_request' && payload.pull_request) {
            const tasks = (await persistence.listDocs(user.id, 'github_tasks', { limit: 200 })).filter(t => t.workspaceId === doc.workspaceId && t.pullRequest?.number === payload.pull_request.number)
            for (const t of tasks) { await refreshPr(user, ctx, doc.workspaceId, doc, t.taskBranch, t).catch(() => null); handled += 1 }
          } else if (event === 'check_suite' || event === 'check_run' || event === 'push') {
            ctx.broadcast({ kind: 'github', event, workspaceId: doc.workspaceId }); handled += 1
          }
        }
      }
      return { handled }
    },
  })

  async function refreshPr(user, ctx, wsId, doc, branch, task) {
    const token = await tokenFor(doc); const base = `/repos/${encodeURIComponent(doc.owner)}/${encodeURIComponent(doc.repo)}`
    const pr = (await api.request('GET', `${base}/pulls/${task.pullRequest.number}`, { token })).json
    let checks = { status: 'unknown', total: 0 }
    try { checks = summarizeChecks((await api.request('GET', `${base}/commits/${pr.head.sha}/check-runs`, { token })).json.check_runs ?? []) } catch { /* checks are advisory */ }
    const summary = { ...prSummary(pr, doc), checks }
    const merged = summary.state === 'merged'
    const changed = JSON.stringify(summary) !== JSON.stringify(task.pullRequest)
    const status = merged ? (task.workflowStatus === 'completed_merged' ? 'completed_merged' : 'pr_merged') : summary.state === 'closed' ? 'pr_closed' : 'pr_open'
    const next = await saveTask(user, wsId, branch, { pullRequest: summary, workflowStatus: status }, changed && merged !== (task.pullRequest.state === 'merged') ? { type: merged ? 'pr_merged' : 'pr_state', detail: `#${summary.number} ${summary.state}` } : null)
    if (changed) ctx.broadcast({ kind: 'github', event: 'pull_request', workspaceId: wsId })
    return { pullRequest: summary, task: clean(next) }
  }

  return feature
}

/** Browser-safe repository identity. Never contains credentials. */
function safeEqual(a, b) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y) }

export function githubMeta(d) {
  return { owner: d.owner, repo: d.repo, repositoryId: d.repositoryId, defaultBranch: d.defaultBranch, htmlUrl: d.htmlUrl, cloneUrl: d.cloneUrl, installationId: d.installationId, private: !!d.private, fork: !!d.fork, upstream: d.upstream ?? null }
}

/** Pull request description for the client; `url` comes from GitHub metadata and is only kept when it points at github. */
export function prSummary(pr, doc) {
  const url = typeof pr.html_url === 'string' && /^https:\/\/[^/]+\//.test(pr.html_url) ? pr.html_url : `https://github.com/${doc.owner}/${doc.repo}/pull/${pr.number}`
  return { number: pr.number, title: redactGithub(pr.title ?? ''), url, state: derivePrState(pr), draft: !!pr.draft, merged: !!(pr.merged || pr.merged_at), mergedAt: pr.merged_at ?? null, mergeCommitSha: pr.merge_commit_sha ?? null, headSha: pr.head?.sha ?? null, base: pr.base?.ref ?? null, head: pr.head?.ref ?? null }
}

export const _internal = { userKey, path }
