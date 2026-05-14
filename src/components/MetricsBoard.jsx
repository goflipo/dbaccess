import React, { useState, useEffect, useCallback, useRef } from 'react'
import './MetricsBoard.css'

const REFRESH_INTERVAL = 10000 // 10 seconds

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

function MetricCard({ title, value, subtitle, icon, color }) {
  return (
    <div className="metric-card" style={{ '--card-accent': color }}>
      <div className="metric-card-icon">{icon}</div>
      <div className="metric-card-content">
        <div className="metric-card-value">{value ?? '—'}</div>
        <div className="metric-card-title">{title}</div>
        {subtitle && <div className="metric-card-sub">{subtitle}</div>}
      </div>
    </div>
  )
}

export default function MetricsBoard({ connectionId }) {
  const [metrics, setMetrics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const intervalRef = useRef(null)

  const fetchMetrics = useCallback(async () => {
    if (!connectionId || !window.dbAccess) return
    try {
      const result = await window.dbAccess.getMetrics(connectionId)
      if (result.success) {
        setMetrics(result.data)
        setLastUpdate(new Date())
        setError(null)
      } else {
        setError(result.error)
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    fetchMetrics()
  }, [fetchMetrics])

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(fetchMetrics, REFRESH_INTERVAL)
    }
    return () => clearInterval(intervalRef.current)
  }, [autoRefresh, fetchMetrics])

  if (loading) return (
    <div className="metrics-board metrics-loading">
      <div className="metrics-spinner"></div>
      <p>Loading metrics...</p>
    </div>
  )

  if (error) return (
    <div className="metrics-board metrics-error">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent-red)" strokeWidth="2">
        <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>
      </svg>
      <p>Failed to load metrics: {error}</p>
      <button className="metrics-retry-btn" onClick={fetchMetrics}>Retry</button>
    </div>
  )

  const isPostgres = metrics?.type === 'postgres'
  const dbStats = metrics?.dbStats || {}
  const cacheHit = parseFloat(metrics?.cacheHitRatio || 0).toFixed(1)
  const totalConns = metrics?.activeConnections?.reduce((s, r) => s + parseInt(r.count || 0), 0) || 0
  const activeConns = metrics?.activeConnections?.find(r => r.state === 'active')?.count || '0'

  return (
    <div className="metrics-board">
      {/* Header */}
      <div className="metrics-header">
        <div className="metrics-header-left">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <span>Metrics Board</span>
          {lastUpdate && (
            <span className="metrics-last-update">Updated {lastUpdate.toLocaleTimeString()}</span>
          )}
        </div>
        <div className="metrics-header-actions">
          <button
            className={`metrics-autorefresh-btn ${autoRefresh ? 'active' : ''}`}
            onClick={() => setAutoRefresh(v => !v)}
            title={autoRefresh ? 'Auto-refresh ON (10s)' : 'Auto-refresh OFF'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
            </svg>
            {autoRefresh ? 'Auto ON' : 'Auto OFF'}
          </button>
          <button className="metrics-refresh-btn" onClick={fetchMetrics} title="Refresh now">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
            </svg>
            Refresh
          </button>
        </div>
      </div>

      <div className="metrics-content">
        {isPostgres ? (
          <>
            {/* KPI Cards */}
            <div className="metrics-cards-grid">
              <MetricCard
                title="Active Connections"
                value={activeConns}
                subtitle={`${totalConns} total`}
                color="var(--accent-blue)"
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>}
              />
              <MetricCard
                title="Cache Hit Ratio"
                value={`${cacheHit}%`}
                subtitle={cacheHit >= 95 ? '✓ Healthy' : cacheHit >= 85 ? '⚠ Moderate' : '✗ Low'}
                color={cacheHit >= 95 ? 'var(--accent-green)' : cacheHit >= 85 ? 'var(--accent-yellow)' : 'var(--accent-red)'}
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>}
              />
              <MetricCard
                title="Transactions Committed"
                value={(parseInt(dbStats.xact_commit) || 0).toLocaleString()}
                subtitle={`${(parseInt(dbStats.xact_rollback) || 0).toLocaleString()} rollbacks`}
                color="var(--accent-green)"
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5"/></svg>}
              />
              <MetricCard
                title="Database Size"
                value={dbStats.size || '—'}
                subtitle={dbStats.datname}
                color="var(--accent-purple)"
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>}
              />
              <MetricCard
                title="Rows Fetched"
                value={(parseInt(dbStats.tup_fetched) || 0).toLocaleString()}
                subtitle={`${(parseInt(dbStats.tup_returned) || 0).toLocaleString()} returned`}
                color="var(--accent-teal)"
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>}
              />
              <MetricCard
                title="Rows Modified"
                value={((parseInt(dbStats.tup_inserted) || 0) + (parseInt(dbStats.tup_updated) || 0) + (parseInt(dbStats.tup_deleted) || 0)).toLocaleString()}
                subtitle={`${parseInt(dbStats.tup_inserted)||0} ins · ${parseInt(dbStats.tup_updated)||0} upd · ${parseInt(dbStats.tup_deleted)||0} del`}
                color="var(--accent-orange)"
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>}
              />
            </div>

            {/* Connections by state */}
            {metrics.activeConnections?.length > 0 && (
              <div className="metrics-section">
                <h3 className="metrics-section-title">Connection States</h3>
                <div className="metrics-conn-states">
                  {metrics.activeConnections.map((row, i) => (
                    <div key={i} className={`conn-state-row state-${(row.state || 'unknown').replace(/\s+/g, '-')}`}>
                      <span className="conn-state-name">{row.state || 'unknown'}</span>
                      <span className="conn-state-count">{row.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Top Tables */}
            {metrics.topTables?.length > 0 && (
              <div className="metrics-section">
                <h3 className="metrics-section-title">Top Tables (by size)</h3>
                <table className="metrics-table">
                  <thead>
                    <tr>
                      <th>Table</th>
                      <th>Size</th>
                      <th>Live Rows</th>
                      <th>Dead Rows</th>
                      <th>Seq Scans</th>
                      <th>Idx Scans</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.topTables.map((t, i) => (
                      <tr key={i}>
                        <td className="metrics-table-name">{t.relname}</td>
                        <td>{t.total_size}</td>
                        <td>{parseInt(t.n_live_tup || 0).toLocaleString()}</td>
                        <td className={parseInt(t.n_dead_tup) > 1000 ? 'metrics-warn' : ''}>
                          {parseInt(t.n_dead_tup || 0).toLocaleString()}
                        </td>
                        <td>{parseInt(t.seq_scan || 0).toLocaleString()}</td>
                        <td>{parseInt(t.idx_scan || 0).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Locks */}
            {metrics.locks?.length > 0 && (
              <div className="metrics-section">
                <h3 className="metrics-section-title">Active Locks</h3>
                <div className="metrics-locks">
                  {metrics.locks.map((l, i) => (
                    <div key={i} className="lock-badge">{l.mode}: {l.count}</div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          // ClickHouse metrics
          <>
            {metrics.metrics?.length > 0 && (
              <div className="metrics-section">
                <h3 className="metrics-section-title">System Metrics</h3>
                <div className="metrics-cards-grid">
                  {metrics.metrics.slice(0, 6).map((m, i) => (
                    <MetricCard key={i} title={m.metric || m.name} value={parseInt(m.value||0).toLocaleString()} color="var(--accent-blue)"
                      icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>}
                    />
                  ))}
                </div>
              </div>
            )}
            {metrics.tables?.length > 0 && (
              <div className="metrics-section">
                <h3 className="metrics-section-title">Top Tables (by size)</h3>
                <table className="metrics-table">
                  <thead><tr><th>Database</th><th>Table</th><th>Rows</th><th>Size</th></tr></thead>
                  <tbody>
                    {metrics.tables.map((t, i) => (
                      <tr key={i}>
                        <td>{t.database}</td>
                        <td className="metrics-table-name">{t.name}</td>
                        <td>{parseInt(t.total_rows||0).toLocaleString()}</td>
                        <td>{formatBytes(t.total_bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
