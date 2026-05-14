import React, { useState } from 'react'
import './SqlFileProgress.css'

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatNum(n) {
  return n.toLocaleString()
}

export default function SqlFileProgress({ execution, onCancel, onClose }) {
  const [showErrors, setShowErrors] = useState(false)

  if (!execution) return null

  const { fileName, stmtExecuted, errCount, bytesProcessed, totalBytes, status, preview, errors = [] } = execution
  const pct = totalBytes > 0 ? Math.min(100, Math.round((bytesProcessed / totalBytes) * 100)) : 0
  const isDone = status === 'done' || status === 'cancelled'

  return (
    <div className="sqlfp-overlay">
      <div className="sqlfp-modal">
        <div className="sqlfp-header">
          <div className="sqlfp-title-row">
            {isDone ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={status === 'done' ? '#22c55e' : '#f59e0b'} strokeWidth="2.5">
                {status === 'done'
                  ? <><polyline points="20 6 9 17 4 12"/></>
                  : <><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01"/></>
                }
              </svg>
            ) : (
              <div className="sqlfp-spinner" />
            )}
            <span className="sqlfp-title">
              {isDone
                ? (status === 'done' ? 'Execution Complete' : 'Execution Cancelled')
                : 'Executing SQL File…'}
            </span>
          </div>
          <span className="sqlfp-filename" title={fileName}>{fileName}</span>
        </div>

        {/* Progress bar */}
        <div className="sqlfp-progress-track">
          <div
            className={`sqlfp-progress-fill ${isDone && errCount === 0 ? 'done' : ''} ${status === 'cancelled' ? 'cancelled' : ''}`}
            style={{ width: `${isDone ? 100 : pct}%` }}
          />
        </div>
        <div className="sqlfp-pct">{isDone ? '100%' : `${pct}%`}</div>

        {/* Stats */}
        <div className="sqlfp-stats">
          <div className="sqlfp-stat">
            <span className="sqlfp-stat-label">Statements</span>
            <span className="sqlfp-stat-value">{formatNum(stmtExecuted)}</span>
          </div>
          <div className="sqlfp-stat">
            <span className="sqlfp-stat-label">Processed</span>
            <span className="sqlfp-stat-value">{formatBytes(bytesProcessed)} / {formatBytes(totalBytes)}</span>
          </div>
          <div className={`sqlfp-stat ${errCount > 0 ? 'has-errors' : ''}`}>
            <span className="sqlfp-stat-label">Errors</span>
            <span className="sqlfp-stat-value">{errCount}</span>
          </div>
        </div>

        {/* Current statement preview */}
        {!isDone && preview && (
          <div className="sqlfp-preview">
            <span className="sqlfp-preview-label">Running:</span>
            <code className="sqlfp-preview-code">{preview}{preview.length >= 90 ? '…' : ''}</code>
          </div>
        )}

        {/* Error list */}
        {errors.length > 0 && (
          <div className="sqlfp-errors-section">
            <button className="sqlfp-errors-toggle" onClick={() => setShowErrors(v => !v)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d={showErrors ? 'M18 15l-6-6-6 6' : 'M6 9l6 6 6-6'}/>
              </svg>
              {showErrors ? 'Hide' : 'Show'} {errors.length} error{errors.length !== 1 ? 's' : ''}
            </button>
            {showErrors && (
              <div className="sqlfp-errors-list">
                {errors.map((e, i) => (
                  <div key={i} className="sqlfp-error-entry">
                    <div className="sqlfp-error-msg">{e.msg}</div>
                    <code className="sqlfp-error-stmt">{e.stmt}</code>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="sqlfp-actions">
          {!isDone ? (
            <button className="sqlfp-cancel-btn" onClick={onCancel}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
              Cancel
            </button>
          ) : (
            <button className="sqlfp-close-btn" onClick={onClose}>
              {status === 'done' && errCount === 0
                ? <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg> Done</>
                : 'Close'
              }
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
