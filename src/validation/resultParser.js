// Extracts compact diagnostics from tool output: robust generic parsing plus patterns for the
// common frameworks (node:test/TAP, jest/vitest, pytest, cargo, go, ESLint, TypeScript, build tools).
// This is evidence extraction, not a repair strategy, and never aims for perfect coverage.

const LOCATION = /((?:[A-Za-z]:)?[\w@./\\-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|rb|php|vue|svelte|css|scss)):(\d+)(?::(\d+))?/
// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

export const stripAnsi = (s) => s.replace(ANSI, '')
const squash = (s, n = 200) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

/** Project-relative path when the location is absolute inside `root`. */
function relPath(p, root) {
  const n = p.replace(/\\/g, '/')
  if (root && n.startsWith(root.replace(/\\/g, '/') + '/')) return n.slice(root.length + 1)
  return n.replace(/^\.\//, '')
}

function addLocation(locs, path, line, column, root) {
  const p = relPath(path, root)
  if (/node_modules|^node:/.test(p) || locs.some(l => l.path === p && l.line === Number(line))) return
  locs.push({ path: p, line: Number(line), ...(column ? { column: Number(column) } : {}) })
}

function parseTest(text, root) {
  const out = { passed: null, failed: null, total: null, keyMessages: [], locations: [], framework: null }
  const num = (re) => { const m = re.exec(text); return m ? Number(m[1]) : null }

  // node:test / TAP
  if (/^# (tests|pass|fail) \d+/m.test(text) || /^(not )?ok \d+ - /m.test(text)) {
    out.framework = 'tap'
    out.passed = num(/^# pass (\d+)/m); out.failed = num(/^# fail (\d+)/m); out.total = num(/^# tests (\d+)/m)
    const blocks = text.split(/^\s*(?=not ok \d+ - )/m).slice(1)
    for (const b of blocks.filter(x => /^not ok/.test(x))) {
      const name = /^not ok \d+ - (.*)$/m.exec(b)?.[1]
      const err = /error: ['"]?\|?-?\s*\n?\s*([^\n]+)/.exec(b)?.[1] ?? /error: (.+)/.exec(b)?.[1]
      const exp = /expected:\s*\n?\s*([^\n]+)/.exec(b)?.[1]
      const act = /actual:\s*\n?\s*([^\n]+)/.exec(b)?.[1]
      out.keyMessages.push(squash(`${name ?? 'test'}${err ? `: ${err}` : ''}${exp && act ? ` (expected ${exp}, actual ${act})` : ''}`))
      const loc = /location: '([^']+)'/.exec(b)?.[1] ?? LOCATION.exec(b)?.[0]
      const m = loc && LOCATION.exec(loc)
      if (m) addLocation(out.locations, m[1], m[2], m[3], root)
    }
  }
  // jest / vitest
  const jest = /Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(?:(\d+) passed,\s*)?(\d+) total/.exec(text)
  if (jest) { out.framework = out.framework ?? 'jest'; out.failed = Number(jest[1] ?? 0); out.passed = Number(jest[3] ?? 0); out.total = Number(jest[4]) }
  const vitest = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/.exec(text)
  if (vitest && !jest) { out.framework = 'vitest'; out.failed = Number(vitest[1] ?? 0); out.passed = Number(vitest[2]) }
  for (const m of text.matchAll(/^\s*(?:●|×|✗|FAIL)\s+(.+)$/gm)) out.keyMessages.push(squash(m[1]))
  // pytest
  const py = /=+\s*(?:(\d+) failed)?(?:,\s*)?(?:(\d+) passed)?.*\bin [\d.]+s/.exec(text)
  if (py && /pytest|FAILED|passed|failed/.test(text) && (py[1] || py[2])) { out.framework = 'pytest'; out.failed = Number(py[1] ?? 0); out.passed = Number(py[2] ?? 0) }
  for (const m of text.matchAll(/^FAILED\s+(\S+)(?: - (.+))?$/gm)) {
    out.keyMessages.push(squash(`${m[1]}${m[2] ? `: ${m[2]}` : ''}`))
    const f = /^([^:]+\.py)/.exec(m[1]); if (f) addLocation(out.locations, f[1], 1, null, root)
  }
  // cargo
  const cargo = /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/.exec(text)
  if (cargo) { out.framework = 'cargo'; out.passed = Number(cargo[1]); out.failed = Number(cargo[2]) }
  for (const m of text.matchAll(/^---- (\S+) stdout ----\n(?:.*\n)*?thread '[^']+' panicked at (.+)$/gm)) out.keyMessages.push(squash(`${m[1]} panicked at ${m[2]}`))
  // go
  for (const m of text.matchAll(/^--- FAIL: (\S+)/gm)) { out.framework = out.framework ?? 'go'; out.keyMessages.push(`FAIL ${m[1]}`) }
  if (out.framework === 'go' && out.failed === null) out.failed = out.keyMessages.length

  // assertion lines and stack locations for any framework
  for (const m of text.matchAll(/^\s*(?:AssertionError[^\n]*|Error: expected[^\n]*|E\s+assert[^\n]*|expected[^\n]+received[^\n]+)$/gim)) {
    if (out.keyMessages.length < 8) out.keyMessages.push(squash(m[0]))
  }
  for (const line of text.split('\n')) {
    if (out.locations.length >= 6) break
    const m = LOCATION.exec(line)
    if (m && /(at |\(|location:|-->|File ")/.test(line)) addLocation(out.locations, m[1], m[2], m[3], root)
  }
  out.keyMessages = [...new Set(out.keyMessages)].slice(0, 6)
  return out
}

function parseLint(text, root) {
  const out = { errors: 0, warnings: 0, keyMessages: [], locations: [] }
  const sum = /(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(text)
  if (sum) { out.errors = Number(sum[2]); out.warnings = Number(sum[3]) }
  let file = null
  for (const line of text.split('\n')) {
    if (/^\S.*\.[A-Za-z]+$/.test(line.trim()) && !/^\s/.test(line) && !/problems?/.test(line)) { file = line.trim(); continue }
    const m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/.exec(line)
    if (m && file) {
      if (m[3] === 'error' && !sum) out.errors++
      if (out.keyMessages.length < 6) out.keyMessages.push(squash(`${relPath(file, root)}:${m[1]} ${m[4]}${m[5] ? ` (${m[5]})` : ''}`))
      addLocation(out.locations, file, m[1], m[2], root)
    }
    const u = /^(\S+\.[A-Za-z]+):(\d+):(\d+):\s*(.+)$/.exec(line.trim()) // unix-style (ruff, flake8, clippy)
    if (u && out.keyMessages.length < 6) { out.keyMessages.push(squash(`${relPath(u[1], root)}:${u[2]} ${u[4]}`)); addLocation(out.locations, u[1], u[2], u[3], root); out.errors++ }
  }
  return out
}

function parseTypecheck(text, root) {
  const out = { errors: 0, keyMessages: [], locations: [] }
  for (const m of text.matchAll(/^(\S+?)(?:\((\d+),(\d+)\)|:(\d+):(\d+))(?::| -)\s*error\s+(TS\d+):\s*(.+)$/gm)) {
    out.errors++
    const line = m[2] ?? m[4]; const col = m[3] ?? m[5]
    if (out.keyMessages.length < 6) out.keyMessages.push(squash(`${relPath(m[1], root)}:${line} ${m[6]} ${m[7]}`))
    addLocation(out.locations, m[1], line, col, root)
  }
  for (const m of text.matchAll(/^(\S+\.py):(\d+): error: (.+)$/gm)) { // mypy
    out.errors++
    if (out.keyMessages.length < 6) out.keyMessages.push(squash(`${relPath(m[1], root)}:${m[2]} ${m[3]}`))
    addLocation(out.locations, m[1], m[2], null, root)
  }
  const found = /Found (\d+) errors?/.exec(text)
  if (found) out.errors = Math.max(out.errors, Number(found[1]))
  return out
}

function parseBuild(text, root) {
  const out = { errors: 0, keyMessages: [], locations: [] }
  for (const line of text.split('\n')) {
    if (out.keyMessages.length >= 6) break
    if (/(^|\s)(error|ERROR)\b|Could not resolve|failed to compile|Build failed|SyntaxError|Cannot find|Unexpected token/.test(line) && line.trim()) {
      out.errors++
      out.keyMessages.push(squash(line))
      const m = LOCATION.exec(line); if (m) addLocation(out.locations, m[1], m[2], m[3], root)
    }
  }
  if (!out.locations.length) { const m = LOCATION.exec(text); if (m) addLocation(out.locations, m[1], m[2], m[3], root) }
  return out
}

/**
 * @param {'test'|'lint'|'typecheck'|'build'|'format_check'|'custom'} kind
 * @param {string} output combined stdout + stderr
 * @param {{root?:string}} [options]
 * @returns {{keyMessages:string[], locations:{path:string,line:number,column?:number}[], counts:object}}
 */
export function parseOutput(kind, output, { root } = {}) {
  const text = stripAnsi(output ?? '')
  let parsed
  switch (kind) {
    case 'test': parsed = parseTest(text, root); break
    case 'lint': case 'format_check': parsed = parseLint(text, root); break
    case 'typecheck': parsed = parseTypecheck(text, root); break
    case 'build': parsed = parseBuild(text, root); break
    default: parsed = parseBuild(text, root)
  }
  const { keyMessages, locations, ...counts } = parsed
  return { keyMessages, locations: locations.slice(0, 6), counts }
}
