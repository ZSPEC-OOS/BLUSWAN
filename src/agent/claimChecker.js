// Narrow, deterministic check of explicit validation claims in a final answer against recorded
// evidence. No model call; it only produces warnings and never rewrites the response.
import { isCurrent } from '../validation/validationState.js'

const CLAIMS = [
  { kind: 'test', label: 'tests pass', re: /\b(all\s+)?(the\s+|unit\s+|relevant\s+|targeted\s+)?tests?\s+(are\s+|now\s+|all\s+)*(pass(?:ed|es|ing)?|succeed(?:ed|s)?|green)\b/i },
  { kind: 'build', label: 'build succeeds', re: /\bbuild\s+(now\s+)?(pass(?:ed|es)?|succeed(?:ed|s)?|is\s+(?:successful|green)|completes?)\b/i },
  { kind: 'lint', label: 'lint is clean', re: /\blint(?:ing|er)?\s+(is\s+|now\s+|checks?\s+)*(clean|pass(?:ed|es)?)\b|\bno\s+lint\s+(errors|issues)\b/i },
  { kind: 'typecheck', label: 'type check passes', re: /\btype[\s-]?check(?:s|ing)?\s+(is\s+|now\s+)*(clean|pass(?:ed|es)?|succeed(?:ed|s)?)\b|\bno\s+type\s+errors\b/i },
]
const NEGATION = /\b(not|n't|never|unable|could\s*n[o']t|didn't|did not|haven't|have not|without|no\s+tests\s+were)\b/i

/** @returns {{kind:string, claim:string, problem:string}[]} */
export function checkClaims(text, state) {
  const warnings = []
  for (const sentence of String(text ?? '').split(/(?<=[.!?\n])\s+/)) {
    for (const c of CLAIMS) {
      if (!c.re.test(sentence) || NEGATION.test(sentence.slice(0, sentence.search(c.re)))) continue
      const passed = state?.results.some(r => r.kind === c.kind && r.status === 'passed' && r.seq === state.mutationSeq)
      const failing = state?.unresolved.some(u => u.kind === c.kind)
      if (failing) warnings.push({ kind: c.kind, claim: c.label, problem: 'a recorded check of this kind is still failing' })
      else if (!passed) warnings.push({ kind: c.kind, claim: c.label, problem: isCurrent(state) && state?.results.some(r => r.kind === c.kind) ? 'no passing result for the current code' : 'no such check ran after the latest changes' })
    }
  }
  const seen = new Set()
  return warnings.filter(w => !seen.has(w.kind) && seen.add(w.kind))
}
