// Architecture guards: the dependency directions, boundaries and "no legacy" rules the codebase promises.
// Static checks over the source tree — cheap, offline, and they fail the moment someone reintroduces a shortcut.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname)
const REPO = path.resolve(ROOT, '..')
const EXTS = ['', '.js', '.jsx', '.mjs', '/index.js']

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(m?js|jsx)$/.test(e.name)) out.push(p)
  }
  return out
}
const isTest = (f) => /\.test\.mjs$/.test(f) || f.includes(`${path.sep}testing${path.sep}`)
const all = walk(ROOT)
const code = all.filter(f => !isTest(f))
const rel = (f) => path.relative(ROOT, f)
const top = (f) => rel(f).split(path.sep)[0].replace(/\.(jsx|js)$/, '')
const read = (f) => fs.readFileSync(f, 'utf8')
const specifiers = (f) => [...read(f).matchAll(/(?:import|export)[^'"`\n]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1] ?? m[2] ?? m[3])
const resolve = (from, spec) => { const b = path.resolve(path.dirname(from), spec); for (const e of EXTS) { const p = b + e; if (fs.existsSync(p) && fs.statSync(p).isFile()) return p } return null }
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

describe('legacy architecture is gone', () => {
  it('has no versioned, legacy or duplicate-engine directories', () => {
    const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
    for (const d of dirs) assert.doesNotMatch(d, /(^|-)v\d+$|legacy|migration/i, `src/${d}`)
    for (const d of ['core', 'core-v2', 'services', 'services-v2', 'components', 'components-v2', 'cli']) assert.equal(fs.existsSync(path.join(ROOT, d)), false, `src/${d} must not exist`)
    for (const d of ['planner', 'pydantic', 'tests']) assert.equal(fs.existsSync(path.join(REPO, d)), false, `${d}/ must not exist`)
  })

  it('every relative import in src resolves (no dead or compatibility imports)', () => {
    // test files fail on their own when an import is broken (and some embed import-like text in fixtures)
    for (const f of all.filter(x => !/\.test\.mjs$/.test(x) && !['eval/tasks.js', 'workspace/testing/fixtureRepo.js', 'validation/testing/fixtures.js'].includes(rel(x)))) for (const s of specifiers(f)) if (s.startsWith('.') && !/\.(css|png|svg)$/.test(s)) assert.ok(resolve(f, s), `${rel(f)} imports missing ${s}`)
  })

  it('nothing imports a removed legacy module', () => {
    const banned = /(^|\/)(core-v2|services-v2|components-v2|services|core|components)\/|agentExecutor|(^|\/)aiService|taskRunner|taskStateMachine|planContract|cycleEngine|completionGate|remediationBudget|shadowContext|memoryGraph|contextCompressor|featureFlags|providerRegistry/
    for (const f of all) for (const s of specifiers(f)) assert.doesNotMatch(s, banned, `${rel(f)} imports ${s}`)
  })

  it('active code carries no engine/version vocabulary', () => {
    const banned = /\b(useV2\w*|fallbackToV1|executeV2|TaskDashboard|PlanReview|CycleReview|EngineToggle|QualitySignals|getMigrationStatus|newEngine)\b/
    for (const f of [...code, path.join(ROOT, 'main.jsx')]) assert.doesNotMatch(strip(read(f)), banned, rel(f))
  })

  it('package scripts and dependencies only reference what exists', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
    for (const [name, cmd] of Object.entries(pkg.scripts)) for (const m of cmd.matchAll(/node (?:--test )?"?((?:scripts|src)\/[^\s"]+)/g)) {
      if (!m[1].includes('*')) assert.ok(fs.existsSync(path.join(REPO, m[1])), `script ${name} -> ${m[1]}`)
    }
    for (const dep of Object.keys(pkg.dependencies)) {
      const used = [...all, ...walk(path.join(REPO, 'scripts'))].some(f => specifiers(f).some(s => s === dep || s.startsWith(`${dep}/`)))
      assert.ok(used, `dependency ${dep} is not imported anywhere`)
    }
    assert.equal(pkg.scripts.test.includes('v2'), false)
  })
})

