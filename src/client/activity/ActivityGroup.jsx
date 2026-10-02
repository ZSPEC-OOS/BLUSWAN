import { memo, useState } from 'react'
import ToolActivity from './ToolActivity.jsx'
import ValidationActivity from './ValidationActivity.jsx'
import './activity.css'

const MARK = { running: '▸', done: '✓', failed: '✕', skipped: '–' }

const Row = ({ item, defaultOpen }) => (item.tool === 'validation'
  ? <ValidationActivity item={item} defaultOpen={defaultOpen} />
  : <ToolActivity item={item} defaultOpen={defaultOpen} />)

/**
 * Consecutive actions of one kind. A lone action renders as its own row; several collapse into a summary
 * ("Read 4 files") that expands to the individual rows.
 */
function ActivityGroup({ group, defaultExpanded = false }) {
  const [open, setOpen] = useState(defaultExpanded)
  if (group.items.length === 1) return <div className="act-group"><Row item={group.items[0]} defaultOpen={defaultExpanded} /></div>
  return (
    <div className={`act-group act-group--${group.status}`}>
      <button type="button" className="act__head act-group__head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <span className={`act__mark act__mark--${group.status}`} aria-hidden="true">{MARK[group.status]}</span>
        <span className="sr-only">{group.status === 'running' ? 'In progress' : group.status === 'failed' ? 'Failed' : 'Done'}: </span>
        <span className="act__label">{group.header}</span>
        <span className="act__chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open ? <div className="act-group__items">{group.items.map(item => <Row key={item.id} item={item} defaultOpen={false} />)}</div> : null}
    </div>
  )
}
export default memo(ActivityGroup)
