import React, { useState } from 'react'
import './DropTableModal.css'

export default function DropTableModal({ tables, connectionType, onConfirm, onCancel }) {
  const [cascade, setCascade] = useState(false)
  const isSingle = tables.length === 1
  const supportsCascade = connectionType !== 'clickhouse'

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
              {isSingle ? `Drop table "${tables[0].split('.').pop()}"` : `Drop ${tables.length} tables`}
            </div>
            <div className="dtm-subtitle">
              Permanently removes the table {isSingle ? '' : 'structures and all data. '}
              This cannot be undone.
            </div>
          </div>
          <button className="dtm-close" onClick={onCancel}>✕</button>
        </div>

        <div className="dtm-body">
          {/* Table list (multi-table) */}
          {!isSingle && (
            <div className="dtm-tables-list">
              {tables.map(t => (
                <div key={t} className="dtm-table-chip">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>
                  </svg>
                  {t}
                </div>
              ))}
            </div>
          )}

          {/* CASCADE option */}
          {supportsCascade && (
            <label className="dtm-cascade-row">
              <div className={`dtm-checkbox ${cascade ? 'checked' : ''}`} onClick={() => setCascade(v => !v)}>
                {cascade && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </div>
              <div className="dtm-cascade-text">
                <span className="dtm-cascade-label">Drop with CASCADE</span>
                <span className="dtm-cascade-desc">
                  Automatically drops dependent objects — views, foreign key constraints, and indexes that reference {isSingle ? 'this table' : 'these tables'}.
                  Without CASCADE the drop will fail if dependencies exist.
                </span>
              </div>
            </label>
          )}

          {connectionType === 'mysql' && cascade && (
            <div className="dtm-info-note">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              MySQL will run <code>SET FOREIGN_KEY_CHECKS = 0</code> before dropping to bypass FK constraints.
            </div>
          )}

          <div className="dtm-warning-box">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>
              All rows and the table schema will be <strong>permanently deleted</strong>.
              {isSingle ? '' : ` ${tables.length} tables will be dropped.`}
            </span>
          </div>
        </div>

        <div className="dtm-footer">
          <button className="dtm-btn dtm-btn-cancel" onClick={onCancel}>Cancel</button>
          <button className="dtm-btn dtm-btn-danger" onClick={() => onConfirm(cascade)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            </svg>
            Drop {isSingle ? 'table' : `${tables.length} tables`}{cascade ? ' CASCADE' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
