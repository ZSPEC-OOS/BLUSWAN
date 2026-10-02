import { useEffect } from 'react'
import { useGithub } from './GithubContext.js'
import { stageLabel } from './githubStore.js'

/** An action button that is disabled, with the reason as its title, while something else holds the repository. */
function Btn({ children, onClick, primary, off, lock }) {
  return <button type="button" className={`btn ${primary ? 'btn--primary' : ''}`} onClick={onClick} disabled={off} title={lock ?? undefined}>{children}</button>
}

const Chip = ({ children, label, tone = '' }) => <span className={`gh-chip-status ${tone ? `gh-chip-status--${tone}` : ''}`} aria-label={label ?? String(children)}>{children}</span>

/** Safe external link: only https URLs on github hosts that came from GitHub metadata. */
const safeUrl = (u) => (typeof u === 'string' && /^https:\/\/[A-Za-z0-9.-]+\//.test(u) ? u : null)

export default function WorkflowBar({ busy = false, offline = false, onReviewDiff }) {
  const { store, snapshot } = useGithub()
  useEffect(() => { store?.refreshGit?.() }, [store])
  if (!store || !snapshot) return null
  const { git, op } = snapshot
  const data = git.data
  if (!data) return git.error ? <section className="wf" aria-label="Repository workflow"><p className="wf__msg" role="alert">{git.error.message} <button type="button" className="btn btn--ghost" onClick={store.refreshGit}>Retry</button></p></section> : null
  const s = data.state; const pr = data.task?.pullRequest; const stage = data.stage
  const running = op?.status === 'running'
  const lock = busy ? 'Stop the current task first.' : offline ? 'You are offline.' : running ? `${op.name.replace(/-/g, ' ')} in progress…` : null
  const off = !!lock
  const gh = data.github
  const url = safeUrl(pr?.url)
  const dirtyN = s.files.length
  const btn = { off, lock }
  const checks = pr?.checks?.status
  return (
    <section className="wf" aria-label="Repository workflow">
      <div className="wf__row">
        <div className="wf__repo">
          {gh ? <strong className="wf__name">{gh.owner}/{gh.repo}</strong> : <strong className="wf__name">Local repository</strong>}
          <span className="wf__branch" aria-label={`Branch ${s.detached ? 'detached HEAD' : s.branch}`}>⎇ {s.detached ? 'detached HEAD' : s.branch}</span>
        </div>
        <div className="wf__chips">
          {gh ? <Chip label={data.pushed ? 'Branch pushed to GitHub' : 'Local only, not pushed'}>{data.pushed ? 'PUSHED' : 'LOCAL'}</Chip> : null}
          {pr ? <Chip label={`Pull request ${pr.state}`} tone={pr.state === 'merged' ? 'ok' : ''}>{pr.state === 'merged' ? 'MERGED' : pr.state === 'closed' ? 'PR CLOSED' : pr.state === 'draft' ? 'PR DRAFT' : 'PR OPEN'}</Chip> : null}
          {checks === 'passed' ? <Chip label="Checks passing" tone="ok">CHECKS PASSING</Chip> : checks === 'failed' ? <Chip label="Checks failing" tone="bad">CHECKS FAILING</Chip> : checks === 'running' ? <Chip label="Checks running">CHECKS RUNNING</Chip> : null}
          <Chip label={dirtyN ? `${dirtyN} uncommitted changes` : 'Working tree clean'} tone={dirtyN ? 'warn' : ''}>{dirtyN ? 'DIRTY' : 'CLEAN'}</Chip>
          {s.upstream ? <span className="wf__ab" aria-label={`${s.ahead} commits ahead, ${s.behind} behind`}>↑{s.ahead} ↓{s.behind}</span> : null}
        </div>
        <div className="wf__tools">
          <button type="button" className="btn" onClick={() => store.openDialog('branch')} disabled={off} title={lock ?? undefined}>Branches</button>
          {gh ? <button type="button" className="btn" onClick={store.actions.sync} disabled={off} title={lock ?? undefined}>Sync</button> : null}
        </div>
      </div>
      {dirtyN ? <p className="wf__counts" aria-label="Git status">{dirtyN} changed file{dirtyN === 1 ? '' : 's'} · {s.staged} staged · {s.unstaged} unstaged · {s.untracked} untracked</p> : null}
      <div className="wf__cta">
        <p className="wf__msg" role="status">{message(stage, s, pr, gh)}</p>
        <div className="wf__actions">
          {stage === 'ready_for_task' ? <Btn {...btn} primary onClick={() => store.openDialog('branch', { mode: 'create' })}>Create Task Branch</Btn> : null}
          {stage === 'has_changes' ? <><button type="button" className="btn" onClick={onReviewDiff}>Review Diff</button><Btn {...btn} primary onClick={() => { store.openDialog('commit'); store.prepareCommit() }}>Commit Changes</Btn></> : null}
          {stage === 'ready_to_push' ? <Btn {...btn} primary onClick={() => store.openDialog('push')}>Push Branch</Btn> : null}
          {stage === 'ready_for_pr' ? <Btn {...btn} primary onClick={() => { store.openDialog('pr'); store.preparePr() }}>Create Pull Request</Btn> : null}
          {stage === 'waiting_for_merge' ? <>{url ? <a className="btn" href={url} target="_blank" rel="noopener noreferrer">Open Pull Request</a> : null}<Btn {...btn} onClick={store.refreshPr}>Refresh Status</Btn></> : null}
          {stage === 'merged' ? <><Btn {...btn} primary onClick={() => store.openDialog('cleanup')}>Sync Main &amp; Clean Up</Btn>{url ? <a className="btn" href={url} target="_blank" rel="noopener noreferrer">Open on GitHub</a> : null}</> : null}
          {stage === 'closed_unmerged' ? <>{url ? <a className="btn" href={url} target="_blank" rel="noopener noreferrer">Reopen on GitHub</a> : null}<Btn {...btn} onClick={() => { store.openDialog('pr'); store.preparePr() }}>Create New PR</Btn><Btn {...btn} onClick={() => store.openDialog('abandon')}>Abandon Task</Btn></> : null}
          {stage === 'detached' && gh ? <Btn {...btn} primary onClick={() => store.actions.switchBranch(gh.defaultBranch)}>Switch to {gh.defaultBranch}</Btn> : null}
          {stage === 'working' || stage === 'has_changes' || stage === 'ready_to_push' || stage === 'ready_for_pr' ? <Btn {...btn} onClick={() => store.openDialog('abandon')}>Abandon Task</Btn> : null}
        </div>
      </div>
      {op ? (
        <div className={`wf__op wf__op--${op.status}`} role="status" aria-live="polite">
          <strong>{op.name.replace(/-/g, ' ')}</strong>{' '}
          {op.status === 'running' ? `${op.steps.at(-1)?.step ?? 'Working'}…` : op.status === 'done' ? 'done' : `failed: ${op.error?.message ?? ''}`}
          {op.status === 'running' ? <button type="button" className="btn btn--ghost" onClick={store.cancelOperation}>Cancel</button> : null}
        </div>
      ) : null}
    </section>
  )
}

function message(stage, s, pr, gh) {
  switch (stage) {
    case 'ready_for_task': return `Ready to start a new task on ${s.branch}.`
    case 'protected_dirty': return `${s.branch} is the default branch and has changes. BLUSWAN will not commit to it — move these changes to a task branch from a terminal, or discard them.`
    case 'working': return 'Continue task on this branch.'
    case 'has_changes': return 'You have uncommitted changes. Review the diff, then commit.'
    case 'ready_to_push': return 'Committed locally. These commits are not on GitHub yet.'
    case 'ready_for_pr': return 'Pushed. Ready for review.'
    case 'waiting_for_merge': return `Pull Request #${pr?.number} is ${pr?.state}. Waiting for merge — review and merge it on GitHub.`
    case 'merged': return `Merged. Your changes are now on ${gh?.defaultBranch ?? 'the default branch'}.`
    case 'closed_unmerged': return `Pull Request #${pr?.number} was CLOSED WITHOUT MERGE.`
    case 'conflicts': return `Repository sync needs attention. ${s.conflicts} file${s.conflicts === 1 ? ' has' : 's have'} conflicts — resolve them in Git.`
    case 'detached': return 'The repository is on a detached HEAD. Switch to a branch to continue.'
    case 'remote_mismatch': return 'Repository remote does not match the connected GitHub repository. GitHub actions are disabled.'
    default: return stageLabel(stage)
  }
}
