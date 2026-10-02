import { useState } from 'react'
import DiffHunk from './DiffHunk.jsx'

const PAGE = 800

/**
 * Renders the state of one file's diff: loading, error (retry), empty, binary, truncated, git diff hunks, or —
 * outside Git — clearly labelled current file contents. Long diffs render progressively.
 */
export default function DiffViewer({ diff, file, onRetry }) {
  const [shown, setShown] = useState(PAGE)
  if (!diff || diff.status === 'idle') return <div className="wp__empty"><p>Select a changed file to review its diff.</p></div>
  if (diff.status === 'loading') return <div className="wp__empty" role="status" aria-busy="true">Loading diff…</div>
  if (diff.status === 'error') return <div className="wp__empty" role="alert"><p>{diff.message}</p><button type="button" className="btn" onClick={onRetry}>Retry</button></div>

  if (diff.source === 'session') {
    if (diff.deleted) return <div className="wp__empty"><p>This file was deleted. No Git diff is available outside a Git repository.</p></div>
    return (
      <div className="dv">
        <p className="wp__note">Current file contents — this folder has no Git history, so a diff is not available.</p>
        <pre className="dv__raw" tabIndex={0}>{diff.contents}</pre>
        {diff.truncated ? <p className="wp__warn" role="status">Contents truncated. Open the file to see the rest.</p> : null}
      </div>
    )
  }

  const { parsed } = diff
  if (diff.empty && !parsed.files.length) return <div className="wp__empty"><p>{file?.binary ? 'Binary file changed' : 'No textual changes to show.'}</p></div>
  if (parsed.malformed) return <div className="dv"><p className="wp__note">Showing the raw diff (it could not be parsed).</p><pre className="dv__raw" tabIndex={0}>{parsed.raw}</pre></div>

  let budget = shown
  const nodes = []
  for (const f of parsed.files) {
    if (f.binary) { nodes.push(<p key={f.path} className="wp__note">Binary file changed</p>); continue }
    for (const [i, h] of f.hunks.entries()) {
      if (budget <= 0) break
      nodes.push(<DiffHunk key={`${f.path}:${i}`} hunk={h} limit={budget} />)
      budget -= h.lines.length
    }
  }
  const total = parsed.files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0)
  return (
    <div className="dv" role="region" aria-label={`Diff of ${file?.path ?? 'file'}`}>
      <div className="dv__lines">{nodes}</div>
      {total > shown ? <button type="button" className="btn dv__more" onClick={() => setShown(s => s + PAGE)}>Show {Math.min(PAGE, total - shown)} more lines</button> : null}
      {diff.truncated ? <p className="wp__warn" role="status">Diff truncated. Open the file or narrow the selection to inspect more.</p> : null}
    </div>
  )
}
