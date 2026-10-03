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

const TIER_NAME = { fast: 'Flash', advanced: 'Pro' }
const MODE_NAME = { auto: 'Auto', fast: 'Flash', advanced: 'Pro' }
export const modeName = (mode) => MODE_NAME[mode] ?? 'Model'

/** Per-run indicator text: "Auto · Flash", "Auto · Pro", "Flash", "Pro". Escalation is shown as a separate note. */
export function routeLabel(mode, tier) {
  return mode === 'auto' ? `Auto · ${TIER_NAME[tier] ?? 'Model'}` : (TIER_NAME[tier] ?? MODE_NAME[mode] ?? 'Model')
}

const MODE_COPY = {
  auto: { title: 'Auto', hint: 'Recommended. BLUSWAN chooses Flash or Pro for each request.' },
  fast: { title: 'Flash', hint: 'Fast and economical. Always uses Flash.' },
  advanced: { title: 'Pro', hint: 'Deeper reasoning for hard work. Always uses Pro.' },
}

/** The Auto / Flash / Pro choices the server says it can run (all three are listed so a missing one can explain itself). */
export function modeOptions(routing) {
  if (!routing?.modes?.length) return []
  return routing.modes.map(m => ({ id: m.id, title: MODE_COPY[m.id]?.title ?? m.label, hint: m.available ? MODE_COPY[m.id]?.hint : 'Not available on this server.', recommended: m.id === 'auto', available: !!m.available }))
}
