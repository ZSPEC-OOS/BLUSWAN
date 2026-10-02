// Chat-first application shell: conversation sidebar, header, conversation, composer.
// Everything it shows is projected from runtime state by the client store; it executes nothing itself.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClientStoreProvider, useBluswan } from './state/useClientStore.js'
import SessionSidebar from './sessions/SessionSidebar.jsx'
import ChatHeader from './status/ChatHeader.jsx'
import ConversationView from './chat/ConversationView.jsx'
import ConnectionBanner from './status/ConnectionBanner.jsx'
import DiagnosticsPanel from './status/DiagnosticsPanel.jsx'
import SettingsPanel from './settings/SettingsPanel.jsx'
import WorkspacePanel from './workspace/WorkspacePanel.jsx'
import ResizablePanel from './shared/ResizablePanel.jsx'
import MobileSheet from './shared/MobileSheet.jsx'
import { ActivityLinksContext } from './activity/ActivityLinks.js'
import { GithubProvider, useGithub } from './github/GithubContext.js'
import GithubPanel from './github/GithubPanel.jsx'
import GithubDialogs from './github/GithubDialogs.jsx'
import WorkflowBar from './github/WorkflowBar.jsx'
import { useMediaQuery } from './shared/useMediaQuery.js'
import { MIN_WIDTH, MAX_WIDTH } from './workspace/workspaceStore.js'
import './theme.css'
import './workspace/workspace.css'
import './shell.css'

