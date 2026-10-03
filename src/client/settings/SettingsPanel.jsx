import { useEffect, useRef, useState } from 'react'
import { MODE_INFO, PERMISSION_MODES } from '../../tools/permissionModes.js'
import RepositoryOpener from './RepositoryOpener.jsx'
import ModelModePicker from '../status/ModelModePicker.jsx'
import './settings.css'

/**
 * Modal settings: model, permission mode, repository, account. Provider credentials are not editable here: they are
 * configured on the BLUSWAN server, and this panel only shows whether a provider is configured.
 */
export default function SettingsPanel({ settings, providers = [], onSave, permissionMode, onPermissionMode, canOpenWorkspaces, onOpenWorkspace, setup, userEmail, onSignOut, onClose, routing = null, mode = null, onChooseMode = null }) {
  const [draft, setDraft] = useState(() => ({ model: settings.model }))
  const dialog = useRef(null)

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
          {routing?.modes?.length && onChooseMode ? <ModelModePicker routing={routing} mode={mode} onChange={onChooseMode} /> : null}
          {providers.map(p => (
            <p key={p.provider} className={`settings__provider ${p.configured ? 'is-ok' : 'is-missing'}`} role="status">
              <strong>{p.label}</strong> {p.configured ? 'configured' : 'not configured'}
              <span className="settings__hint"> — {p.configured ? 'the API key is held by the BLUSWAN server and is never sent to this browser.' : 'ask the administrator to set it on the server.'}</span>
            </p>
          ))}
          {!setup?.ready && !providers.length ? <p className="settings__warn" role="status">{setup?.message ?? 'A model provider needs to be configured.'}</p> : null}
          <label className="field"><span>Model</span><input value={draft.model} placeholder={providers[0]?.model || 'e.g. deepseek-chat'} onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></label>
          <div className="settings__row"><button type="button" className="btn btn--primary" onClick={() => onSave({ model: draft.model })}>Save</button></div>
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
          <RepositoryOpener canOpenWorkspaces={canOpenWorkspaces} onOpen={(spec) => { onOpenWorkspace(spec); onClose() }} />
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
