// The signed-in application: connects the browser to the BLUSWAN runtime and renders either the connection screen
// (while there is nothing to show) or the app shell (live data, or the cached session list when offline).
import { useCallback, useEffect, useMemo, useState } from 'react'
import AppShell from './client/AppShell.jsx'
import ConnectionScreen from './client/status/ConnectionScreen.jsx'
import { createSettingsStore, scrubLegacySecrets } from './client/settings/settingsStore.js'
import { createRemoteRuntime, createIndexCache } from './client/runtime/createRemoteRuntime.js'
import { resolveApiUrl } from './client/runtime/apiUrl.js'
import { createClientStore } from './client/state/clientStore.js'
import { createGithubStore } from './client/github/githubStore.js'
import { pickModel } from './client/models/modelSelection.js'
import { createIndexedDbDocStore, openIndexedDb } from './persistence/adapters/localPersistence.js'

/** IndexedDB cache of the session list (offline display). Absent storage just means no offline list. */
async function openCache() {
  try { return globalThis.indexedDB ? createIndexCache(createIndexedDbDocStore({ db: await openIndexedDb(globalThis.indexedDB) })) : null } catch { return null }
}

export default function ConnectedApplication({ identity }) {
  const api = useMemo(() => resolveApiUrl(), [])
  const [session, setSession] = useState({ runtime: null, store: null, settings: null, github: null, connection: { state: 'starting' } })

  useEffect(() => {
    let cancelled = false
    let runtime = null; let store = null; let off = null; let github = null
    scrubLegacySecrets() // provider keys left in this browser by earlier versions
    ;(async () => {
      const cache = await openCache()
      if (cancelled) return
      runtime = createRemoteRuntime({ baseUrl: api.url, getToken: identity.getToken, userKey: identity.id, cache })
      const onChange = (connection) => {
        if (cancelled) return
        if (connection.usable && !store) { // something to show: live data or the cached session list
          const settings = createSettingsStore()
          store = createClientStore({ runtime, settings, selectModel: () => pickModel({ settings: settings.get(), models: runtime.getModels(), defaultModel: runtime.getDefaultModel() }) })
          github = runtime.github ? createGithubStore({
            runtime, workspaceId: () => store.getSnapshot().active?.workspace?.id ?? null, canAct: () => store.getSnapshot().canAct !== false,
            runBusy: () => !!store.getSnapshot().active?.composer?.busy, startTask: (workspaceId) => store.newSession({ workspaceId }),
          }) : null
          github?.loadStatus().then(() => github.completeFromLocation())
          setSession({ runtime, store, settings, github, connection })
        } else if (!store) setSession({ runtime, store: null, settings: null, connection })
      }
      off = runtime.onConnection(onChange)
      onChange(runtime.getConnection())
      runtime.start({ autoRetry: true })
    })()
    return () => { cancelled = true; off?.(); github?.destroy(); store?.destroy(); runtime?.close() }
  }, [identity.id, identity.getToken, api.url])

  const retry = useCallback(() => session.runtime?.retryConnection(), [session.runtime])
  const diagnose = useCallback(() => session.runtime.diagnoseConnection(), [session.runtime])
  const signOut = identity.signOut ? async () => { await session.runtime?.logout(); identity.signOut() } : null

  if (!session.store) {
    return (
      <ConnectionScreen
        connection={session.connection} onRetry={session.runtime ? retry : undefined} onSignIn={identity.signOut ? () => identity.signOut() : undefined}
        diagnose={session.runtime ? diagnose : undefined} apiUrl={api.url} warnings={api.warnings} mobile={api.mobile}
      />
    )
  }
  return <AppShell store={session.store} settings={session.settings} userEmail={identity.email} onLogout={signOut} apiUrl={api.url} github={session.github} />
}
