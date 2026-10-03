import { modelGroups, modeOptions } from '../models/modelSelection.js'

/**
 * Model for the conversation (applies to its next run). With server routing the first group offers Auto (recommended),
 * Flash and Pro; the provider groups below stay available for choosing a specific model. Unusable choices are shown
 * but disabled, with the reason.
 */
export default function ModelSelector({ models, current, disabled = false, onChange, routing = null, mode = null, onModeChange = null }) {
  const groups = modelGroups(models, current)
  const modes = onModeChange ? modeOptions(routing) : []
  const value = mode && modes.length ? `mode:${mode}` : current?.model ? `${current.provider}:${current.model}` : ''
  if (!groups.length && !modes.length) return null
  return (
    <label className="model-select">
      <span className="sr-only">Model</span>
      <select value={value} disabled={disabled} aria-label="Model" title={disabled ? 'Stop BLUSWAN to change the model' : 'Model for the next request'}
        onChange={(e) => {
          if (e.target.value.startsWith('mode:')) { onModeChange?.(e.target.value.slice(5)); return }
          const o = groups.flatMap(g => g.options).find(x => x.value === e.target.value)
          if (o) onChange({ provider: o.provider, model: o.model })
        }}>
        {!value ? <option value="">Choose a model</option> : null}
        {modes.length ? (
          <optgroup label="Automatic">
            {modes.map(o => <option key={o.id} value={`mode:${o.id}`} disabled={!o.available}>{o.title}{o.recommended ? ' (recommended)' : ''}{o.available ? '' : ' — unavailable'}</option>)}
          </optgroup>
        ) : null}
        {groups.map(g => (
          <optgroup key={g.provider} label={g.label}>
            {g.options.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  )
}
