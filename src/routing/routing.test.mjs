// Routing: signals, policy, classifier, router, escalation, profile parsing. Deterministic; no network, no filesystem.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractSignals } from './signals.js'
import { scoreSignals, THRESHOLDS } from './policy.js'
import { parseVerdict, classify } from './classifier.js'
import { createRouter } from './router.js'
import { evaluateEscalation } from './escalation.js'
import { parseRoutingEnv, evaluateProfiles, publicRouting, normalizeMode } from './profiles.js'
import { isReasonCode } from './reasons.js'

const profiles = {
  fast: { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high' },
  advanced: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
}
const band = (message, context) => scoreSignals(extractSignals(message, context)).band
const scored = (message, context) => scoreSignals(extractSignals(message, context))

describe('deterministic routing matrix', () => {
  const FAST = [
    'What does the parseConfig function in src/config.js do?',
    'Explain how the session manager restores sessions.',
    'Fix the typo in README.md.',
    'Rename the variable `userCount` to `activeUsers` in src/stats.js.',
    'Add a comment above the retry loop in src/net.js.',
    'Change the button label from Save to Apply in src/Toolbar.jsx.',
    'Bump the version in package.json.',
    'List the exported functions in src/utils.js.',
  ]
  for (const m of FAST) it(`Fast: ${m}`, () => assert.equal(band(m), 'fast', JSON.stringify(scored(m))))

  const ADVANCED = [
    'Refactor the entire codebase to replace callbacks with async/await across all modules.',
    'Redesign the authentication architecture: move sessions to JWT with token rotation across the API and the client.',
    'Write a database migration that changes the schema of the orders table and backfills data.',
    'There is an intermittent race condition in the reconnect logic; find the root cause and fix it.',
    'Debug why the tests fail intermittently across src/a.js, src/b.js and src/c.js — what is the root cause?',
    'Rewrite the state machine so every route and component uses the new data model.',
  ]
  for (const m of ADVANCED) it(`Pro: ${m}`, () => assert.equal(band(m), 'advanced', JSON.stringify(scored(m))))

  it('is deterministic and stable for identical input', () => {
    const a = scored('Refactor the entire codebase across all modules.'); const b = scored('Refactor the entire codebase across all modules.')
    assert.deepEqual(a, b)
  })

  it('every emitted reason code is a known code', () => {
    for (const m of [...FAST, ...ADVANCED]) for (const c of scored(m).reasonCodes) assert.ok(isReasonCode(c), c)
  })
})

describe('counterexamples: keywords and length alone do not decide', () => {
  it('a single security / architecture / refactor word does not force Pro', () => {
    assert.notEqual(band('Where is the auth middleware defined in src/server.js?'), 'advanced')
    assert.notEqual(band('Explain the architecture of the context engine.'), 'advanced')
    assert.notEqual(band('Rename the refactor flag in src/flags.js to useNewPath.'), 'advanced')
    assert.notEqual(band('Fix the typo in the authentication error message in src/auth.js.'), 'advanced')
  })
  it('a long message is not complexity', () => {
    const long = `Please fix the typo in README.md. ${'Thank you very much for your help with this small thing. '.repeat(40)}`
    assert.equal(band(long), 'fast')
  })
  it('a short message can be hard', () => {
    assert.equal(band('Fix the intermittent race in reconnect across all modules; find the root cause.'), 'advanced')
  })
  it('a pure question about migrations stays out of Pro', () => {
    assert.notEqual(band('What does the migration in db/001.sql do?'), 'advanced')
  })
})

describe('follow-ups', () => {
  const prior = { tier: 'advanced', score: 80, failedValidation: false }
  it('"Fix it." inherits the previous task difficulty', () => {
    assert.equal(band('Fix it.', { prior }), 'advanced')
    assert.equal(band('Fix it.', { prior: { tier: 'fast', score: 10, failedValidation: false } }), 'fast')
  })
  it('a follow-up after failed validation goes to Pro', () => {
    assert.equal(band('Fix it.', { prior: { tier: 'fast', score: 20, failedValidation: true } }), 'advanced')
  })
  it('without a previous task it is not treated as a follow-up', () => {
    assert.equal(extractSignals('Fix it.').followUp, false)
  })
  it('unresolved failures push towards Pro', () => {
    assert.equal(band('Tidy up src/a.js', { unresolvedFailures: 3 }), 'advanced')
  })
})

describe('classifier', () => {
  const good = '{"route":"fast","confidence":0.9,"scope":"narrow","risk":"low"}'
  it('accepts only the strict schema', () => {
    assert.deepEqual(parseVerdict(good), { route: 'fast', confidence: 0.9, scope: 'narrow', risk: 'low' })
    assert.deepEqual(parseVerdict('```json\n' + good + '\n```').route, 'fast')
    for (const bad of ['', 'nonsense', '[]', '{"route":"fast"}', '{"route":"slow","confidence":1,"scope":"narrow","risk":"low"}',
      '{"route":"fast","confidence":2,"scope":"narrow","risk":"low"}', '{"route":"fast","confidence":0.5,"scope":"narrow","risk":"low","why":"because"}', null, 5]) {
      assert.equal(parseVerdict(bad), null, String(bad))
    }
  })
  it('times out and honours cancellation', async () => {
    const slow = ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    const t = await classify({ message: 'x', signals: extractSignals('x') }, { complete: slow, timeoutMs: 20 })
    assert.deepEqual([t.ok, t.reason], [false, 'unavailable'])
    const ac = new AbortController(); ac.abort()
    assert.equal((await classify({ message: 'x', signals: extractSignals('x') }, { complete: slow, signal: ac.signal })).reason, 'cancelled')
  })
})

describe('router', () => {
  const AMBIGUOUS = 'Improve the error handling in the sync module and clean up anything weird.'
  const mk = (complete, tiers) => createRouter({ profiles, complete, tiers })
  const verdict = (o) => async () => ({ text: JSON.stringify({ route: 'fast', confidence: 0.9, scope: 'narrow', risk: 'low', ...o }), usage: { input: 50, output: 10 } })

  it('the gray fixture really is in the gray band', () => assert.equal(band(AMBIGUOUS), 'gray', JSON.stringify(scored(AMBIGUOUS))))

  it('skips the classifier for obvious requests', async () => {
    let calls = 0
    const r = mk(async () => { calls += 1; return { text: '' } })
    const fast = await r.route({ message: 'Fix the typo in README.md.' })
    const pro = await r.route({ message: 'Refactor the entire codebase across all modules.' })
    assert.deepEqual([fast.tier, fast.source, pro.tier, pro.source, calls], ['fast', 'deterministic', 'advanced', 'deterministic', 0])
    assert.equal(fast.model, 'deepseek-flash'); assert.equal(pro.model, 'deepseek-v4-pro'); assert.equal(pro.reasoningEffort, 'high')
  })

  it('invokes the classifier for gray requests and respects a confident verdict', async () => {
    const d = await mk(verdict({})).route({ message: AMBIGUOUS })
    assert.deepEqual([d.tier, d.source, d.reasonCodes, d.classifier.outcome, d.classifier.usage], ['fast', 'classifier', ['classifier_fast'], 'ok', { input: 50, output: 10 }])
    assert.equal((await mk(verdict({ route: 'advanced' })).route({ message: AMBIGUOUS })).tier, 'advanced')
  })

  it('low confidence and high risk default to Pro', async () => {
    assert.deepEqual((await mk(verdict({ confidence: 0.3 })).route({ message: AMBIGUOUS })).reasonCodes, ['classifier_low_confidence'])
    assert.equal((await mk(verdict({ risk: 'high', confidence: 0.7 })).route({ message: AMBIGUOUS })).tier, 'advanced')
  })

  it('malformed output, errors, timeouts and a missing classifier all default to Pro', async () => {
    const cases = [async () => ({ text: 'not json' }), async () => { throw new Error('boom') }]
    for (const c of cases) {
      const d = await mk(c).route({ message: AMBIGUOUS })
      assert.deepEqual([d.tier, d.source, d.reasonCodes.includes('default_advanced')], ['advanced', 'default', true])
    }
    const none = await mk(null).route({ message: AMBIGUOUS })
    assert.deepEqual([none.tier, none.source], ['advanced', 'default'])
    const slowRouter = createRouter({ profiles, complete: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('x')))), classifierLimits: { timeoutMs: 20, minConfidence: 0.6 } })
    const t = await slowRouter.route({ message: AMBIGUOUS })
    assert.deepEqual([t.tier, t.reasonCodes[0]], ['advanced', 'classifier_unavailable'])
  })

  it('manual modes never score, classify or change', async () => {
    let calls = 0
    const r = mk(async () => { calls += 1; return { text: '' } })
    const flash = await r.route({ mode: 'fast', message: 'Rewrite everything across the entire codebase.' })
    const pro = await r.route({ mode: 'advanced', message: 'Fix the typo.' })
    assert.deepEqual([flash.tier, flash.source, flash.score, pro.tier, pro.source, calls], ['fast', 'manual', null, 'advanced', 'manual', 0])
  })

  it('never substitutes an unavailable tier', async () => {
    const proDown = mk(null, { fast: { ok: true }, advanced: { ok: false, reason: 'Pro unavailable' } })
    await assert.rejects(proDown.route({ mode: 'advanced', message: 'x' }), e => e.code === 'configuration_error')
    await assert.rejects(proDown.route({ mode: 'auto', message: 'Fix the typo in README.md.' }), e => e.code === 'configuration_error')
    const flashDown = mk(null, { fast: { ok: false, reason: 'Flash unavailable' }, advanced: { ok: true } })
    await assert.rejects(flashDown.route({ mode: 'fast', message: 'x' }), e => e.code === 'configuration_error')
    assert.equal((await flashDown.route({ mode: 'advanced', message: 'x' })).tier, 'advanced')
  })

  it('routes concurrent requests independently', async () => {
    const r = mk(verdict({}))
    const [a, b, c] = await Promise.all([
      r.route({ message: 'Fix the typo in README.md.' }), r.route({ message: 'Refactor the entire codebase across all modules.' }), r.route({ message: AMBIGUOUS }),
    ])
    assert.deepEqual([a.tier, b.tier, c.tier], ['fast', 'advanced', 'fast'])
  })

  it('cancellation during classification rejects as cancelled', async () => {
    const ac = new AbortController()
    const r = mk(({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('x')))))
    const p = r.route({ message: AMBIGUOUS, signal: ac.signal }); ac.abort()
    await assert.rejects(p, e => e.code === 'cancelled')
  })

  it('decisions carry no message text', async () => {
    const d = await mk(verdict({})).route({ message: `${AMBIGUOUS} secret-marker-123` })
    assert.ok(!JSON.stringify(d).includes('secret-marker-123'))
  })
})

