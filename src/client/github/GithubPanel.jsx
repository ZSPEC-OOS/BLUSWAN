import { useEffect, useState } from 'react'
import MobileSheet from '../shared/MobileSheet.jsx'
import ErrorNotice from '../shared/ErrorNotice.jsx'
import { useGithub } from './GithubContext.js'
import './github.css'

const ago = (iso) => { if (!iso) return ''; const d = Math.max(0, Date.now() - Date.parse(iso)); const days = Math.floor(d / 86_400_000); return days < 1 ? 'updated today' : days < 60 ? `updated ${days}d ago` : `updated ${Math.floor(days / 30)}mo ago` }

function Progress({ op }) {
  if (!op) return null
  return (
    <div className="gh-progress" role="status" aria-live="polite" aria-label={`${op.name} progress`}>
      <ol className="gh-steps">
        {op.steps.map(st => <li key={st.step} className={`gh-step gh-step--${st.status}`}><span className="gh-step__mark" aria-hidden="true">{st.status === 'done' ? '✓' : st.status === 'failed' ? '✕' : '…'}</span><span>{st.step}</span><span className="sr-only"> — {st.status}</span></li>)}
      </ol>
    </div>
  )
}

function Connection({ snapshot, store, onOpenLocal }) {
  const st = snapshot.status
  if (st.phase === 'loading') return <p className="gh-muted" role="status">Loading GitHub…</p>
  if (st.phase === 'error') return <ErrorNotice tone="error" text={st.error.message} action={<button type="button" className="btn" onClick={store.loadStatus}>Retry</button>} />
  if (!st.configured) {
    return (
      <div className="gh-card" role="status">
        <h3 className="gh-h">GitHub integration is unavailable</h3>
        <p className="gh-muted">This BLUSWAN server has not been set up for GitHub, so repositories cannot be browsed here. Local repositories still work.</p>
        <button type="button" className="btn" onClick={onOpenLocal}>Open Local Repository</button>
      </div>
    )
  }
  if (!st.connected) {
    return (
      <div className="gh-card">
        <h3 className="gh-h">GitHub</h3>
        <p className="gh-muted">Connect your GitHub account to open repositories, create branches, push changes, and create pull requests.</p>
        <div className="gh-actions"><button type="button" className="btn btn--primary" onClick={store.startConnect}>Connect GitHub</button><button type="button" className="btn" onClick={onOpenLocal}>Open Local Repository</button></div>
      </div>
    )
  }
  return (
    <div className="gh-card gh-card--row">
      <div><h3 className="gh-h">GitHub connected</h3><p className="gh-muted">Account: <strong>{st.login ?? 'unknown'}</strong> · Repositories available: <strong>{snapshot.repos.total}</strong></p></div>
      <div className="gh-actions"><button type="button" className="btn btn--ghost" onClick={store.disconnect}>Disconnect</button></div>
    </div>
  )
}

function RepoList({ snapshot, store }) {
  const r = snapshot.repos
  const [q, setQ] = useState(r.query)
  return (
    <section aria-label="Repositories">
      <div className="gh-filters">
        <input type="search" className="gh-input" aria-label="Search repositories" placeholder="Search repositories" value={q} onChange={(e) => { setQ(e.target.value); store.search({ query: e.target.value }) }} />
        <select className="gh-input" aria-label="Filter by owner" value={r.owner} onChange={(e) => store.search({ owner: e.target.value })}><option value="">All owners</option>{r.owners.map(o => <option key={o} value={o}>{o}</option>)}</select>
        <select className="gh-input" aria-label="Filter by visibility" value={r.visibility} onChange={(e) => store.search({ visibility: e.target.value })}><option value="">Private and public</option><option value="private">Private</option><option value="public">Public</option></select>
        <button type="button" className="btn" onClick={store.refreshRepos} disabled={r.loading}>Refresh</button>
      </div>
      {r.error ? <ErrorNotice tone="error" text={r.error.message} action={<><button type="button" className="btn" onClick={() => store.refreshRepos()}>Retry</button>{r.error.code === 'github_auth_expired' || r.error.code === 'github_permission_denied' ? <button type="button" className="btn" onClick={store.startConnect}>Reconnect GitHub</button> : null}</>} /> : null}
      {!r.error && !r.loading && !r.items.length ? <p className="gh-muted" role="status">{r.query || r.owner || r.visibility ? 'No repositories match.' : 'No repositories found. Check your GitHub installation permissions.'}</p> : null}
      <ul className="gh-repos" aria-busy={r.loading}>
        {r.items.map(it => (
          <li key={it.fullName}>
            <button type="button" className="gh-repo" onClick={() => store.selectRepo(it.owner, it.repo)}>
              <span className="gh-repo__name">{it.owner} / <strong>{it.repo}</strong></span>
              <span className="gh-repo__meta"><span className="gh-badge">{it.private ? 'Private' : 'Public'}</span><span>Default: {it.defaultBranch}</span><span>{ago(it.updatedAt)}</span><span className={`gh-badge ${it.cloned ? 'gh-badge--ok' : ''}`}>{it.cloned ? 'Available locally' : 'Not cloned'}</span></span>
            </button>
          </li>
        ))}
      </ul>
      {r.loading ? <p className="gh-muted" role="status">Loading repositories…</p> : null}
      {r.nextPage && !r.loading ? <button type="button" className="btn" onClick={store.loadMore}>Load more</button> : null}
    </section>
  )
}

