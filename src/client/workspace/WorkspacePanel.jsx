import ChangedFilesPanel from './ChangedFilesPanel.jsx'
import DiffViewer from './DiffViewer.jsx'
import DiffFileHeader from './DiffFileHeader.jsx'
import { CommandDetails, CommandsList } from './CommandDetails.jsx'
import { ValidationDetails, ValidationSummary } from './ValidationDetails.jsx'
import WorkspaceTabs from './WorkspaceTabs.jsx'
import RevertFileDialog from './RevertFileDialog.jsx'
import './workspace.css'

/**
 * The review workspace. On desktop list and detail show together; on mobile (`stacked`) detail replaces the
 * list until the user goes back. Rendering only: every action is a callback into the client store.
 */
export default function WorkspacePanel({ review, actions, stacked = false, onCollapse }) {
  const { ui, repository } = review
  const tab = ui.tab
  const showDetail = !stacked || ui.detail
  const showList = !stacked || !ui.detail
  const counts = { changes: review.changedFiles.length, validation: review.validation.rows.length, commands: review.commands.reduce((n, g) => n + g.commands.length, 0) }

  const file = review.selectedFile
  const valRow = review.validation.rows.find(r => r.id === ui.selectedValidationId) ?? null
  const cmd = ui.selectedCommandId ? actions.getCommand(ui.selectedCommandId) : null
  const changedPaths = review.changedFiles.map(f => f.path)
  const revertTarget = ui.revert ? review.changedFiles.find(f => f.path === ui.revert.path) : null

  return (
    <div className="wp">
      <header className="wp__head">
        <div className="wp__repo" title={repository?.name ?? ''}>
          <strong>{repository?.name ?? 'No repository'}</strong>
          {repository?.branch ? <span className="topbar__branch">⎇ {repository.branch}</span> : null}
        </div>
        {onCollapse ? <button type="button" className="btn btn--ghost" onClick={onCollapse} aria-label="Collapse workspace panel">⟩</button> : null}
      </header>
      <WorkspaceTabs tab={tab} onSelect={actions.selectTab} counts={counts} />
      <div className="wp__body" id="wpanel-body" role="tabpanel" aria-labelledby={`wtab-${tab}`}>
        {tab === 'changes' ? (
          <>
            {showList ? <ChangedFilesPanel review={review} selectedPath={ui.selectedPath} onSelect={(p) => actions.selectFile(p, { openPanel: false })} onRetry={actions.refresh} /> : null}
            {showDetail && file ? (
              <div className="wp__detail">
                {stacked ? <button type="button" className="btn btn--ghost cmd__back" onClick={actions.closeDetail}>‹ Changed files</button> : null}
                <DiffFileHeader file={file} multiple={review.changedFiles.length > 1} canRevert={review.gitBacked && file.status !== 'conflicted'} onRevert={actions.requestRevert}
                  onPrev={() => actions.stepFile(-1)} onNext={() => actions.stepFile(1)} onClose={stacked ? undefined : actions.clearSelection} />
                <DiffViewer diff={review.diff} file={file} onRetry={() => actions.selectFile(file.path, { openPanel: false })} />
              </div>
            ) : null}
          </>
        ) : null}
        {tab === 'validation' ? (
          stacked && ui.detail && valRow
            ? <ValidationDetails row={valRow} changedPaths={changedPaths} onBack={actions.closeDetail} onOpenFile={(p) => actions.selectFile(p, { openPanel: false })} onOpenOutput={(id) => actions.openCommand(id)} />
            : <>
              <ValidationSummary validation={review.validation} selectedId={ui.selectedValidationId} onSelect={actions.openValidation} />
              {!stacked && valRow ? <ValidationDetails row={valRow} changedPaths={changedPaths} onOpenFile={(p) => actions.selectFile(p, { openPanel: false })} onOpenOutput={(id) => actions.openCommand(id)} /> : null}
            </>
        ) : null}
        {tab === 'commands' ? (
          stacked && ui.detail && ui.selectedCommandId
            ? <CommandDetails command={cmd} onBack={actions.closeDetail} />
            : <>
              <CommandsList groups={review.commands} selectedId={ui.selectedCommandId} onSelect={actions.openCommand} />
              {!stacked && ui.selectedCommandId ? <CommandDetails command={cmd} /> : null}
            </>
        ) : null}
      </div>
      {ui.revert ? <RevertFileDialog revert={ui.revert} isNewFile={!!revertTarget?.untracked || revertTarget?.status === 'added'} onConfirm={actions.confirmRevert} onCancel={actions.cancelRevert} /> : null}
    </div>
  )
}
