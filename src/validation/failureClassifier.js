// Classifies WHAT KIND of failure a validation command produced (never how to fix it).
import { parseOutput, stripAnsi } from './resultParser.js'

export const FAILURE_CATEGORIES = Object.freeze([
  'test_failure', 'lint_failure', 'type_error', 'build_failure', 'dependency_missing', 'command_not_found',
  'configuration_error', 'timeout', 'runtime_crash', 'environment_error', 'unknown',
])

const NOT_FOUND = /(command not found|is not recognized as an internal or external command|\bnot found\b.*\bsh:|sh: \d+: [\w./-]+: not found|ENOENT.*spawn|No such file or directory.*\b(npm|node|python|cargo|go)\b)/i
const MISSING_SCRIPT = /(missing script:|npm err! missing script|no such script|error: script .* not found)/i
const MODULE_NOT_FOUND = [
  /Cannot find (?:module|package) '([^']+)'/, /Error \[ERR_MODULE_NOT_FOUND\][^\n]*'([^']+)'/, /ModuleNotFoundError: No module named '([^']+)'/,
  /ImportError: No module named '?([^'\s]+)/, /unresolved import `([^`]+)`/, /Failed to resolve import "([^"]+)"/, /Could not resolve "([^"]+)"/,
]
const CONFIG = /(invalid configuration|configuration error|ERR_INVALID_PACKAGE_CONFIG|error TS5\d{3}|Unexpected token .* in JSON|failed to load config|ESLint couldn't find|cannot read config|no (?:test )?(?:files|tests) found, exiting)/i
const ENV = /(EACCES|EADDRINUSE|ENOSPC|EMFILE|permission denied|ECONNREFUSED|ETIMEDOUT|getaddrinfo|out of memory|ENOMEM)/i
const CRASH = /(segmentation fault|core dumped|fatal error|unhandled (?:promise )?rejection|uncaught exception|panicked at|terminated by signal|RangeError: Maximum call stack)/i

/** A bare package name (not a relative path) is an installation problem; relative paths are code problems. */
function missingDependency(text) {
  for (const re of MODULE_NOT_FOUND) {
    const m = re.exec(text)
    if (m && !m[1].startsWith('.') && !m[1].startsWith('/') && !/^[A-Za-z]:/.test(m[1])) return m[1]
  }
  return null
}

const summaries = {
  test_failure: (c) => (c.failed ? `${c.failed} test${c.failed === 1 ? '' : 's'} failed${c.passed != null ? `, ${c.passed} passed` : ''}` : 'tests failed'),
  lint_failure: (c) => `${c.errors || 'some'} lint error${c.errors === 1 ? '' : 's'}${c.warnings ? `, ${c.warnings} warnings` : ''}`,
  type_error: (c) => `${c.errors || 'some'} type error${c.errors === 1 ? '' : 's'}`,
  build_failure: () => 'build failed',
}

/**
 * @param {{kind:string, exitCode:number|null, timedOut?:boolean, cancelled?:boolean, stdout?:string, stderr?:string,
 *          root?:string, spawnError?:string}} input
 * @returns {{category:string, summary:string, locations:object[], keyMessages:string[], counts:object, detail?:string}}
 */
export function classifyFailure({ kind, exitCode, timedOut = false, stdout = '', stderr = '', root, spawnError }) {
  const text = stripAnsi(`${stdout}\n${stderr}`)
  const done = (category, summary, extra = {}) => ({ category, summary, locations: [], keyMessages: [], counts: {}, ...extra })

  if (timedOut) return done('timeout', 'the command exceeded its time limit')
  if (spawnError || exitCode === 127 || NOT_FOUND.test(text)) return done('command_not_found', 'a required command or tool is not installed', { keyMessages: [firstLine(text, NOT_FOUND) ?? spawnError ?? ''].filter(Boolean) })
  if (MISSING_SCRIPT.test(text)) return done('configuration_error', 'the project does not define this script', { keyMessages: [firstLine(text, MISSING_SCRIPT)] })
  const dep = missingDependency(text)
  if (dep) return done('dependency_missing', `missing dependency: ${dep}`, { detail: dep, keyMessages: [firstLine(text, /Cannot find|No module|unresolved import|Failed to resolve|Could not resolve/)] })

  const parsed = parseOutput(kind, text, { root })
  const failedTests = kind === 'test' && ((parsed.counts.failed ?? 0) > 0 || /^not ok /m.test(text) || /\bFAIL\b|✗|● /.test(text))
  const typeErrors = /error TS\d{4}:/.test(text) || (kind === 'typecheck' && parsed.counts.errors > 0)
  if (CONFIG.test(text) && !failedTests) return done('configuration_error', 'the tool configuration is invalid or incomplete', { keyMessages: [firstLine(text, CONFIG)] })
  if (typeErrors) return done('type_error', summaries.type_error(parsed.counts), parsed)
  if (failedTests) return done('test_failure', summaries.test_failure(parsed.counts), parsed)
  if (CRASH.test(text)) return done('runtime_crash', 'the process crashed', { keyMessages: [firstLine(text, CRASH)], locations: parsed.locations })
  if (ENV.test(text)) return done('environment_error', 'the environment prevented the command from running', { keyMessages: [firstLine(text, ENV)] })
  if (kind === 'lint' || kind === 'format_check') return done('lint_failure', summaries.lint_failure(parsed.counts), parsed)
  if (kind === 'build') return done('build_failure', summaries.build_failure(), parsed)
  if (kind === 'test') return done('test_failure', exitCode != null ? `the test command exited with ${exitCode}` : 'the test command failed', parsed)
  if (kind === 'typecheck') return done('type_error', 'the type check failed', parsed)
  return done('unknown', exitCode != null ? `the command exited with ${exitCode}` : 'the command failed', parsed)
}

function firstLine(text, re) {
  const line = text.split('\n').find(l => re.test(l))
  return line ? line.trim().slice(0, 200) : undefined
}
