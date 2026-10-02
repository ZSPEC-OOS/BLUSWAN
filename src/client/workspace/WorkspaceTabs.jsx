const LABEL = { changes: 'Changes', validation: 'Validation', commands: 'Commands' }

/** Three tabs only. Arrow keys move between them. */
export default function WorkspaceTabs({ tab, onSelect, counts = {} }) {
  const tabs = Object.keys(LABEL)
  const onKeyDown = (e) => {
    const i = tabs.indexOf(tab)
    if (e.key === 'ArrowRight') { e.preventDefault(); onSelect(tabs[(i + 1) % tabs.length]) }
    if (e.key === 'ArrowLeft') { e.preventDefault(); onSelect(tabs[(i + tabs.length - 1) % tabs.length]) }
  }
  return (
    <div className="wtabs" role="tablist" aria-label="Workspace sections" onKeyDown={onKeyDown}>
      {tabs.map(t => (
        <button key={t} type="button" role="tab" id={`wtab-${t}`} aria-selected={t === tab} aria-controls="wpanel-body" tabIndex={t === tab ? 0 : -1}
          className={`wtabs__tab${t === tab ? ' is-active' : ''}`} onClick={() => onSelect(t)}>
          {LABEL[t]}{counts[t] ? <span className="wtabs__count">{counts[t]}</span> : null}
        </button>
      ))}
    </div>
  )
}
