// Decides WHAT to validate from the files that changed: classification of each change, related-test
// discovery by naming convention, and the validation policy that turns it into ordered steps.
// Everything here is deterministic and explainable; there are no semantic heuristics.
import { focusedTestCommand } from './commandDiscovery.js'

const CODE_EXT = /\.(jsx?|tsx?|mjs|cjs|py|rs|go|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|vue|svelte|html)$/i
const TEST_PATH = [/(^|\/)(tests?|__tests__|spec|e2e)\//i, /\.(test|spec)\.[cm]?[jt]sx?$/i, /(^|\/)test_[^/]+\.py$/i, /_test\.(py|go)$/i]
const CONFIG_PATH = [
  /(^|\/)package\.json$/, /(^|\/)tsconfig[^/]*\.json$/, /(^|\/)(vite|vitest|jest|webpack|rollup|babel|eslint|prettier)\.config\.[cm]?[jt]s$/,
  /(^|\/)\.(eslintrc|prettierrc|babelrc)[^/]*$/, /(^|\/)(pyproject\.toml|setup\.py|setup\.cfg|Cargo\.toml|go\.mod|Makefile)$/, /(^|\/)\.github\/workflows\//,
]
const DEPENDENCY_PATH = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|go\.sum)$/
const DOC_PATH = /(\.(md|mdx|txt|rst|adoc)$)|((^|\/)(docs?|documentation)\/)|((^|\/)(LICENSE|CHANGELOG|AUTHORS)[^/]*$)/i
const STYLE_PATH = /\.(css|scss|sass|less|styl)$/i

/** @returns {'docs'|'test'|'config'|'dependency'|'style'|'source'} */
export function classifyChange(path) {
  if (DEPENDENCY_PATH.test(path)) return 'dependency'
  if (CONFIG_PATH.some(re => re.test(path))) return 'config'
  if (TEST_PATH.some(re => re.test(path)) && (CODE_EXT.test(path) || /\.(json|snap)$/.test(path))) return 'test'
  if (DOC_PATH.test(path) && !CODE_EXT.test(path)) return 'docs'
  if (STYLE_PATH.test(path)) return 'style'
  return 'source' // code, and anything unrecognized, is treated as potentially behavior-affecting
}

const baseName = (p) => p.slice(p.lastIndexOf('/') + 1)
const stem = (p) => baseName(p).replace(/\.[^.]+$/, '')

/** Test files that conventionally accompany `path` (e.g. src/auth.js → tests/auth.test.js). Deterministic order. */
export function findRelatedTests(path, fileSet, limit = 3) {
  if (classifyChange(path) === 'test') return fileSet.has(path) ? [path] : []
  const s = stem(path)
  const family = /\.py$/.test(path) ? 'py' : /\.go$/.test(path) ? 'go' : 'js' // tests are matched within the source's language
  const wanted = new Set()
  if (family === 'js') for (const ext of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']) { wanted.add(`${s}.test.${ext}`); wanted.add(`${s}.spec.${ext}`) }
  if (family === 'py') { wanted.add(`test_${s}.py`); wanted.add(`${s}_test.py`) }
  if (family === 'go') wanted.add(`${s}_test.go`)
  const dirOf = (p) => p.split('/').slice(0, -1)
  const shared = (a, b) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n }
  const here = dirOf(path)
  return [...fileSet].filter(f => wanted.has(baseName(f)) && classifyChange(f) === 'test')
    .sort((a, b) => shared(dirOf(b), here) - shared(dirOf(a), here) || (a < b ? -1 : 1)).slice(0, limit)
}

