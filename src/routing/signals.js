// Deterministic request signals. Pure functions over the user's message and bounded session facts. Signals describe
// WHAT is being asked (request kind, scope, risk areas, ambiguity, runtime evidence); no single word decides a route,
// and message length is never treated as complexity.

const FILE_REF = /\b[\w./@-]+\.(?:jsx?|tsx?|mjs|cjs|py|go|rs|java|rb|php|cs|c|cpp|h|json|ya?ml|toml|md|css|scss|html|sql|sh)\b/gi
const BROAD_SCOPE = /\b(across|throughout|entire|whole|everywhere|repo[- ]?wide|codebase|every (?:file|module|component|route|usage|caller|service)|all (?:the )?(?:files|modules|components|routes|usages|callers|services|call sites|tests))\b/i
const STEP_MARKERS = /(?:^|\n)\s*(?:\d+[.)]|[-*])\s+\S/g
const SEQUENCE = /\b(?:then|after that|afterwards|finally|first|second|third|next)\b/gi

const QUESTION = /^\s*(?:what|where|which|who|when|how|why|can you (?:explain|show|tell)|could you (?:explain|show|tell)|explain|describe|show me|list|summari[sz]e|tell me|is there|does|do )/i
const TRIVIAL = /\b(typo|spelling|rename (?:the )?(?:variable|function|file|constant)|add (?:a )?comment|fix (?:the )?(?:indent|whitespace|formatting|lint)|bump (?:the )?version|update (?:the )?(?:readme|copyright|changelog)|change (?:the )?(?:label|text|title|color|colour|copy)|reword)\b/i
const CHANGE = /\b(add|implement|build|create|write|change|modify|update|migrate|rewrite|refactor|redesign|restructure|replace|remove|delete|fix|debug|repair|port|convert|extract|introduce|wire|integrate|support)\b/i
const DEBUG = /\b(bug|broken|crash(?:es|ing)?|regression|failing|fails?|failure|stack ?trace|exception|intermittent(?:ly)?|flaky|hangs?|deadlock|race condition|doesn'?t work|not working|wrong|unexpected|error)\b/i
const ROOT_CAUSE = /\b(root cause|why (?:does|is|are|did)|intermittent(?:ly)?|only (?:sometimes|in production)|sometimes|can'?t reproduce|inconsistent)\b/i
const REFACTOR = /\b(refactor|restructure|re-?architect|redesign|rewrite|reorgani[sz]e|split up|decouple|modulari[sz]e)\b/i
const ARCHITECTURE = /\b(architecture|module boundar(?:y|ies)|layering|design (?:the|a) (?:system|schema|api)|state machine|data model)\b/i
const SECURITY = /\b(auth(?:entication|orization|orisation)?|oauth|oidc|sso|csrf|xss|sql injection|crypto(?:graphy)?|encryption|permissions?|access control|rbac|jwt|session (?:fixation|handling|management)|secrets?|credentials?|token (?:refresh|rotation|validation)|sanitiz\w+|vulnerab\w+)\b/i
const PERSISTENCE = /\b(schema|database|firestore|postgres|mysql|sqlite|persist(?:ence|ed)?|data model|backfill|serializ\w+)\b/i
const CONCURRENCY = /\b(race condition|concurren\w+|deadlock|mutex|lock(?:ing)?|parallel|async(?:hronous)?|reconnect\w*|ordering|idempotent|retry logic|debounce|stale state|state sync\w*|re-?entran\w+)\b/i
const ANAPHORA = /^\s*(?:please\s+)?(?:(?:fix|do|try|continue|retry|redo|finish|apply|proceed|go ahead|keep going|resolve)(?:\s+(?:it|that|this|them|those|these|again|the (?:rest|issue|problem|error|failure|failing tests?|remaining (?:issues|failures|errors))))?(?:\s+(?:now|again|please))?|yes|ok(?:ay)?|sure|same|go on|do it|do that)\s*[.!]?\s*$/i
const VAGUE = /\b(improve|make (?:it )?better|clean ?up|optimi[sz]e|something|somehow|anything|stuff|things|polish|enhance|handle (?:it|this|that)|take a look|have a look)\b/i

const count = (text, re) => (text.match(re) ?? []).length

/**
 * @param {string} message
 * @param {{prior?:{tier?:string, score?:number, kind?:string, failedValidation?:boolean}|null, changedFiles?:number, unresolvedFailures?:number, hasWorkspace?:boolean}} [context]
 */
export function extractSignals(message, context = {}) {
  const text = String(message ?? '').slice(0, 4000)
  const files = new Set((text.match(FILE_REF) ?? []).map(f => f.toLowerCase())).size
  const broad = BROAD_SCOPE.test(text)
  const steps = Math.max(count(text, STEP_MARKERS), count(text, SEQUENCE) + 1 > 3 ? count(text, SEQUENCE) + 1 : 0)
  const wantsChange = CHANGE.test(text)
  const question = QUESTION.test(text) && !/\b(and|then)\s+(?:fix|implement|change|add|update|refactor)\b/i.test(text)
  const trivial = TRIVIAL.test(text)
  const debug = DEBUG.test(text) && wantsChange
  const traces = /\n\s+at\s+\S+.*\(.*:\d+:\d+\)|Traceback \(most recent call last\)|^\s*(?:Error|TypeError|ReferenceError):/m.test(text)
  const domains = {
    security: SECURITY.test(text), persistence: PERSISTENCE.test(text), concurrency: CONCURRENCY.test(text),
    architecture: ARCHITECTURE.test(text) || REFACTOR.test(text),
  }
  const migration = domains.persistence && /\bmigrat(?:e|ion|ions|ing)\b/i.test(text)
  const followUp = ANAPHORA.test(text) && text.length < 60 && !!context.prior
  const hasTarget = files > 0 || /`[^`]+`/.test(text) || /\b[a-z]+[A-Z]\w+\b|\b\w+_\w+\b/.test(text) || text.length > 140
  const ambiguous = !followUp && !question && !trivial && (VAGUE.test(text) || (!hasTarget && wantsChange && !broad))

  const kind = followUp ? 'follow_up'
    : question ? 'question'
      : trivial ? 'trivial_edit'
        : debug ? 'debug'
          : REFACTOR.test(text) ? 'refactor'
            : wantsChange ? 'change' : 'unknown'

  return {
    kind, files, broad, steps, wantsChange, question, trivial, debug, rootCause: ROOT_CAUSE.test(text) || traces,
    traces, domains, migration, followUp, ambiguous,
    scope: broad ? 'broad' : files >= 3 ? 'multi_file' : files >= 1 ? 'narrow' : 'unknown',
    // runtime evidence (bounded facts, never content)
    prior: context.prior ?? null,
    changedFiles: Math.max(0, context.changedFiles ?? 0),
    unresolvedFailures: Math.max(0, context.unresolvedFailures ?? 0),
  }
}
