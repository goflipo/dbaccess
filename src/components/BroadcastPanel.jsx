import React, { useState, useCallback, useRef } from 'react'
import './BroadcastPanel.css'

const DESTRUCTIVE_PATTERN = /\b(DROP|DELETE|TRUNCATE|ALTER)\b/i

function ResultTable({ data }) {
  if (!data || !data.columns || data.columns.length === 0) return null
  const rows = data.rows || []
  const preview = rows.slice(0, 15)
  return (
    <div className="bc-result-table-wrap">
      <table className="bc-result-table">
        <thead>
          <tr>
            {data.columns.map(c => <th key={c.name} title={c.dataType}>{c.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {preview.map((row, i) => (
            <tr key={i}>
              {data.columns.map(c => {
                const val = row[c.name]
                const display = val === null || val === undefined ? <span className="bc-null">NULL</span> : String(val)
                return <td key={c.name}>{display}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 15 && (
        <div className="bc-result-more">Showing 15 of {rows.length} rows</div>
      )}
    </div>
  )
}

function StatusBadge({ res }) {
  if (!res) return null
  if (res.status === 'running') {
    return <span className="bc-badge bc-badge-running"><span className="bc-spinner" />Running…</span>
  }
  if (res.status === 'success') {
    return (
      <span className="bc-badge bc-badge-success">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>
        {res.data?.rowCount ?? 0} rows · {res.duration}ms
      </span>
    )
  }
  if (res.status === 'error') {
    return (
      <span className="bc-badge bc-badge-error">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
        Error
      </span>
    )
  }
  return null
}

export default function BroadcastPanel({ connections }) {
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [results, setResults] = useState({})
  const [isRunning, setIsRunning] = useState(false)
  const startTimesRef = useRef({})
  const remainingRef = useRef(0)

  const activeConns = connections.filter(c => c.connected !== false)

  const toggleConn = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const selectAll = () => setSelectedIds(new Set(activeConns.map(c => c.id)))
  const clearAll = () => setSelectedIds(new Set())

  const handleRun = useCallback(() => {
    if (!query.trim() || selectedIds.size === 0 || isRunning) return

    if (DESTRUCTIVE_PATTERN.test(query)) {
      const keyword = query.match(DESTRUCTIVE_PATTERN)?.[0]?.toUpperCase()
      const ok = window.confirm(
        `⚠️ Broadcast Warning\n\nThis query contains "${keyword}" and will run on ${selectedIds.size} database(s).\n\nThis action may be irreversible on all selected databases. Continue?`
      )
      if (!ok) return
    }

    setIsRunning(true)
    const initial = {}
    startTimesRef.current = {}
    for (const id of selectedIds) {
      initial[id] = { status: 'running' }
      startTimesRef.current[id] = Date.now()
    }
    setResults(initial)
    remainingRef.current = selectedIds.size

    for (const connId of selectedIds) {
      window.dbAccess.executeQuery(connId, query)
        .then(result => {
          const duration = Date.now() - (startTimesRef.current[connId] || Date.now())
          setResults(prev => ({
            ...prev,
            [connId]: result.success
              ? { status: 'success', data: result.data, duration }
              : { status: 'error', error: result.error, duration },
          }))
        })
        .catch(err => {
          const duration = Date.now() - (startTimesRef.current[connId] || Date.now())
          setResults(prev => ({
            ...prev,
            [connId]: { status: 'error', error: err.message, duration },
          }))
        })
        .finally(() => {
          remainingRef.current -= 1
          if (remainingRef.current <= 0) setIsRunning(false)
        })
    }
  }, [query, selectedIds, isRunning])

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      handleRun()
    }
  }

  const successCount = Object.values(results).filter(r => r.status === 'success').length
  const errorCount = Object.values(results).filter(r => r.status === 'error').length
  const hasResults = Object.keys(results).length > 0

  return (
    <div className="bc-panel">
      <div className="bc-header">
        <div className="bc-header-left">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="bc-header-icon">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
          </svg>
          <span className="bc-header-title">Multi-DB Broadcast</span>
          <span className="bc-header-sub">Run one query across multiple databases at once</span>
        </div>
        {hasResults && (
          <div className="bc-header-summary">
            {successCount > 0 && <span className="bc-summary-ok">{successCount} succeeded</span>}
            {errorCount > 0 && <span className="bc-summary-err">{errorCount} failed</span>}
          </div>
        )}
      </div>

      <div className="bc-body">
        <div className="bc-left">
          <div className="bc-left-header">
            <span className="bc-left-title">
              Target Databases
              <span className="bc-left-count">{activeConns.length}</span>
            </span>
            <div className="bc-left-actions">
              <button className="bc-text-btn" onClick={selectAll} disabled={activeConns.length === 0}>All</button>
              <button className="bc-text-btn" onClick={clearAll}>None</button>
            </div>
          </div>

          <div className="bc-conn-list">
            {activeConns.length === 0 && (
              <div className="bc-conn-empty">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>
                <span>No connected databases</span>
              </div>
            )}
            {activeConns.map(conn => {
              const res = results[conn.id]
              const isSelected = selectedIds.has(conn.id)
              return (
                <label
                  key={conn.id}
                  className={`bc-conn-item ${isSelected ? 'bc-conn-selected' : ''}`}
                  onClick={() => toggleConn(conn.id)}
                >
                  <div className="bc-conn-check">
                    {isSelected
                      ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>
                      : null
                    }
                  </div>
                  <div className={`bc-conn-dot bc-conn-dot-${conn.type || 'postgres'}`} />
                  <div className="bc-conn-info">
                    <span className="bc-conn-name">{conn.name || conn.host}</span>
                    <span className="bc-conn-db">{conn.database || conn.host}</span>
                  </div>
                  <div className="bc-conn-indicator">
                    {res?.status === 'running' && <span className="bc-dot-running" />}
                    {res?.status === 'success' && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                    )}
                    {res?.status === 'error' && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                    )}
                  </div>
                </label>
              )
            })}
          </div>

          <div className="bc-left-footer">
            <span>{selectedIds.size} selected</span>
          </div>
        </div>

        <div className="bc-right">
          <div className="bc-editor-section">
            <div className="bc-editor-label">SQL Query <span className="bc-shortcut">Ctrl+Enter to run</span></div>
            <textarea
              className="bc-editor"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="SELECT 1; — type your query here, then click Run"
              spellCheck={false}
              autoComplete="off"
            />
            <div className="bc-editor-footer">
              <div className="bc-editor-info">
                {selectedIds.size === 0
                  ? <span className="bc-hint">Select databases on the left to get started</span>
                  : <span className="bc-hint">{selectedIds.size} database{selectedIds.size !== 1 ? 's' : ''} selected</span>
                }
              </div>
              <button
                className="bc-run-btn"
                onClick={handleRun}
                disabled={isRunning || selectedIds.size === 0 || !query.trim()}
              >
                {isRunning
                  ? <><span className="bc-spinner bc-spinner-sm" />Running…</>
                  : <>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      Run on {selectedIds.size} DB{selectedIds.size !== 1 ? 's' : ''}
                    </>
                }
              </button>
            </div>
          </div>

          {hasResults && (
            <div className="bc-results-section">
              <div className="bc-results-header">Results</div>
              <div className="bc-results-list">
                {Array.from(selectedIds).map(connId => {
                  const conn = connections.find(c => c.id === connId)
                  const res = results[connId]
                  if (!res) return null
                  return (
                    <div key={connId} className={`bc-result-card bc-result-${res.status}`}>
                      <div className="bc-result-card-header">
                        <div className="bc-result-card-title">
                          <div className={`bc-conn-dot bc-conn-dot-${conn?.type || 'postgres'}`} />
                          <span className="bc-result-card-name">{conn?.name || conn?.host}</span>
                          {conn?.database && <span className="bc-result-card-db">{conn.database}</span>}
                        </div>
                        <StatusBadge res={res} />
                      </div>
                      {res.status === 'error' && (
                        <div className="bc-result-error">{res.error}</div>
                      )}
                      {res.status === 'success' && res.data?.rows?.length > 0 && (
                        <ResultTable data={res.data} />
                      )}
                      {res.status === 'success' && res.data?.rows?.length === 0 && (
                        <div className="bc-result-ok-msg">
                          Query executed successfully
                          {res.data?.command && ` (${res.data.command})`}
                          {res.data?.rowCount !== undefined && res.data.rowCount > 0 && ` — ${res.data.rowCount} rows affected`}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {!hasResults && (
            <div className="bc-results-empty">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
              </svg>
              <p>Results from each database will appear here after you run a query</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
