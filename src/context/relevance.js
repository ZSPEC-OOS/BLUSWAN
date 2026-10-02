// Deterministic, explainable file relevance. No embeddings: path/name matches against the user's
// requests, recency of access, changed status, search hits, symbol names and import proximity.
import { isExcludedFromContext } from './fileFacts.js'

const STOPWORDS = new Set(('the and for with that this from into when then than have has not are was were will would should could can you your ' +
  'please make sure also now fix add update change create remove use using file files code test tests function bug issue it its our out all any ' +
  'does did just need want like run new old get set src lib jsx tsx mjs cjs json index').split(/\s+/))

/** Lower-cased search terms from free text; splits camelCase, snake_case, kebab-case and paths. */
export function extractKeywords(...texts) {
  const out = new Set()
  for (const text of texts) {
    for (const raw of String(text ?? '').split(/[^A-Za-z0-9_./-]+/)) {
      for (const piece of raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_./-]+/)) {
        const w = piece.toLowerCase()
        if (w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) out.add(w)
      }
    }
  }
  return out
}

/** Explicit path or file-name mentions inside the request (e.g. "src/auth.js", "auth.js"). */
export function extractPathMentions(text) {
  return [...new Set(String(text ?? '').match(/[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,6}\b/g) ?? [])]
}

const W = { changed: 10, mention: 12, recentBase: 6, search: 5, term: 3, termCap: 9, symbol: 4, symbolCap: 8, importProximity: 3 }

/**
 * @param {{files:string[], requests:string[], changed:{path:string,action:string}[], recent:string[],
 *          searchHits:string[], symbols?:Map<string,string[]>, imports?:Map<string,string[]>, limit?:number}} input
 *   `recent` is ordered newest first; `imports` maps a path to the workspace paths it imports.
 * @returns {{path:string, score:number, reasons:string[]}[]} highest score first, ties by path
 */
export function scoreCandidates({ files, requests, changed = [], recent = [], searchHits = [], symbols = new Map(), imports = new Map(), limit = 8 }) {
  const keywords = extractKeywords(...requests)
  const mentions = requests.flatMap(extractPathMentions).map(m => m.toLowerCase())
  const changedSet = new Set(changed.filter(c => c.action !== 'deleted').map(c => c.path))
  const recentRank = new Map(recent.map((p, i) => [p, i]))
  const hitSet = new Set(searchHits)
  const importedByChanged = new Set()
  const importsChanged = new Set()
  for (const [from, targets] of imports) {
    for (const t of targets) {
      if (changedSet.has(from)) importedByChanged.add(t)
      if (changedSet.has(t)) importsChanged.add(from)
    }
  }

  const candidates = new Set([...changedSet, ...recent, ...searchHits])
  for (const f of files.slice(0, 20_000)) candidates.add(f)

  const scored = []
  for (const path of candidates) {
    if (isExcludedFromContext(path)) continue
    const lower = path.toLowerCase()
    const reasons = []
    let score = 0
    if (changedSet.has(path)) { score += W.changed; reasons.push('recently changed') }
    if (recentRank.has(path)) { score += Math.max(2, W.recentBase - recentRank.get(path)); reasons.push('recently read') }
    if (hitSet.has(path)) { score += W.search; reasons.push('search result') }
    const mentioned = mentions.some(m => lower === m || lower.endsWith(`/${m}`))
    if (mentioned) { score += W.mention; reasons.push('named in request') }
    const segs = new Set(extractKeywords(path))
    const matched = [...keywords].filter(k => segs.has(k))
    if (matched.length && !mentioned) { score += Math.min(W.termCap, W.term * matched.length); reasons.push(`path matches request terms (${matched.slice(0, 3).join(', ')})`) }
    const syms = (symbols.get(path) ?? []).filter(sym => extractKeywords(sym).size && [...extractKeywords(sym)].some(k => keywords.has(k)))
    if (syms.length) { score += Math.min(W.symbolCap, W.symbol * syms.length); reasons.push(`symbol match (${syms.slice(0, 2).join(', ')})`) }
    if (importedByChanged.has(path)) { score += W.importProximity; reasons.push('imported by a changed file') }
    else if (importsChanged.has(path)) { score += W.importProximity; reasons.push('imports a changed file') }
    if (score > 0) scored.push({ path, score, reasons })
  }
  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return scored.slice(0, limit)
}
