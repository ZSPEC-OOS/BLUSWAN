import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createFixtureRepo, FIXTURE_FILES } from '../workspace/testing/fixtureRepo.js'
import { createLocalWorkspace } from '../workspace/localWorkspace.js'
import { scoreCandidates, extractKeywords, extractPathMentions } from './relevance.js'
import { extractSymbols, extractImports, resolveImport, hashContent, isSecretPath, isBinaryPath, describeFile } from './fileFacts.js'
import { buildRepositoryItems, observeFileRead, invalidateFiles, getRepositoryCache } from './repositoryContext.js'
import { buildWorkspaceContext } from './workspaceContext.js'
import { createSimulator } from './testing/simulator.js'
import { createTokenEstimator } from './tokenEstimator.js'
import { DEFAULT_CONTEXT } from '../config/runtimeConfig.js'

const AUTH = `// Owns token refresh and request retry coordination.
import { api } from './api.js'
import firebase from 'firebase/auth'
export async function refreshToken() { return api.refresh() }
export const authorizedFetch = async (url) => fetch(url)
export class AuthService {}
`

describe('relevance scoring', () => {
  const files = ['src/auth/AuthProvider.jsx', 'src/services/authService.js', 'src/services/api.js', 'src/ui/Button.jsx', 'tests/auth.test.js', '.env', 'assets/logo.png', 'docs/guide.md']

  it('is deterministic and explains every score', () => {
    const input = { files, requests: ['Fix the refresh race in authService'], changed: [], recent: [], searchHits: [], limit: 5 }
    const a = scoreCandidates(input)
    assert.deepEqual(scoreCandidates(input), a)
    assert.equal(a[0].path, 'src/services/authService.js')
    assert.match(a[0].reasons.join(';'), /path matches request terms \(.*auth/)
    for (const r of a) assert.ok(r.score > 0 && r.reasons.length > 0)
  })

  it('combines changed, recently read, search-hit and named-in-request signals', () => {
    const r = scoreCandidates({
      files, requests: ['look at src/ui/Button.jsx'], changed: [{ path: 'src/services/api.js', action: 'modified' }],
      recent: ['tests/auth.test.js', 'docs/guide.md'], searchHits: ['src/auth/AuthProvider.jsx'], limit: 10,
    })
    const by = Object.fromEntries(r.map(x => [x.path, x]))
    assert.deepEqual(by['src/services/api.js'].reasons, ['recently changed'])
    assert.ok(by['tests/auth.test.js'].score > by['docs/guide.md'].score) // more recent read ranks higher
    assert.ok(by['src/ui/Button.jsx'].reasons.includes('named in request'))
    assert.ok(by['src/auth/AuthProvider.jsx'].reasons.includes('search result'))
    assert.deepEqual(r.map(x => x.score), [...r.map(x => x.score)].sort((a, b) => b - a))
  })

  it('breaks ties alphabetically', () => {
    const r = scoreCandidates({ files: ['b/x.js', 'a/x.js', 'c/x.js'], requests: [], changed: [], recent: [], searchHits: ['c/x.js', 'a/x.js', 'b/x.js'], limit: 3 })
    assert.deepEqual(r.map(x => x.path), ['a/x.js', 'b/x.js', 'c/x.js'])
  })

  it('never proposes secret or binary files, even if they were hit or mentioned', () => {
    const r = scoreCandidates({ files, requests: ['read .env and logo.png'], changed: [], recent: ['.env'], searchHits: ['assets/logo.png', '.env.local'], limit: 20 })
    assert.ok(!r.some(x => /\.env|\.png/.test(x.path)))
  })

  it('uses symbols and import proximity', () => {
    const r = scoreCandidates({
      files, requests: ['why does refreshToken fail'], changed: [{ path: 'src/services/authService.js', action: 'modified' }], recent: [], searchHits: [],
      symbols: new Map([['src/services/api.js', ['refreshToken']]]),
      imports: new Map([['src/services/authService.js', ['src/services/api.js']]]), limit: 10,
    })
    const api = r.find(x => x.path === 'src/services/api.js')
    assert.match(api.reasons.join(';'), /symbol match \(refreshToken\)/)
    assert.match(api.reasons.join(';'), /imported by a changed file/)
  })

  it('splits identifiers into keywords and finds path mentions', () => {
    assert.deepEqual([...extractKeywords('Fix refreshToken in auth_service please')].sort(), ['auth', 'refresh', 'service', 'token'])
    assert.deepEqual(extractPathMentions('see src/a/b.js and index.test.mjs, not nothing'), ['src/a/b.js', 'index.test.mjs'])
  })
})

describe('file facts', () => {
  it('extracts symbols, imports, summaries and stable hashes', () => {
    assert.deepEqual(extractSymbols(AUTH), ['refreshToken', 'authorizedFetch', 'AuthService'])
    assert.deepEqual(extractImports(AUTH), ['./api.js', 'firebase/auth'])
    assert.match(describeFile('src/auth.js', AUTH), /^Owns token refresh.*Defines refreshToken, authorizedFetch, AuthService.*imports \.\/api\.js/)
    assert.equal(hashContent('abc'), hashContent('abc'))
    assert.notEqual(hashContent('abc'), hashContent('abd'))
  })
  it('resolves relative imports against known files only', () => {
    const set = new Set(['src/api.js', 'src/lib/index.js'])
    assert.equal(resolveImport('src/auth.js', './api.js', set), 'src/api.js')
    assert.equal(resolveImport('src/auth.js', './api', set), 'src/api.js')
    assert.equal(resolveImport('src/auth.js', './lib', set), 'src/lib/index.js')
    assert.equal(resolveImport('src/auth.js', 'firebase/auth', set), null)
  })
  it('classifies secret and binary paths', () => {
    for (const p of ['.env', '.env.production', 'config/.env.local', 'credentials.json', 'keys/server.pem', 'id_rsa']) assert.ok(isSecretPath(p), p)
    for (const p of ['src/env.js', 'README.md', 'src/environment.ts']) assert.ok(!isSecretPath(p), p)
    for (const p of ['a.PNG', 'doc.pdf', 'lib.so', 'bun.lockb']) assert.ok(isBinaryPath(p), p)
  })
})

describe('repository context (real workspace)', () => {
  let fx, ws
  const estimator = createTokenEstimator()
  const cfg = { ...DEFAULT_CONTEXT, maxOutputTokens: 1000 }
  const items = (over = {}) => buildRepositoryItems({ workspace: ws, summary: null, requests: ['fix refreshToken in the auth service'], searchHits: [], estimator, cfg, level: 'full', ...over })

  beforeEach(async () => {
    fx = await createFixtureRepo({
      files: {
        ...FIXTURE_FILES,
        'src/services/authService.js': AUTH, 'src/services/api.js': 'export const api = { refresh() {} }\n',
        'AGENTS.md': '# Engineering notes\nRun `npm test` before finishing. Prefer small patches.\n',
        '.env': 'SECRET_TOKEN=super-secret-value\n', 'assets/logo.png': 'not really png', 'node_modules/pkg/auth.js': 'x', 'vendor/auth.js': 'x',
      },
    })
    ws = await createLocalWorkspace({ root: fx.root })
  })
  afterEach(() => fx.cleanup())

  it('selects relevant files and bounded repository instructions', async () => {
    const { items: out, relevant } = await items()
    const text = out.map(i => i.text).join('\n')
    assert.equal(relevant[0].path, 'src/services/authService.js')
    assert.match(text, /Repository instructions \(AGENTS\.md\):\n# Engineering notes/)
    assert.deepEqual(out.map(i => i.type), ['repository_instructions', 'repository_relevant_files'])
    assert.ok(out.reduce((n, i) => n + i.tokens, 0) <= cfg.maxRepositoryContextTokens)
  })

  it('never injects secret, binary or generated files automatically', async () => {
    const { items: out } = await items({ requests: ['look at .env and logo.png and auth in node_modules and vendor'], searchHits: ['.env', 'assets/logo.png'] })
    const text = out.map(i => i.text).join('\n')
    assert.ok(!/\.env|SECRET|super-secret|logo\.png|node_modules|vendor\//.test(text), text)
    await fs.appendFile(path.join(fx.root, 'AGENTS.md'), '')
    assert.ok(!(await ws.listFiles()).files.some(f => /node_modules|vendor/.test(f)))
    assert.equal(await observeFileRead(ws, { path: '.env', content: 'SECRET_TOKEN=x', startLine: 1, endLine: 1, totalLines: 1, truncated: false }), null)
  })

  it('stays bounded and fast in a repository with thousands of files', async () => {
    await Promise.all(Array.from({ length: 30 }, async (_, d) => {
      await fs.mkdir(path.join(fx.root, `src/gen/d${d}`), { recursive: true })
      await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(path.join(fx.root, `src/gen/d${d}/file${i}.js`), `export const v${i} = ${i}\n`)))
    }))
    const big = await createLocalWorkspace({ root: fx.root })
    assert.ok((await big.listFiles()).files.length >= 3000)
    const t0 = Date.now()
    const out = await buildRepositoryItems({ workspace: big, summary: null, requests: ['fix refreshToken in the auth service'], searchHits: [], estimator, cfg, level: 'full' })
    assert.ok(Date.now() - t0 < 3000)
    assert.ok(out.items.reduce((n, i) => n + i.tokens, 0) <= cfg.maxRepositoryContextTokens)
    assert.equal(out.relevant[0].path, 'src/services/authService.js')
    assert.ok(out.relevant.length <= cfg.maxRelevantFiles)
    const ctx = await buildWorkspaceContext(big)
    assert.ok(ctx.length < 2000 && !/file99/.test(ctx), 'workspace context must not enumerate the repository')
  })

  it('records file summaries from reads and shows them for relevant files', async () => {
    const read = await ws.readFile('src/services/authService.js')
    const entry = await observeFileRead(ws, read)
    assert.deepEqual(entry.symbols, ['refreshToken', 'authorizedFetch', 'AuthService'])
    assert.equal(entry.hash, hashContent(AUTH))
    assert.equal(entry.complete, true)
    const { items: out } = await items()
    assert.match(out.at(-1).text, /authService\.js \(.*\) — Owns token refresh.*Defines refreshToken/)
    const lite = await items({ level: 'minimal' })
    assert.ok(!/Defines refreshToken/.test(lite.items.map(i => i.text).join('')))
    assert.ok(!lite.items.some(i => i.type === 'repository_instructions'))
    assert.deepEqual((await items({ level: 'none' })).items, [])
  })

  it('invalidates a file summary when the file is modified by a tool', async () => {
    await observeFileRead(ws, await ws.readFile('src/services/authService.js'))
    assert.ok(getRepositoryCache(ws).files.has('src/services/authService.js'))
    await ws.applyPatch(`--- a/src/services/authService.js
+++ b/src/services/authService.js
@@ -4,3 +4,3 @@
-export async function refreshToken() { return api.refresh() }
+export async function renewSession() { return api.refresh() }
 export const authorizedFetch = async (url) => fetch(url)
 export class AuthService {}
`)
    invalidateFiles(ws, ['src/services/authService.js'])
    assert.ok(!getRepositoryCache(ws).files.has('src/services/authService.js'))
    const text = (await items()).items.map(i => i.text).join('\n')
    assert.ok(!/Defines refreshToken/.test(text), 'stale summary must not be used')
  })

  it('also drops summaries when a file changed outside the tools (e.g. via a shell command)', async () => {
    await observeFileRead(ws, await ws.readFile('src/services/authService.js'))
    await new Promise(r => setTimeout(r, 10))
    await fs.writeFile(path.join(fx.root, 'src/services/authService.js'), 'export function somethingElse() {}\n// changed behind our back\n')
    const text = (await items()).items.map(i => i.text).join('\n')
    assert.ok(!/Defines refreshToken/.test(text))
    assert.ok(!getRepositoryCache(ws).files.has('src/services/authService.js'))
  })

  it('keeps a whole-file entry when a later partial read adds only what it saw', async () => {
    await observeFileRead(ws, await ws.readFile('src/services/authService.js'))
    const partial = await ws.readFile('src/services/authService.js', { startLine: 4, endLine: 5 })
    const entry = await observeFileRead(ws, partial)
    assert.equal(entry.complete, true)
    assert.ok(entry.symbols.includes('AuthService'))
  })

  it('describes workspace conventions compactly and stably', async () => {
    const text = await buildWorkspaceContext(ws)
    assert.match(text, /Branch: main/)
    assert.match(text, /Git status: clean/)
    assert.match(text, /Conventions: language JavaScript; tests node:test .*; source src\/; tests dir tests\//)
    await ws.writeFile('new.txt', 'x')
    assert.match(await buildWorkspaceContext(ws), /Git status: 1 untracked/)
    assert.ok(!/Top-level/.test(await buildWorkspaceContext(ws, { level: 'minimal' })))
  })

  it('invalidates a read through the whole pipeline: engine context never shows stale content', async () => {
    const sim = createSimulator({ workspace: ws, contextWindow: 60_000 })
    sim.user('Fix refreshToken in the auth service')
    const read = await ws.readFile('src/services/authService.js')
    await observeFileRead(ws, read)
    sim.tool('read_file', { path: read.path }, { ok: true, tool: 'read_file', output: read })
    let ctx = await sim.build()
    assert.match(ctx.messages[0].content, /Defines refreshToken/)
    assert.match(ctx.messages.find(m => m.role === 'tool').content, /export async function refreshToken/)

    await ws.writeFile('src/services/authService.js', 'export function renewed() {}\n')
    invalidateFiles(ws, ['src/services/authService.js'])
    sim.tool('write_file', { path: read.path, content: '...' }, { ok: true, tool: 'write_file', output: { path: read.path, created: false, overwritten: true, bytesWritten: 30 } })
    ctx = await sim.build()
    assert.ok(!/Defines refreshToken/.test(ctx.messages[0].content))
    assert.ok(!ctx.messages.some(m => m.role === 'tool' && /export async function refreshToken/.test(m.content)), 'old read content must be superseded')
    assert.match(ctx.messages.find(m => m.role === 'tool').content, /Superseded/)
    assert.match(ctx.messages[0].content, /authService\.js \(modified since read\)/)
  })
})
