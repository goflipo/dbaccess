import React from 'react'
import './StatusBar.css'

export default function StatusBar({ message, connectionCount, activeConnection, safeMode, onToggleSafeMode, theme, onToggleTheme, onOpenSettings, onOpenDeleteHistory, deleteHistoryCount, onOpenCompare }) {
  return (
    <div className="statusbar">
      
      <div className="statusbar-left">
        <div className={`status-dot status-${message.type}`}></div>
        <span className={`status-text status-text-${message.type}`}>{message.text}</span>
      </div>
      <button
        className="theme-toggle"
        onClick={onToggleTheme}
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {theme === 'dark' ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        )}
      </button>
      <button className="statusbar-compare-btn" onClick={onOpenCompare} title="Compare & Sync databases">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/>
        </svg>
        Compare & Sync
      </button>
      <div className="statusbar-right">
        <button
          data-tour="safe-mode"
          className={`safe-mode-toggle ${safeMode ? 'enabled' : 'disabled'}`}
          onClick={() => onToggleSafeMode(!safeMode)}
          title={safeMode ? "Safe Mode: Active (Protects against destructive queries)" : "Safe Mode: Off (DANGEROUS)"}
        >
          {safeMode ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01"/></svg>
          )}
          <span>{safeMode ? 'SAFE MODE ON' : 'SAFE MODE OFF'}</span>
        </button>
        {activeConnection && (
          <span className="status-connection">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
            </svg>
            <span className="status-conn-name">{activeConnection.name || activeConnection.host}</span>
            {activeConnection.database && (
              <span className="status-db-name">/ {activeConnection.database}</span>
            )}
            <span className="status-conn-port">:{activeConnection.port}</span>
          </span>
        )}
        <span className="status-conncount">{connectionCount} conn{connectionCount !== 1 ? 's' : ''}</span>
        <button
          className={`delete-history-btn ${deleteHistoryCount > 0 ? 'has-entries' : ''}`}
          onClick={onOpenDeleteHistory}
          title={`Delete history (${deleteHistoryCount} entries)`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
          </svg>
          {deleteHistoryCount > 0 && <span className="delete-history-badge">{deleteHistoryCount}</span>}
        </button>
        <button
          className="settings-gear-btn"
          onClick={() => window.location.reload()}
          title="Reload application"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
        <button
          data-tour="settings"
          className="settings-gear-btn"
          onClick={onOpenSettings}
          title="Open settings"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
          </svg>
        </button>
      </div>
    </div>
  )
}
