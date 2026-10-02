// Chat-first application shell: conversation sidebar, header, conversation, composer.
// Everything it shows is projected from runtime state by the client store; it executes nothing itself.
import { useCallback, useEffect, useRef, useState } from 'react'
import { ClientStoreProvider, useBluswan } from './state/useClientStore.js'
import SessionSidebar from './sessions/SessionSidebar.jsx'
import ChatHeader from './status/ChatHeader.jsx'
import ConversationView from './chat/ConversationView.jsx'
import SettingsPanel from './settings/SettingsPanel.jsx'
import './theme.css'
import './shell.css'

export function Shell({ settings, userEmail, onLogout }) {
  const { snapshot, store } = useBluswan()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [, bump] = useState(0)
  const started = useRef(false)

  useEffect(() => { // first conversation; the ref keeps StrictMode's double effect from creating two
    if (started.current) return
    started.current = true
    if (!store.getSnapshot().activeId) store.newSession()
  }, [store])

  useEffect(() => settings.subscribe(() => { store.refresh(); bump(n => n + 1) }), [settings, store])

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); store.newSession(); document.querySelector('[data-composer]')?.focus() }
      else if (e.key === 'Escape') setSidebarOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [store])

  const select = useCallback((id) => { store.selectSession(id); setSidebarOpen(false) }, [store])
  const send = useCallback((text) => store.sendMessage(text).ok, [store])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  return (
    <div className="shell">
      <SessionSidebar
        sessions={snapshot.sessions} activeId={snapshot.activeId} open={sidebarOpen} onClose={() => setSidebarOpen(false)}
        onNew={() => { store.newSession(); setSidebarOpen(false) }} onSelect={select} onDelete={(id, opts) => store.deleteSession(id, opts)}
      />
      <div className="shell__main">
        <ChatHeader
          active={snapshot.active} workspace={snapshot.active?.workspace ?? snapshot.workspace} model={snapshot.active?.model ?? snapshot.model}
          permissionMode={snapshot.permissionMode} onPermissionMode={store.setPermissionMode}
          onOpenSettings={() => setSettingsOpen(true)} onToggleSidebar={() => setSidebarOpen(o => !o)}
        />
        <ConversationView
          active={snapshot.active} notice={snapshot.notice} setup={snapshot.setup} canOpenWorkspaces={snapshot.canOpenWorkspaces}
          onSend={send} onStop={store.cancel} onApprove={store.approvePermission} onDeny={store.denyPermission}
          onOpenSettings={() => setSettingsOpen(true)} onDismissNotice={store.dismissNotice}
        />
      </div>
      {settingsOpen ? (
        <SettingsPanel
          settings={settings.get()} onSave={settings.update} permissionMode={snapshot.permissionMode} onPermissionMode={store.setPermissionMode}
          canOpenWorkspaces={snapshot.canOpenWorkspaces} onOpenWorkspace={store.openWorkspace} setup={snapshot.setup}
          userEmail={userEmail} onSignOut={onLogout} onClose={closeSettings}
        />
      ) : null}
    </div>
  )
}

export default function AppShell({ store, settings, userEmail, onLogout }) {
  return (
    <ClientStoreProvider store={store}>
      <Shell settings={settings} userEmail={userEmail} onLogout={onLogout} />
    </ClientStoreProvider>
  )
}
