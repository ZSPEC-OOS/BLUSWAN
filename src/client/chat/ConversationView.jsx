import MessageList from './MessageList.jsx'
import ChatComposer from './ChatComposer.jsx'
import EmptyState from '../shared/EmptyState.jsx'
import ErrorNotice from '../shared/ErrorNotice.jsx'
import ReconnectWorkspace from '../workspace/ReconnectWorkspace.jsx'

const DEV = typeof import.meta !== 'undefined' && !!import.meta.env?.DEV

/** The primary surface: transcript (messages + activity + approvals) and the composer for one conversation. */
export default function ConversationView({ active, notice, setup, canOpenWorkspaces, onSend, onStop, onApprove, onDeny, onOpenSettings, onDismissNotice, onOpenPath, chips = null, onReconnectWorkspace, onRetryLoad }) {
  if (!active) return <main className="conversation" />
  const { view, composer, workspace } = active
  return (
    <main className="conversation" aria-label="Conversation">
      {!setup.ready ? (
        <div className="conversation__banner">
          <ErrorNotice tone="warning" text={setup.message ?? 'Connect a model to start.'} action={<button type="button" className="btn" onClick={onOpenSettings}>Open settings</button>} />
        </div>
      ) : null}
      {!workspace && setup.ready && !canOpenWorkspaces ? (
        <div className="conversation__banner">
          <ErrorNotice tone="subdued" text="No repository is connected, so BLUSWAN can chat but cannot read or change files." />
        </div>
      ) : null}
      {active.workspaceMissing && onReconnectWorkspace ? (
        <div className="conversation__banner"><ReconnectWorkspace name={workspace?.name} onReconnect={onReconnectWorkspace} /></div>
      ) : null}
      {active.loadError ? (
        <div className="conversation__banner"><ErrorNotice tone="error" text={`This conversation couldn't be restored. ${active.loadError}`} action={<button type="button" className="btn" onClick={onRetryLoad}>Try again</button>} /></div>
      ) : null}
      {active.loading ? <div className="conversation__banner"><ErrorNotice tone="subdued" text="Restoring this conversation…" /></div> : null}
      <MessageList
        entries={view.entries} working={composer.busy} onApprove={onApprove} onDeny={onDeny} onOpenPath={onOpenPath} showTechnical={DEV}
        empty={<EmptyState repoName={workspace?.name} />}
      />
      {notice ? (
        <div className="conversation__banner">
          <ErrorNotice tone="error" text={notice.text} details={notice.details} showTechnical={DEV} action={<button type="button" className="btn btn--ghost" onClick={onDismissNotice}>Dismiss</button>} />
        </div>
      ) : null}
      {chips}
      <ChatComposer key={active.id} disabled={composer.disabled || !setup.ready} canStop={composer.canStop} reason={!setup.ready ? 'Connect a model in Settings to start.' : composer.reason} onSend={onSend} onStop={onStop} />
    </main>
  )
}