describe('escalation', () => {
  const route = { mode: 'auto', tier: 'fast', escalated: false }
  const ev = (o) => ({ recoveryRounds: 0, repairSucceeded: false, sawFailure: false, failedTurns: 0, newChangedFiles: 0, ...o })
  it('escalates on repeated validation failure after repairs, once', () => {
    assert.deepEqual(evaluateEscalation(route, ev({ sawFailure: true, recoveryRounds: 2 })), { escalate: true, reasonCode: 'repeated_validation_failure' })
    assert.equal(evaluateEscalation({ ...route, escalated: true }, ev({ sawFailure: true, recoveryRounds: 5 })).escalate, false)
  })
  it('does not escalate on one ordinary failure or after a successful repair', () => {
    assert.equal(evaluateEscalation(route, ev({ sawFailure: true, recoveryRounds: 1 })).escalate, false)
    assert.equal(evaluateEscalation(route, ev({ sawFailure: true, recoveryRounds: 3, repairSucceeded: true })).escalate, false)
    assert.equal(evaluateEscalation(route, ev({ failedTurns: 1 })).escalate, false)
  })
  it('escalates on stalled turns and scope growth', () => {
    assert.equal(evaluateEscalation(route, ev({ failedTurns: 3 })).reasonCode, 'repeated_tool_failures')
    assert.equal(evaluateEscalation(route, ev({ newChangedFiles: 8 })).reasonCode, 'scope_expanded')
  })
  it('never applies to manual modes or to Pro', () => {
    for (const r of [{ mode: 'fast', tier: 'fast' }, { mode: 'advanced', tier: 'advanced' }, { mode: 'auto', tier: 'advanced' }]) {
      assert.equal(evaluateEscalation(r, ev({ sawFailure: true, recoveryRounds: 9, failedTurns: 9, newChangedFiles: 99 })).escalate, false)
    }
  })
})

