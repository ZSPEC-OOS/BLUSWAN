import { memo } from 'react'
import { splitPath } from './format.js'

/** One changed file: letter badge (not color alone), path, +/− counts. Selecting it opens the diff. */
function ChangedFileRow({ file, selected, onSelect }) {
  const { dir, name } = splitPath(file.path)
  return (
    <li>
      <button type="button" className={`cf${selected ? ' is-selected' : ''}`} aria-current={selected ? 'true' : undefined} onClick={() => onSelect(file.path)}
        title={file.from ? `${file.from} → ${file.path}` : file.path}>
        <span className={`cf__badge cf__badge--${file.status}`} aria-hidden="true">{file.letter}</span>
        <span className="sr-only">{file.label}: </span>
        <span className="cf__path"><span className="cf__dir">{dir}</span><span className="cf__name">{name}</span></span>
        {file.preexisting ? <span className="cf__tag" title="Already changed before this session">earlier</span> : null}
        {file.binary ? <span className="cf__tag">binary</span> : (
          <span className="cf__counts">
            {file.additions != null && file.additions > 0 ? <span className="cf__add"><span className="sr-only">{file.additions} added</span><span aria-hidden="true">+{file.additions}</span></span> : null}
            {file.deletions != null && file.deletions > 0 ? <span className="cf__del"><span className="sr-only">{file.deletions} removed</span><span aria-hidden="true">−{file.deletions}</span></span> : null}
          </span>
        )}
      </button>
    </li>
  )
}
export default memo(ChangedFileRow)
