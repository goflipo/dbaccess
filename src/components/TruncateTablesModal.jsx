import React, { useState } from 'react'
import './DropTableModal.css'

export default function TruncateTablesModal({ tables, affected = [], connectionType, isLoading, onConfirm, onCancel }) {
  const isPg = ['postgres', 'cockroachdb', 'greenplum', 'redshift'].includes(connectionType)
  const isMysql = ['mysql', 'mariadb'].includes(connectionType)
  const supportsCascade = connectionType !== 'clickhouse'
  const [cascade, setCascade] = useState(affected.length > 0)
  const [restartIdentity, setRestartIdentity] = useState(false)
  const isSingle = tables.length === 1
  const short = (t) => t.split('.').pop()
  const hasAffected = affected.length > 0
  const total = tables.length + (cascade && hasAffected ? affected.length : 0)

  const chip = (t, highlight) => (
    <div key={t} className="dtm-table-chip" style={highlight ? { borderColor: '#f7c948', color: '#f7c948' } : undefined}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>
      </svg>
      {t}
    </div>
  )

  const checkbox = (checked, onToggle, label, desc) => (
    <label className="dtm-cascade-row">
      <div className={`dtm-checkbox ${checked ? 'checked' : ''}`} onClick={onToggle}>
        {checked && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
        )}
      </div>
      <div className="dtm-cascade-text">
        <span className="dtm-cascade-label">{label}</span>
        <span className="dtm-cascade-desc">{desc}</span>
      </div>
    </label>
  )

  return (
    <div className="dtm-overlay" onClick={onCancel}>
      <div className="dtm-modal" onClick={e => e.stopPropagation()}>
        <div className="dtm-header">
          <div className="dtm-header-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <div>
            <div className="dtm-title">
              {isSingle ? `Truncate table "${short(tables[0])}"` : `Truncate ${tables.length} tables`}
            </div>
            <div className="dtm-subtitle">All rows will be permanently removed. This cannot be undone.</div>
          </div>
          <button className="dtm-close" onClick={onCancel}>✕</button>
        </div>

        <div className="dtm-body">
          {!isSingle && <div className="dtm-tables-list">{tables.map(t => chip(t))}</div>}

          {isLoading && <div className="dtm-info-note">Checking foreign key dependencies...</div>}

          {!isLoading && hasAffected && (
            <>
              <div className="dtm-info-note">
                {affected.length} more table{affected.length !== 1 ? 's' : ''} reference{affected.length === 1 ? 's' : ''} the selection (directly or through other tables):
              </div>
              <div className="dtm-tables-list">{affected.map(t => chip(t, cascade))}</div>
            </>
          )}

          {!isLoading && supportsCascade && hasAffected && checkbox(
            cascade, () => setCascade(v => !v),
            'Truncate with CASCADE',
            cascade
              ? `The ${affected.length} table${affected.length !== 1 ? 's' : ''} above will be emptied too.`
              : 'Without CASCADE the database will refuse to truncate tables referenced by a foreign key.'
          )}

          {!isLoading && isPg && checkbox(
            restartIdentity, () => setRestartIdentity(v => !v),
            'Restart identity',
            'Reset sequences / auto-increment counters owned by the truncated columns back to 1.'
          )}

          {isMysql && cascade && hasAffected && (
            <div className="dtm-info-note">
              MySQL will run <code>SET FOREIGN_KEY_CHECKS = 0</code> before truncating. Referencing tables are not emptied automatically.
            </div>
          )}

          <div className="dtm-warning-box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>
              <strong>{total} table{total !== 1 ? 's' : ''}</strong> will lose all rows. Truncated rows are not saved in delete history.
            </span>
          </div>
        </div>

        <div className="dtm-footer">
          <button className="dtm-btn dtm-btn-cancel" onClick={onCancel}>Cancel</button>
          <button
            className="dtm-btn dtm-btn-danger"
            disabled={isLoading}
            onClick={() => onConfirm({ cascade: cascade && hasAffected, restartIdentity })}
          >
            Truncate {isSingle ? 'table' : `${tables.length} tables`}{cascade && hasAffected ? ' CASCADE' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
