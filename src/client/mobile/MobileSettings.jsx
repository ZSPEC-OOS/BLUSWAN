import { useRef, useState } from 'react'
import { useFocusTrap } from '../shared/useFocusTrap.js'
import ModelSelector from '../status/ModelSelector.jsx'
import DiagnosticsPanel from '../status/DiagnosticsPanel.jsx'
import { MODE_INFO, PERMISSION_MODES } from '../../tools/permissionModes.js'
import './mobile.css'

const RUNTIME = { online: '● Connected', connecting_stream: '◌ Connecting…', reconnecting: '◌ Reconnecting…', offline_cached: '○ Offline — saved conversations only', auth_error: '✕ Sign-in expired', server_unreachable: '✕ Cannot reach runtime', server_error: '✕ Runtime problem' }
export const runtimeLabel = (state) => RUNTIME[state] ?? '◌ Connecting…'

/** GitHub state as text (never colour alone), from the existing integration state. */
export function githubLabel(status) {
  if (!status || status.phase === 'loading') return '◌ Checking…'
  if (status.phase === 'error') return '✕ Could not check'
  if (!status.configured) return '○ Unavailable on this server'
  return status.connected ? `● Connected${status.login ? ` as ${status.login}` : ''}` : '○ Not connected'
}

/** Mobile Settings: the existing model, edit-mode, GitHub and runtime state, grouped. Controls are the existing ones. */
export default function MobileSettings({ models = [], model, modelBusy = false, onChooseModel, permissionMode, onPermissionMode, github = null, onGithub, connection, apiUrl = '', diagnose, onAllSettings, userEmail, onSignOut, onClose }) {
  const ref = useRef(null)
  const [diag, setDiag] = useState(false)
  useFocusTrap(ref, { onEscape: onClose })
  return (
    <div className="mdrawer__scrim mdrawer__scrim--right" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="mdrawer mdrawer--right" role="dialog" aria-modal="true" aria-label="Settings" ref={ref} tabIndex={-1}>
        <header className="mdrawer__head"><h2 className="mdrawer__title">Settings</h2><button type="button" className="mhead__btn" onClick={onClose} aria-label="Close settings"><span aria-hidden="true">✕</span></button></header>
        <div className="mdrawer__body">
          <section className="msec" aria-labelledby="ms-ai">
            <h3 id="ms-ai" className="msec__title">AI</h3>
            <div className="mfield"><span className="mfield__label" id="ms-model-l">Model</span>
              {onChooseModel ? <ModelSelector models={models} current={model} disabled={modelBusy} onChange={onChooseModel} /> : <span className="mrow__detail">{model?.model || 'No model'}</span>}
            </div>
            {onAllSettings ? <button type="button" className="mrow" onClick={onAllSettings}><span className="mrow__label">Provider status &amp; default model</span><span className="mrow__chev" aria-hidden="true">›</span></button> : null}
          </section>

          <section className="msec" aria-labelledby="ms-edit">
            <h3 id="ms-edit" className="msec__title">Editing</h3>
            <div className="mfield"><label className="mfield__label" htmlFor="ms-mode">Edit mode</label>
              <select id="ms-mode" className="mselect" value={permissionMode} onChange={(e) => onPermissionMode(e.target.value)}>
                {PERMISSION_MODES.map(m => <option key={m} value={m}>{MODE_INFO[m].label}</option>)}
              </select>
              <span className="mrow__detail">{MODE_INFO[permissionMode]?.description}</span>
            </div>
          </section>

          {github ? (
            <section className="msec" aria-labelledby="ms-conn">
              <h3 id="ms-conn" className="msec__title">Connections</h3>
              <button type="button" className="mrow" onClick={onGithub}><span className="mrow__label">GitHub</span><span className="mrow__detail" data-testid="github-status">{githubLabel(github.status)}</span><span className="mrow__chev" aria-hidden="true">›</span></button>
            </section>
          ) : null}

          <section className="msec" aria-labelledby="ms-rt">
            <h3 id="ms-rt" className="msec__title">Runtime</h3>
            <div className="mrow mrow--static"><span className="mrow__label">Status</span><span className="mrow__detail" role="status" data-testid="runtime-status">{runtimeLabel(connection?.state)}</span></div>
            <button type="button" className="mrow" aria-expanded={diag} onClick={() => setDiag(v => !v)}><span className="mrow__label">Diagnostics</span><span className="mrow__chev" aria-hidden="true">{diag ? '⌄' : '›'}</span></button>
            {diag ? <DiagnosticsPanel connection={connection} apiUrl={apiUrl} diagnose={diagnose} /> : null}
          </section>

          {userEmail || onSignOut ? (
            <section className="msec" aria-labelledby="ms-acct"><h3 id="ms-acct" className="msec__title">Account</h3>
              {userEmail ? <div className="mrow mrow--static"><span className="mrow__detail">{userEmail}</span></div> : null}
              {onSignOut ? <button type="button" className="mrow" onClick={onSignOut}><span className="mrow__label">Sign out</span></button> : null}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
