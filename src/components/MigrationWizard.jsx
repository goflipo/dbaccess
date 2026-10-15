import React, { useReducer, useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { migrationBlocker, formatDuration, buildReportJson, stamp } from '../utils/migrationSupport'
import './MigrationWizard.css'

// ── Constants ───────────────────────────────────────────────
const STEP_KEYS = ['scope', 'options', 'review', 'confirm', 'run', 'result']
const STEP_LABELS = ['Scope', 'Options', 'Review', 'Confirm', 'Run', 'Result']
const PHASE_ORDER = ['types', 'sequences', 'tables', 'columns', 'data', 'constraints', 'indexes', 'views', 'sequence-sync', 'drops']
const PHASE_LABELS = {
  types: 'Types and enums', sequences: 'Sequences', tables: 'Tables', columns: 'Columns', data: 'Data copy',
  constraints: 'Constraints', indexes: 'Indexes', views: 'Views', 'sequence-sync': 'Sequence sync', drops: 'Drops',
}
const DEFAULT_OPTIONS = {
  dataMode: 'append', allowDrops: false, dropExtraTables: false, dropExtraColumns: false,
  alterTypes: true, createIndexes: true, createConstraints: true, createViews: true, syncSequences: true,
  batchSize: 1000, onError: 'stop',
}
const MIRROR_OPTIONS = { ...DEFAULT_OPTIONS, dataMode: 'truncate-copy', allowDrops: true, dropExtraTables: true, dropExtraColumns: true }
const DATA_MODES = [
  { id: 'append', label: 'Append', desc: 'Adds all source rows. Fails on duplicate keys. Best for empty target tables.' },
  { id: 'insert-missing', label: 'Insert missing only', desc: 'Skips rows whose key already exists. Never changes existing rows.', tag: 'recommended for non-empty targets', tagCls: 'green' },
  { id: 'upsert', label: 'Upsert', desc: 'Updates existing rows that have the same primary key with source values, and inserts the rest.', tag: 'overwrites target data', tagCls: 'yellow' },
  { id: 'truncate-copy', label: 'Replace', desc: 'Empties each target table first, then copies.', tag: 'DESTRUCTIVE: deletes target rows', tagCls: 'red' },
]
const GATE_RE = /^\s*(DROP|ALTER|TRUNCATE|DELETE)\b/i
const STALE_MS = 5 * 60 * 1000

const fmt = (n) => (n == null || isNaN(n) ? '-' : Number(n).toLocaleString())
const copyText = (t) => { try { return navigator.clipboard.writeText(t) } catch { return Promise.resolve() } }
const readSafeLS = () => { try { return localStorage.getItem('dbaccess:safeMode') !== 'false' } catch { return true } }
const connLabel = (c) => `${c?.name || c?.host || '?'}${c?.database ? ` / ${c.database}` : ''}`
const timeStr = (ts) => new Date(ts).toLocaleTimeString()

// ── Icons ───────────────────────────────────────────────────
const ICONS = {
  check: <path d="M20 6L9 17l-5-5" />,
  x: <path d="M18 6L6 18M6 6l12 12" />,
  warn: <><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  info: <><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>,
  copy: <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></>,
  dash: <path d="M5 12h14" />,
  circle: <circle cx="12" cy="12" r="8" />,
  arrow: <path d="M5 12h14M12 5l7 7-7 7" />,
}
function Icon({ name, size = 13 }) {
  return <svg className="mw-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>
}

// ── Small shared pieces ─────────────────────────────────────
function CopyBtn({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="mw-btn mw-btn-ghost mw-btn-sm" onClick={() => { copyText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
      <Icon name={done ? 'check' : 'copy'} size={12} />{done ? 'Copied' : label}
    </button>
  )
}

// Long messages go into <details>; never raw stack as the primary line.
function ErrorBox({ message, onRetry, onBack }) {
  const msg = String(message || 'Unknown error')
  const [first, ...rest] = msg.split('\n')
  return (
    <div className="mw-error-panel" role="alert">
      <div className="mw-error-title"><Icon name="x" />{first.length > 220 ? first.slice(0, 220) + '…' : first}</div>
      {(rest.length > 0 || first.length > 220) && <details><summary>Details</summary><pre className="mw-pre">{msg}</pre></details>}
      <div className="mw-row">
        <CopyBtn text={msg} label="Copy error" />
        {onRetry && <button type="button" className="mw-btn mw-btn-sm" onClick={onRetry}>Retry</button>}
        {onBack && <button type="button" className="mw-btn mw-btn-ghost mw-btn-sm" onClick={onBack}>Back</button>}
      </div>
    </div>
  )
}

function ProgressBar({ value, max, label, status }) {
  const determinate = max != null && max > 0
  const pct = determinate ? Math.min(100, (value / max) * 100) : 0
  return (
    <div className="mw-bar" role="progressbar" aria-label={label} aria-valuemin={0}
      {...(determinate ? { 'aria-valuemax': max, 'aria-valuenow': value } : {})}>
      <div className={`mw-bar-fill ${status || ''} ${determinate ? '' : 'indeterminate'}`} style={determinate ? { width: `${pct}%` } : undefined} />
    </div>
  )
}

function Tabs({ tabs, active, onChange, idPrefix }) {
  const onKey = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const i = tabs.findIndex(t => t.id === active)
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    onChange(n.id)
    setTimeout(() => document.getElementById(`${idPrefix}-tab-${n.id}`)?.focus(), 0)
  }
  return (
    <div className="mw-tabs" role="tablist" onKeyDown={onKey}>
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" id={`${idPrefix}-tab-${t.id}`} aria-selected={active === t.id}
          aria-controls={`${idPrefix}-panel`} tabIndex={active === t.id ? 0 : -1}
          className={`mw-tab ${active === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  )
}

function Stepper({ current, maxStep, disabled, hasError, onGo }) {
  return (
    <ol className="mw-stepper" aria-label="Migration steps">
      {STEP_LABELS.map((label, i) => {
        const done = i < current
        const clickable = i <= 3 && i <= maxStep && !disabled && i !== current
        const cls = i === current ? (hasError ? 'error' : 'current') : done ? 'done' : 'future'
        return (
          <li key={label} className={`mw-step ${cls}`} aria-current={i === current ? 'step' : undefined}>
            <button type="button" className="mw-step-btn" disabled={!clickable} onClick={() => onGo(i)}>
              <span className="mw-step-dot">{done ? <Icon name="check" size={11} /> : i + 1}</span>
              <span className="mw-step-label">{label}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

// ── Reducer ─────────────────────────────────────────────────
function initState(selectedTables) {
  return {
    step: 0, maxStep: 0, mode: 'schema', tables: [...(selectedTables || [])],
    options: { ...DEFAULT_OPTIONS }, dryRun: false,
    plan: null, planKey: null, plannedAt: null, planStatus: 'idle', planError: null,
    confirmText: '', ackBackup: false, restoreSafe: true, notice: null, announce: '',
    runId: null, runStatus: 'idle', startedAt: null, phases: {}, curPhase: null, phaseMsg: {},
    tableProgress: {}, log: [], stepResults: {}, report: null, verify: null, safeTurnedOff: false,
  }
}

// Any change to scope/options invalidates the plan.
const invalidate = (s) => ({
  ...s, plan: null, planKey: null, plannedAt: null, planStatus: 'idle', planError: null,
  confirmText: '', ackBackup: false, maxStep: Math.min(s.maxStep, 1),
})

function normalizeOptions(o) {
  const n = { ...o }
  if (!n.allowDrops) { n.dropExtraTables = false; n.dropExtraColumns = false }
  return n
}

function pushLog(log, level, message) {
  const next = log.length >= 500 ? log.slice(log.length - 499) : log.slice()
  next.push({ ts: Date.now(), level: level || 'info', message: String(message ?? '') })
  return next
}

function applyEvent(s, e) {
  switch (e.type) {
    case 'phase': {
      const phases = { ...s.phases }
      if (s.curPhase && phases[s.curPhase] === 'active') phases[s.curPhase] = 'ok'
      if (e.phase) phases[e.phase] = 'active'
      return { ...s, phases, curPhase: e.phase || s.curPhase, announce: `Phase: ${e.phase} started`, log: e.message ? pushLog(s.log, 'info', e.message) : s.log }
    }
    case 'step': {
      const st = e.status || (e.level === 'error' ? 'error' : 'running')
      const phases = st === 'error' && s.curPhase ? { ...s.phases, [s.curPhase]: 'error' } : s.phases
      return {
        ...s, phases, stepResults: e.stepId ? { ...s.stepResults, [e.stepId]: st } : s.stepResults,
        phaseMsg: s.curPhase && e.message ? { ...s.phaseMsg, [s.curPhase]: e.message } : s.phaseMsg,
        log: e.message ? pushLog(s.log, st === 'error' ? 'error' : e.level, e.message) : s.log,
      }
    }
    case 'rows': {
      if (!e.table) return s
      const total = e.rowsTotal ?? s.tableProgress[e.table]?.rowsTotal ?? 0
      const done = e.rowsDone ?? 0
      const status = s.tableProgress[e.table]?.status === 'error' ? 'error' : (total > 0 && done >= total) || total === 0 ? 'done' : 'running'
      return { ...s, tableProgress: { ...s.tableProgress, [e.table]: { rowsDone: done, rowsTotal: total, status } } }
    }
    case 'error': {
      const phases = s.curPhase ? { ...s.phases, [s.curPhase]: 'error' } : s.phases
      const tp = e.table ? { ...s.tableProgress, [e.table]: { ...(s.tableProgress[e.table] || { rowsDone: 0, rowsTotal: 0 }), status: 'error' } } : s.tableProgress
      return { ...s, phases, tableProgress: tp, stepResults: e.stepId ? { ...s.stepResults, [e.stepId]: 'error' } : s.stepResults, log: pushLog(s.log, 'error', e.message) }
    }
    case 'log': return { ...s, log: pushLog(s.log, e.level, e.message) }
    case 'done': return { ...s, log: pushLog(s.log, 'info', e.message || 'Migration finished') }
    default: return s
  }
}

function reducer(s, a) {
  switch (a.type) {
    case 'PATCH': return { ...s, ...a.patch }
    case 'SET_MODE': return invalidate({ ...s, mode: a.mode, options: { ...s.options } })
    case 'SET_TABLES': return invalidate({ ...s, tables: a.tables })
    case 'SET_OPTS': return invalidate({ ...s, options: normalizeOptions({ ...s.options, ...a.patch }) })
    case 'SET_DRY': return { ...s, dryRun: a.value, confirmText: '', ackBackup: false }
    case 'GO': return { ...s, step: a.step, maxStep: Math.max(s.maxStep, a.step) }
    case 'PLAN_IDLE': return { ...s, plan: null, planKey: null, planStatus: 'idle', planError: null, confirmText: '', ackBackup: false, maxStep: Math.min(s.maxStep, 2) }
    case 'PLAN_LOADING': return { ...s, planStatus: 'loading', planError: null }
    case 'PLAN_OK': return {
      ...s, plan: a.plan, planKey: a.key, plannedAt: a.at, planStatus: 'ready', planError: null,
      announce: `Plan ready: ${a.plan?.steps?.length || 0} steps, ${a.plan?.warnings?.length || 0} warnings`,
    }
    case 'PLAN_ERR': return { ...s, planStatus: 'error', planError: a.error }
    case 'RUN_START': return {
      ...s, step: 4, maxStep: 4, runId: a.runId, runStatus: 'running', startedAt: Date.now(), phases: {}, curPhase: null, phaseMsg: {},
      tableProgress: {}, log: [], stepResults: {}, report: null, verify: null, planError: null, notice: null,
    }
    case 'EVENTS': return a.events.reduce(applyEvent, s)
    case 'CANCELLING': return { ...s, runStatus: 'cancelling' }
    case 'RUN_DONE': return {
      ...s, step: 5, maxStep: 5, runStatus: 'done', report: a.report, announce: `Migration finished: ${a.report?.status}`,
    }
    case 'RETRY': return invalidate({ ...s, step: 2, maxStep: 1, tables: a.tables, options: normalizeOptions({ ...s.options, ...a.optsPatch }), notice: a.notice, report: null, runStatus: 'idle', verify: null })
    case 'AGAIN': return { ...s, step: 0, maxStep: 0, plan: null, planKey: null, planStatus: 'idle', report: null, runStatus: 'idle', verify: null, confirmText: '', ackBackup: false, notice: null }
    default: return s
  }
}

// ── Main component ──────────────────────────────────────────
export default function MigrationWizard({
  srcId, tgtId, srcConn, tgtConn, schemaDiff, selectedTables,
  safeMode: safeProp, onToggleSafeMode, onRequestSafeModeOff, onStatus, onClose,
}) {
  const allTables = useMemo(() => schemaDiff?.all || [], [schemaDiff])
  const [state, dispatch] = useReducer(reducer, selectedTables, initState)
  const stateRef = useRef(state)
  stateRef.current = state

  // Safe mode: live prop, with a localStorage fallback for older call sites.
  const [localSafe, setLocalSafe] = useState(readSafeLS)
  const safeMode = safeProp !== undefined ? safeProp : localSafe
  const setSafe = useCallback((v) => {
    if (onToggleSafeMode) onToggleSafeMode(v)
    else if (onRequestSafeModeOff && v === false) onRequestSafeModeOff()
    else { try { localStorage.setItem('dbaccess:safeMode', String(v)) } catch { /* ignore */ } setLocalSafe(v) }
  }, [onToggleSafeMode, onRequestSafeModeOff])
  const safeRef = useRef({ safeMode, setSafe, onStatus })
  safeRef.current = { safeMode, setSafe, onStatus }

  const blocker = useMemo(() => migrationBlocker(srcConn, tgtConn, srcId, tgtId), [srcConn, tgtConn, srcId, tgtId])
  const running = state.runStatus === 'running' || state.runStatus === 'cancelling'

  const buildOptions = useCallback((s, forPlan) => {
    const o = s.options
    // target-only tables do not exist in the source: never send them (the planner would raise a blocker)
    const names = allTables.filter(t => t.status !== 'onlyTarget').map(t => t.name)
    const nameSet = new Set(names)
    const chosen = s.tables.filter(n => nameSet.has(n))
    return {
      tables: chosen.length === names.length ? null : chosen,
      includeSchema: true, includeData: s.mode === 'schema+data', dataMode: o.dataMode,
      allowDrops: o.allowDrops, dropExtraTables: o.allowDrops && o.dropExtraTables, dropExtraColumns: o.allowDrops && o.dropExtraColumns,
      alterTypes: o.alterTypes, createIndexes: o.createIndexes, createConstraints: o.createConstraints,
      createViews: o.createViews, syncSequences: o.syncSequences,
      batchSize: Math.min(10000, Math.max(100, Number(o.batchSize) || 1000)), onError: o.onError,
      dryRun: forPlan ? true : s.dryRun,
    }
  }, [allTables])

  const currentKey = useMemo(() => JSON.stringify([srcId, tgtId, [...state.tables].sort(), state.mode, state.options]),
    [srcId, tgtId, state.tables, state.mode, state.options])
  const planFresh = !!state.plan && state.planKey === currentKey

  // ── Planning (stale responses discarded via planSeq + key check) ──
  const planSeq = useRef(0)
  const requestPlan = useCallback(async () => {
    const seq = ++planSeq.current
    const s = stateRef.current
    const key = JSON.stringify([srcId, tgtId, [...s.tables].sort(), s.mode, s.options])
    dispatch({ type: 'PLAN_LOADING' })
    try {
      const fn = window.dbAccess?.migrationPlan
      if (!fn) throw new Error('Migration is not available in this build (the migrationPlan bridge is missing).')
      const res = await fn(srcId, tgtId, buildOptions(s, true))
      if (seq !== planSeq.current) return
      if (!res?.success) throw new Error(res?.error || 'Planning failed')
      const cur = stateRef.current
      if (JSON.stringify([srcId, tgtId, [...cur.tables].sort(), cur.mode, cur.options]) !== key) return // options changed meanwhile
      dispatch({ type: 'PLAN_OK', plan: res.data, key, at: Date.now() })
    } catch (e) {
      if (seq === planSeq.current) dispatch({ type: 'PLAN_ERR', error: e?.message || String(e) })
    }
  }, [srcId, tgtId, buildOptions])

  useEffect(() => {
    if (state.step === 2 && state.planStatus === 'idle' && !blocker) requestPlan()
  }, [state.step, state.planStatus, blocker, requestPlan])

  // ── Run lifecycle ──
  const runIdRef = useRef(null)
  const offRef = useRef(null)
  const bufRef = useRef([])
  const turnedOffRef = useRef(false)

  const flush = useCallback(() => {
    if (bufRef.current.length) dispatch({ type: 'EVENTS', events: bufRef.current.splice(0) })
  }, [])

  useEffect(() => {
    if (!running) return undefined
    const t = setInterval(flush, 150)
    return () => clearInterval(t)
  }, [running, flush])

  const restoreSafeIfNeeded = useCallback(() => {
    if (turnedOffRef.current && stateRef.current.restoreSafe) { turnedOffRef.current = false; safeRef.current.setSafe(true) }
  }, [])

  const startRunInner = useCallback(async () => {
    const s = stateRef.current
    const opts = buildOptions(s, false)
    const plan = s.plan
    const destructiveCount = (plan?.steps || []).filter(x => x.destructive).length
    const truncates = opts.includeData && opts.dataMode === 'truncate-copy' ? (plan?.dataPlan || []).length : 0
    if (!s.dryRun && (destructiveCount || truncates || opts.allowDrops)) {
      const ok = await window.dbAccess?.confirm?.({
        type: 'warning', title: 'Start migration', message: `Migrate into "${connLabel(tgtConn)}"?`,
        detail: `${destructiveCount} destructive step(s), ${truncates} table(s) will be emptied.`, confirmLabel: 'Migrate', cancelLabel: 'Cancel',
      })
      if (ok === false) return
    }
    const runId = 'mig-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    runIdRef.current = runId
    bufRef.current = []
    dispatch({ type: 'RUN_START', runId })
    safeRef.current.onStatus?.('Migration running…', 'info')
    const off = window.dbAccess?.onMigrationProgress?.((evt) => { if (evt && evt.runId === runId) bufRef.current.push(evt) })
    offRef.current = off || null
    let report
    try {
      if (!window.dbAccess?.migrationRun) throw new Error('Migration is not available in this build (the migrationRun bridge is missing).')
      const res = await window.dbAccess.migrationRun(runId, srcId, tgtId, opts)
      if (!res?.success) throw new Error(res?.error || 'Migration failed to start')
      report = res.data
    } catch (e) {
      report = { runId, status: 'failed', steps: [], tables: [], errors: [{ where: 'run', message: e?.message || String(e) }], durationMs: Date.now() - s.startedAt }
    } finally {
      try { off?.() } catch { /* ignore */ }
      offRef.current = null
    }
    flush()
    runIdRef.current = null
    dispatch({ type: 'RUN_DONE', report })
    safeRef.current.onStatus?.(report.status === 'success' ? 'Migration finished' : `Migration ${report.status}`, report.status === 'success' ? 'success' : 'error')
    restoreSafeIfNeeded()
  }, [buildOptions, srcId, tgtId, tgtConn, flush, restoreSafeIfNeeded])

  const startingRef = useRef(false)
  const startRun = useCallback(async () => {
    if (startingRef.current) return   // a confirm dialog or run is already in flight
    startingRef.current = true
    try { await startRunInner() } finally { startingRef.current = false }
  }, [startRunInner])

  const cancelRun = useCallback(async () => {
    if (!runIdRef.current) return
    dispatch({ type: 'CANCELLING' })
    try { await window.dbAccess?.migrationCancel?.(runIdRef.current) } catch { /* report will still arrive */ }
  }, [])

  // Unmount mid-run: cancel, unsubscribe, restore safe mode.
  useEffect(() => () => {
    if (runIdRef.current) { try { window.dbAccess?.migrationCancel?.(runIdRef.current) } catch { /* ignore */ } }
    try { offRef.current?.() } catch { /* ignore */ }
    if (turnedOffRef.current && stateRef.current.restoreSafe) safeRef.current.setSafe(true)
  }, [])

  // Warn on accidental window close while running.
  useEffect(() => {
    if (!running) return undefined
    const h = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [running])

  // ── Dialog behaviour: focus, trap, Esc ──
  const modalRef = useRef(null)
  const headingRef = useRef(null)
  const lastFocus = useRef(null)
  useEffect(() => {
    lastFocus.current = document.activeElement
    return () => { try { if (lastFocus.current && document.contains(lastFocus.current)) lastFocus.current.focus() } catch { /* ignore */ } }
  }, [])
  useEffect(() => { headingRef.current?.focus() }, [state.step])

  const close = useCallback(() => {
    if (stateRef.current.runStatus === 'running' || stateRef.current.runStatus === 'cancelling') return
    const r = stateRef.current.report
    onClose?.({ ran: !!r && !stateRef.current.dryRun })
  }, [onClose])

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return }
    if (e.key !== 'Tab' || !modalRef.current) return
    const f = [...modalRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')]
      .filter(el => el.offsetParent !== null)
    if (!f.length) return
    const first = f[0], last = f[f.length - 1]
    if (e.shiftKey && (document.activeElement === first || !modalRef.current.contains(document.activeElement))) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }

  // ── Navigation ──
  const blockers = (state.plan?.warnings || []).filter(w => w.level === 'blocker')
  const planEmpty = planFresh && !(state.plan.steps || []).length && !(state.plan.dataPlan || []).some(d => (d.sourceRows || 0) > 0)
  const go = (i) => dispatch({ type: 'GO', step: i })

  let nextDisabled = false, nextReason = ''
  if (state.step === 0) {
    if (blocker) { nextDisabled = true; nextReason = blocker.title }
    else if (!state.tables.length) { nextDisabled = true; nextReason = 'Select at least one table' }
  } else if (state.step === 1) {
    if (blocker) nextDisabled = true
  } else if (state.step === 2) {
    if (state.planStatus !== 'ready' || !planFresh) { nextDisabled = true; nextReason = 'Plan not ready' }
    else if (blockers.length) { nextDisabled = true; nextReason = `Resolve ${blockers.length} blocker(s) first` }
  }

  const stepDesc = ['Choose what to migrate.', 'Choose how to migrate.', 'Review the generated plan.', 'Confirm and start.', 'Migration in progress.', 'Migration result.'][state.step]
  const hasRunError = state.step === 5 && state.report && state.report.status !== 'success'

  return (
    <div className="mw-overlay">
      <div className="mw-modal" role="dialog" aria-modal="true" aria-labelledby="mw-title" aria-describedby="mw-step-desc" ref={modalRef} onKeyDown={onKeyDown}>
        {/* ── Header ── */}
        <div className="mw-header">
          <h2 id="mw-title" className="mw-title">Migrate database</h2>
          <div className="mw-endpoints">
            <span className="mw-chip"><span className="mw-chip-type">{srcConn?.type}</span>{connLabel(srcConn)}</span>
            <Icon name="arrow" size={14} />
            <span className={`mw-chip ${state.options.allowDrops || state.options.dataMode === 'truncate-copy' ? 'mw-chip-danger' : ''}`}>
              <span className="mw-chip-type">{tgtConn?.type}</span>{connLabel(tgtConn)}
            </span>
          </div>
          <button type="button" className="mw-close" onClick={close} disabled={running} aria-label="Close"
            title={running ? 'Cancel the migration first' : 'Close'}><Icon name="x" size={14} /></button>
        </div>

        <Stepper current={state.step} maxStep={blocker ? 0 : state.maxStep} disabled={running || state.step >= 4} hasError={hasRunError} onGo={go} />

        {blocker && (
          <div className="mw-banner mw-banner-red" role="alert">
            <Icon name="x" size={14} />
            <div><strong>{blocker.title}</strong><div>{blocker.body}</div>{blocker.tip && <div className="mw-dim">{blocker.tip}</div>}</div>
          </div>
        )}

        {/* ── Body ── */}
        <div className="mw-body">
          <h3 className="mw-step-title" tabIndex={-1} ref={headingRef}>{STEP_LABELS[state.step]}</h3>
          <p id="mw-step-desc" className="mw-sr-only">{stepDesc}</p>
          {state.step === 0 && <StepScope state={state} dispatch={dispatch} allTables={allTables} />}
          {state.step === 1 && <StepOptions state={state} dispatch={dispatch} allTables={allTables} />}
          {state.step === 2 && <StepReview state={state} dispatch={dispatch} srcConn={srcConn} tgtConn={tgtConn} blockers={blockers}
            onRetry={() => dispatch({ type: 'PLAN_IDLE' })} onBack={() => go(1)} onClose={close} planEmpty={planEmpty} />}
          {state.step === 3 && <StepConfirm state={state} dispatch={dispatch} tgtConn={tgtConn} safeMode={safeMode}
            onTurnOffSafe={async () => {
              const ok = await window.dbAccess?.confirm?.({ type: 'warning', title: 'Turn off Safe Mode?', message: 'Safe Mode will be turned off for the whole app.', detail: 'You can turn it back on from the status bar.', confirmLabel: 'Turn off', cancelLabel: 'Keep on' })
              if (ok === false) return
              turnedOffRef.current = true
              dispatch({ type: 'PATCH', patch: { safeTurnedOff: true } })
              setSafe(false)
            }}
            onBack={() => go(2)} />}
          {state.step === 4 && <StepRun state={state} />}
          {state.step === 5 && <StepResult state={state} dispatch={dispatch} srcId={srcId} tgtId={tgtId} srcConn={srcConn} tgtConn={tgtConn}
            allTables={allTables} buildOptions={buildOptions} safeMode={safeMode} onRestoreSafe={() => { turnedOffRef.current = false; setSafe(true); dispatch({ type: 'PATCH', patch: { safeTurnedOff: false } }) }} />}
        </div>

        <div className="mw-sr-only" aria-live="polite">{state.announce}</div>

        {/* ── Footer ── */}
        <div className="mw-footer">
          <div className="mw-footer-status">
            {state.step >= 2 && state.step <= 3 && !planFresh && state.planStatus !== 'loading' && <span className="mw-pill mw-pill-yellow">Plan outdated</span>}
            {state.dryRun && state.step < 5 && <span className="mw-pill mw-pill-blue">Dry run</span>}
            {nextDisabled && nextReason && <span className="mw-dim" id="mw-next-reason">{nextReason}</span>}
          </div>
          <div className="mw-footer-actions">
            {state.step >= 1 && state.step <= 3 && <button type="button" className="mw-btn" onClick={() => go(state.step - 1)}>Back</button>}
            {state.step === 0 && <button type="button" className="mw-btn" onClick={close}>Cancel</button>}
            {state.step <= 1 && <button type="button" className="mw-btn mw-btn-primary" disabled={nextDisabled} aria-describedby={nextDisabled ? 'mw-next-reason' : undefined}
              onClick={() => go(state.step + 1)}>{state.step === 0 ? 'Next: Options' : 'Next: Review plan'}</button>}
            {state.step === 2 && (planEmpty
              ? <button type="button" className="mw-btn mw-btn-primary" onClick={close}>Close</button>
              : <button type="button" className="mw-btn mw-btn-primary" disabled={nextDisabled} aria-describedby={nextDisabled ? 'mw-next-reason' : undefined}
                onClick={() => go(3)}>Next: Confirm</button>)}
            {state.step === 3 && <ConfirmRunButton state={state} tgtConn={tgtConn} safeMode={safeMode} planFresh={planFresh} blockers={blockers} onRun={startRun} />}
            {state.step === 4 && (
              <button type="button" className="mw-btn mw-btn-danger-outline" disabled={state.runStatus === 'cancelling'} onClick={cancelRun}>
                {state.runStatus === 'cancelling' ? 'Cancelling…' : 'Cancel migration'}
              </button>
            )}
            {state.step === 5 && <>
              <button type="button" className="mw-btn" onClick={() => dispatch({ type: 'AGAIN' })}>Run again</button>
              <button type="button" className="mw-btn" onClick={() => { dispatch({ type: 'PLAN_IDLE' }); go(2) }}>Re-plan</button>
              <button type="button" className={`mw-btn ${state.report?.status === 'success' ? 'mw-btn-primary' : ''}`} onClick={close}>Close</button>
            </>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Confirm helpers (shared by StepConfirm + footer button) ──
function confirmFlags(state, tgtConn) {
  const { plan, options, mode, dryRun } = state
  const includeData = mode === 'schema+data'
  const steps = plan?.steps || []
  const hasDestructive = steps.some(s => s.destructive) || (includeData && options.dataMode === 'truncate-copy') || options.allowDrops
  const hasOverwrite = includeData && options.dataMode === 'upsert'
  const targetNonEmpty = (plan?.dataPlan || []).some(d => (d.targetRows || 0) > 0)
  const gatedSteps = steps.filter(s => s.destructive || GATE_RE.test(s.sql || '')).length
  const truncates = includeData && options.dataMode === 'truncate-copy' ? (plan?.dataPlan || []).length : 0
  const gated = !dryRun && (gatedSteps > 0 || truncates > 0)
  const expected = (tgtConn?.database || tgtConn?.name || '').trim()
  return { hasDestructive, hasOverwrite, targetNonEmpty, gatedSteps, truncates, gated, expected, needTyped: hasDestructive && !dryRun, needAck: !dryRun }
}

function unmetConditions(state, tgtConn, safeMode, planFresh, blockers) {
  const f = confirmFlags(state, tgtConn)
  const out = []
  if (!planFresh) out.push('Plan is out of date. Re-plan to continue.')
  else if (Date.now() - (state.plannedAt || 0) > STALE_MS) out.push('Plan is older than 5 minutes. Re-plan to continue.')
  if (blockers.length) out.push(`Resolve ${blockers.length} blocker(s)`)
  if (f.needTyped && state.confirmText.trim() !== f.expected) out.push('Type the target database name')
  if (f.needAck && !state.ackBackup) out.push('Tick the backup acknowledgement')
  if (safeMode && f.gated) out.push('Safe Mode is on')
  return out
}

function ConfirmRunButton({ state, tgtConn, safeMode, planFresh, blockers, onRun }) {
  const unmet = unmetConditions(state, tgtConn, safeMode, planFresh, blockers)
  const f = confirmFlags(state, tgtConn)
  const label = state.dryRun ? 'Run dry run' : f.hasDestructive ? 'Start destructive migration' : 'Start migration'
  return (
    <button type="button" className={`mw-btn ${f.hasDestructive && !state.dryRun ? 'mw-btn-danger' : 'mw-btn-primary'}`}
      disabled={unmet.length > 0} aria-describedby="mw-unmet" onClick={onRun}>{label}</button>
  )
}

// ── Step 1: Scope ───────────────────────────────────────────
const STATUS_INFO = {
  onlySource: { label: 'new in target', cls: 'green' },
  different: { label: 'differs', cls: 'yellow' },
  same: { label: 'identical', cls: 'gray' },
  onlyTarget: { label: 'target only', cls: 'red' },
}

function StepScope({ state, dispatch, allTables }) {
  const [filter, setFilter] = useState('')
  const sel = useMemo(() => new Set(state.tables), [state.tables])
  const counts = useMemo(() => allTables.filter(t => sel.has(t.name)).reduce((a, t) => { a[t.status] = (a[t.status] || 0) + 1; return a }, {}), [allTables, sel])
  const visible = useMemo(() => allTables.filter(t => !filter || t.name.toLowerCase().includes(filter.toLowerCase())), [allTables, filter])
  const shown = visible.slice(0, 200)
  const setTables = (names) => dispatch({ type: 'SET_TABLES', tables: names })
  const toggle = (name) => setTables(sel.has(name) ? state.tables.filter(n => n !== name) : [...state.tables, name])
  const onlyIdentical = state.tables.length > 0 && state.tables.every(n => allTables.find(t => t.name === n)?.status === 'same')

  const onModeKey = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const next = state.mode === 'schema' ? 'schema+data' : 'schema'
    dispatch({ type: 'SET_MODE', mode: next })
    setTimeout(() => document.getElementById(`mw-mode-${next}`)?.focus(), 0)
  }

  return (
    <div className="mw-section">
      <p className="mw-info"><Icon name="info" />Same-engine migration only. Cross-engine migration (for example PostgreSQL to MySQL) is not supported.</p>
      <h4 className="mw-h4">What do you want to migrate?</h4>
      <div className="mw-cards" role="radiogroup" aria-label="Migration mode" onKeyDown={onModeKey}>
        {[
          { id: 'schema', t: 'Schema only', d: 'Creates missing tables, columns, indexes, constraints and views in the target. No rows are copied.' },
          { id: 'schema+data', t: 'Schema and data', d: 'Also copies the rows, in foreign-key order, in batches. Sequences are re-synced afterwards.' },
        ].map(m => (
          <button key={m.id} type="button" role="radio" id={`mw-mode-${m.id}`} aria-checked={state.mode === m.id} tabIndex={state.mode === m.id ? 0 : -1}
            className={`mw-radio-card ${state.mode === m.id ? 'active' : ''}`} onClick={() => dispatch({ type: 'SET_MODE', mode: m.id })}>
            <span className="mw-radio-card-title">{m.t}</span><span className="mw-dim">{m.d}</span>
          </button>
        ))}
      </div>

      <div className="mw-card">
        <div className="mw-card-head">
          <strong>{state.tables.length} tables selected of {allTables.length}</strong>
          <span className="mw-presets">
            <button type="button" className="mw-link" onClick={() => setTables(allTables.filter(t => t.status !== 'onlyTarget').map(t => t.name))}>All</button>
            <button type="button" className="mw-link" onClick={() => setTables(allTables.filter(t => t.status === 'onlySource').map(t => t.name))}>Only missing in target</button>
            <button type="button" className="mw-link" onClick={() => setTables(allTables.filter(t => t.status === 'different').map(t => t.name))}>Only differing</button>
            <button type="button" className="mw-link" onClick={() => setTables([])}>None</button>
          </span>
        </div>
        <div className="mw-chips">
          <span className="mw-pill mw-pill-green">{counts.onlySource || 0} new in target (will be created)</span>
          <span className="mw-pill mw-pill-yellow">{counts.different || 0} differ (will be altered)</span>
          <span className="mw-pill mw-pill-gray">{counts.same || 0} identical</span>
          <span className="mw-pill mw-pill-red">{counts.onlyTarget || 0} exist only in the target (never touched unless drops are enabled)</span>
        </div>
        {onlyIdentical && <p className="mw-dim">Nothing to migrate for schema. Data copy is still possible.</p>}

        {state.tables.length === 0 ? (
          <div className="mw-empty">
            No tables selected. Pick tables below, or
            <button type="button" className="mw-btn mw-btn-sm" onClick={() => setTables(allTables.filter(t => t.status !== 'same' && t.status !== 'onlyTarget').map(t => t.name))}>Select all differing tables</button>
          </div>
        ) : null}

        <input className="mw-input" placeholder="Filter tables…" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter tables" />
        <ul className="mw-table-list">
          {shown.map(t => {
            const si = STATUS_INFO[t.status] || STATUS_INFO.same
            return (
              <li key={t.name}>
                <label className="mw-check-row">
                  <input type="checkbox" checked={sel.has(t.name)} onChange={() => toggle(t.name)} />
                  <span className="mw-mono">{t.name}</span>
                  <span className={`mw-pill mw-pill-${si.cls}`}>{si.label}</span>
                </label>
              </li>
            )
          })}
          {visible.length > shown.length && <li className="mw-dim mw-pad">+{visible.length - shown.length} more (use the filter)</li>}
        </ul>
      </div>
    </div>
  )
}

// ── Step 2: Options ─────────────────────────────────────────
function Toggle({ checked, onChange, label, desc, disabled, tag, tagCls, locked }) {
  return (
    <label className={`mw-opt ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled || locked} onChange={e => onChange?.(e.target.checked)} />
      <span className="mw-opt-text">
        <span className="mw-opt-label">{label}{tag && <span className={`mw-pill mw-pill-${tagCls}`}>{tag}</span>}</span>
        <span className="mw-dim">{desc}</span>
      </span>
    </label>
  )
}

function StepOptions({ state, dispatch, allTables }) {
  const o = state.options
  const includeData = state.mode === 'schema+data'
  const [dropsOpen, setDropsOpen] = useState(o.allowDrops)
  const set = (patch) => dispatch({ type: 'SET_OPTS', patch })

  const sel = new Set(state.tables)
  const extraTables = allTables.filter(t => t.status === 'onlyTarget' && sel.has(t.name)).length
  const extraCols = (schemaDiffCols(allTables, sel))
  const preset = JSON.stringify(normalizeOptions(o)) === JSON.stringify(DEFAULT_OPTIONS) ? 'safe'
    : JSON.stringify(normalizeOptions(o)) === JSON.stringify(MIRROR_OPTIONS) ? 'mirror' : 'custom'

  const summary = []
  summary.push('Create missing tables and columns')
  if (o.alterTypes) summary.push('convert differing column types')
  const extras = [o.createIndexes && 'indexes', o.createConstraints && 'constraints', o.createViews && 'views'].filter(Boolean)
  if (extras.length) summary.push(`add ${extras.join(', ')}`)
  if (includeData) {
    const m = DATA_MODES.find(d => d.id === o.dataMode)
    summary.push(`copy rows (${m.label.toLowerCase()})`)
    if (o.syncSequences) summary.push('re-sync sequences')
  }
  const text = summary.join(', ') + '. ' + (o.allowDrops
    ? `Drops enabled: ${[o.dropExtraTables && 'extra tables', o.dropExtraColumns && 'extra columns'].filter(Boolean).join(' and ') || 'none selected'}.`
    : 'Nothing is deleted.') + (includeData && o.dataMode === 'truncate-copy' ? ' Target tables are emptied first.' : '')

  return (
    <div className="mw-split">
      <div className="mw-section">
        <div className="mw-seg" role="group" aria-label="Presets">
          <button type="button" className={`mw-seg-btn ${preset === 'safe' ? 'active' : ''}`} onClick={() => dispatch({ type: 'SET_OPTS', patch: DEFAULT_OPTIONS })}>Safe (recommended)</button>
          <button type="button" className={`mw-seg-btn ${preset === 'mirror' ? 'active' : ''}`} onClick={() => { setDropsOpen(true); dispatch({ type: 'SET_OPTS', patch: MIRROR_OPTIONS }) }}>Mirror (replace target)</button>
          <button type="button" className={`mw-seg-btn ${preset === 'custom' ? 'active' : ''}`} disabled>Custom</button>
        </div>

        <fieldset className="mw-group"><legend>Structure</legend>
          <Toggle checked locked label="Create missing tables and columns" desc="Required for schema migration." />
          <Toggle checked={o.alterTypes} onChange={v => set({ alterTypes: v })} label="Change column types where they differ" desc="Converted with an explicit cast. May fail if existing values cannot be converted." />
          <Toggle checked={o.createIndexes} onChange={v => set({ createIndexes: v })} label="Create indexes" desc="Includes unique indexes." />
          <Toggle checked={o.createConstraints} onChange={v => set({ createConstraints: v })} label="Create constraints" desc="Primary keys, unique, foreign keys and check constraints. Added after the data is copied for speed and to avoid ordering problems." />
          <Toggle checked={o.createViews} onChange={v => set({ createViews: v })} label="Create views" desc="Views are created after all tables exist." />
          <Toggle checked={o.syncSequences} onChange={v => set({ syncSequences: v })} label="Keep sequences in sync" desc="After copying data, auto-increment counters are moved past the highest copied id so new inserts do not collide." />
          <p className="mw-dim">Custom types and sequences are created automatically when needed.</p>
        </fieldset>

        <fieldset className={`mw-group ${includeData ? '' : 'mw-group-off'}`} disabled={!includeData}><legend>Data</legend>
          {!includeData && <p className="mw-dim">Enable Schema and data in step 1.</p>}
          <div role="radiogroup" aria-label="Data mode">
            {DATA_MODES.map(m => (
              <label key={m.id} className="mw-opt">
                <input type="radio" name="mw-datamode" checked={o.dataMode === m.id} onChange={() => set({ dataMode: m.id })} />
                <span className="mw-opt-text">
                  <span className="mw-opt-label">{m.label}{m.tag && <span className={`mw-pill mw-pill-${m.tagCls}`}>{m.tag}</span>}</span>
                  <span className="mw-dim">{m.desc}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="mw-group"><legend>Execution</legend>
          <label className="mw-field">
            <span className="mw-opt-label">Batch size</span>
            <input type="number" className="mw-input mw-input-sm" min={100} max={10000} step={100} value={o.batchSize}
              onChange={e => set({ batchSize: e.target.value === '' ? '' : Number(e.target.value) })}
              onBlur={() => set({ batchSize: Math.min(10000, Math.max(100, Number(o.batchSize) || 1000)) })} />
            <span className="mw-dim">Rows per INSERT batch (100 to 10000). Lower it for very wide tables.</span>
          </label>
          <div role="radiogroup" aria-label="Error handling">
            <label className="mw-opt"><input type="radio" name="mw-onerror" checked={o.onError === 'stop'} onChange={() => set({ onError: 'stop' })} />
              <span className="mw-opt-text"><span className="mw-opt-label">Stop at first error</span><span className="mw-dim">Safest. Nothing after the failure runs.</span></span></label>
            <label className="mw-opt"><input type="radio" name="mw-onerror" checked={o.onError === 'continue'} onChange={() => set({ onError: 'continue' })} />
              <span className="mw-opt-text"><span className="mw-opt-label">Continue and report</span><span className="mw-dim">Skips the failing step or table and keeps going. Review errors in the result.</span></span></label>
          </div>
          <Toggle checked={state.dryRun} onChange={v => dispatch({ type: 'SET_DRY', value: v })} label="Preview only (dry run)" desc="Executes nothing, validates the plan and reports." />
        </fieldset>

        <div className="mw-group mw-group-danger">
          <button type="button" className="mw-collapse" aria-expanded={dropsOpen} onClick={() => setDropsOpen(v => !v)}>
            <Icon name="warn" /> Removing things {o.allowDrops && <span className="mw-pill mw-pill-red">drops enabled</span>}
          </button>
          {dropsOpen && <div className="mw-group-inner">
            <Toggle checked={o.allowDrops} onChange={v => set({ allowDrops: v })} label="Allow DROP statements" desc="Off by default. Objects that exist only in the target are reported but never removed." />
            {o.allowDrops && <p className="mw-warn-text" role="status">Dropped tables and columns cannot be recovered. You will be asked to type the target database name later.</p>}
            <Toggle checked={o.dropExtraTables} disabled={!o.allowDrops} onChange={v => set({ dropExtraTables: v })} label="Drop tables that exist only in the target" desc={`${extraTables} selected table(s) would be dropped.`} />
            <Toggle checked={o.dropExtraColumns} disabled={!o.allowDrops} onChange={v => set({ dropExtraColumns: v })} label="Drop columns that exist only in the target" desc={`${extraCols} column(s) in selected tables would be dropped.`} />
          </div>}
        </div>
      </div>

      <aside className="mw-aside" aria-label="What will happen">
        <h4 className="mw-h4">What will happen</h4>
        <p>{state.dryRun ? 'Dry run: no changes will be made. ' : ''}{text}</p>
        <p className="mw-dim">{state.tables.length} table(s) in scope.</p>
      </aside>
    </div>
  )
}

// Count of columns present only in target for selected differing tables.
function schemaDiffCols(allTables, sel) {
  let n = 0
  for (const t of allTables) {
    if (t.status !== 'different' || !sel.has(t.name)) continue
    const src = new Set((t.srcColumns || []).map(c => c.name))
    n += (t.tgtColumns || []).filter(c => !src.has(c.name)).length
  }
  return n
}

// ── Step 3: Review ──────────────────────────────────────────
const SUMMARY_CARDS = [
  ['tablesToCreate', 'Tables to create', 'green'], ['tablesToAlter', 'Tables to alter', 'yellow'],
  ['columnsToAdd', 'Columns to add', 'green'], ['columnsToAlter', 'Columns to alter', 'yellow'],
  ['indexesToCreate', 'Indexes', 'green'], ['constraintsToCreate', 'Constraints', 'green'],
  ['enumsToCreate', 'Enums and types', 'green'], ['sequencesToCreate', 'Sequences', 'green'],
  ['viewsToCreate', 'Views', 'green'], ['rowsEstimate', 'Rows to copy', 'blue'],
]

function StepReview({ state, dispatch, blockers, onRetry, onBack, planEmpty }) {
  const { plan, planStatus } = state
  const [tab, setTab] = useState('steps')
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (planStatus !== 'loading') { setSlow(false); return undefined }
    const t = setTimeout(() => setSlow(true), 20000)
    return () => clearTimeout(t)
  }, [planStatus])

  if (planStatus === 'loading' || planStatus === 'idle') {
    return (
      <div className="mw-loading" role="status">
        <span className="mw-spinner" /><div>Analyzing source and target schemas…</div>
        {slow && <div className="mw-dim">Still working, large schemas can take a while.</div>}
        <div className="mw-skeletons">{[0, 1, 2, 3, 4].map(i => <div key={i} className="mw-skeleton" />)}</div>
      </div>
    )
  }
  if (planStatus === 'error') {
    let msg = state.planError || ''
    if (/different engine/i.test(msg)) msg = 'Cross-engine migration is not supported. ' + msg
    else if (/not connected|no longer active|connection lost/i.test(msg)) msg = 'A connection is no longer active. Reconnect from the sidebar and retry.\n' + msg
    return <ErrorBox message={msg} onRetry={onRetry} onBack={onBack} />
  }
  if (!plan) return null

  const warnings = plan.warnings || []
  const warns = warnings.filter(w => w.level === 'warn')
  const infos = warnings.filter(w => w.level === 'info')
  const sum = plan.summary || {}
  const includeData = state.mode === 'schema+data'
  const nonEmptyAppend = includeData && state.options.dataMode === 'append' && (plan.dataPlan || []).some(d => (d.targetRows || 0) > 0)

  return (
    <div className="mw-section">
      <div className="mw-row mw-between">
        <span className="mw-dim">Planned at {timeStr(state.plannedAt)}</span>
        <button type="button" className="mw-btn mw-btn-ghost mw-btn-sm" onClick={onRetry}>Re-plan</button>
      </div>

      {blockers.length > 0 && (
        <div className="mw-banner mw-banner-red mw-sticky" role="alert">
          <Icon name="x" size={14} />
          <div><strong>Blocked: resolve {blockers.length} blocker(s) before continuing</strong>
            <ul>{blockers.map((w, i) => <li key={i}><span className="mw-mono">{w.object}</span> {w.message}</li>)}</ul></div>
        </div>
      )}

      {planEmpty ? (
        <div className="mw-empty-big"><Icon name="check" size={22} />Nothing to do. The target already matches the source for the selected scope.</div>
      ) : (<>
        {nonEmptyAppend && <div className="mw-banner mw-banner-yellow"><Icon name="warn" size={14} />Some target tables already contain rows. Append may fail on duplicates. Consider Insert missing only.</div>}
        <div className="mw-summary">
          {SUMMARY_CARDS.filter(([k]) => k === 'rowsEstimate' ? includeData : (sum[k] || 0) > 0 || ['tablesToCreate', 'tablesToAlter', 'columnsToAdd'].includes(k)).map(([k, label, c]) => (
            <div key={k} className={`mw-sum mw-sum-${c}`}><div className="mw-sum-n">{fmt(sum[k] || 0)}</div><div className="mw-sum-l">{label}</div></div>
          ))}
          {[['tablesToDrop', 'Tables to drop'], ['columnsToDrop', 'Columns to drop']].map(([k, label]) => (
            <div key={k} className={`mw-sum mw-sum-red ${(sum[k] || 0) > 0 ? 'hot' : ''}`} title={!state.options.allowDrops ? 'Drops are disabled; extra objects are reported as warnings only.' : undefined}>
              <div className="mw-sum-n">{state.options.allowDrops ? fmt(sum[k] || 0) : '0'}{!state.options.allowDrops && <span className="mw-sum-note"> (disabled)</span>}</div>
              <div className="mw-sum-l">{label}</div>
            </div>
          ))}
        </div>

        <div role="region" aria-label="Warnings">
          {warns.length > 0 && <div className="mw-banner mw-banner-yellow"><Icon name="warn" size={14} />
            <div><strong>Warnings ({warns.length})</strong><ul>{warns.map((w, i) => <li key={i}><span className="mw-mono">{w.object}</span> {w.message}</li>)}</ul></div></div>}
          {infos.length > 0 && <details className="mw-details"><summary>{infos.length} notes</summary>
            <ul>{infos.map((w, i) => <li key={i}><Icon name="info" size={11} /> <span className="mw-mono">{w.object}</span> {w.message}</li>)}</ul></details>}
        </div>

        <Tabs idPrefix="mw-rev" active={tab} onChange={setTab} tabs={[
          { id: 'steps', label: `Steps (${(plan.steps || []).length})` },
          { id: 'data', label: `Data plan (${(plan.dataPlan || []).length} tables)` },
          { id: 'sql', label: 'SQL script' },
        ]} />
        <div role="tabpanel" id="mw-rev-panel" aria-labelledby={`mw-rev-tab-${tab}`}>
          {tab === 'steps' && <ReviewSteps plan={plan} includeData={includeData} />}
          {tab === 'data' && <ReviewData plan={plan} includeData={includeData} />}
          {tab === 'sql' && <ReviewScript plan={plan} state={state} />}
        </div>
      </>)}
    </div>
  )
}

function ReviewSteps({ plan, includeData }) {
  const [filter, setFilter] = useState('')
  const [onlyDestructive, setOnlyDestructive] = useState(false)
  const [expandAll, setExpandAll] = useState(false)
  const [limit, setLimit] = useState(300)
  const steps = useMemo(() => (plan.steps || []).map((s, i) => ({ ...s, _i: i + 1 })), [plan])
  const f = steps.filter(s => (!onlyDestructive || s.destructive) &&
    (!filter || `${s.object} ${s.description} ${s.kind}`.toLowerCase().includes(filter.toLowerCase())))
  const shown = f.slice(0, limit)
  let lastPhase = null, dataDividerDone = !includeData
  const rows = []
  shown.forEach(s => {
    // Data copy sits between 'columns' and 'constraints'.
    if (!dataDividerDone && PHASE_ORDER.indexOf(s.phase) > PHASE_ORDER.indexOf('data')) {
      rows.push(<div key="data-div" className="mw-divider">Data copy (see Data plan tab)</div>); dataDividerDone = true
    }
    if (s.phase !== lastPhase) { rows.push(<div key={`ph-${s._i}`} className="mw-phase-h">{PHASE_LABELS[s.phase] || s.phase}</div>); lastPhase = s.phase }
    rows.push(<StepRow key={s.id || s._i} s={s} forceOpen={expandAll} />)
  })
  if (!dataDividerDone && f.length === shown.length) rows.push(<div key="data-div" className="mw-divider">Data copy (see Data plan tab)</div>)
  return (
    <div>
      <div className="mw-row">
        <input className="mw-input mw-input-sm" placeholder="Filter steps…" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter steps" />
        <label className="mw-inline-check"><input type="checkbox" checked={onlyDestructive} onChange={e => setOnlyDestructive(e.target.checked)} />Show only destructive</label>
        <label className="mw-inline-check"><input type="checkbox" checked={expandAll} onChange={e => setExpandAll(e.target.checked)} />Expand all SQL</label>
      </div>
      {steps.length === 0 && <div className="mw-empty">No schema steps.</div>}
      <div className="mw-steps">{rows}</div>
      {f.length > shown.length && <button type="button" className="mw-btn mw-btn-sm" onClick={() => setLimit(l => l + 100)}>Show more ({f.length - shown.length} left)</button>}
    </div>
  )
}
function StepRow({ s, forceOpen }) {
  const [open, setOpen] = useState(false)
  const o = open || forceOpen
  return (
    <div className={`mw-step-row ${s.destructive ? 'destructive' : ''}`}>
      <div className="mw-step-main">
        <span className="mw-ord">{s._i}</span>
        <span className="mw-pill mw-pill-gray">{s.kind}</span>
        {s.destructive && <span className="mw-pill mw-pill-red"><Icon name="warn" size={10} /> DESTRUCTIVE</span>}
        <span className="mw-mono mw-step-obj">{s.object}</span>
        <span className="mw-dim mw-step-desc">{s.description}</span>
        <button type="button" className="mw-link" aria-expanded={o} onClick={() => setOpen(v => !v)}>SQL</button>
      </div>
      {o && <pre className="mw-pre">{s.sql}</pre>}
    </div>
  )
}

function ReviewData({ plan, includeData }) {
  const dp = plan.dataPlan || []
  if (!includeData || !dp.length) return <div className="mw-empty">Data copy is off. Go back to Scope to enable it.</div>
  const tot = dp.reduce((a, d) => ({ s: a.s + (d.sourceRows || 0), t: a.t + (d.targetRows || 0) }), { s: 0, t: 0 })
  return (
    <div className="mw-table-wrap">
      <table className="mw-table">
        <thead><tr><th>#</th><th>Table</th><th>Mode</th><th className="num">Source rows</th><th className="num">Target rows</th><th className="num">Columns</th><th className="num">Skipped</th></tr></thead>
        <tbody>
          {dp.map((d, i) => {
            const warn = (d.targetRows || 0) > 0 && d.mode === 'append'
            const del = (d.targetRows || 0) > 0 && d.mode === 'truncate-copy'
            return (
              <tr key={d.table} className={del ? 'row-red' : warn ? 'row-yellow' : ''}>
                <td>{i + 1}</td><td className="mw-mono">{d.table}</td><td>{d.mode}</td>
                <td className="num">{fmt(d.sourceRows)}</td>
                <td className="num">{fmt(d.targetRows)}{warn && <span className="mw-pill mw-pill-yellow">duplicates possible</span>}{del && <span className="mw-pill mw-pill-red">will delete {fmt(d.targetRows)} rows</span>}</td>
                <td className="num">{(d.columns || []).length}</td>
                <td className="num" title={(d.skippedColumns || []).map(c => `${c.name}: ${c.reason}`).join('\n') || undefined}>{(d.skippedColumns || []).length}</td>
              </tr>
            )
          })}
        </tbody>
        <tfoot><tr><td /><td>Total</td><td /><td className="num">{fmt(tot.s)}</td><td className="num">{fmt(tot.t)}</td><td /><td /></tr></tfoot>
      </table>
    </div>
  )
}

function ReviewScript({ plan, state }) {
  const [err, setErr] = useState(null)
  const save = async () => {
    setErr(null)
    const res = await window.dbAccess?.saveRawFile?.(plan.script || '', `migration-${stamp()}.sql`, [{ name: 'SQL', extensions: ['sql'] }])
    if (res && res.success === false && res.error !== 'Cancelled') setErr(res.error)
  }
  return (
    <div>
      <div className="mw-row">
        <CopyBtn text={plan.script || ''} />
        <button type="button" className="mw-btn mw-btn-ghost mw-btn-sm" onClick={save}>Save .sql…</button>
        {err && <span className="mw-err-text">{err}</span>}
      </div>
      <p className="mw-dim">Data copy is performed by the app and is not part of this script.</p>
      <pre className="mw-script">{plan.script || '-- (empty)'}</pre>
    </div>
  )
}

// ── Step 4: Confirm ─────────────────────────────────────────
function StepConfirm({ state, dispatch, tgtConn, safeMode, onTurnOffSafe, onBack }) {
  const { plan, options, mode, dryRun } = state
  const f = confirmFlags(state, tgtConn)
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 30000); return () => clearInterval(t) }, [])
  const age = state.plannedAt ? Date.now() - state.plannedAt : 0
  const stale = age > STALE_MS
  const sum = plan?.summary || {}
  const includeData = mode === 'schema+data'
  const blockers = (plan?.warnings || []).filter(w => w.level === 'blocker')
  const planFresh = !!plan
  const unmet = unmetConditions(state, tgtConn, safeMode, planFresh, blockers)
  const mDef = DATA_MODES.find(d => d.id === options.dataMode)
  const typed = state.confirmText.trim()

  const lines = []
  if (sum.enumsToCreate) lines.push([`Create ${sum.enumsToCreate} custom type(s)`])
  if (sum.tablesToCreate) lines.push([`Create ${sum.tablesToCreate} table(s)`])
  if (sum.tablesToAlter || sum.columnsToAdd || sum.columnsToAlter) lines.push([`Alter ${sum.tablesToAlter || 0} table(s): add ${sum.columnsToAdd || 0}, change ${sum.columnsToAlter || 0} column(s)`])
  if (sum.indexesToCreate || sum.constraintsToCreate) lines.push([`Create ${sum.indexesToCreate || 0} index(es) and ${sum.constraintsToCreate || 0} constraint(s)`])
  if (sum.viewsToCreate) lines.push([`Create ${sum.viewsToCreate} view(s)`])
  if (includeData) lines.push([`Copy about ${fmt(sum.rowsEstimate || 0)} rows (${mDef?.label})`, options.dataMode === 'truncate-copy' ? 'red' : ''])
  if (sum.tablesToDrop) lines.push([`Drop ${sum.tablesToDrop} table(s)`, 'red'])
  if (sum.columnsToDrop) lines.push([`Drop ${sum.columnsToDrop} column(s)`, 'red'])

  return (
    <div className="mw-section">
      {dryRun && <div className="mw-banner mw-banner-blue"><Icon name="info" size={14} />Dry run: no changes will be made.</div>}
      <div className="mw-card">
        <p>This will run against <strong className="mw-mono">{connLabel(tgtConn)}</strong>{tgtConn?.host ? <> on <span className="mw-mono">{tgtConn.host}{tgtConn.port ? `:${tgtConn.port}` : ''}</span></> : null}:</p>
        <ul className="mw-recap">{lines.length ? lines.map(([t, c], i) => <li key={i} className={c ? 'mw-red' : ''}>{t}</li>) : <li>No schema changes.</li>}</ul>
        <p className="mw-dim">Plan computed {Math.floor(age / 60000)}m ago.</p>
      </div>

      {stale && (
        <div className="mw-banner mw-banner-yellow" role="alert"><Icon name="warn" size={14} />
          <div>This plan is older than 5 minutes. The databases may have changed. Re-plan?
            <div><button type="button" className="mw-btn mw-btn-sm" onClick={() => { dispatch({ type: 'PLAN_IDLE' }); dispatch({ type: 'GO', step: 2 }) }}>Re-plan</button></div></div>
        </div>
      )}

      <div className="mw-banner mw-banner-yellow"><Icon name="shield" size={14} />
        <div><strong>Back up the target database before you continue.</strong>
          <div>A migration can change or delete data and may not be fully reversible. Schema steps run in a transaction where possible, but data copy is committed in batches.</div></div>
      </div>

      {!dryRun && (
        <label className="mw-opt">
          <input type="checkbox" checked={state.ackBackup} onChange={e => dispatch({ type: 'PATCH', patch: { ackBackup: e.target.checked } })} />
          <span className="mw-opt-text"><span className="mw-opt-label">{f.hasDestructive || f.hasOverwrite || f.targetNonEmpty ? 'I have a backup or accept the risk' : <>I understand this will modify <span className="mw-mono">{connLabel(tgtConn)}</span></>}</span></span>
        </label>
      )}

      {f.needTyped && (
        <div className="mw-card">
          <label className="mw-opt-label" htmlFor="mw-typed">Type the target database name to confirm</label>
          <div className="mw-row"><span>Expected:</span><span className="mw-chip mw-mono">{f.expected}</span></div>
          <input id="mw-typed" className="mw-input" placeholder={f.expected} value={state.confirmText} autoComplete="off" spellCheck={false}
            onChange={e => dispatch({ type: 'PATCH', patch: { confirmText: e.target.value } })} />
          {typed && typed !== f.expected && <span className="mw-err-text" role="status">does not match</span>}
        </div>
      )}

      {safeMode && f.gated && (
        <div className="mw-banner mw-banner-yellow" role="alert"><Icon name="shield" size={14} />
          <div>
            <strong>Safe Mode is ON.</strong> This migration contains operations Safe Mode normally blocks: {f.gatedSteps} destructive or ALTER step(s), {f.truncates} truncate(s).
            <div className="mw-row">
              <button type="button" className="mw-btn mw-btn-sm" onClick={onTurnOffSafe}>Turn off Safe Mode and continue</button>
              <button type="button" className="mw-btn mw-btn-ghost mw-btn-sm" onClick={onBack}>Cancel / go back</button>
              <label className="mw-inline-check"><input type="checkbox" checked={state.restoreSafe} onChange={e => dispatch({ type: 'PATCH', patch: { restoreSafe: e.target.checked } })} />Re-enable Safe Mode when finished</label>
            </div>
            <div className="mw-dim">Alternatively, use Generate SQL Script and run the statements manually.</div>
          </div>
        </div>
      )}

      <div id="mw-unmet" className="mw-unmet">
        {unmet.length > 0 ? <><span className="mw-dim">Before you can start:</span><ul>{unmet.map((u, i) => <li key={i}>{u}</li>)}</ul></> : <span className="mw-ok-text"><Icon name="check" /> Ready to start.</span>}
      </div>
    </div>
  )
}

