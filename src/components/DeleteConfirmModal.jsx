import React, { useState } from 'react'
import './DeleteConfirmModal.css'

const MAX_PREVIEW_COLS = 6

function MiniTable({ rows, label }) {
  if (!rows || rows.length === 0) return null
  const cols = Object.keys(rows[0]).filter(k => k !== '__db_ctid').slice(0, MAX_PREVIEW_COLS)
  return (
    <div className="dcm-mini-table-wrap">
      {label && <div className="dcm-mini-label">{label}</div>}
      <div className="dcm-mini-scroll">
        <table className="dcm-mini-table">
          <thead>
            <tr>{cols.map(c => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((row, i) => (
              <tr key={i}>
                {cols.map(c => {
                  const v = row[c]
                  const isNull = v === null || v === undefined
                  return <td key={c} className={isNull ? 'dcm-null' : ''}>{isNull ? 'NULL' : String(v).slice(0, 60)}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 10 && <div className="dcm-more">+{rows.length - 10} more rows in preview</div>}
    </div>
  )
}

export default function DeleteConfirmModal({ mode, tableName, rows, fkImpact, onConfirm, onCancel, isLoading }) {
  const [expanded, setExpanded] = useState({})
  const hasFk = fkImpact && fkImpact.length > 0
  const hasAffectedFk = hasFk && fkImpact.some(fk => fk.affectedCount > 0)
  const totalCascadeRows = fkImpact ? fkImpact.reduce((s, fk) => s + fk.affectedCount, 0) : 0

  const toggleExpand = (idx) => setExpanded(prev => ({ ...prev, [idx]: !prev[idx] }))

  return (
    <div className="dcm-overlay" onClick={onCancel}>
      <div className="dcm-modal" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className={`dcm-header ${mode === 'truncate' ? 'dcm-header-truncate' : 'dcm-header-delete'}`}>
          <div className="dcm-header-icon">
            {mode === 'truncate' ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6M9 6V4h6v2"/>
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            )}
          </div>
          <div>
            <div className="dcm-title">
              {mode === 'truncate'
                ? `Truncate table "${tableName}"`
                : `Delete ${rows.length} row${rows.length !== 1 ? 's' : ''} from "${tableName}"`}
            </div>
            <div className="dcm-subtitle">
              {mode === 'truncate'
                ? 'All rows will be permanently removed. This cannot be undone.'
                : 'Selected rows will be permanently deleted. This cannot be undone.'}
            </div>
          </div>
        </div>

        <div className="dcm-body">
          {isLoading && (
            <div className="dcm-loading">
              <div className="dcm-spinner" />
              <span>Checking foreign key dependencies…</span>
            </div>
          )}

          {/* Rows preview (delete mode) */}
          {mode === 'delete' && rows.length > 0 && !isLoading && (
            <div className="dcm-section">
              <div className="dcm-section-title">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>
                Rows to delete ({rows.length})
              </div>
              <MiniTable rows={rows} />
            </div>
          )}

          {/* FK dependencies */}
          {!isLoading && hasFk && (
            <div className="dcm-section">
              <div className={`dcm-section-title ${hasAffectedFk ? 'dcm-warn' : ''}`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01"/>
                </svg>
                Foreign key dependencies ({fkImpact.length} referencing table{fkImpact.length !== 1 ? 's' : ''})
                {hasAffectedFk && <span className="dcm-badge-warn">{totalCascadeRows} rows affected</span>}
              </div>

              {fkImpact.map((fk, idx) => (
                <div key={idx} className={`dcm-fk-entry ${fk.affectedCount > 0 ? 'dcm-fk-affected' : 'dcm-fk-clean'}`}>
                  <div className="dcm-fk-header" onClick={() => fk.affectedCount > 0 && toggleExpand(idx)}>
                    <div className="dcm-fk-info">
                      <span className="dcm-fk-table">{fk.fullTableName}</span>
                      <span className="dcm-fk-rel">
                        <code>.{fk.refColumn}</code>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                        <code>{fk.srcColumn}</code>
                      </span>
                    </div>
                    <div className="dcm-fk-meta">
                      {fk.affectedCount > 0 ? (
                        <>
                          <span className="dcm-fk-count-warn">{fk.affectedCount} row{fk.affectedCount !== 1 ? 's' : ''} affected</span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: expanded[idx] ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}><path d="M6 9l6 6 6-6"/></svg>
                        </>
                      ) : (
                        <span className="dcm-fk-count-ok">No rows affected</span>
                      )}
                    </div>
                  </div>
                  {expanded[idx] && fk.affectedRows?.length > 0 && (
                    <div className="dcm-fk-preview">
                      <MiniTable rows={fk.affectedRows} />
                      {fk.affectedCount > fk.affectedRows.length && (
                        <div className="dcm-more">Showing {fk.affectedRows.length} of {fk.affectedCount} affected rows</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* No FK */}
          {!isLoading && !hasFk && mode === 'delete' && (
            <div className="dcm-no-fk">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg>
              No foreign key dependencies found
            </div>
          )}

          {/* Truncate note */}
          {mode === 'truncate' && !isLoading && (
            <div className="dcm-truncate-note">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              TRUNCATE removes all rows and resets sequences. Row data cannot be stored in delete history for truncate operations.
              {hasAffectedFk && <> Make sure referencing tables allow this or cascade manually.</>}
            </div>
          )}
        </div>

        {/* Footer buttons */}
        <div className="dcm-footer">
          <button className="dcm-btn dcm-btn-cancel" onClick={onCancel}>Cancel</button>
          <div className="dcm-footer-right">
            {mode === 'delete' && hasAffectedFk && (
              <button className="dcm-btn dcm-btn-delete" onClick={() => onConfirm('single')}>
                Delete this table only
                <span className="dcm-btn-hint">(may fail if FK enforced)</span>
              </button>
            )}
            <button
              className={`dcm-btn ${hasAffectedFk && mode === 'delete' ? 'dcm-btn-cascade' : 'dcm-btn-danger'}`}
              onClick={() => onConfirm(hasAffectedFk && mode === 'delete' ? 'cascade' : 'single')}
              disabled={isLoading}
            >
              {mode === 'truncate' ? (
                'Truncate table'
              ) : hasAffectedFk ? (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                  Cascade Delete ({rows.length + totalCascadeRows} total rows)
                </>
              ) : (
                <>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                  Delete {rows.length} row{rows.length !== 1 ? 's' : ''}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
