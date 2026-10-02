// React bindings for the client store. Subscriptions are owned by useSyncExternalStore, so they are
// cleaned up on unmount and never duplicated when the active session changes.
import { createContext, createElement, useContext, useSyncExternalStore } from 'react'

const StoreContext = createContext(null)

export function ClientStoreProvider({ store, children }) {
  return createElement(StoreContext.Provider, { value: store }, children)
}

export function useClientStore() {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useClientStore must be used inside <ClientStoreProvider>')
  return store
}

/** The whole UI snapshot plus actions. */
export function useBluswan() {
  const store = useClientStore()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return { snapshot, store }
}

/**
 * Focused hook for one conversation.
 * @returns {{session, messages, activities, status, pendingPermission, sendMessage, cancel, approvePermission, denyPermission}}
 */
export function useSession() {
  const { snapshot, store } = useBluswan()
  const active = snapshot.active
  return {
    session: active,
    messages: active ? active.view.entries.filter(e => e.kind === 'user' || e.kind === 'assistant') : [],
    activities: active ? active.view.entries.filter(e => e.kind === 'activity') : [],
    status: active?.view.status ?? 'ready',
    pendingPermission: active?.view.pendingPermission ?? null,
    sendMessage: store.sendMessage,
    cancel: store.cancel,
    approvePermission: store.approvePermission,
    denyPermission: store.denyPermission,
  }
}