const DECLINE = [
  /\b(do not|don't|dont|never|no need to|without)\s+(run|running|execute|executing)\s+(any\s+|the\s+)?(tests?|test suite|checks?|validation|linters?|lint|builds?)\b/i,
  /\b(skip|omit|avoid)\s+(running\s+)?(the\s+)?(tests?|test suite|checks?|validation|lint|linting|builds?)\b/i,
  /\bno\s+(tests?|validation|checks)\s+(please|needed|required|should be run)\b/i,
  /\b(do not|don't|dont)\s+(validate|test)\b/i,
]
export const userDeclinesValidation = (texts) => texts.some(t => DECLINE.some(re => re.test(t ?? '')))

const skip = (code, extra = {}) => ({ shouldValidate: false, scope: null, commands: [], reason: code, ...extra })

/**
 * The validation policy: given what changed and what is available, decide what to run now.
 * @param {{project:object, byKind:object, changed:{path:string,action:string}[], fileSet:Set<string>, config:object,
 *          userInstructions?:string[], state?:object|null, roundsUsed?:number}} input
 * @returns {{shouldValidate:boolean, scope:string|null, commands:object[], reason:string, categories?:string[]}}
 */
export function planValidation({ project, byKind, changed, fileSet, config, userInstructions = [], state = null, roundsUsed = 0 }) {
  if (!config.enableAutomaticValidation) return skip('automatic_validation_disabled')
  if (userDeclinesValidation(userInstructions)) return skip('user_declined_validation')
  const live = changed.filter(c => c.action !== 'deleted' || classifyChange(c.path) !== 'docs')
  if (!live.length) return skip('no_changes')
  if (roundsUsed >= config.maxAutomaticValidationRounds) return skip('validation_round_limit_reached')

  const kinds = live.map(c => ({ ...c, category: classifyChange(c.path) }))
  const categories = [...new Set(kinds.map(k => k.category))]
  if (categories.every(c => c === 'docs')) return skip('documentation_only', { categories })

  const has = (c) => categories.includes(c)
  const sourceLike = has('source') || has('config') || has('dependency')
  const tests = kinds.filter(k => k.category === 'test').map(k => k.path)
  const sources = kinds.filter(k => k.category === 'source').map(k => k.path)
  const related = [...new Set([...tests, ...sources.flatMap(p => findRelatedTests(p, fileSet))])].sort()
  const topDirs = new Set(kinds.map(k => k.path.split('/')[0]))
  const significant = has('config') || has('dependency') || kinds.length >= 3 || topDirs.size >= 2 && sources.length >= 2

  const steps = []
  const add = (kind, command, scope, reason, relatedFiles = []) => {
    if (command && !steps.some(s => s.command === command)) steps.push({ kind, command, scope, source: byKind[kind]?.source ?? 'derived', reason, relatedFiles })
  }

  const onlyStyle = categories.every(c => c === 'style' || c === 'docs')
  if (byKind.test && !onlyStyle) {
    const focused = focusedTestCommand(project, related, byKind)
    if (focused) add('test', focused, 'focused', 'related_tests_found', related)
    else add('test', byKind.test.command, 'broad', related.length ? 'no_focused_runner_for_related_tests' : 'no_related_tests_found', related)
  }
  if (byKind.typecheck && (project.hasTypeScript || project.ecosystems.some(e => e !== 'node')) && (sourceLike || has('test'))) {
    add('typecheck', byKind.typecheck.command, 'broad', 'typed_project_source_changed')
  }
  if (byKind.lint && (sourceLike || has('style') || has('test'))) add('lint', byKind.lint.command, 'broad', 'lint_command_available')
  if (config.enableBroadValidation) {
    const focusedOnly = steps.find(s => s.kind === 'test')?.scope === 'focused'
    if (byKind.test && focusedOnly && significant) add('test', byKind.test.command, 'broad', 'significant_change_needs_full_suite')
    if (byKind.build && (sourceLike || has('style'))) add('build', byKind.build.command, 'broad', has('config') ? 'config_changed' : 'production_code_changed')
  }
  if (!steps.length) return skip('no_validation_available', { categories })

  void state
  const scope = steps.some(s => s.scope === 'broad') ? 'broad' : 'focused'
  const lead = steps[0]
  return { shouldValidate: true, scope, commands: steps, categories, reason: `${categories.join('+')}_changed_and_${lead.kind}_command_available` }
}
