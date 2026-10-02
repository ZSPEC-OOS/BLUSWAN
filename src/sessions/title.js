// Deterministic session titles from the first user request (no model call).

const LEAD = /^(?:(?:hey|hi|hello)[,!]?\s+)?(?:bluswan[,:]?\s+)?(?:please\s+|pls\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?|^(?:please|pls)\s+|^i\s+(?:need|want|would like)\s+(?:you\s+)?to\s+|^let'?s\s+/i

/** "Can you fix the login refresh race? It breaks on slow networks." → "Fix the login refresh race" */
export function deriveTitle(firstMessage, max = 48) {
  const text = String(firstMessage ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return 'New chat'
  let t = text.replace(LEAD, '')
  t = t.split(/(?<=[.!?])\s+/)[0].replace(/[.!?:;,\s]+$/, '')
  if (!t) return 'New chat'
  t = t[0].toUpperCase() + t.slice(1)
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, '')}…`
}
