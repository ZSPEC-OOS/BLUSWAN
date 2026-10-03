// Stable, safe reason codes for routing decisions. Codes (not prose derived from the user's text or any model
// reasoning) are what events, logs and the UI carry; labels are static strings.
export const REASONS = Object.freeze({
  // sources
  manual_fast: 'You selected Flash.',
  manual_advanced: 'You selected Pro.',
  // deterministic
  routine_request: 'Routine, narrowly scoped request.',
  question_only: 'Question or explanation; no code change requested.',
  small_change: 'Small, well-scoped change.',
  broad_scope: 'The request spans many files or the whole repository.',
  multi_step: 'The request has several dependent steps.',
  safety_critical: 'Safety-critical area combined with a structural change.',
  persistence_change: 'Changes to persisted data or schema.',
  concurrency_state: 'Concurrency or state-management problem.',
  root_cause_debugging: 'Root-cause debugging across components.',
  repo_wide_refactor: 'Repository-wide refactor or redesign.',
  follow_up_inherited: 'Follow-up request inheriting the previous task.',
  prior_failures: 'Earlier attempts at this task failed validation.',
  // classifier / fallbacks
  classifier_fast: 'Ambiguous request; classified as suitable for Flash.',
  classifier_advanced: 'Ambiguous request; classified as needing deeper reasoning.',
  classifier_low_confidence: 'Ambiguous request; classifier was not confident, so Pro was used.',
  classifier_unavailable: 'Classifier did not answer in time; deterministic policy applied.',
  classifier_invalid: 'Classifier answer was not usable; deterministic policy applied.',
  default_advanced: 'Request remained ambiguous; defaulted to Pro.',
  // escalation
  repeated_validation_failure: 'Repeated validation failures after repair attempts.',
  recovery_no_progress: 'Recovery rounds made insufficient progress.',
  scope_expanded: 'The task grew well beyond its initial scope.',
  repeated_tool_failures: 'Consecutive turns made no progress.',
})

export const reasonLabel = (code) => REASONS[code] ?? 'Routing decision.'
export const isReasonCode = (code) => Object.hasOwn(REASONS, code)
