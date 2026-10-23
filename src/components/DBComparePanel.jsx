import React, { useState, useCallback, useMemo } from 'react'
import SideBySideCompare from './SideBySideCompare'
import MigrationWizard from './MigrationWizard'
import { isMigratable } from '../utils/migrationSupport'
import './DBComparePanel.css'

export default function DBComparePanel({ connections, safeMode, onToggleSafeMode }) {
  const connected = connections.filter(c => c.connected)

  const [srcId, setSrcId] = useState(connected[0]?.id || '')
  const [tgtId, setTgtId] = useState(connected[1]?.id || connected[0]?.id || '')
  const [loading, setLoading] = useState(false)
  const [loadingData, setLoadingData] = useState(false)
  const [error, setError] = useState(null)
  const [schemaDiff, setSchemaDiff] = useState(null)
  const [dataDiff, setDataDiff] = useState(null)
  const [view, setView] = useState('schema')
  const [direction, setDirection] = useState('src_to_tgt')
  const [expanded, setExpanded] = useState(new Set())
  const [script, setScript] = useState(null)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState(null)
  // null = "all tables, not yet touched"; lives here so it survives view-tab switches
  const [selectedTables, setSelectedTables] = useState(null)
  const [showWizard, setShowWizard] = useState(false)
  const [scriptSource, setScriptSource] = useState('legacy')
  const [scriptWarnings, setScriptWarnings] = useState([])

  const srcConn = connected.find(c => c.id === srcId)
  const tgtConn = connected.find(c => c.id === tgtId)

  const sameConn  = srcId && tgtId && srcId === tgtId
  const crossType = srcConn && tgtConn && srcConn.type !== tgtConn.type

  const handleCompare = useCallback(async () => {
    if (!srcId || !tgtId) return
    setLoading(true)
    setError(null)
    setSchemaDiff(null)
    setDataDiff(null)
    setScript(null)
    setScriptWarnings([])
    setApplyResult(null)
    setSelectedTables(null)
    try {
      const res = await window.dbAccess.compareSchema(srcId, tgtId)
      if (!res.success) throw new Error(res.error)
      setSchemaDiff(res.data)
      setSelectedTables(new Set((res.data.all || []).map(t => t.name)))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [srcId, tgtId])

  const handleCompareData = useCallback(async () => {
    if (!schemaDiff) return
    const sharedTables = [
      ...schemaDiff.same,
      ...schemaDiff.different.map(d => d.table),
    ]
    if (!sharedTables.length) return
    setLoadingData(true)
    try {
      const res = await window.dbAccess.compareData(srcId, tgtId, sharedTables)
      if (!res.success) throw new Error(res.error)
      setDataDiff(res.data)
      setView('data')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingData(false)
    }
  }, [schemaDiff, srcId, tgtId])

  const migratable = !!srcConn && !!tgtConn && srcConn.type === tgtConn.type && isMigratable(srcConn.type)
  const allNames = useMemo(() => schemaDiff ? schemaDiff.all.map(t => t.name) : [], [schemaDiff])
  const allSet = useMemo(() => new Set(allNames), [allNames])
  const reversed = direction === 'tgt_to_src'
  // The diff re-oriented for the migration flow: when the direction is reversed, "only in source" tables are
  // the ones that exist only in the migration TARGET, and the column sides swap too.
  const flowDiff = useMemo(() => {
    if (!schemaDiff || !reversed) return schemaDiff
    const flip = { onlySource: 'onlyTarget', onlyTarget: 'onlySource' }
    return { ...schemaDiff, all: schemaDiff.all.map(t => ({ ...t, status: flip[t.status] || t.status, srcColumns: t.tgtColumns, tgtColumns: t.srcColumns })) }
  }, [schemaDiff, reversed])
  // Only tables that exist in the migration source can be selected (target-only tables are never sent to the planner).
  const flowSourceNames = useMemo(() => flowDiff ? flowDiff.all.filter(t => t.status !== 'onlyTarget').map(t => t.name) : [], [flowDiff])
  const selectedList = useMemo(() => flowSourceNames.filter(n => !selectedTables || selectedTables.has(n)), [flowSourceNames, selectedTables])

  // Migration always flows source -> target, so swap everything when the direction is reversed.
  const flowSrcId = direction === 'tgt_to_src' ? tgtId : srcId
  const flowTgtId = direction === 'tgt_to_src' ? srcId : tgtId
  const flowSrcConn = direction === 'tgt_to_src' ? tgtConn : srcConn
  const flowTgtConn = direction === 'tgt_to_src' ? srcConn : tgtConn

  const handleGenerateScript = useCallback(async () => {
    if (!schemaDiff) return
    setScriptWarnings([])
    if (migratable && window.dbAccess.migrationPlan) {
      try {
        const res = await window.dbAccess.migrationPlan(flowSrcId, flowTgtId, {
          tables: selectedList.length === flowSourceNames.length ? null : selectedList,
          includeSchema: true, includeData: false,
          allowDrops: false, alterTypes: true, createIndexes: true, createConstraints: true,
          createViews: true, syncSequences: true, dryRun: true,
        })
        if (!res.success) throw new Error(res.error)
        setScript(res.data.script)
        setScriptSource('plan')
        setScriptWarnings((res.data.warnings || []).filter(w => w.level === 'blocker' || w.level === 'warn'))
      } catch (err) {
        setError(err.message)
      }
      return
    }
    // Unsupported engines keep the legacy generator
    const res = await window.dbAccess.generateSyncScript(schemaDiff, direction)
    if (res.success) { setScript(res.data); setScriptSource('legacy') }
  }, [schemaDiff, direction, migratable, flowSrcId, flowTgtId, selectedList, flowSourceNames])

  const handleApply = useCallback(async () => {
    if (!script) return
    const targetConnId = direction === 'src_to_tgt' ? tgtId : srcId
    const targetConn = connected.find(c => c.id === targetConnId)
    const ok = await window.dbAccess.confirm({
      title: 'Apply Sync Script',
      message: `Apply sync script to "${targetConn?.name || targetConnId}"?`,
      detail: 'This will modify the database. Make sure you have a backup.',
      confirmLabel: 'Apply',
      cancelLabel: 'Cancel',
    })
    if (!ok) return
    setApplying(true)
    setApplyResult(null)
    try {
      const res = await window.dbAccess.applySync(targetConnId, script)
      if (!res.success) throw new Error(res.error)
      setApplyResult(res.data)
    } catch (err) {
      setError(err.message)
    } finally {
      setApplying(false)
    }
  }, [script, direction, srcId, tgtId, connected])

  const toggleExpand = (key) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const swap = () => {
    setSrcId(tgtId)
    setTgtId(srcId)
    setSelectedTables(null)
    // the existing diff/script belong to the old orientation
    setSchemaDiff(null); setDataDiff(null); setScript(null); setError(null)
  }

  const totalIssues = schemaDiff
    ? schemaDiff.onlyInSource.length + schemaDiff.onlyInTarget.length + schemaDiff.different.length
    : 0

  const dataDiffCount = dataDiff ? dataDiff.filter(r => r.status !== 'same').length : 0

  return (
    <div className="dbcompare">
      {/* ── Selector bar ── */}
      <div className="dbcompare-bar">
        <div className="dbcompare-endpoint">
          <span className="dbcompare-endpoint-label">Source</span>
          <select value={srcId} onChange={e => { setSrcId(e.target.value); setSchemaDiff(null); setDataDiff(null); setScript(null); setError(null); setSelectedTables(null) }} className="dbcompare-select">
            {connected.map(c => <option key={c.id} value={c.id}>[{c.type}] {c.name || c.host}{c.database ? ` / ${c.database}` : ''}</option>)}
          </select>
        </div>

        <button className="dbcompare-swap" onClick={swap} title="Swap source and target">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/>
          </svg>
        </button>

        <div className="dbcompare-endpoint">
          <span className="dbcompare-endpoint-label">Target</span>
          <select value={tgtId} onChange={e => { setTgtId(e.target.value); setSchemaDiff(null); setDataDiff(null); setScript(null); setError(null); setSelectedTables(null) }} className="dbcompare-select">
            {connected.map(c => <option key={c.id} value={c.id}>[{c.type}] {c.name || c.host}{c.database ? ` / ${c.database}` : ''}</option>)}
          </select>
        </div>

        <button
          className="dbcompare-run-btn"
          onClick={handleCompare}
          disabled={loading || !srcId || !tgtId || sameConn || crossType}
        >
          {loading ? <span className="dbcompare-spinner" /> : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6" transform="rotate(90 12 12)"/><circle cx="12" cy="12" r="10"/></svg>
          )}
          {loading ? 'Comparing…' : 'Compare'}
        </button>
      </div>

      {sameConn  && <div className="dbcompare-warn">Source and target must be different connections.</div>}
      {crossType && !sameConn && <div className="dbcompare-warn"><strong>Cross-engine migration is not supported.</strong> Cannot compare {srcConn?.type} with {tgtConn?.type} — both connections must use the same database type.</div>}
      {error && <div className="dbcompare-error">{error}</div>}

      {/* ── Results ── */}
      {schemaDiff && (
        <div className="dbcompare-results">
          {/* Direction + view tabs */}
          <div className="dbcompare-controls">
            <div className="dbcompare-direction">
              <span className="dbcompare-direction-label">Sync direction:</span>
              <button
                className={`dbcompare-dir-btn ${direction === 'src_to_tgt' ? 'active' : ''}`}
                onClick={() => setDirection('src_to_tgt')}
              >
                Source → Target
              </button>
              <button
                className={`dbcompare-dir-btn ${direction === 'tgt_to_src' ? 'active' : ''}`}
                onClick={() => setDirection('tgt_to_src')}
              >
                Target → Source
              </button>
            </div>

            <div className="dbcompare-view-tabs">
              <button
                className={`dbcompare-view-tab ${view === 'schema' ? 'active' : ''}`}
                onClick={() => setView('schema')}
              >
                Schema
                {totalIssues > 0 && <span className="dbcompare-badge-count">{totalIssues}</span>}
              </button>
              <button
                className={`dbcompare-view-tab ${view === 'side' ? 'active' : ''}`}
                onClick={() => setView('side')}
              >
                Side by side
              </button>
              <button
                className={`dbcompare-view-tab ${view === 'data' ? 'active' : ''}`}
                onClick={() => { setView('data'); if (!dataDiff) handleCompareData() }}
              >
                Data
                {dataDiff && dataDiffCount > 0 && <span className="dbcompare-badge-count">{dataDiffCount}</span>}
                {loadingData && <span className="dbcompare-spinner-sm" />}
              </button>
            </div>
          </div>

          {/* ── Schema view ── */}
          {view === 'schema' && (
            <div className="dbcompare-list">
              {totalIssues === 0 && (
                <div className="dbcompare-all-same">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                  Schemas are identical ({schemaDiff.same.length} tables)
                </div>
              )}

              {schemaDiff.onlyInSource.map(t => (
                <div key={t.fullName} className="dbcompare-row dbcompare-row-add">
                  <span className="dbcompare-pill dbcompare-pill-add">+ source only</span>
                  <span className="dbcompare-table-name">{t.fullName}</span>
                  <span className="dbcompare-meta">{t.columns.length} columns</span>
                </div>
              ))}

              {schemaDiff.onlyInTarget.map(t => (
                <div key={t.fullName} className="dbcompare-row dbcompare-row-remove">
                  <span className="dbcompare-pill dbcompare-pill-remove">− target only</span>
                  <span className="dbcompare-table-name">{t.fullName}</span>
                  <span className="dbcompare-meta">{t.columns.length} columns</span>
                </div>
              ))}

              {schemaDiff.different.map(({ table, diff }) => {
                const isOpen = expanded.has(table)
                return (
                  <div key={table} className="dbcompare-row dbcompare-row-change">
                    <div className="dbcompare-row-header" onClick={() => toggleExpand(table)}>
                      <span className="dbcompare-pill dbcompare-pill-change">~ changed</span>
                      <span className="dbcompare-table-name">{table}</span>
                      <span className="dbcompare-meta">
                        {diff.added.length > 0 && `+${diff.added.length} `}
                        {diff.removed.length > 0 && `-${diff.removed.length} `}
                        {diff.changed.length > 0 && `~${diff.changed.length}`}
                      </span>
                      <svg
                        className={`dbcompare-chevron ${isOpen ? 'open' : ''}`}
                        width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                      ><path d="M9 18l6-6-6-6"/></svg>
                    </div>
                    {isOpen && (
                      <div className="dbcompare-col-list">
                        {diff.added.map(col => (
                          <div key={col.name} className="dbcompare-col dbcompare-col-add">
                            <span className="dbcompare-col-sign">+</span>
                            <span className="dbcompare-col-name">{col.name}</span>
                            <span className="dbcompare-col-type">{col.type}</span>
                            {col.nullable === 'NO' && <span className="dbcompare-col-tag">NOT NULL</span>}
                          </div>
                        ))}
                        {diff.removed.map(col => (
                          <div key={col.name} className="dbcompare-col dbcompare-col-remove">
                            <span className="dbcompare-col-sign">−</span>
                            <span className="dbcompare-col-name">{col.name}</span>
                            <span className="dbcompare-col-type">{col.type}</span>
                          </div>
                        ))}
                        {diff.changed.map(({ name, source, target }) => (
                          <div key={name} className="dbcompare-col dbcompare-col-change">
                            <span className="dbcompare-col-sign">~</span>
                            <span className="dbcompare-col-name">{name}</span>
                            <span className="dbcompare-col-type">
                              <span className="dbcompare-type-src">{source.type}</span>
                              <span className="dbcompare-type-arrow">→</span>
                              <span className="dbcompare-type-tgt">{target.type}</span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}

              {schemaDiff.same.length > 0 && (
                <div className="dbcompare-same-count">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                  {schemaDiff.same.length} tables identical
                </div>
              )}
            </div>
          )}

          {/* ── Side-by-side view ── */}
          {view === 'side' && (
            <SideBySideCompare
              schemaDiff={schemaDiff}
              srcLabel={srcConn?.name || srcConn?.database || 'Source'}
              tgtLabel={tgtConn?.name || tgtConn?.database || 'Target'}
              selected={selectedTables ?? allSet}
              onSelectedChange={setSelectedTables}
            />
          )}

          {/* ── Data view ── */}
          {view === 'data' && (
            <div className="dbcompare-data-wrap">
              {loadingData && <div className="dbcompare-loading">Counting rows…</div>}
              {dataDiff && (
                <table className="dbcompare-data-table">
                  <thead>
                    <tr>
                      <th>Table</th>
                      <th>Source rows</th>
                      <th>Target rows</th>
                      <th>Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dataDiff.map(row => {
                      const diff = row.sourceCount - row.targetCount
                      return (
                        <tr key={row.table} className={row.status !== 'same' ? 'dbcompare-data-diff' : ''}>
                          <td className="dbcompare-data-tablename">{row.table}</td>
                          <td>{row.sourceCount < 0 ? '—' : row.sourceCount.toLocaleString()}</td>
                          <td>{row.targetCount < 0 ? '—' : row.targetCount.toLocaleString()}</td>
                          <td>
                            {row.status === 'error' ? <span className="dbcompare-data-error">{row.error}</span>
                              : row.status === 'same' ? <span className="dbcompare-data-ok">✓ same</span>
                              : <span className="dbcompare-data-diff-val">{diff > 0 ? '+' : ''}{diff.toLocaleString()}</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* ── Actions ── */}
          <div className="dbcompare-actions">
            {view !== 'side' && (
              <button className="dbcompare-hint" onClick={() => setView('side')} title="Change the selection in Side by side">
                {selectedList.length} of {allNames.length} tables selected (change in Side by side)
              </button>
            )}
            <button className="dbcompare-action-btn" onClick={handleGenerateScript}
              disabled={selectedList.length === 0 || (!migratable && totalIssues === 0)}
              title={selectedList.length === 0 ? 'Select at least one table in Side by side.' : undefined}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/></svg>
              Generate SQL Script
            </button>
            <button className="dbcompare-action-btn dbcompare-action-primary" onClick={() => setShowWizard(true)}
              disabled={selectedList.length === 0 || !migratable}
              title={selectedList.length === 0 ? 'Select at least one table in Side by side.'
                : !migratable ? 'Migration supports PostgreSQL-compatible and MySQL/MariaDB only.'
                : 'Same-engine only: migrate schema and data from source to target'}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="9" cy="5" rx="6" ry="2.5"/><path d="M3 5v10c0 1.4 2.7 2.5 6 2.5M15 12h7m0 0l-3-3m3 3l-3 3M3 10c0 1.4 2.7 2.5 6 2.5"/></svg>
              Migrate…
            </button>
            <span className="dbcompare-hint-chip">Same-engine only</span>
            {script && scriptSource === 'legacy' && (
              <button className="dbcompare-action-btn dbcompare-action-danger" onClick={handleApply} disabled={applying}>
                {applying ? <span className="dbcompare-spinner" /> : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                )}
                {applying ? 'Applying…' : `Apply to ${direction === 'src_to_tgt' ? (tgtConn?.name || 'Target') : (srcConn?.name || 'Source')}`}
              </button>
            )}
          </div>

          {script && scriptSource === 'plan' && (
            <div className="dbcompare-hint-line">Use Migrate… to run this with transactions, ordering and data copy.</div>
          )}
          {scriptWarnings.length > 0 && (
            <details className="dbcompare-warn">
              <summary>{scriptWarnings.length} warning(s) in generated script</summary>
              {scriptWarnings.map((w, i) => <div key={i}>[{w.level}] {w.object}: {w.message}</div>)}
            </details>
          )}

          {/* Apply result */}
          {applyResult && (
            <div className={`dbcompare-apply-result ${applyResult.errors.length ? 'has-errors' : 'success'}`}>
              <strong>{applyResult.executed}/{applyResult.total} statements applied</strong>
              {applyResult.errors.map((e, i) => (
                <div key={i} className="dbcompare-apply-error">
                  <code>{e.statement}</code>
                  <span>{e.error}</span>
                </div>
              ))}
            </div>
          )}

          {/* Script output */}
          {script && (
            <div className="dbcompare-script-wrap">
              <div className="dbcompare-script-header">
                <span>Generated SQL Script</span>
                <button onClick={() => navigator.clipboard.writeText(script).catch(() => {})}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                  Copy
                </button>
                <button onClick={() => setScript(null)}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              </div>
              <pre className="dbcompare-script">{script}</pre>
            </div>
          )}
        </div>
      )}

      {!schemaDiff && !loading && (
        <div className="dbcompare-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5">
            <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
          </svg>
          <p>Select source and target connections, then click <strong>Compare</strong></p>
        </div>
      )}

      {showWizard && schemaDiff && (
        <MigrationWizard
          srcId={flowSrcId} tgtId={flowTgtId} srcConn={flowSrcConn} tgtConn={flowTgtConn}
          schemaDiff={flowDiff} selectedTables={selectedList}
          safeMode={safeMode} onToggleSafeMode={onToggleSafeMode}
          onClose={(r) => { setShowWizard(false); if (r?.ran) handleCompare() }}
        />
      )}
    </div>
  )
}
