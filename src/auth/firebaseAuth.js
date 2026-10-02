// Firebase Authentication for the web client (sign-in only). The ID token it yields is sent to the BLUSWAN server,
// which verifies it; nothing here touches provider credentials, sessions or storage. The Firebase web config is
// public by design (VITE_FIREBASE_*) — access control is enforced by the server and Firebase security rules.
import { initializeApp, getApps } from 'firebase/app'

const CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
}

let app = null
let auth = null

export const isFirebaseConfigured = () => !!(CONFIG.apiKey && CONFIG.projectId)

function init() {
  if (app) return app
  if (!isFirebaseConfigured()) throw new Error('Firebase is not configured (set VITE_FIREBASE_* variables).')
  app = getApps().find(a => a.options.projectId === CONFIG.projectId) ?? initializeApp(CONFIG)
  return app
}

async function getAuth() {
  if (!auth) { const { getAuth: get } = await import('firebase/auth'); auth = get(init()) }
  return auth
}

export async function signInWithGoogle() {
  const a = await getAuth()
  const { GoogleAuthProvider, signInWithPopup, signInWithRedirect } = await import('firebase/auth')
  const provider = new GoogleAuthProvider()
  try {
    return (await signInWithPopup(a, provider)).user
  } catch (err) {
    if (err?.code === 'auth/popup-blocked' || err?.code === 'auth/popup-closed-by-user') { await signInWithRedirect(a, provider); return null }
    throw err
  }
}

export async function signInWithEmail(email, password) {
  const a = await getAuth()
  const { signInWithEmailAndPassword } = await import('firebase/auth')
  return (await signInWithEmailAndPassword(a, email, password)).user
}

export async function signUpWithEmail(email, password) {
  const a = await getAuth()
  const { createUserWithEmailAndPassword } = await import('firebase/auth')
  return (await createUserWithEmailAndPassword(a, email, password)).user
}

export async function signOutUser() {
  const a = await getAuth()
  const { signOut } = await import('firebase/auth')
  await signOut(a)
}

/** callback(user | null) now and on every change. Returns an unsubscribe function. */
export function onAuthStateChange(callback) {
  let unsub = null
  let cancelled = false
  ;(async () => {
    try {
      const a = await getAuth()
      const { onAuthStateChanged } = await import('firebase/auth')
      if (!cancelled) unsub = onAuthStateChanged(a, callback)
    } catch {
      if (!cancelled) callback(null) // never leave the app on the loading screen
    }
  })()
  return () => { cancelled = true; unsub?.() }
}
