// Cheap, deterministic facts about source files: symbols, imports, content hash, and the
// secret/binary classification that keeps such files out of automatic context.

const SECRET_PATH = [
  /(^|\/)\.env(\.|$)/i, /(^|\/)credentials(\.|$)/i, /(^|\/)secrets?(\.|$)/i, /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /(^|\/)\.(npmrc|pypirc|netrc)$/i, /(^|\/)service-?account[^/]*\.json$/i,
]
const BINARY_EXT = /\.(png|jpe?g|gif|bmp|ico|webp|avif|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|woff2?|ttf|otf|eot|exe|dll|so|dylib|bin|class|o|a|mp[34]|mov|avi|webm|wav|ogg|psd|sqlite3?|db|lockb|wasm)$/i

export const isSecretPath = (p) => SECRET_PATH.some(re => re.test(p))
export const isBinaryPath = (p) => BINARY_EXT.test(p)
/** Files that must never be injected into context automatically. */
export const isExcludedFromContext = (p) => isSecretPath(p) || isBinaryPath(p)

/** FNV-1a 32-bit: small, dependency-free, stable (not cryptographic). */
export function hashContent(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

const SYMBOL_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/,
  /^\s*export\s+(?:type|interface|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)\s*[(:]/, // python
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, // go
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, // rust
]

export function extractSymbols(content, limit = 12) {
  const out = []
  for (const line of content.split('\n')) {
    if (line.length > 300) continue
    for (const re of SYMBOL_PATTERNS) {
      const m = re.exec(line)
      if (m) { if (!out.includes(m[1])) out.push(m[1]); break }
    }
    if (out.length >= limit) break
  }
  return out
}

/** Module specifiers imported by JS/TS-like sources (empty for other languages). */
export function extractImports(content, limit = 20) {
  const out = []
  const re = /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(content)) && out.length < limit) if (!out.includes(m[1])) out.push(m[1])
  return out
}

const RESOLVE_SUFFIXES = ['', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '/index.js', '/index.jsx', '/index.ts', '/index.tsx']

/** Resolves a relative specifier against known workspace paths; null for packages/unresolvable. */
export function resolveImport(fromPath, specifier, fileSet) {
  if (!specifier.startsWith('.')) return null
  const parts = fromPath.split('/').slice(0, -1)
  for (const seg of specifier.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  const base = parts.join('/')
  for (const suffix of RESOLVE_SUFFIXES) if (fileSet.has(base + suffix)) return base + suffix
  return null
}

/** One-line description of a file from its leading comment and symbols (bounded). */
export function describeFile(path, content, { symbols = extractSymbols(content), imports = extractImports(content), maxChars = 600 } = {}) {
  const lead = /^\s*(?:\/\/+|\/\*+|#|"""|''')\s*([^\n*]{8,120})/.exec(content.slice(0, 400))
  const parts = []
  if (lead) parts.push(lead[1].trim().replace(/\*\/\s*$/, '').trim())
  if (symbols.length) parts.push(`Defines ${symbols.slice(0, 8).join(', ')}`)
  if (imports.length) parts.push(`imports ${imports.slice(0, 6).join(', ')}`)
  return (parts.join('. ') || `${path} (${content.split('\n').length} lines)`).slice(0, maxChars)
}
