import ChangedFileRow from './ChangedFileRow.jsx'
import { plural } from './format.js'

/** Summary line + list of changed files. Counts come from git where available. */
export default function ChangedFilesPanel({ review, selectedPath, onSelect, onRetry }) {
  const { changedFiles, diffSummary, gitBacked, loaded, loadError, loading } = review
  if (loadError && !loaded) {
    return <div className="wp__empty" role="alert"><p>{loadError.message}</p><button type="button" className="btn" onClick={onRetry}>Retry</button></div>
  }
  if (!loaded && loading) return <div className="wp__empty" role="status">Loading changes…</div>
  if (!changedFiles.length) return <div className="wp__empty"><p>No workspace changes</p></div>
  return (
    <div className="cfp">
      <div className="cfp__summary" aria-live="polite">
        <strong>{plural(diffSummary.files, 'file')} changed</strong>
        {diffSummary.additions != null ? <span className="cf__add">+{diffSummary.additions}</span> : null}
        {diffSummary.deletions != null ? <span className="cf__del">−{diffSummary.deletions}</span> : null}
        <span className="cfp__source" title={gitBacked ? 'Read from git' : 'No git repository: files this session changed'}>{gitBacked ? 'Git' : 'Session-tracked'}</span>
      </div>
      {!gitBacked ? <p className="wp__note">This folder is not a Git repository. Showing files changed in this session; diffs and revert need Git.</p> : null}
      <ul className="cfp__list" aria-label="Changed files">
        {changedFiles.map(f => <ChangedFileRow key={f.path} file={f} selected={f.path === selectedPath} onSelect={onSelect} />)}
      </ul>
    </div>
  )
}
