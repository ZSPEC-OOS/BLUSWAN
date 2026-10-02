// Bounded repository knowledge beyond the immediate tool results: a workspace-scoped cache of file
// facts (summary, symbols, imports, hash) and a deterministic selection of relevant files plus
// repository instruction files. Never indexes the whole repository into the prompt.
//
// Scope: this cache belongs to the *workspace* (valid across sessions while files are unchanged);
// session-specific decisions live in the session summary.
import { extractSymbols, extractImports, resolveImport, hashContent, describeFile, isExcludedFromContext } from './fileFacts.js'
import { scoreCandidates } from './relevance.js'

const caches = new WeakMap()
const INSTRUCTION_FILES = ['AGENTS.md', 'CONTRIBUTING.md']

export function getRepositoryCache(workspace) {
  let cache = caches.get(workspace)
  if (!cache) {
    cache = { files: new Map(), instructions: new Map(), manifest: null }
    caches.set(workspace, cache)
  }
  return cache
}

const signature = (st) => `${st.size}:${st.mtimeMs}`

async function currentSignature(workspace, path) {
  try { return signature(await workspace.stat(path)) } catch { return null }
}

/** Records facts about a file the agent just read (a full or partial `read_file` output). */
export async function observeFileRead(workspace, output, { maxSummaryChars = 600 } = {}) {
  const { path, content } = output
  if (typeof path !== 'string' || typeof content !== 'string' || isExcludedFromContext(path)) return null
  const cache = getRepositoryCache(workspace)
  const prev = cache.files.get(path)
  const symbols = extractSymbols(content)
  const imports = extractImports(content)
  const complete = output.startLine <= 1 && !output.truncated && output.endLine >= output.totalLines
  // A partial read never replaces a fresh whole-file entry; it only adds what it saw.
  const merged = prev && !complete
    ? { symbols: [...new Set([...prev.symbols, ...symbols])].slice(0, 12), imports: [...new Set([...prev.imports, ...imports])].slice(0, 20) }
    : { symbols, imports }
  const entry = {
    path, ...merged, hash: hashContent(content), complete: complete || !!prev?.complete,
    summary: describeFile(path, content, { ...merged, maxChars: maxSummaryChars }),
    lastReadAt: Date.now(), sig: await currentSignature(workspace, path),
  }
  cache.files.set(path, entry)
  return entry
}

/** Mutations invalidate everything derived from the affected files. */
export function invalidateFiles(workspace, paths) {
  const cache = getRepositoryCache(workspace)
  for (const p of paths) {
    cache.files.delete(p)
    cache.instructions.delete(p)
    if (p === 'package.json') cache.manifest = null
  }
}

/** Drops entries whose file changed on disk since they were recorded (e.g. edited by a shell command). */
async function dropStale(workspace, paths) {
  const cache = getRepositoryCache(workspace)
  let dropped = 0
  for (const p of paths) {
    const entry = cache.files.get(p)
    if (!entry?.sig) continue
    if ((await currentSignature(workspace, p)) !== entry.sig) { cache.files.delete(p); dropped++ }
  }
  return dropped
}

async function readInstruction(workspace, path, maxChars) {
  const cache = getRepositoryCache(workspace)
  const sig = await currentSignature(workspace, path)
  const hit = cache.instructions.get(path)
  if (hit && hit.sig === sig) return hit.text
  try {
    const { content } = await workspace.readFile(path, { maxBytes: maxChars })
    cache.instructions.set(path, { sig, text: content })
    return content
  } catch { return null }
}

const clipChars = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…` : s)

/**
 * @param {{workspace:object, summary:object|null, requests:string[], searchHits:string[], estimator:object,
 *          cfg:object, level:'full'|'minimal'|'none'}} args
 * @returns {Promise<{items:object[], relevant:object[]}>}
 */
export async function buildRepositoryItems({ workspace, summary, requests, searchHits, estimator, cfg, level }) {
  if (level === 'none') return { items: [], relevant: [] }
  const { files } = await workspace.listFiles()
  const fileSet = new Set(files)
  const cache = getRepositoryCache(workspace)
  const changed = summary?.filesChanged ?? []
  const recent = [...(summary?.filesInspected ?? [])].sort((a, b) => b.lastReadAt - a.lastReadAt).map(f => f.path)

  const rank = () => {
    const symbols = new Map()
    const imports = new Map()
    for (const [p, e] of cache.files) {
      symbols.set(p, e.symbols)
      imports.set(p, e.imports.map(spec => resolveImport(p, spec, fileSet)).filter(Boolean))
    }
    return scoreCandidates({ files, requests, changed, recent, searchHits, symbols, imports, limit: level === 'minimal' ? 3 : cfg.maxRelevantFiles })
  }
  let relevant = rank()
  if (await dropStale(workspace, relevant.map(r => r.path))) relevant = rank() // stale facts are never used

  const items = []
  let remaining = cfg.maxRepositoryContextTokens

  if (level === 'full') {
    const maxChars = Math.floor(Math.min(cfg.maxInstructionTokens, remaining) * 3.6)
    for (const name of INSTRUCTION_FILES.filter(n => fileSet.has(n))) {
      const text = await readInstruction(workspace, name, maxChars)
      if (!text) continue
      const body = `Repository instructions (${name}):\n${clipChars(text.trim(), maxChars)}`
      const tokens = estimator.estimateTokens(body)
      if (tokens > remaining) break
      items.push({ section: 'repository', type: 'repository_instructions', source: name, priority: 'medium', text: body, tokens })
      remaining -= tokens
      break // one instruction file is enough; AGENTS.md wins over CONTRIBUTING.md
    }
  }

  if (relevant.length) {
    const lines = []
    let used = estimator.estimateTokens('Likely relevant files:')
    for (const r of relevant) {
      const entry = cache.files.get(r.path)
      const detail = level === 'full' && entry ? ` — ${entry.summary.slice(0, cfg.maxFileSummaryTokens * 3)}` : ''
      const line = `- ${r.path} (${r.reasons.join('; ')})${detail}`
      const cost = estimator.estimateTokens(line)
      if (used + cost > remaining) break
      lines.push(line)
      used += cost
    }
    if (lines.length) {
      const body = `Likely relevant files:\n${lines.join('\n')}`
      items.push({ section: 'repository', type: 'repository_relevant_files', source: 'relevance', priority: 'medium', text: body, tokens: estimator.estimateTokens(body) })
    }
  }
  return { items, relevant }
}