function RepoDetail({ snapshot, store }) {
  const d = snapshot.repo; const op = snapshot.op
  if (!d) return null
  if (d.loading) return <p className="gh-muted" role="status">Loading repository…</p>
  const info = d.info
  return (
    <section className="gh-detail" aria-label="Repository">
      {d.error ? <ErrorNotice tone="error" text={d.error.message} action={<><button type="button" className="btn" onClick={() => (info ? store.cloneOrOpen(d.local?.cloned ? 'open' : 'clone') : store.selectRepo(d.owner, d.repo))}>Retry</button><button type="button" className="btn" onClick={store.backToList}>Back to repositories</button></>} /> : null}
      {info ? (
        <>
          <h3 className="gh-h">{info.owner} / {info.repo}</h3>
          <p className="gh-muted"><span className="gh-badge">{info.private ? 'Private' : 'Public'}</span> Default branch: <strong>{info.defaultBranch}</strong></p>
          <div className="gh-actions">
            {d.local?.cloned
              ? <button type="button" className="btn btn--primary" disabled={d.working} onClick={() => store.cloneOrOpen('open')}>Open</button>
              : <button type="button" className="btn btn--primary" disabled={d.working} onClick={() => store.cloneOrOpen('clone')}>Clone &amp; Open</button>}
            {d.working && op?.status === 'running' ? <button type="button" className="btn" onClick={store.cancelOperation}>Cancel</button> : null}
          </div>
          {d.working || (op && op.status !== 'running' && op.name === 'clone') ? <Progress op={op} /> : null}
        </>
      ) : null}
    </section>
  )
}

/** Connection, repository browser and repository actions — one panel, a bottom sheet on phones. */
export default function GithubPanel({ onOpenLocal }) {
  const { store, snapshot } = useGithub()
  useEffect(() => { if (store && snapshot?.panel && snapshot.status.phase === 'loading') store.loadStatus() }, [store, snapshot?.panel, snapshot?.status.phase])
  if (!store || !snapshot?.panel) return null
  const view = snapshot.panel.view
  const connected = snapshot.status.phase === 'ready' && snapshot.status.connected
  return (
    <MobileSheet title="Repositories" variant="dialog" onClose={store.closePanel} onBack={view === 'repo' ? store.backToList : undefined} backLabel="Repositories">
      <div className="gh-body">
        {snapshot.notice ? <div role="status" className={`gh-notice gh-notice--${snapshot.notice.kind}`}>{snapshot.notice.text} <button type="button" className="btn btn--ghost" onClick={store.dismissNotice}>Dismiss</button></div> : null}
        {view === 'repo' ? <RepoDetail snapshot={snapshot} store={store} /> : (
          <>
            <Connection snapshot={snapshot} store={store} onOpenLocal={() => { store.closePanel(); onOpenLocal?.() }} />
            {connected && snapshot.recent.length ? (
              <section aria-label="Recent repositories"><h3 className="gh-h">Recent repositories</h3>
                <ul className="gh-recent">{snapshot.recent.map(r => <li key={r.fullName}><button type="button" className="gh-chip" onClick={() => store.openRecent(r.owner, r.repo)}>{r.repo}<span className="sr-only"> ({r.owner})</span></button></li>)}</ul>
              </section>
            ) : null}
            {connected ? <RepoList snapshot={snapshot} store={store} /> : null}
          </>
        )}
      </div>
    </MobileSheet>
  )
}
