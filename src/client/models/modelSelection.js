// Which model new conversations use, and what the selector offers. Display and choice only — provider protocols
// live in src/providers; the server is the authority on what is configured and capable.
import { providerLabel } from '../../providers/labels.js'

const usable = (m) => m.configured && m.codingCapable

/** The user's saved choice if it is still usable, else the server's default. */
export function pickModel({ settings, models, defaultModel }) {
  const chosen = settings?.provider && settings?.model ? models.find(m => m.provider === settings.provider && m.id === settings.model) : null
  if (chosen && usable(chosen)) return { provider: chosen.provider, model: chosen.id }
  return defaultModel?.model ? { provider: defaultModel.provider, model: defaultModel.model } : { provider: '', model: '' }
}

/** Options grouped by provider, each with a plain-language state. Models that cannot act as the coding agent are disabled. */
export function modelGroups(models, current = null) {
  const groups = new Map()
  for (const m of models) {
    if (!groups.has(m.provider)) groups.set(m.provider, { provider: m.provider, label: providerLabel(m.provider), options: [] })
    const notes = [m.capabilities?.reasoning ? 'reasoning' : null].filter(Boolean)
    const unavailable = !m.configured ? 'not configured' : !m.codingCapable ? 'no tool support' : null
    groups.get(m.provider).options.push({
      value: `${m.provider}:${m.id}`, provider: m.provider, model: m.id, disabled: !!unavailable,
      label: `${m.displayName}${notes.length ? ` · ${notes.join(', ')}` : ''}${unavailable ? ` — ${unavailable}` : ''}`,
    })
  }
  // keep an unlisted current model visible so the control never shows a blank selection
  if (current?.model && !models.some(m => m.provider === current.provider && m.id === current.model)) {
    const g = groups.get(current.provider) ?? { provider: current.provider, label: providerLabel(current.provider), options: [] }
    g.options.unshift({ value: `${current.provider}:${current.model}`, provider: current.provider, model: current.model, disabled: false, label: current.model })
    groups.set(current.provider, g)
  }
  return [...groups.values()]
}
