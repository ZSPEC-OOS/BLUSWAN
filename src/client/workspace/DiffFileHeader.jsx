import { splitPath } from './format.js'

/** Path, change kind, counts and the per-file actions for the open diff. */
export default function DiffFileHeader({ file, onRevert, onPrev, onNext, onClose, canRevert, multiple }) {
  const { dir, name } = splitPath(file.path)
  return (
    <div className="dfh">
      <div className="dfh__main">
        <span className={`cf__badge cf__badge--${file.status}`} aria-hidden="true">{file.letter}</span>
        <h3 className="dfh__path" title={file.path}><span className="cf__dir">{dir}</span><span className="cf__name">{name}</span></h3>
        <span className="dfh__kind">{file.label}{file.from ? ` from ${file.from}` : ''}</span>
        {file.additions != null && !file.binary ? <span className="dfh__counts"><span className="cf__add">+{file.additions}</span> <span className="cf__del">−{file.deletions}</span></span> : null}
      </div>
      <div className="dfh__actions">
        {multiple ? <>
          <button type="button" className="btn btn--ghost" onClick={onPrev} aria-label="Previous changed file">↑</button>
          <button type="button" className="btn btn--ghost" onClick={onNext} aria-label="Next changed file">↓</button>
        </> : null}
        {canRevert ? <button type="button" className="btn btn--danger" onClick={() => onRevert(file.path)}>Revert file</button> : null}
        {onClose ? <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close diff">✕</button> : null}
      </div>
    </div>
  )
}