describe('profile configuration', () => {
  it('is unconfigured (manual-only) without routing variables', () => {
    const r = parseRoutingEnv({ DEEPSEEK_API_KEY: 'x' })
    assert.equal(r.configured, false)
  })
  it('applies documented defaults when only the mode is set', () => {
    const r = parseRoutingEnv({ BLUSWAN_MODEL_MODE: 'auto' })
    assert.deepEqual([r.configured, r.problems, r.profiles.fast.model, r.profiles.advanced.model, r.profiles.fast.reasoningEffort], [true, [], 'deepseek-flash', 'deepseek-v4-pro', 'high'])
  })
  it('reports actionable problems for bad or partial values', () => {
    assert.match(parseRoutingEnv({ BLUSWAN_MODEL_MODE: 'turbo' }).problems[0], /BLUSWAN_MODEL_MODE/)
    assert.match(parseRoutingEnv({ BLUSWAN_FAST_PROVIDER: 'nope' }).problems.join(), /BLUSWAN_FAST_PROVIDER/)
    assert.match(parseRoutingEnv({ BLUSWAN_ADVANCED_REASONING_EFFORT: 'warp' }).problems.join(), /REASONING_EFFORT/)
    assert.match(parseRoutingEnv({ BLUSWAN_FAST_MODEL: 'deepseek-flash' }).problems.join(), /set both/)
  })
  it('accepts flash/pro aliases', () => {
    assert.deepEqual(['flash', 'PRO', 'auto', 'x'].map(normalizeMode), ['fast', 'advanced', 'auto', null])
  })
  it('Auto is available only when both profiles are usable; the public projection leaks nothing sensitive', () => {
    const routing = parseRoutingEnv({ BLUSWAN_MODEL_MODE: 'auto' })
    const caps = () => ({ toolCalling: true, streaming: true })
    const both = evaluateProfiles(routing, { isConfigured: () => true, capabilitiesFor: caps })
    assert.equal(both.available, true)
    const noKey = evaluateProfiles(routing, { isConfigured: () => false, capabilitiesFor: caps })
    assert.equal(noKey.available, false)
    const weak = evaluateProfiles(routing, { isConfigured: () => true, capabilitiesFor: (p, m) => (m === 'deepseek-flash' ? { toolCalling: false, streaming: true } : caps()) })
    assert.deepEqual([weak.available, weak.tiers.fast.ok, weak.tiers.advanced.ok], [false, false, true])
    const pub = publicRouting(routing, both)
    assert.deepEqual(pub.profiles.map(p => p.id), ['fast', 'advanced'])
    assert.ok(!/key|prompt|weight|threshold/i.test(JSON.stringify(pub)))
    assert.equal(THRESHOLDS.fastMax, 35)
  })
})

describe('follow-up detection is strict', () => {
  it('only bare anaphoric requests inherit; concrete requests are routed on their own', () => {
    const prior = { tier: 'advanced', score: 80, failedValidation: false }
    for (const m of ['Fix it.', 'fix the failing tests', 'Try again.', 'continue', 'Please fix that']) assert.equal(extractSignals(m, { prior }).followUp, true, m)
    for (const m of ['Fix the typo in README.md.', 'Fix the login redirect', 'Do the migration of the users table']) assert.equal(extractSignals(m, { prior }).followUp, false, m)
  })
})

describe('routing isolation', () => {
  it('routing code cannot touch the filesystem, processes, the environment, workspaces, tools or credentials', async () => {
    const fs = await import('node:fs'); const path = await import('node:path')
    const dir = new URL('.', import.meta.url).pathname
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '')
      assert.doesNotMatch(src, /node:fs|node:child_process|process\.env|from '\.\.\/(tools|workspace|persistence|server|agent|providers)\//, f)
    }
  })
})
