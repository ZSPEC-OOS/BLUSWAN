import SessionListItem from './SessionListItem.jsx'

export default function SessionList({ sessions, activeId, onSelect, onDelete }) {
  if (!sessions.length) return <p className="sessions__empty">No conversations yet.</p>
  return (
    <ul className="sessions__list" aria-label="Conversations">
      {sessions.map(item => <SessionListItem key={item.id} item={item} active={item.id === activeId} onSelect={onSelect} onDelete={onDelete} />)}
    </ul>
  )
}
