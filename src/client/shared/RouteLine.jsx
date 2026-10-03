/** A quiet per-run indicator of which capability tier answers: "Auto · Flash", "Auto · Pro", "Flash", "Pro". */
export default function RouteLine({ entry }) {
  return (
    <div className="routeline" data-testid="route-indicator" data-tier={entry.tier} data-escalated={entry.escalated ? 'true' : 'false'}>
      <span className="routeline__label">{entry.label}</span>
      {entry.escalated ? <span className="routeline__note"> · Escalated for deeper reasoning</span> : null}
    </div>
  )
}
