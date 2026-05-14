import React, { useState, useMemo } from 'react'
import './DeleteHistoryPanel.css'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`
  const s = String(v)
  // Detect serialised Date strings
  if (/^\w{3} \w{3} {1,2}\d{1,2} \d{4}/.test(s)) {
    const d = new Date(s)
    if (!isNaN(d.getTime())) return `'${d.toISOString()}'`
  }
  return `'${s.replace(/'/g, "''")}'`
}

function buildReinsertSQL(tableName, rows) {
  if (!rows || rows.length === 0) return ''
  const cols = Object.keys(rows[0]).filter(k => k !== '__db_ctid')
  const colList = cols.map(c => `"${c}"`).join(', ')
  const valueRows = rows.map(row =>
    '  (' + cols.map(c => sqlLiteral(row[c])).join(', ') + ')'
  ).join(',\n')
  return `INSERT INTO ${tableName} (${colList}) VALUES\n${valueRows};`
}

function formatTimestamp(iso) {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch { return iso }
}

function daysUntilExpiry(expiresAt) {
  const diff = new Date(expiresAt) - Date.now()
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)))
}

export default function DeleteHistoryPanel({ history, onClose, onRestoreEntry, onClearAll, onDeleteEntry }) {
  const [search, setSearch] = useState('')
  const [copiedId, setCopiedId] = useState(null)

  const filtered = useMemo(() => {
    if (!search.trim()) return history
    const q = search.toLowerCase()
    return history.filter(e =>
      e.tableName?.toLowerCase().includes(q) ||
      e.connectionName?.toLowerCase().includes(q) ||
      e.operation?.toLowerCase().includes(q)
    )
  }, [history, search])

  const handleCopySQL = (entry) => {
    const parts = [buildReinsertSQL(entry.tableName, entry.rows)]
    if (entry.cascadeRows) {
      entry.cascadeRows.forEach(cr => {
        const s = buildReinsertSQL(cr.tableName, cr.rows)
        if (s) parts.unshift(s) // cascade tables go first (children before parent)
      })
    }
    const sql = parts.filter(Boolean).join('\n\n')
    navigator.clipboard.writeText(sql).then(() => {
      setCopiedId(entry.id)
      setTimeout(() => setCopiedId(null), 2000)
    })
  }

  const handleRestore = (entry) => {
    const parts = []
    if (entry.cascadeRows) {
      entry.cascadeRows.forEach(cr => {
        const s = buildReinsertSQL(cr.tableName, cr.rows)
        if (s) parts.push(s)
      })
    }
    parts.push(buildReinsertSQL(entry.tableName, entry.rows))
    const sql = parts.filter(Boolean).join('\n\n')
    onRestoreEntry({ ...entry, reinsertSQL: sql })
  }

  const total = history.length
  const restorable = history.filter(e => e.restorable && e.rows?.length > 0).length

  return (
    <div className="dhp-overlay" onClick={onClose}>
      <div className="dhp-panel" onClick={e => e.stopPropagation()}>

        <div className="dhp-header">
          <div className="dhp-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              <path d="M10 11v6M14 11v6"/>
            </svg>
            Delete History
            <span className="dhp-count">{total} entries</span>
          </div>
          <div className="dhp-header-actions">
            {restorable > 0 && <span className="dhp-restorable-badge">{restorable} restorable</span>}
            {total > 0 && <button className="dhp-btn-clear" onClick={onClearAll} title="Clear all history">Clear all</button>}
            <button className="dhp-close-btn" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="dhp-toolbar">
          <div className="dhp-search-wrap">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
            <input
              className="dhp-search"
              placeholder="Search by table, connection…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="dhp-hint">Data stored for 30 days · Timestamps in local time</div>
        </div>

        <div className="dhp-list">
          {filtered.length === 0 && (
            <div className="dhp-empty">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--border-strong)" strokeWidth="1.5">
                <path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              </svg>
              <p>{search ? 'No entries match your search' : 'No delete history yet'}</p>
              <p className="dhp-empty-hint">Deleted rows will appear here for 30 days</p>
            </div>
          )}

          {filtered.map(entry => {
            const daysLeft = daysUntilExpiry(entry.expiresAt)
            const isRestorable = entry.restorable && entry.rows?.length > 0
            const hasCascade = entry.cascadeRows && entry.cascadeRows.some(cr => cr.rowCount > 0)

            return (
              <div key={entry.id} className="dhp-entry">
                <div className="dhp-entry-header">
                  <div className="dhp-entry-meta">
                    <span className={`dhp-op-badge dhp-op-${entry.operation}`}>
                      {entry.operation === 'truncate' ? 'TRUNCATE' : 'DELETE'}
                    </span>
                    <span className="dhp-table-name">{entry.tableName}</span>
                    {entry.connectionName && (
                      <span className="dhp-conn-name">· {entry.connectionName}</span>
                    )}
                  </div>
                  <button
                    className="dhp-remove-btn"
                    onClick={() => onDeleteEntry(entry.id)}
                    title="Remove from history"
                  >✕</button>
                </div>

                <div className="dhp-entry-stats">
                  <div className="dhp-stat">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>
                    {entry.rowCount} row{entry.rowCount !== 1 ? 's' : ''} deleted
                  </div>
                  {hasCascade && (
                    <div className="dhp-stat dhp-stat-cascade">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
                      cascade: {entry.cascadeRows.map(cr => `${cr.rowCount} from ${cr.tableName}`).join(', ')}
                    </div>
                  )}
                  <div className="dhp-stat dhp-stat-time">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    {formatTimestamp(entry.timestamp)}
                  </div>
                  <div className={`dhp-stat dhp-expiry ${daysLeft <= 3 ? 'dhp-expiry-warn' : ''}`}>
                    Expires in {daysLeft} day{daysLeft !== 1 ? 's' : ''}
                  </div>
                </div>

                {isRestorable && (
                  <div className="dhp-entry-actions">
                    <button
                      className={`dhp-action-btn ${copiedId === entry.id ? 'dhp-copied' : ''}`}
                      onClick={() => handleCopySQL(entry)}
                      title="Copy re-insert SQL to clipboard"
                    >
                      {copiedId === entry.id ? (
                        <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg> Copied!</>
                      ) : (
                        <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy SQL</>
                      )}
                    </button>
                    <button
                      className="dhp-action-btn dhp-action-restore"
                      onClick={() => handleRestore(entry)}
                      title="Open re-insert SQL in a new tab"
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
                      Restore to tab
                    </button>
                  </div>
                )}

                {!isRestorable && (
                  <div className="dhp-not-restorable">
                    {entry.operation === 'truncate'
                      ? 'Row data not stored for TRUNCATE operations'
                      : 'No row data available'}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