export function Shell({ settings, userEmail, onLogout, mobileOverride, apiUrl = '' }) {
  const { snapshot, store } = useBluswan()
  const { store: gh } = useGithub()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [diagOpen, setDiagOpen] = useState(false)
  const [, bump] = useState(0)
  const started = useRef(false)
  const mediaMobile = useMediaQuery('(max-width: 900px)')
  const mobile = mobileOverride ?? mediaMobile

  useEffect(() => { // first conversation; the ref keeps StrictMode's double effect from creating two
    if (started.current) return
    started.current = true
    if (!store.getSnapshot().activeId) store.newSession()
  }, [store])

  useEffect(() => settings.subscribe(() => { store.refresh(); bump(n => n + 1) }), [settings, store])

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); store.workspace.togglePanel() }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); store.newSession(); document.querySelector('[data-composer]')?.focus() }
      else if (e.key === 'Escape') setSidebarOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [store])

  useEffect(() => { // the branch or files may change outside BLUSWAN: re-read git state when the user comes back
    const onFocus = () => { if (document.visibilityState !== 'hidden') store.workspace.refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) }
  }, [store])

  // the repository workflow re-reads git when the repository, connectivity or the agent's run state changes
  const wsId = snapshot.active?.workspace?.id ?? null
  const runBusy = !!snapshot.active?.composer?.busy
  useEffect(() => { gh?.notifyContextChanged() }, [gh, wsId, snapshot.canAct, runBusy, snapshot.activeId])
  const select = useCallback((id) => { store.selectSession(id); setSidebarOpen(false) }, [store])
  const send = useCallback((text) => store.sendMessage(text).ok, [store])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  const review = snapshot.active?.review ?? null
  const panelOpen = !!review && (mobile ? review.ui.sheetOpen : review.prefs.open)
  const changedKey = review?.changedFiles.map(f => f.path).join('\n') ?? ''
  const links = useMemo(() => ({
    openFile: (p) => store.workspace.selectFile(p), openCommand: (id) => store.workspace.openCommand(id),
    openValidation: (id) => store.workspace.openValidation(id), canOpenDeleted: true,
  }), [store])
  const openPath = useMemo(() => {
    const known = new Set(changedKey ? changedKey.split('\n') : [])
    // only paths with structured changed-file metadata are actionable
    return Object.assign((p) => store.workspace.selectFile(p), { accepts: (p) => known.has(p) })
  }, [store, changedKey])
  const toggleChanges = useCallback(() => { if (mobile) store.workspace.openChanges(); else store.workspace.togglePanel() }, [mobile, store])
  const changed = snapshot.active?.changedCount ?? 0
  const vrow = review?.validation.rows[0]
  const chips = mobile && review && (changed || vrow) ? (
    <div className="chips">
      {changed ? <button type="button" className="changes-chip" onClick={() => store.workspace.openChanges()}>{changed} {changed === 1 ? 'file' : 'files'} changed</button> : null}
      {vrow ? <button type="button" className="changes-chip" onClick={() => store.workspace.openValidation(null)}>{vrow.name}: {vrow.status === 'stale' ? 'stale' : vrow.summary || vrow.status}</button> : null}
    </div>
  ) : null

  return (
    <ActivityLinksContext.Provider value={links}>
    <div className="shell">
      <SessionSidebar
        sessions={snapshot.sessions} activeId={snapshot.activeId} open={sidebarOpen} onClose={() => setSidebarOpen(false)}
        onNew={() => { store.newSession(); setSidebarOpen(false) }} onRepositories={gh ? () => { gh.openPanel('home'); setSidebarOpen(false) } : undefined} onSelect={select} onDelete={(id, opts) => store.deleteSession(id, opts)}
      />
      <div className="shell__main">
        <ConnectionBanner connection={snapshot.connection} onRetry={store.retryConnection} onSignIn={onLogout} onDetails={() => setDiagOpen(v => !v)} />
        {diagOpen && snapshot.connection.state !== 'online' ? <div className="conversation__banner"><DiagnosticsPanel connection={snapshot.connection} apiUrl={apiUrl} diagnose={store.diagnoseConnection} /></div> : null}
        <ChatHeader
          active={snapshot.active} workspace={snapshot.active?.workspace ?? snapshot.workspace} model={snapshot.active?.model ?? snapshot.model}
          permissionMode={snapshot.permissionMode} onPermissionMode={store.setPermissionMode}
          onOpenSettings={() => setSettingsOpen(true)} onToggleSidebar={() => setSidebarOpen(o => !o)} onToggleChanges={toggleChanges} panelOpen={panelOpen} models={snapshot.models} onChooseModel={store.chooseModel}
        />
        {gh ? <WorkflowBar busy={runBusy} offline={!snapshot.canAct} onReviewDiff={toggleChanges} /> : null}
        {gh && !snapshot.active?.workspace ? (
          <div className="conversation__banner gh-empty" role="status">
            <span>Choose a repository to start coding.</span>
            <button type="button" className="btn btn--primary" onClick={() => gh.openPanel('home')}>Browse GitHub</button>
            <button type="button" className="btn" onClick={() => setSettingsOpen(true)}>Open Local Repository</button>
          </div>
        ) : null}
        <ConversationView
          active={snapshot.active} notice={snapshot.notice} setup={snapshot.setup} canOpenWorkspaces={snapshot.canOpenWorkspaces}
          onSend={send} onStop={store.cancel} onApprove={store.approvePermission} onDeny={store.denyPermission}
          onOpenSettings={() => setSettingsOpen(true)} onDismissNotice={store.dismissNotice} onOpenPath={openPath} chips={chips} connection={snapshot.connection} onReconnectWorkspace={(root) => store.reconnectWorkspace(root)} onRetryLoad={store.retryLoad}
        />
      </div>
      {review && panelOpen && !mobile ? (
        <ResizablePanel width={review.prefs.width} min={MIN_WIDTH} max={MAX_WIDTH} onWidthChange={store.workspace.setWidth}>
          <WorkspacePanel review={review} actions={store.workspace} onCollapse={() => store.workspace.setPanelOpen(false)} />
        </ResizablePanel>
      ) : null}
      {review && panelOpen && mobile ? (
        <MobileSheet title="Workspace" onClose={store.workspace.closeSheet}>
          <WorkspacePanel review={review} actions={store.workspace} stacked />
        </MobileSheet>
      ) : null}
      {gh ? <><GithubPanel onOpenLocal={() => setSettingsOpen(true)} /><GithubDialogs /></> : null}
      {settingsOpen ? (
        <SettingsPanel
          settings={settings.get()} providers={snapshot.providerStatus} onSave={(patch) => { settings.update(patch); store.saveSettings(patch) }} permissionMode={snapshot.permissionMode} onPermissionMode={store.setPermissionMode}
          canOpenWorkspaces={snapshot.canOpenWorkspaces} onOpenWorkspace={store.openWorkspace} setup={snapshot.setup}
          userEmail={userEmail} onSignOut={onLogout} onClose={closeSettings}
        />
      ) : null}
    </div>
    </ActivityLinksContext.Provider>
  )
}

export default function AppShell({ store, settings, userEmail, onLogout, mobileOverride, apiUrl = '', github = null }) {
  return (
    <ClientStoreProvider store={store}>
      <GithubProvider store={github}>
        <Shell settings={settings} userEmail={userEmail} onLogout={onLogout} mobileOverride={mobileOverride} apiUrl={apiUrl} />
      </GithubProvider>
    </ClientStoreProvider>
  )
}
