// Bounded classifier for ambiguous requests. It runs on the Fast profile with no tools, a tiny output budget and a
// strict JSON answer, under a timeout and the request's cancellation signal. Its answer is validated against a
// schema; anything else is a failure the router handles deterministically. The classifier never sees repository
// contents, never receives tools or secrets, and its text is never logged or shown.
export const CLASSIFIER_LIMITS = Object.freeze({ timeoutMs: 8000, maxOutputTokens: 120, maxInputChars: 1500, minConfidence: 0.6 })

const ROUTES = ['fast', 'advanced']
const SCOPES = ['narrow', 'moderate', 'broad']
const RISKS = ['low', 'medium', 'high']
const KEYS = ['route', 'confidence', 'scope', 'risk']

export const CLASSIFIER_SYSTEM = [
  'You route coding requests to one of two capability tiers. You do not perform the task.',
  'Answer with ONE JSON object and nothing else: {"route":"fast"|"advanced","confidence":0..1,"scope":"narrow"|"moderate"|"broad","risk":"low"|"medium"|"high"}.',
  'Choose "fast" for routine, well-scoped work. Choose "advanced" when the task needs deep multi-step reasoning, spans many components, or is risky to get wrong.',
  'Do not explain. Do not include any other text.',
].join('\n')

/** Strict validation of the classifier output. Returns the verdict or null. */
export function parseVerdict(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
  let v
  try { v = JSON.parse(trimmed) } catch { return null }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  if (Object.keys(v).some(k => !KEYS.includes(k)) || KEYS.some(k => !(k in v))) return null
  if (!ROUTES.includes(v.route) || !SCOPES.includes(v.scope) || !RISKS.includes(v.risk)) return null
  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence) || v.confidence < 0 || v.confidence > 1) return null
  return { route: v.route, confidence: v.confidence, scope: v.scope, risk: v.risk }
}

export function buildClassifierPrompt(message, signals) {
  const facts = `kind=${signals.kind}; files_mentioned=${signals.files}; broad_scope=${signals.broad}; steps=${signals.steps}; follow_up=${signals.followUp}`
  return `Request (truncated):\n${String(message).slice(0, CLASSIFIER_LIMITS.maxInputChars)}\n\nFacts: ${facts}`
}

/**
 * @param {{message:string, signals:object}} input
 * @param {{complete:(req:{system:string, prompt:string, maxOutputTokens:number, signal:AbortSignal})=>Promise<{text:string, usage?:object}>, signal?:AbortSignal, timeoutMs?:number}} deps
 * @returns {Promise<{ok:true, verdict:object, usage:object|null, durationMs:number}|{ok:false, reason:'unavailable'|'invalid'|'cancelled', usage:object|null, durationMs:number}>}
 */
export async function classify({ message, signals }, { complete, signal, timeoutMs = CLASSIFIER_LIMITS.timeoutMs, now = Date.now }) {
  const started = now()
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  if (signal?.aborted) return { ok: false, reason: 'cancelled', usage: null, durationMs: 0 }
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer
  const timedOut = new Promise(resolve => { timer = setTimeout(() => { ac.abort(); resolve('timeout') }, timeoutMs) })
  try {
    const result = await Promise.race([
      complete({ system: CLASSIFIER_SYSTEM, prompt: buildClassifierPrompt(message, signals), maxOutputTokens: CLASSIFIER_LIMITS.maxOutputTokens, signal: ac.signal }),
      timedOut,
    ])
    const durationMs = now() - started
    if (signal?.aborted) return { ok: false, reason: 'cancelled', usage: null, durationMs }
    if (result === 'timeout') return { ok: false, reason: 'unavailable', usage: null, durationMs }
    const verdict = parseVerdict(result?.text)
    return verdict ? { ok: true, verdict, usage: result.usage ?? null, durationMs } : { ok: false, reason: 'invalid', usage: result?.usage ?? null, durationMs }
  } catch {
    return { ok: false, reason: signal?.aborted ? 'cancelled' : 'unavailable', usage: null, durationMs: now() - started }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
