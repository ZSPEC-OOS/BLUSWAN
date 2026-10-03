import { modeOptions } from '../models/modelSelection.js'

/** Radio-style Auto / Flash / Pro choice for the Settings drawer. Auto is labelled as the recommended default. */
export default function ModelModePicker({ routing, mode, disabled = false, onChange }) {
  const options = modeOptions(routing)
  if (!options.length) return null
  return (
    <div className="mode-picker" role="radiogroup" aria-label="Model mode">
      {options.map(o => (
        <label key={o.id} className={`mode-picker__opt${mode === o.id ? ' is-selected' : ''}${o.available ? '' : ' is-disabled'}`}>
          <input type="radio" name="model-mode" value={o.id} checked={mode === o.id} disabled={disabled || !o.available} onChange={() => onChange(o.id)} />
          <span className="mode-picker__text">
            <span className="mode-picker__title">{o.title}{o.recommended ? <span className="mode-picker__badge"> · Recommended</span> : null}</span>
            <span className="mode-picker__hint">{o.hint}</span>
          </span>
        </label>
      ))}
    </div>
  )
}
