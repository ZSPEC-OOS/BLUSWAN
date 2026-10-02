import { useEffect, useState } from 'react'
import MobileSheet from '../shared/MobileSheet.jsx'
import ErrorNotice from '../shared/ErrorNotice.jsx'
import { useGithub } from './GithubContext.js'
import './github.css'

const slug = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')

function Footer({ children }) { return <div className="gh-footer">{children}</div> }
function Err({ error, onRetry }) { return error ? <ErrorNotice tone="error" text={error.message} action={onRetry ? <button type="button" className="btn" onClick={onRetry}>Retry</button> : null} /> : null }

function BranchDialog({ store, snap, d }) {
  const [tab, setTab] = useState(d.mode === 'create' ? 'create' : 'switch')
  const [task, setTask] = useState(''); const [name, setName] = useState(''); const [edited, setEdited] = useState(false)
  const [filter, setFilter] = useState('')
  const [commits, setCommits] = useState(null)
  useEffect(() => { store.loadCommits().then(setCommits) }, [store])
  const suggested = `bluswan/${slug(task) || 'task'}`
  const branches = snap.branches?.branches ?? []
  const shown = branches.filter(b => b.name.toLowerCase().includes(filter.toLowerCase()))
  const def = snap.git.data?.github?.defaultBranch
  return (
    <>
      <div role="tablist" aria-label="Branch actions" className="gh-tabs">
        {[['create', 'Create task branch'], ['switch', 'Switch branch']].map(([k, label]) => <button key={k} role="tab" type="button" aria-selected={tab === k} className={`gh-tab ${tab === k ? 'is-active' : ''}`} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === 'create' ? (
        <form onSubmit={(e) => { e.preventDefault(); store.actions.createBranch({ task, ...(edited ? { name } : {}) }) }}>
          <p className="gh-muted">BLUSWAN updates {def ?? 'the default branch'} from GitHub, then branches from it.</p>
          <label className="gh-label" htmlFor="gh-task">What is the task?</label>
          <input id="gh-task" className="gh-input" data-autofocus value={task} onChange={(e) => setTask(e.target.value)} placeholder="Fix login redirect" />
          <label className="gh-label" htmlFor="gh-branch">Branch name</label>
          <input id="gh-branch" className="gh-input gh-mono" value={edited ? name : suggested} onChange={(e) => { setEdited(true); setName(e.target.value) }} />
          <Err error={snap.dialogError} />
          <Footer><button type="button" className="btn" onClick={store.closeDialog}>Cancel</button><button type="submit" className="btn btn--primary" disabled={snap.dialogBusy}>{snap.dialogBusy ? 'Creating…' : 'Create Branch'}</button></Footer>
        </form>
      ) : (
        <div>
          <div className="gh-filters"><input type="search" className="gh-input" aria-label="Filter branches" placeholder="Filter branches" value={filter} onChange={(e) => setFilter(e.target.value)} /><button type="button" className="btn" onClick={store.loadBranches}>Refresh branches</button></div>
          <ul className="gh-branches">
            {shown.map(b => (
              <li key={`${b.scope}:${b.name}`} className="gh-branch">
                <span className="gh-mono">{b.name}</span>
                <span className="gh-repo__meta">{b.current ? <span className="gh-badge gh-badge--ok">Current</span> : null}<span className="gh-badge">{b.scope === 'local' ? 'Local' : 'Remote'}</span>{b.isDefault ? <span className="gh-badge">Default</span> : null}{b.merged ? <span className="gh-badge">Merged</span> : null}</span>
                <button type="button" className="btn" disabled={b.current || snap.dialogBusy} onClick={() => store.actions.switchBranch(b.name)} aria-label={`Switch to ${b.name}`}>Switch</button>
              </li>
            ))}
            {!shown.length ? <li className="gh-muted">No branches match.</li> : null}
          </ul>
          <Err error={snap.dialogError} />
          <details className="gh-details" onToggle={(e) => e.target.open && store.loadCommits().then(setCommits)}><summary>Recent commits</summary>
            <ul className="gh-commits">{(commits ?? []).map(c => <li key={c.sha}><code>{c.short}</code> {c.subject} <span className="gh-muted">— {c.author}, {new Date(c.at).toLocaleDateString()}</span></li>)}{commits && !commits.length ? <li className="gh-muted">No commits.</li> : null}</ul>
          </details>
          <Footer><button type="button" className="btn" onClick={store.closeDialog}>Close</button></Footer>
        </div>
      )}
    </>
  )
}

function CommitDialog({ store, snap, d }) {
  const files = d.files ?? snap.git.data?.state.files ?? []
  const [off, setOff] = useState(() => new Set(files.filter(f => f.sensitive).map(f => f.path)))
  const [message, setMessage] = useState(null)
  const text = message ?? d.message ?? ''
  const selected = files.filter(f => !off.has(f.path) && !f.sensitive)
  return (
    <form onSubmit={(e) => { e.preventDefault(); store.actions.commit({ message: text, paths: selected.map(f => f.path) }) }}>
      <p className="gh-muted">A commit saves your changes to the repository&apos;s Git history on the runtime. It is <strong>not on GitHub</strong> until you push.</p>
      <fieldset className="gh-files"><legend>Changes ({selected.length} of {files.length} selected)</legend>
        {files.map(f => (
          <label key={f.path} className="gh-file"><input type="checkbox" checked={!off.has(f.path) && !f.sensitive} disabled={f.sensitive} onChange={(e) => setOff(prev => { const n = new Set(prev); if (e.target.checked) n.delete(f.path); else n.add(f.path); return n })} />
            <span className="gh-mono">{f.path}</span>{f.sensitive ? <span className="gh-badge gh-badge--warn">Sensitive — will not be committed</span> : null}</label>
        ))}
      </fieldset>
      <label className="gh-label" htmlFor="gh-msg">Commit message</label>
      <textarea id="gh-msg" className="gh-input gh-mono" rows={3} data-autofocus value={text} onChange={(e) => setMessage(e.target.value)} />
      <Err error={snap.dialogError} />
      <Footer><button type="button" className="btn" onClick={store.closeDialog}>Cancel</button><button type="submit" className="btn btn--primary" disabled={snap.dialogBusy || !text.trim() || !selected.length}>{snap.dialogBusy ? 'Committing…' : 'Commit Changes'}</button></Footer>
    </form>
  )
}

function PushDialog({ store, snap }) {
  const b = snap.git.data?.state.branch
  return (
    <div>
      <p>Push <code className="gh-mono">{b}</code> to GitHub?</p>
      <p className="gh-muted">This sends your commits to GitHub (<code>git push -u origin {b}</code>). BLUSWAN never force-pushes. Pushing is separate from committing.</p>
      <Err error={snap.dialogError} />
      <Footer><button type="button" className="btn" onClick={store.closeDialog}>Cancel</button><button type="button" className="btn btn--primary" disabled={snap.dialogBusy} onClick={store.actions.push}>{snap.dialogBusy ? 'Pushing…' : 'Push Branch'}</button></Footer>
    </div>
  )
}

function PrDialog({ store, snap, d }) {
  const draft = d.draft
  const [title, setTitle] = useState(null); const [body, setBody] = useState(null); const [base, setBase] = useState(null); const [asDraft, setAsDraft] = useState(false)
  if (!draft) return <p className="gh-muted" role="status">Preparing pull request…{snap.dialogError ? <Err error={snap.dialogError} /> : null}</p>
  const val = draft.validation
  return (
    <form onSubmit={(e) => { e.preventDefault(); store.actions.createPullRequest({ title: title ?? draft.title, body: body ?? draft.body, base: base ?? draft.base, draft: asDraft }) }}>
      <p className="gh-muted"><code className="gh-mono">{draft.head}</code> → <code className="gh-mono">{base ?? draft.base}</code></p>
      <section aria-label="Validation" className={`gh-validation gh-validation--${val.status}`}><strong>Validation</strong><ul>{val.lines.map((l, i) => <li key={i}>{l}</li>)}</ul></section>
      <label className="gh-label" htmlFor="gh-base">Base branch</label>
      <input id="gh-base" className="gh-input gh-mono" value={base ?? draft.base} onChange={(e) => setBase(e.target.value)} />
      <label className="gh-label" htmlFor="gh-title">Title</label>
      <input id="gh-title" className="gh-input" data-autofocus value={title ?? draft.title} onChange={(e) => setTitle(e.target.value)} />
      <label className="gh-label" htmlFor="gh-body">Description</label>
      <textarea id="gh-body" className="gh-input gh-mono" rows={8} value={body ?? draft.body} onChange={(e) => setBody(e.target.value)} />
      <label className="gh-check"><input type="checkbox" checked={asDraft} onChange={(e) => setAsDraft(e.target.checked)} /> Create as draft</label>
      <Err error={snap.dialogError} />
      <Footer><button type="button" className="btn" onClick={store.closeDialog}>Cancel</button><button type="submit" className="btn btn--primary" disabled={snap.dialogBusy || !(title ?? draft.title).trim()}>{snap.dialogBusy ? 'Creating…' : 'Create Pull Request'}</button></Footer>
    </form>
  )
}

function CleanupDialog({ store, snap, d }) {
  const data = snap.git.data; const branch = data?.state.branch; const def = data?.github?.defaultBranch ?? 'main'
  const task = data?.task; const result = d.result
  const c = d.confirm
  if (result?.done) {
    return (
      <div role="status">
        <h3 className="gh-h">Repository synced</h3>
        <p><strong>{result.defaultBranch}</strong> · clean{result.notes?.length ? ` · ${result.notes.join(' ')}` : ''}</p>
        <Footer><button type="button" className="btn btn--primary" onClick={() => { store.closeDialog(); store.openDialog('branch', { mode: 'create' }) }}>Start New Task</button><button type="button" className="btn" onClick={store.closeDialog}>Close</button></Footer>
      </div>
    )
  }
  const run = async (extra = {}) => { const r = await store.actions.cleanup({ branch: task?.taskBranch ?? branch, ...extra }); if (r?.done) store.setDialogField({ result: r }) }
  if (c?.needsConfirmation === 'force_delete') {
    return (
      <div role="alertdialog" aria-label="Confirm deleting the local branch">
        <p>{c.message}</p>
        <p>This will run <code>git branch -D {c.branch}</code> on the local copy only. The merged commit stays in {def}.</p>
        <Footer><button type="button" className="btn" onClick={store.clearConfirm}>Cancel</button><button type="button" className="btn btn--danger" disabled={snap.dialogBusy} onClick={() => run({ confirmForceDelete: true })}>Delete Local Branch</button></Footer>
      </div>
    )
  }
  const op = snap.op
  return (
    <div>
      <h3 className="gh-h">Clean up completed task?</h3>
      <p>This will:</p>
      <ul className="gh-list">
        <li>switch to <strong>{def}</strong></li><li>pull latest changes</li>
        <li>delete local branch <code className="gh-mono">{task?.taskBranch ?? branch}</code></li>
        <li>delete the remote branch if it still exists</li>
      </ul>
      <p className="gh-muted">Your merged commit will remain in {def}. Your conversation stays in history.</p>
      {snap.dialogBusy && op?.name === 'cleanup' ? <ol className="gh-steps" role="status">{op.steps.map(s => <li key={s.step} className={`gh-step gh-step--${s.status}`}><span aria-hidden="true">{s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : '…'}</span> {s.step}</li>)}</ol> : null}
      <Err error={snap.dialogError} />
      <Footer><button type="button" className="btn" onClick={store.closeDialog}>Cancel</button><button type="button" className="btn btn--primary" disabled={snap.dialogBusy} onClick={() => run()}>{snap.dialogBusy ? 'Cleaning up…' : 'Sync & Clean Up'}</button></Footer>
    </div>
  )
}

function AbandonDialog({ store, snap, d }) {
  const data = snap.git.data; const branch = data?.state.branch; const c = d.confirm
  return (
    <div role="alertdialog" aria-label="Abandon task">
      <h3 className="gh-h">Abandon this task?</h3>
      <p>This switches back to the default branch and deletes the local branch <code className="gh-mono">{branch}</code>. It does not touch GitHub unless you also choose to.</p>
      {c ? <p className="gh-warn" role="alert">{c.message} ({(c.risks ?? []).join('; ')})</p> : null}
      <Err error={snap.dialogError} />
      <Footer><button type="button" className="btn" onClick={store.closeDialog}>Keep Task</button>
        <button type="button" className="btn btn--danger" disabled={snap.dialogBusy} onClick={() => store.actions.abandon({ confirm: !!c })}>{c ? 'Abandon Anyway' : 'Abandon Task'}</button></Footer>
    </div>
  )
}

const TITLES = { branch: 'Branches', commit: 'Commit changes', push: 'Push branch', pr: 'Create pull request', cleanup: 'Sync main & clean up', abandon: 'Abandon task' }

export default function GithubDialogs() {
  const { store, snapshot } = useGithub()
  const d = snapshot?.dialog
  if (!store || !d) return null
  const Body = { branch: BranchDialog, commit: CommitDialog, push: PushDialog, pr: PrDialog, cleanup: CleanupDialog, abandon: AbandonDialog }[d.kind]
  if (!Body) return null
  return (
    <MobileSheet title={TITLES[d.kind]} variant="dialog" onClose={store.closeDialog}>
      <div className="gh-body"><Body store={store} snap={snapshot} d={d} /></div>
    </MobileSheet>
  )
}
