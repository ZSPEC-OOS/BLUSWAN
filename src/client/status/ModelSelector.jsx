import { modelGroups } from '../models/modelSelection.js'

/** Provider + model for the conversation (applies to its next run). Unusable models are shown but disabled, with the reason. */
export default function ModelSelector({ models, current, disabled = false, onChange }) {
  const groups = modelGroups(models, current)
  const value = current?.model ? `${current.provider}:${current.model}` : ''
  if (!groups.length) return null
  return (
    <label className="model-select">
      <span className="sr-only">Model</span>
      <select value={value} disabled={disabled} aria-label="Model" title={disabled ? 'Stop BLUSWAN to change the model' : 'Model for the next request'}
        onChange={(e) => { const o = groups.flatMap(g => g.options).find(x => x.value === e.target.value); if (o) onChange({ provider: o.provider, model: o.model }) }}>
        {!value ? <option value="">Choose a model</option> : null}
        {groups.map(g => (
          <optgroup key={g.provider} label={g.label}>
            {g.options.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  )
}
