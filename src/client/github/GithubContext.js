import { createContext, createElement, useContext, useSyncExternalStore } from 'react'

const Ctx = createContext(null)
export function GithubProvider({ store, children }) { return createElement(Ctx.Provider, { value: store }, children) }
/** @returns {{store:object|null, snapshot:object|null}} null when the runtime has no GitHub support (older runtimes, tests). */
export function useGithub() {
  const store = useContext(Ctx)
  const snapshot = useSyncExternalStore(store ? store.subscribe : noopSubscribe, store ? store.getSnapshot : nullSnapshot, store ? store.getSnapshot : nullSnapshot)
  return { store, snapshot }
}
const noopSubscribe = () => () => {}
const nullSnapshot = () => null
