import { useState, useEffect, useRef } from 'react'
import EngineToggle from './EngineToggle.jsx'
import ModelSetup from './ModelSetup.jsx'
import DeliverableList from './DeliverableList.jsx'
import BudgetBar from './BudgetBar.jsx'
import QualitySignals from './QualitySignals.jsx'
import { getAuthenticatedUser, getRepo, listUserRepos } from '../services/githubService.js'
import './styles.css'

// ─── Constants ────────────────────────────────────────────────────────────────

const RUNNING_PHASES = new Set([
  'planning', 'plan_review', 'cycle_prep', 'cycle_exec',
  'cycle_validate', 'completion_check', 'completion_confirm',
])
const TERMINAL_PHASES = new Set(['done', 'failed', 'halted'])

const PHASE_STEPS = [
  { key: 'plan',     label: 'Planning',   phases: new Set(['planning', 'plan_review']) },
  { key: 'exec',     label: 'Executing',  phases: new Set(['cycle_prep', 'cycle_exec', 'cycle_validate']) },
  { key: 'complete', label: 'Completing', phases: new Set(['completion_check', 'completion_confirm']) },
  { key: 'done',     label: 'Done',       phases: new Set(['done', 'failed', 'halted']) },
]

const RESULT_META = {
  done:   { icon: '✓', title: 'Task Complete', titleClass: 'done' },
  failed: { icon: '✗', title: 'Task Failed',   titleClass: 'failed' },
  halted: { icon: '⏸', title: 'Task Halted',   titleClass: 'halted' },
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

const GH_TOKEN_PERSIST = 'bluswan:ghtoken-persist'

function readGitHubConfig() {
  try {
    const s = JSON.parse(localStorage.getItem('bluswan:settings') || '{}')
    // sessionStorage primary (V1 compat), localStorage persist fallback (V2 cross-session)
    const token = sessionStorage.getItem('bluswan:ghtoken')
      || localStorage.getItem(GH_TOKEN_PERSIST)
      || ''
    return {
      token,
      owner:  s.repoOwner  || '',
      repo:   s.repoName   || '',
      branch: s.baseBranch || 'main',
    }
  } catch { return { token: '', owner: '', repo: '', branch: 'main' } }
}

function writeGitHubConfig({ token, owner, repo, branch }) {
  try {
    sessionStorage.setItem('bluswan:ghtoken', token)
    // Persist token across sessions (V2-specific; V1 uses Firebase for this)
    if (token) {
      localStorage.setItem(GH_TOKEN_PERSIST, token)
    } else {
      localStorage.removeItem(GH_TOKEN_PERSIST)
    }
    const s = JSON.parse(localStorage.getItem('bluswan:settings') || '{}')
    localStorage.setItem('bluswan:settings', JSON.stringify({
      ...s, repoOwner: owner, repoName: repo, baseBranch: branch,
    }))
  } catch {}
}

// ─── GitHub Section ───────────────────────────────────────────────────────────

function GitHubSection() {
  const [cfg, setCfg]           = useState(readGitHubConfig)
  const [form, setForm]         = useState(cfg)
  const [checking, setChecking] = useState(false)
  const [ghUser, setGhUser]     = useState(null)
  const [error, setError]       = useState('')
  const [repos, setRepos]       = useState([])
  const [loadingRepos, setLoadingRepos] = useState(false)

  // On mount: verify stored token and load repos if already connected
  useEffect(() => {
    if (!cfg.token) return
    getAuthenticatedUser(cfg.token)
      .then(u => {
        setGhUser(u)
        loadRepos(cfg.token)
      })
      .catch(() => setGhUser(null))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadRepos(token) {
    setLoadingRepos(true)
    try {
      const list = await listUserRepos(token)
      setRepos(list.map(r => ({ fullName: r.full_name, owner: r.owner.login, name: r.name, branch: r.default_branch || 'main' })))
    } catch {} finally {
      setLoadingRepos(false)
    }
  }

  async function handleConnect(e) {
    e.preventDefault()
    if (!form.token.trim()) return
    setChecking(true)
    setError('')
    try {
      const u = await getAuthenticatedUser(form.token.trim())
      setGhUser(u)
      const saved = { ...form, token: form.token.trim() }
      setCfg(saved)
      writeGitHubConfig(saved)
      loadRepos(form.token.trim())
    } catch {
      setError('Token invalid or network error.')
      setGhUser(null)
    } finally {
      setChecking(false)
    }
  }

  function handleDisconnect() {
    const cleared = { token: '', owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }
    setCfg(cleared)
    setForm(cleared)
    setGhUser(null)
    setRepos([])
    writeGitHubConfig(cleared)
  }

  function handleRepoSelect(e) {
    const r = repos.find(r => r.fullName === e.target.value)
    if (!r) return
    setForm(f => ({ ...f, owner: r.owner, repo: r.name, branch: r.branch }))
  }

  function handleRepoSave(e) {
    e.preventDefault()
    const saved = { ...cfg, owner: form.owner.trim(), repo: form.repo.trim(), branch: form.branch.trim() || 'main' }
    setCfg(saved)
    writeGitHubConfig(saved)
  }

  async function detectBranch() {
    if (!cfg.token || !form.owner || !form.repo) return
    try {
      const r = await getRepo(cfg.token, form.owner, form.repo)
      if (r.default_branch) setForm(f => ({ ...f, branch: r.default_branch }))
    } catch {}
  }

  const connected       = Boolean(cfg.token && ghUser)
  const currentFullName = form.owner && form.repo ? `${form.owner}/${form.repo}` : ''

  return (
    <div className="v2-gh-section">
      {/* Status */}
      <div className="v2-gh-status">
        <span className={`v2-gh-dot v2-gh-dot--${connected ? 'on' : 'off'}`} />
        <span className="v2-gh-status-text">
          {connected ? `@${ghUser.login}` : 'Not connected'}
        </span>
        {connected && (
          <button type="button" className="v2-gh-disconnect" onClick={handleDisconnect}>Disconnect</button>
        )}
      </div>

      {/* Token form */}
      {!connected && (
        <form onSubmit={handleConnect} className="v2-gh-form">
          <input
            className="v2-settings-input"
            type="password"
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
            value={form.token}
            onChange={e => setForm(f => ({ ...f, token: e.target.value }))}
            autoComplete="new-password"
          />
          {error && <div className="v2-gh-error">{error}</div>}
          <button type="submit" className="btn-primary v2-settings-btn" disabled={!form.token.trim() || checking}>
            {checking ? 'Connecting…' : 'Connect GitHub'}
          </button>
          <p className="v2-settings-hint">
            Create a token at{' '}
            <a href="https://github.com/settings/tokens/new?scopes=repo&description=BLUSWAN" target="_blank" rel="noreferrer">
              github.com/settings/tokens
            </a>
            {' '}— <strong>repo</strong> scope.
          </p>
        </form>
      )}

      {/* Repo picker + manual fields */}
      <form onSubmit={handleRepoSave} className="v2-gh-repo-form">
        {connected && repos.length > 0 && (
          <div style={{ marginBottom: '0.45rem' }}>
            <div className="v2-sidebar-section-label" style={{ marginBottom: '0.25rem' }}>
              {loadingRepos ? 'Loading repos…' : `${repos.length} repos`}
            </div>
            <select
              className="v2-model-select"
              value={currentFullName}
              onChange={handleRepoSelect}
            >
              <option value="">— pick a repo —</option>
              {repos.map(r => (
                <option key={r.fullName} value={r.fullName}>{r.fullName}</option>
              ))}
            </select>
          </div>
        )}
        <div className="v2-settings-row">
          <input className="v2-settings-input v2-settings-input--half" placeholder="owner"
            value={form.owner} onChange={e => setForm(f => ({ ...f, owner: e.target.value }))} />
          <input className="v2-settings-input v2-settings-input--half" placeholder="repo"
            value={form.repo} onChange={e => setForm(f => ({ ...f, repo: e.target.value }))} />
        </div>
        <div className="v2-settings-row">
          <input className="v2-settings-input" placeholder="branch"
            value={form.branch} onChange={e => setForm(f => ({ ...f, branch: e.target.value }))} />
          <button type="button" className="v2-settings-icon-btn" title="Auto-detect branch"
            disabled={!cfg.token || !form.owner || !form.repo} onClick={detectBranch}>⟳</button>
        </div>
        <button type="submit" className="btn-secondary v2-settings-btn">Save Repo</button>
      </form>
    </div>
  )
}

// ─── Phase stepper ────────────────────────────────────────────────────────────

function PhaseStepper({ phase }) {
  const activeIdx  = PHASE_STEPS.findIndex(s => s.phases.has(phase))
  const isTerminal = TERMINAL_PHASES.has(phase)
  const isFailed   = phase === 'failed' || phase === 'halted'

  return (
    <div className="v2-phase-stepper">
      {PHASE_STEPS.map((step, i) => {
        let cls = 'v2-phase-step'
        if (isTerminal) {
          cls += i < 3 ? ' v2-phase-step--done' : (isFailed ? ' v2-phase-step--error' : ' v2-phase-step--done')
        } else if (activeIdx === i) {
          cls += ' v2-phase-step--active'
        } else if (i < activeIdx) {
          cls += ' v2-phase-step--done'
        }
        return (
          <span key={step.key} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
            {i > 0 && <span className="v2-phase-sep">›</span>}
            <span className={cls}>{step.label}</span>
          </span>
        )
      })}
    </div>
  )
}

// ─── Feed entry ───────────────────────────────────────────────────────────────

function FeedEntry({ event }) {
  const type = event.type || 'info'
  const icon = type === 'phase' ? '◆' : type === 'tool' ? '⚙' : type === 'error' ? '✗' : '·'
  return (
    <div className={`v2-feed-entry v2-feed-entry--${type}`}>
      <span className="v2-feed-entry-icon">{icon}</span>
      <div className="v2-feed-entry-body">
        {type === 'phase' && <span className="v2-feed-phase-text">{event.data?.phase || event.message || ''}</span>}
        {type === 'tool' && (
          <>
            <span className="v2-feed-tool-name">{event.data?.tool || event.message || 'tool'}</span>
            {event.data?.path && <div className="v2-feed-tool-path">{event.data.path}</div>}
          </>
        )}
        {type !== 'phase' && type !== 'tool' && (
          <span style={{ color: type === 'error' ? 'var(--lk-danger)' : 'var(--lk-text-muted)' }}>
            {event.message || (event.data ? JSON.stringify(event.data) : '')}
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Error Log ────────────────────────────────────────────────────────────────

function ErrorLog({ errors }) {
  const [copiedIdx, setCopiedIdx] = useState(null)

  if (!errors.length) return null

  function copy(text, idx) {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    })
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 1800)
  }

  const allText = errors.map((e, i) => `[${i + 1}] ${e}`).join('\n')

  return (
    <div className="v2-error-log">
      <div className="v2-error-log-header">
        <span className="v2-error-log-label">
          {errors.length} error{errors.length !== 1 ? 's' : ''}
        </span>
        <button
          type="button"
          className="v2-error-copy-all"
          onClick={() => copy(allText, 'all')}
        >
          {copiedIdx === 'all' ? '✓ Copied' : 'Copy all'}
        </button>
      </div>
      {errors.map((msg, i) => (
        <div key={i} className="v2-error-entry">
          <span className="v2-error-entry-num">{i + 1}</span>
          <span className="v2-error-entry-text">{msg}</span>
          <button
            type="button"
            className="v2-error-copy-one"
            title="Copy this error"
            onClick={() => copy(msg, i)}
          >
            {copiedIdx === i ? '✓' : '⎘'}
          </button>
        </div>
      ))}
    </div>
  )
}

// ─── Sidebar content ──────────────────────────────────────────────────────────

function SidebarContent({ models, selectedModelId, onModelChange, isRunning, onOpenModelSetup, onClose }) {
  return (
    <>
      {/* Brand */}
      <div className="v2-sidebar-brand">
        <img src="/BLUSWAN-logo-transparent.png" className="v2-sidebar-logo" alt="BLUSWAN" />
        <span className="v2-sidebar-brand-tag">V2</span>
        {onClose && (
          <button type="button" className="v2-sidebar-close" onClick={onClose} aria-label="Close menu">✕</button>
        )}
      </div>

      {/* GitHub */}
      <div className="v2-sidebar-section">
        <div className="v2-sidebar-section-label">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: '0.3rem', verticalAlign: 'middle' }}>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          GitHub Repository
        </div>
        <GitHubSection />
      </div>

      {/* Model */}
      <div className="v2-sidebar-section">
        <div className="v2-sidebar-section-label">AI Model</div>
        <select
          className="v2-model-select"
          value={selectedModelId}
          onChange={e => onModelChange?.(e.target.value)}
          disabled={isRunning}
        >
          {models.length === 0 && <option value="">No models configured</option>}
          {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button type="button" className="v2-sidebar-btn" style={{ marginTop: '0.5rem' }} onClick={onOpenModelSetup}>
          <span className="v2-sidebar-btn-icon">⚙</span>
          <span>Manage API Keys</span>
        </button>
      </div>

      {/* Engine */}
      <div className="v2-sidebar-footer">
        <div className="v2-sidebar-section-label" style={{ marginBottom: '0.5rem' }}>Engine</div>
        <EngineToggle position="sidebar" />
      </div>
    </>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TaskDashboard({
  v2State = {},
  onStartTask,
  models = [],
  selectedModelId = '',
  onModelChange,
  onModelsUpdate,
}) {
  const [goal, setGoal]                   = useState('')
  const [showModelSetup, setShowModelSetup] = useState(false)
  const [sidebarOpen, setSidebarOpen]     = useState(false)

  const {
    phase       = 'idle',
    plan        = null,
    cycles      = [],
    budget      = null,
    gates       = [],
    securityScan = null,
    taskSpec    = null,
    error       = null,
    events      = [],
    haltReason  = null,
  } = v2State

  const deliverables   = plan?.deliverables || []
  const completedCount = deliverables.filter(d => d.completed).length
  const isRunning      = RUNNING_PHASES.has(phase)
  const isTerminal     = TERMINAL_PHASES.has(phase)

  const selectedModel = models.find(m => m.id === selectedModelId) || models[0]
  const hasModel      = Boolean(selectedModel?.apiKey)

  const tokenPct = budget?.tokens ? Math.round(budget.tokens.used / budget.tokens.total * 100) : 0
  const cyclePct = budget?.cycles ? Math.round(budget.cycles.used / budget.cycles.total * 100) : 0

  // Collect all error strings from the main error field + error-type events
  const allErrors = [
    ...(error ? [String(error)] : []),
    ...(events || [])
      .filter(e => e.type === 'error')
      .map(e => e.message || (e.data ? JSON.stringify(e.data) : ''))
      .filter(Boolean),
  ]

  function handleStart(e) {
    e.preventDefault()
    if (!goal.trim() || !hasModel) return
    const taskId = 'task-' + Date.now().toString(36)
    onStartTask?.({
      taskId,
      goal: goal.trim(),
      // No plan — taskRunner generates it via LLM from the goal
      options: {
        maxCycles: 10, maxTurnsPerCycle: 100, contextWindow: 128000,
        requirePlanReview: false, requireCompletionConfirm: false,
      },
    })
  }

  const resultMeta      = RESULT_META[phase] || RESULT_META.failed
  const hasTopbarBudget = Boolean(budget?.tokens || budget?.cycles)

  const sidebarProps = {
    models, selectedModelId, onModelChange,
    isRunning,
    onOpenModelSetup: () => setShowModelSetup(true),
  }

  return (
    <div className="lk-root v2-root">

      {/* ── Mobile top bar ───────────────────────────────────────── */}
      <div className="v2-mobile-bar">
        <button
          type="button"
          className="v2-hamburger"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open settings"
        >
          <span /><span /><span />
        </button>
        <span className="v2-mobile-bar-brand">BLUSWAN</span>
        <span className="v2-mobile-bar-model">
          {selectedModel ? selectedModel.name : 'No model'}
        </span>
      </div>

      {/* ── Body row ─────────────────────────────────────────────── */}
      <div className="v2-body-row">

        {/* Desktop sidebar */}
        <aside className="v2-sidebar">
          <SidebarContent {...sidebarProps} />
        </aside>

        {/* Mobile sidebar overlay */}
        {sidebarOpen && (
          <div
            className="v2-sidebar-overlay"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Mobile sidebar (slide-in) */}
        <aside className={`v2-sidebar v2-sidebar--mobile${sidebarOpen ? ' v2-sidebar--open' : ''}`}>
          <SidebarContent {...sidebarProps} onClose={() => setSidebarOpen(false)} />
        </aside>

        {/* ── Main ───────────────────────────────────────────────── */}
        <div className="v2-main">

          {/* Topbar */}
          <div className="v2-topbar">
            <PhaseStepper phase={phase} />
            {hasTopbarBudget && (
              <div className="v2-topbar-right">
                {budget?.tokens && (
                  <div className="v2-topbar-budget-item">
                    <span>Ctx</span>
                    <div className="v2-topbar-mini-bar">
                      <div
                        className={`v2-topbar-mini-fill v2-topbar-mini-fill--${tokenPct > 85 ? 'danger' : tokenPct > 65 ? 'warn' : 'ok'}`}
                        style={{ width: `${Math.min(tokenPct, 100)}%` }}
                      />
                    </div>
                    <span>{tokenPct}%</span>
                  </div>
                )}
                {budget?.cycles && (
                  <div className="v2-topbar-budget-item">
                    <span>Cyc</span>
                    <div className="v2-topbar-mini-bar">
                      <div
                        className={`v2-topbar-mini-fill v2-topbar-mini-fill--${cyclePct > 85 ? 'danger' : cyclePct > 65 ? 'warn' : 'ok'}`}
                        style={{ width: `${Math.min(cyclePct, 100)}%` }}
                      />
                    </div>
                    <span>{cyclePct}%</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="v2-content">

            {/* Idle: Composer */}
            {phase === 'idle' && (
              <div className="v2-composer">
                <div className="v2-composer-inner">
                  <h1 className="v2-composer-heading">What do you want to build?</h1>
                  <p className="v2-composer-sub">
                    Describe your task. BLUSWAN V2 will plan, execute, and validate it.
                  </p>

                  {!hasModel && (
                    <div className="v2-composer-no-model">
                      <span>No model with API key configured.</span>
                      <button type="button" className="btn-secondary" onClick={() => setShowModelSetup(true)}>
                        Configure →
                      </button>
                    </div>
                  )}

                  <form onSubmit={handleStart}>
                    <textarea
                      className="v2-composer-textarea"
                      placeholder="e.g. Add a dark mode toggle to the settings page, update the CSS, and write a unit test for it."
                      value={goal}
                      onChange={e => setGoal(e.target.value)}
                      rows={5}
                    />

                    <div className="v2-composer-footer">
                      <button type="submit" className="v2-composer-submit" disabled={!goal.trim() || !hasModel}>
                        Start Task
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            {/* Running: Live exec feed */}
            {isRunning && (
              <div className="v2-exec-feed">
                {events.length === 0 ? (
                  <div className="v2-feed-waiting">
                    <span className="v2-feed-spinner" />
                    {phase === 'planning' ? 'Generating plan…' : `${phase.replace(/_/g, ' ')}…`}
                  </div>
                ) : (
                  events.map((ev, i) => <FeedEntry key={i} event={ev} />)
                )}
                {events.length > 0 && (
                  <div className="v2-feed-waiting">
                    <span className="v2-feed-spinner" />
                    <span>{phase.replace(/_/g, ' ')}…</span>
                  </div>
                )}
              </div>
            )}

            {/* Terminal: Result view */}
            {isTerminal && (
              <div className="v2-result">
                <div className="v2-result-card">
                  <div className="v2-result-header">
                    <span className="v2-result-icon">{resultMeta.icon}</span>
                    <h2 className={`v2-result-title v2-result-title--${resultMeta.titleClass}`}>
                      {resultMeta.title}
                    </h2>
                    <span className={`phase-badge phase-badge--${phase}`}>{phase}</span>
                  </div>

                  {(taskSpec?.goal || goal) && (
                    <div className="v2-result-goal">{taskSpec?.goal || goal}</div>
                  )}

                  <div className="v2-result-meta">
                    <div className="v2-result-meta-item">
                      <span className="v2-result-meta-label">Cycles</span>
                      <span className="v2-result-meta-value">{cycles.length}</span>
                    </div>
                    <div className="v2-result-meta-item">
                      <span className="v2-result-meta-label">Deliverables</span>
                      <span className="v2-result-meta-value">{completedCount}/{deliverables.length}</span>
                    </div>
                    {budget?.tokens && (
                      <div className="v2-result-meta-item">
                        <span className="v2-result-meta-label">Tokens</span>
                        <span className="v2-result-meta-value">{(budget.tokens.used / 1000).toFixed(1)}k</span>
                      </div>
                    )}
                  </div>

                  {haltReason && <div className="v2-result-halt-reason">{haltReason}</div>}
                  <ErrorLog errors={allErrors} />

                  <div className="v2-result-actions">
                    <button type="button" className="btn-primary" onClick={() => { setGoal(''); onStartTask?.(null) }}>
                      New Task
                    </button>
                    {phase !== 'done' && taskSpec && (
                      <button type="button" className="btn-secondary" onClick={() => onStartTask?.(taskSpec)}>
                        Retry
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

          </div>
        </div>

        {/* ── Right Panel ──────────────────────────────────────────── */}
        <aside className="v2-right-panel">
          <div className="v2-panel-section">
            <div className="v2-panel-section-title">
              <span>Deliverables</span>
              {deliverables.length > 0 && (
                <span className="status-badge status-badge--completed">{completedCount}/{deliverables.length}</span>
              )}
            </div>
            {deliverables.length === 0
              ? <div className="v2-panel-empty">No deliverables yet</div>
              : <DeliverableList deliverables={deliverables} />
            }
          </div>

          {(budget?.tokens || budget?.cycles) && (
            <div className="v2-panel-section">
              <div className="v2-panel-section-title"><span>Budget</span></div>
              {budget?.tokens && <BudgetBar used={budget.tokens.used} total={budget.tokens.total} label="Tokens" type="tokens" />}
              {budget?.cycles && <BudgetBar used={budget.cycles.used} total={budget.cycles.total} label="Cycles" type="cycles" />}
            </div>
          )}

          {gates.length > 0 && (
            <div className="v2-panel-section">
              <div className="v2-panel-section-title"><span>Quality Signals</span></div>
              <QualitySignals gates={gates} securityScan={securityScan} />
            </div>
          )}

          {allErrors.length > 0 && (
            <div className="v2-panel-section">
              <div className="v2-panel-section-title" style={{ color: 'var(--lk-danger)' }}>
                <span>Errors</span>
                <span className="status-badge status-badge--failed">{allErrors.length}</span>
              </div>
              <ErrorLog errors={allErrors} />
            </div>
          )}
        </aside>

      </div>{/* end .v2-body-row */}

      {/* ── ModelSetup Modal ──────────────────────────────────────── */}
      {showModelSetup && (
        <ModelSetup
          models={models}
          onSave={updated => onModelsUpdate?.(updated)}
          onClose={() => setShowModelSetup(false)}
        />
      )}
    </div>
  )
}
