import React, { useState, useCallback } from 'react'
import './DBComparePanel.css'

export default function DBComparePanel({ connections }) {
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
    setApplyResult(null)
    try {
      const res = await window.dbAccess.compareSchema(srcId, tgtId)
      if (!res.success) throw new Error(res.error)
      setSchemaDiff(res.data)
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

  const handleGenerateScript = useCallback(async () => {
    if (!schemaDiff) return
    const res = await window.dbAccess.generateSyncScript(schemaDiff, direction)
    if (res.success) setScript(res.data)
  }, [schemaDiff, direction])

  const handleApply = useCallback(async () => {
    if (!script) return
    const targetConnId = direction === 'src_to_tgt' ? tgtId : srcId
    const targetConn = connected.find(c => c.id === targetConnId)
    if (!window.confirm(`Apply sync script to "${targetConn?.name || targetConnId}"?\n\nThis will modify the database. Make sure you have a backup.`)) return
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
          <select value={srcId} onChange={e => { setSrcId(e.target.value); setSchemaDiff(null); setDataDiff(null); setScript(null); setError(null) }} className="dbcompare-select">
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
          <select value={tgtId} onChange={e => { setTgtId(e.target.value); setSchemaDiff(null); setDataDiff(null); setScript(null); setError(null) }} className="dbcompare-select">
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
      {crossType && !sameConn && <div className="dbcompare-warn">Cannot compare {srcConn?.type} with {tgtConn?.type} — both connections must use the same database type.</div>}
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
            <button className="dbcompare-action-btn" onClick={handleGenerateScript} disabled={totalIssues === 0}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/></svg>
              Generate SQL Script
            </button>
            {script && (
              <button className="dbcompare-action-btn dbcompare-action-danger" onClick={handleApply} disabled={applying}>
                {applying ? <span className="dbcompare-spinner" /> : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                )}
                {applying ? 'Applying…' : `Apply to ${direction === 'src_to_tgt' ? (tgtConn?.name || 'Target') : (srcConn?.name || 'Source')}`}
              </button>
            )}
          </div>

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
    </div>
  )
}