// ── Step 5: Run ─────────────────────────────────────────────
function PhaseIcon({ status }) {
  if (status === 'active') return <span className="mw-spinner mw-spinner-sm" aria-label="running" />
  if (status === 'ok') return <span className="mw-green"><Icon name="check" /></span>
  if (status === 'error') return <span className="mw-red"><Icon name="x" /></span>
  if (status === 'skipped') return <Icon name="dash" />
  return <span className="mw-dim"><Icon name="circle" /></span>
}

function StepRun({ state }) {
  const { plan, tableProgress, log, phases, phaseMsg, stepResults } = state
  const [now, setNow] = useState(Date.now())
  const [pause, setPause] = useState(false)
  const [slowCancel, setSlowCancel] = useState(false)
  const logRef = useRef(null)
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  useEffect(() => {
    if (state.runStatus !== 'cancelling') { setSlowCancel(false); return undefined }
    const t = setTimeout(() => setSlowCancel(true), 30000)
    return () => clearTimeout(t)
  }, [state.runStatus])
  useEffect(() => { if (!pause && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [log, pause])

  const includeData = state.mode === 'schema+data'
  const phaseList = useMemo(() => {
    const present = new Set((plan?.steps || []).map(s => s.phase))
    if (includeData) present.add('data')
    return PHASE_ORDER.filter(p => present.has(p))
  }, [plan, includeData])
  const dataTables = (plan?.dataPlan || [])
  const names = useMemo(() => {
    const n = dataTables.map(d => d.table)
    Object.keys(tableProgress).forEach(t => { if (!n.includes(t)) n.push(t) })
    return n
  }, [dataTables, tableProgress])
  const totalOf = (t) => tableProgress[t]?.rowsTotal ?? dataTables.find(d => d.table === t)?.sourceRows ?? 0
  const sumDone = names.reduce((a, t) => a + (tableProgress[t]?.rowsDone || 0), 0)
  const sumTotal = names.reduce((a, t) => a + totalOf(t), 0)
  const stepsDone = Object.values(stepResults).filter(v => v !== 'running').length
  const stepsTotal = (plan?.steps || []).length
  const elapsed = now - state.startedAt
  const rps = elapsed > 1000 ? Math.round(sumDone / (elapsed / 1000)) : 0
  const useRows = includeData && sumTotal > 0
  const started = state.curPhase || log.length > 0

  return (
    <div className="mw-run">
      {state.dryRun && <span className="mw-pill mw-pill-blue">DRY RUN</span>}
      <div className="mw-run-grid">
        <div className="mw-card">
          <div className="mw-card-head"><strong>Phases</strong><span className="mw-dim">Step {stepsDone} of {stepsTotal}</span></div>
          <ul className="mw-phases" role="list">
            {phaseList.map(p => (
              <li key={p} role="listitem" className={`mw-phase ${phases[p] || 'pending'}`}>
                <PhaseIcon status={phases[p]} /><div><div>{PHASE_LABELS[p]}</div>{phases[p] === 'active' && phaseMsg[p] && <div className="mw-dim mw-small">{phaseMsg[p]}</div>}</div>
              </li>
            ))}
          </ul>
        </div>
        <div className="mw-run-right">
          <div className="mw-card">
            {!started && <div className="mw-dim">Preparing…</div>}
            <div className="mw-card-head">
              <strong>Overall progress</strong>
              <span className="mw-dim">{formatDuration(elapsed)}{useRows && rps > 0 ? ` · ${fmt(rps)} rows/s` : ''}</span>
            </div>
            {useRows ? <ProgressBar value={sumDone} max={sumTotal} label="Overall progress" />
              : stepsTotal ? <ProgressBar value={stepsDone} max={stepsTotal} label="Overall progress" /> : <ProgressBar label="Overall progress" />}
            {useRows && <div className="mw-dim mw-small">{fmt(sumDone)} / {fmt(sumTotal)} rows</div>}
          </div>
          {includeData && names.length > 0 && (
            <div className="mw-card mw-tprogress">
              {names.map(t => {
                const p = tableProgress[t] || { rowsDone: 0, rowsTotal: totalOf(t), status: 'queued' }
                const tot = p.rowsTotal || totalOf(t)
                return (
                  <div key={t} className="mw-trow">
                    <span className="mw-mono mw-tname">{t}</span>
                    <ProgressBar value={p.rowsDone} max={tot || (p.status === 'done' ? 1 : 0)} label={`${t} copy progress`} status={p.status === 'done' ? 'done' : p.status === 'error' ? 'error' : ''} />
                    <span className="mw-dim mw-tcount">{tot === 0 && p.status === 'done' ? 'empty' : `${fmt(p.rowsDone)} / ${fmt(tot)}`}</span>
                    <span className="mw-ticon">{p.status === 'done' ? <span className="mw-green"><Icon name="check" /></span> : p.status === 'error' ? <span className="mw-red"><Icon name="x" /></span> : p.status === 'running' ? <span className="mw-spinner mw-spinner-sm" /> : <span className="mw-dim"><Icon name="circle" /></span>}</span>
                  </div>
                )
              })}
            </div>
          )}
          <div className="mw-card">
            <div className="mw-card-head"><strong>Log</strong>
              <span className="mw-row">
                <label className="mw-inline-check"><input type="checkbox" checked={pause} onChange={e => setPause(e.target.checked)} />Pause scroll</label>
                <CopyBtn text={log.map(l => `[${l.level.toUpperCase()}] ${l.message}`).join('\n')} label="Copy log" />
              </span>
            </div>
            <div className="mw-log" role="log" aria-live="off" ref={logRef}>
              {log.map((l, i) => <div key={i} className={`mw-log-${l.level}`}>{l.level !== 'info' ? `[${l.level.toUpperCase()}] ` : ''}{l.message}</div>)}
            </div>
          </div>
        </div>
      </div>
      <p className="mw-dim">The migration stops after the current batch. Rows already copied stay in the target. Schema changes done so far are kept unless they were in an open transaction.</p>
      {slowCancel && <p className="mw-warn-text" role="status">Still stopping, waiting for the current operation to finish.</p>}
    </div>
  )
}

// ── Step 6: Result ──────────────────────────────────────────
function StepResult({ state, dispatch, srcId, tgtId, srcConn, tgtConn, allTables, buildOptions, safeMode, onRestoreSafe }) {
  const { report, plan, verify } = state
  const [tab, setTab] = useState('tables')
  const [exportErr, setExportErr] = useState(null)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [sort, setSort] = useState({ key: 'table', dir: 1 })
  const [openRow, setOpenRow] = useState(null)
  const [dismissed, setDismissed] = useState(false)
  if (!report) return null

  const tbls = report.tables || []
  const rowStatus = (t) => t.error ? 'error' : (t.targetRowsAfter != null && t.sourceRows != null && t.targetRowsAfter < t.sourceRows) ? 'mismatch' : 'ok'
  const totalCopied = tbls.reduce((a, t) => a + (t.rowsCopied || 0), 0)
  const sorted = [...tbls].filter(t => !onlyProblems || rowStatus(t) !== 'ok').sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key]
    return (typeof av === 'string' ? av.localeCompare(bv) : (av || 0) - (bv || 0)) * sort.dir
  })
  const errors = report.errors || []
  const status = report.status
  const bannerCls = status === 'success' ? 'green' : status === 'partial' || status === 'cancelled' ? 'yellow' : 'red'
  const bannerText = status === 'success' ? 'Migration completed successfully' : status === 'partial' ? `Completed with ${errors.length} errors` : status === 'cancelled' ? 'Cancelled by user' : 'Migration failed'

  // Failed tables for retry
  const stepById = new Map((plan?.steps || []).map(s => [s.id, s]))
  const known = new Set(allTables.map(t => t.name))
  const failed = new Set()
  tbls.forEach(t => { if (t.error || (t.rowsCopied || 0) + (t.rowsSkipped || 0) < (t.sourceRows || 0)) failed.add(t.table) })
  ;(report.steps || []).filter(s => s.status === 'error').forEach(s => { const o = stepById.get(s.id)?.object; if (o && known.has(o)) failed.add(o) })
  const failedList = [...failed].filter(t => known.has(t))
  const canRetry = status !== 'success' && failedList.length > 0 && !state.dryRun

  const retry = () => {
    const prevAppend = state.options.dataMode === 'append' && state.mode === 'schema+data'
    dispatch({
      type: 'RETRY', tables: failedList,
      optsPatch: { onError: 'stop', ...(prevAppend ? { dataMode: 'insert-missing' } : {}) },
      notice: prevAppend ? 'Data mode was switched to "Insert missing only" to avoid duplicates from the partial copy. You can change it in Options.' : null,
    })
  }

  const runVerify = async () => {
    dispatch({ type: 'PATCH', patch: { verify: { status: 'loading', rows: null, error: null } } })
    const list = state.mode === 'schema+data' && plan?.dataPlan?.length ? plan.dataPlan.map(d => d.table) : state.tables
    try {
      if (!window.dbAccess?.migrationVerify) throw new Error('Verification is not available in this build.')
      const res = await window.dbAccess.migrationVerify(srcId, tgtId, list)
      if (!res?.success) throw new Error(res?.error || 'Verification failed')
      dispatch({ type: 'PATCH', patch: { verify: { status: 'ready', rows: res.data, error: null } } })
    } catch (e) {
      dispatch({ type: 'PATCH', patch: { verify: { status: 'error', rows: null, error: e?.message || String(e) } } })
    }
  }

  const exportFile = async (content, name, filters) => {
    setExportErr(null)
    try {
      const res = await window.dbAccess?.saveRawFile?.(content, name, filters)
      if (res && res.success === false && res.error !== 'Cancelled') setExportErr(res.error)
    } catch (e) { setExportErr(e?.message || String(e)) }
  }
  const sLabel = (srcConn?.name || 'src').replace(/[^\w.-]+/g, '_'), tLabel = (tgtConn?.name || 'tgt').replace(/[^\w.-]+/g, '_')
  const exportJson = () => exportFile(buildReportJson({ srcId, tgtId, srcConn, tgtConn, options: buildOptions(state, false), plan, report, verify }),
    `migration-report-${sLabel}-to-${tLabel}-${stamp()}.json`, [{ name: 'JSON', extensions: ['json'] }])
  const exportSql = () => exportFile(
    `-- Migration script\n-- Generated: ${new Date().toISOString()}\n-- Source: ${connLabel(srcConn)}\n-- Target: ${connLabel(tgtConn)}\n\n${plan?.script || ''}`,
    `migration-report-${sLabel}-to-${tLabel}-${stamp()}.sql`, [{ name: 'SQL', extensions: ['sql'] }])

  const th = (key, label, num) => (
    <th className={num ? 'num' : ''} aria-sort={sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="mw-th-btn" onClick={() => setSort(s => ({ key, dir: s.key === key ? -s.dir : 1 }))}>{label}{sort.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button>
    </th>
  )

  const vrows = verify?.rows || []
  const vMatch = vrows.filter(r => r.status === 'match').length

  return (
    <div className="mw-section">
      <div className={`mw-banner mw-banner-${bannerCls}`} role="status">
        <Icon name={status === 'success' ? 'check' : status === 'cancelled' ? 'info' : 'warn'} size={16} />
        <div><strong>{bannerText}</strong>
          <div className="mw-dim">{formatDuration(report.durationMs)} · {tbls.length} tables · {fmt(totalCopied)} rows copied · {errors.length} errors{state.dryRun ? ' · dry run' : ''}</div></div>
      </div>

      {state.notice && !dismissed && <div className="mw-banner mw-banner-blue"><Icon name="info" size={14} />{state.notice}<button type="button" className="mw-link" onClick={() => setDismissed(true)}>Dismiss</button></div>}
      {state.safeTurnedOff && !safeMode && (
        <div className="mw-banner mw-banner-yellow"><Icon name="shield" size={14} />Safe Mode was turned off for this migration.
          <button type="button" className="mw-btn mw-btn-sm" onClick={onRestoreSafe}>Turn it back on</button></div>
      )}

      <div className="mw-row">
        {canRetry && <button type="button" className="mw-btn" onClick={retry}>Retry {failedList.length} failed tables…</button>}
        <button type="button" className="mw-btn mw-btn-ghost" onClick={exportJson}>Export report (.json)</button>
        <button type="button" className="mw-btn mw-btn-ghost" onClick={exportSql} disabled={!plan?.script}>Export script (.sql)</button>
        {exportErr && <span className="mw-err-text">{exportErr}</span>}
      </div>

      <Tabs idPrefix="mw-res" active={tab} onChange={setTab} tabs={[
        { id: 'tables', label: 'Tables' }, { id: 'steps', label: 'Steps' }, { id: 'errors', label: `Errors (${errors.length})` }, { id: 'verify', label: 'Verify' },
      ]} />
      <div role="tabpanel" id="mw-res-panel" aria-labelledby={`mw-res-tab-${tab}`}>
        {tab === 'tables' && (tbls.length === 0 ? <div className="mw-empty">No tables were processed.</div> : (
          <div>
            <label className="mw-inline-check"><input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)} />Show only problems</label>
            <p className="mw-dim mw-small">Skipped = already existed (insert missing) or conflicting.</p>
            <div className="mw-table-wrap"><table className="mw-table">
              <thead><tr>{th('table', 'Table')}{th('sourceRows', 'Source rows', 1)}{th('rowsCopied', 'Copied', 1)}{th('rowsSkipped', 'Skipped', 1)}{th('targetRowsAfter', 'Target after', 1)}<th>Status</th></tr></thead>
              <tbody>{sorted.map(t => {
                const st = rowStatus(t)
                return (<React.Fragment key={t.table}>
                  <tr className={st === 'error' ? 'row-red' : st === 'mismatch' ? 'row-yellow' : ''} onClick={() => t.error && setOpenRow(openRow === t.table ? null : t.table)} title={t.error || undefined}>
                    <td className="mw-mono">{t.table}</td><td className="num">{fmt(t.sourceRows)}</td><td className="num">{fmt(t.rowsCopied)}</td>
                    <td className="num">{fmt(t.rowsSkipped)}</td><td className="num">{fmt(t.targetRowsAfter)}</td>
                    <td><span className={`mw-pill mw-pill-${st === 'ok' ? 'green' : st === 'error' ? 'red' : 'yellow'}`}>{st === 'ok' ? 'OK' : st === 'error' ? 'Error' : 'Mismatch'}</span></td>
                  </tr>
                  {openRow === t.table && t.error && <tr><td colSpan={6}><pre className="mw-pre">{t.error}</pre><CopyBtn text={t.error} /></td></tr>}
                </React.Fragment>)
              })}</tbody>
            </table></div>
          </div>
        ))}
        {tab === 'steps' && ((report.steps || []).length === 0 ? <div className="mw-empty">No step results.</div> : (
          <div className="mw-steps">{report.steps.map((s, i) => {
            const ps = stepById.get(s.id)
            return (
              <div key={s.id || i} className={`mw-step-row ${s.status === 'error' ? 'destructive' : ''}`}>
                <div className="mw-step-main">
                  <span className={`mw-pill mw-pill-${s.status === 'ok' ? 'green' : s.status === 'error' ? 'red' : 'gray'}`}>{s.status}</span>
                  <span className="mw-mono mw-step-obj">{ps?.object || s.id}</span><span className="mw-dim mw-step-desc">{ps?.description}</span>
                  <span className="mw-dim">{formatDuration(s.ms)}</span>
                </div>
                {s.error && <><pre className="mw-pre">{s.error}</pre><div className="mw-row"><CopyBtn text={s.error} label="Copy error" /></div></>}
                {s.status === 'error' && ps?.sql && <pre className="mw-pre">{ps.sql}</pre>}
              </div>
            )
          })}</div>
        ))}
        {tab === 'errors' && (errors.length === 0 ? <div className="mw-empty">No errors.</div> : (
          <ul className="mw-errors">{errors.map((e, i) => <li key={i}><span className="mw-mono">{e.where}</span><pre className="mw-pre">{e.message}</pre><CopyBtn text={e.message} /></li>)}</ul>
        ))}
        {tab === 'verify' && (
          <div>
            <div className="mw-row"><button type="button" className="mw-btn mw-btn-primary" onClick={runVerify} disabled={verify?.status === 'loading'}>Verify row counts</button></div>
            {!verify && <div className="mw-empty">Run verify to compare row counts.</div>}
            {verify?.status === 'loading' && <div className="mw-loading" role="status"><span className="mw-spinner" />Counting rows in {state.tables.length} tables…</div>}
            {verify?.status === 'error' && <ErrorBox message={verify.error} onRetry={runVerify} />}
            {verify?.status === 'ready' && (<>
              <p><strong>{vMatch} of {vrows.length} tables match</strong>{vMatch === vrows.length && vrows.length > 0 && <span className="mw-ok-text"> <Icon name="check" /> All tables verified</span>}</p>
              {vMatch < vrows.length && state.options.dataMode !== 'truncate-copy' && <p className="mw-dim">For insert-missing and upsert modes, a target count above the source is expected if the target had extra rows.</p>}
              <div className="mw-table-wrap"><table className="mw-table">
                <thead><tr><th>Table</th><th className="num">Source rows</th><th className="num">Target rows</th><th>Status</th></tr></thead>
                <tbody>{vrows.map(r => (
                  <tr key={r.table} className={r.status === 'error' ? 'row-red' : r.status === 'mismatch' ? 'row-yellow' : ''}>
                    <td className="mw-mono">{r.table}</td><td className="num">{fmt(r.sourceRows)}</td><td className="num">{fmt(r.targetRows)}</td>
                    <td><span className={`mw-pill mw-pill-${r.status === 'match' ? 'green' : r.status === 'error' ? 'red' : 'yellow'}`} title={r.error}>{r.status === 'match' ? 'Match' : r.status === 'error' ? 'Error' : 'Mismatch'}</span>{r.error && <span className="mw-dim mw-small"> {r.error}</span>}</td>
                  </tr>))}</tbody>
              </table></div>
            </>)}
          </div>
        )}
      </div>
    </div>
  )
}
