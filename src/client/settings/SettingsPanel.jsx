import { useEffect, useRef, useState } from 'react'
import { MODE_INFO, PERMISSION_MODES } from '../../tools/permissionModes.js'
import './settings.css'

/**
 * Modal settings: model connection, permission mode, repository, account. The API key is write-only in the
 * UI (shown masked) and never leaves the settings store / provider.
 */
export default function SettingsPanel({ settings, onSave, permissionMode, onPermissionMode, canOpenWorkspaces, onOpenWorkspace, setup, userEmail, onSignOut, onClose }) {
  const [draft, setDraft] = useState(() => ({ model: settings.model, apiKey: '', baseUrl: settings.baseUrl }))
  const [path, setPath] = useState('')
  const dialog = useRef(null)
  const keySet = !!settings.apiKey

  useEffect(() => {
    dialog.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal__card" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={dialog}>
        <div className="modal__head"><h2 id="settings-title">Settings</h2><button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close settings">✕</button></div>

        <section aria-labelledby="set-model">
          <h3 id="set-model">Model</h3>
          {!setup?.ready ? <p className="settings__warn" role="status">{setup?.message ?? 'A model provider needs to be configured.'}</p> : null}
          <label className="field"><span>Provider</span><select value="deepseek" disabled aria-label="Provider"><option value="deepseek">DeepSeek</option></select></label>
          <label className="field"><span>Model</span><input value={draft.model} placeholder="e.g. deepseek-chat" onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></label>
          <label className="field"><span>API key</span><input type="password" autoComplete="off" value={draft.apiKey} placeholder={keySet ? '•••••••• (saved — enter a new key to replace)' : 'Paste your API key'} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} /></label>
          <label className="field"><span>Base URL (optional)</span><input value={draft.baseUrl} placeholder="https://api.deepseek.com" onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
          <p className="settings__hint">The key is stored in this browser only.</p>
          <div className="settings__row">
            <button type="button" className="btn btn--primary" onClick={() => onSave({ model: draft.model, baseUrl: draft.baseUrl, ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) })}>Save</button>
            {keySet ? <button type="button" className="btn btn--ghost" onClick={() => onSave({ apiKey: '' })}>Remove saved key</button> : null}
          </div>
        </section>

        <section aria-labelledby="set-perm">
          <h3 id="set-perm">Permissions</h3>
          <div role="radiogroup" aria-labelledby="set-perm" className="settings__modes">
            {PERMISSION_MODES.map(m => (
              <label key={m} className={`mode${m === permissionMode ? ' is-selected' : ''}`}>
                <input type="radio" name="permission-mode" value={m} checked={m === permissionMode} onChange={() => onPermissionMode(m)} />
                <span><strong>{MODE_INFO[m].label}</strong><small>{MODE_INFO[m].description}</small></span>
              </label>
            ))}
          </div>
          <p className="settings__hint">Commands blocked by workspace safety policy never run in any mode.</p>
        </section>

        <section aria-labelledby="set-repo">
          <h3 id="set-repo">Repository</h3>
          {canOpenWorkspaces ? (
            <div className="settings__row">
              <input aria-label="Repository path" value={path} placeholder="/path/to/repository" onChange={(e) => setPath(e.target.value)} />
              <button type="button" className="btn" disabled={!path.trim()} onClick={() => { onOpenWorkspace({ root: path.trim() }); onClose() }}>Open</button>
            </div>
          ) : (
            <p className="settings__hint">This browser session cannot open local folders. Run BLUSWAN against a local repository with <code>npm run agent -- --workspace &lt;dir&gt; &quot;your request&quot;</code>.</p>
          )}
        </section>

        {userEmail || onSignOut ? (
          <section aria-labelledby="set-acct">
            <h3 id="set-acct">Account</h3>
            <div className="settings__row"><span className="settings__hint">{userEmail}</span>{onSignOut ? <button type="button" className="btn" onClick={onSignOut}>Sign out</button> : null}</div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