// Allowed dependency directions between top-level modules (a DAG). Anything else is an architecture change.
const ALLOWED = {
  protocol: ['utils'], utils: [], config: [],
  providers: ['config', 'protocol', 'utils'],
  workspace: ['config', 'protocol'],
  tools: ['config', 'protocol', 'utils', 'workspace'],
  validation: ['config', 'tools'],
  context: ['config', 'protocol', 'validation'],
  persistence: ['protocol', 'tools', 'utils'],
  sessions: ['persistence', 'protocol', 'utils', 'workspace'],
  agent: ['config', 'context', 'protocol', 'providers', 'sessions', 'tools', 'utils', 'validation'],
  eval: ['agent', 'config', 'validation', 'workspace'],
  server: ['agent', 'config', 'persistence', 'protocol', 'providers', 'sessions', 'tools', 'utils', 'workspace'],
  client: ['protocol', 'providers', 'tools', 'utils'],
  auth: ['client'],
  ConnectedApplication: ['client', 'persistence'],
  App: ['auth', 'ConnectedApplication'],
  main: ['App'],
}

describe('dependency directions', () => {
  it('top-level modules depend only in the allowed direction (and so form no cycles)', () => {
    for (const f of code) {
      const from = top(f)
      assert.ok(from in ALLOWED, `unexpected top-level module: ${from}`)
      for (const s of specifiers(f)) {
        if (!s.startsWith('.')) continue
        const r = resolve(f, s); if (!r) continue
        const to = top(r)
        if (to !== from) assert.ok(ALLOWED[from].includes(to), `${rel(f)} (${from}) must not depend on ${to}`)
      }
    }
  })

  const importsOf = (dir) => code.filter(f => top(f) === dir).flatMap(f => specifiers(f).map(s => ({ f, s })))
  const PROVIDER_IMPL = /providers\/(deepseek|kimi|openai|anthropic|adapter|transport|chatCompletions|credentials)/

  it('the agent runtime is provider-neutral: no React, no UI, no provider implementations, no provider-name branches', () => {
    for (const { f, s } of importsOf('agent')) { assert.doesNotMatch(s, /^react|client|server/, `${rel(f)} imports ${s}`); assert.doesNotMatch(s, PROVIDER_IMPL, `${rel(f)} imports ${s}`) }
    for (const dir of ['agent', 'context', 'tools', 'validation', 'sessions', 'workspace', 'persistence']) {
      for (const f of code.filter(x => top(x) === dir)) assert.doesNotMatch(strip(read(f)), /['"`](deepseek|kimi|openai|anthropic)['"`]/i, `${rel(f)} names a provider`)
    }
  })
  it('providers never reach the runtime, tools, workspaces, sessions or storage', () => {
    for (const { f, s } of importsOf('providers')) assert.doesNotMatch(s, /agent|tools|workspace|sessions|persistence|client|server|react/, `${rel(f)} imports ${s}`)
  })
  it('context, validation and workspace code has no React and no provider implementation', () => {
    for (const dir of ['context', 'validation', 'workspace', 'tools', 'sessions', 'persistence']) {
      for (const { f, s } of importsOf(dir)) { assert.doesNotMatch(s, /^react|client\//, `${rel(f)} imports ${s}`); assert.doesNotMatch(s, PROVIDER_IMPL, `${rel(f)} imports ${s}`) }
    }
  })
  it('persistence and core modules never import Firebase; only the Firestore adapter and web sign-in know it', () => {
    for (const f of code) for (const s of specifiers(f)) if (/firebase/i.test(s) && !s.startsWith('.')) assert.ok(['auth/firebaseAuth.js', 'server/main.js'].includes(rel(f)), `${rel(f)} imports ${s}`)
    for (const f of code.filter(x => top(x) === 'persistence')) for (const s of specifiers(f)) assert.doesNotMatch(s, /firebase/i, rel(f))
  })
  it('browser code imports no Node built-ins, server modules or storage backends that need them', () => {
    const browser = code.filter(f => ['client', 'auth', 'App', 'ConnectedApplication', 'main'].includes(top(f)))
    for (const f of [...browser, ...['persistence/persistence.js', 'persistence/docStore.js', 'persistence/serializer.js', 'persistence/migration.js', 'persistence/adapters/localPersistence.js', 'utils/title.js'].map(p => path.join(ROOT, p))]) {
      for (const s of specifiers(f)) assert.doesNotMatch(s, /^node:|\/server\/|providers\/credentials|filePersistence|firebasePersistence|providers\/(deepseek|kimi|openai|anthropic|adapter|transport)/, `${rel(f)} imports ${s}`)
    }
  })
  it('only the server reaches the runtime; the client talks to it over the API', () => {
    for (const f of code) if (top(f) !== 'server' && top(f) !== 'eval') for (const s of specifiers(f)) { const r = s.startsWith('.') ? resolve(f, s) : null; if (r) assert.notEqual(rel(r), path.join('agent', 'runtime.js'), `${rel(f)} imports the runtime`) }
  })
})

describe('secrets stay on the server', () => {
  it('browser code never names provider secrets or VITE_ keys', () => {
    // (auth/firebaseAuth.js reads the public Firebase web config, which is not a secret)
    for (const f of code.filter(x => ['client', 'auth', 'App', 'ConnectedApplication', 'main'].includes(top(x)) && rel(x) !== 'auth/firebaseAuth.js')) assert.doesNotMatch(read(f), /(DEEPSEEK|KIMI|OPENAI|ANTHROPIC)_API_KEY|VITE_[A-Z_]*(API_KEY|SECRET|TOKEN)\b/, rel(f))
  })
  it('no source or example config contains a real-looking key', () => {
    const files = [...all, ...walk(path.join(REPO, 'scripts')), path.join(REPO, '.env.example')]
    for (const f of files) {
      const text = read(f).replace(/sk-[A-Za-z0-9_-]*(?:test|fake|secret|never|contract|int|smoke|server-only|livesecret|old|model|live|abcdef|aaaa|bbbb|key)[A-Za-z0-9_-]*/gi, '')
      assert.doesNotMatch(text, /sk-[A-Za-z0-9]{24,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|xox[bp]-[A-Za-z0-9-]{20,}|-----BEGIN (RSA )?PRIVATE KEY-----/, path.relative(REPO, f))
    }
    const env = read(path.join(REPO, '.env.example'))
    for (const line of env.split('\n')) if (/^[A-Z_]*(KEY|SECRET|TOKEN)[A-Z_]*=/.test(line)) assert.match(line, /=\s*$/, `.env.example must hold names only: ${line.split('=')[0]}`)
  })
})

describe('release-stabilization guards', () => {
  const BROWSER = ['client', 'auth', 'App', 'ConnectedApplication', 'main']
  const browserFiles = code.filter(f => BROWSER.includes(top(f)))

  it('introduces no parallel runtime: no V4 / new* / runtime-v2 modules anywhere', () => {
    for (const f of [...all, ...walk(path.join(REPO, 'scripts')), ...walk(path.join(REPO, 'e2e'))]) assert.doesNotMatch(path.basename(f), /^new(Runtime|Server|Persistence|ContextEngine|Engine|Agent)|v4|runtime-v2|-v2\b/i, f)
  })
  it('the application shell never builds a local agent runtime, provider, workspace or tool executor', () => {
    for (const f of code.filter(x => ['App', 'ConnectedApplication', 'auth', 'main'].includes(top(x)))) {
      const t = strip(read(f))
      assert.doesNotMatch(t, /createAgentRuntime|createProviderRegistry|createStandardProviders|createNodeWorkspaceManager|createToolExecutor/, rel(f))
    }
  })
  it('server-owned tuning is not read from VITE_ variables: only the public API URL and Firebase web config are', () => {
    for (const f of all.filter(x => !/\.test\.mjs$/.test(x))) {
      for (const m of strip(read(f)).matchAll(/VITE_[A-Z0-9_]+/g)) assert.ok(/^VITE_(BLUSWAN_API_URL|FIREBASE_(API_KEY|AUTH_DOMAIN|PROJECT_ID|APP_ID|))$/.test(m[0]), `${rel(f)} reads ${m[0]}`)
    }
  })
  it('browser code does not read the whole import.meta.env object (it would inline every VITE_ variable)', () => {
    for (const f of browserFiles) assert.doesNotMatch(strip(read(f)), /import\.meta\.env(?!\.|\?\.(DEV|PROD)\b)(?!\s*\.)/, rel(f))
  })
  it('runtime configuration for the server never depends on the browser build environment', () => {
    for (const f of code.filter(x => top(x) === 'server')) assert.doesNotMatch(strip(read(f)), /import\.meta\.env/, rel(f))
  })
  it('every API route a browser file calls exists on the server', () => {
    const http = strip(read(path.join(ROOT, 'server', 'http.js')))
    const routes = new Set([...http.matchAll(/seg\[0\] === '([a-z-]+)'/g)].map(m => m[1]))
    for (const r of ['health', 'ready', 'stream']) routes.add(r)
    for (const f of browserFiles) for (const m of read(f).matchAll(/['"`]\/api\/([a-z-]+)/g)) assert.ok(routes.has(m[1]), `${rel(f)} calls /api/${m[1]} which the server does not serve`)
  })
})
