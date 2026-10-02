// Scrubbing for anything GitHub-related that may reach logs, errors, events or responses.
import { redactSecrets } from '../../utils/redact.js'

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted-private-key]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/g, '[redacted-token]'],
  [/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[redacted]@'], // credentials embedded in a URL
  [/(authorization\s*[:=]\s*)(?:basic|bearer|token)?\s*[A-Za-z0-9+/=._-]{8,}/gi, '$1[redacted]'],
  [/(extraheader\s*[=:]\s*)\S.*$/gim, '$1[redacted]'],
  [/\bx-access-token:[^\s@]+/gi, 'x-access-token:[redacted]'],
]

export function redactGithub(text) {
  let out = String(text ?? '')
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  return redactSecrets(out)
}
