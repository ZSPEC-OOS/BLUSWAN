// Secret scrubbing for anything that may reach events, logs, or session history.

const SECRET_ASSIGN = /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Za-z0-9_]*)=\S+/gi
const SECRET_FLAG = /(--?(?:token|password|passwd|secret|api-key|apikey)[= ])\S+/gi
const BEARER = /(Bearer\s+)\S+/gi
const API_KEY_LIKE = /\bsk-[A-Za-z0-9_-]{8,}/g

export function redactSecrets(text) {
  return String(text)
    .replace(SECRET_ASSIGN, '$1=[redacted]')
    .replace(SECRET_FLAG, '$1[redacted]')
    .replace(BEARER, '$1[redacted]')
    .replace(API_KEY_LIKE, '[redacted]')
}
