import React, { useState } from 'react'
import './ConnectionModal.css'

const CONNECTION_COLORS = [
  '#6c7bf7', '#3dd68c', '#f76c6c', '#f7c948', '#4ecdc4', '#a78bfa', '#f472b6', '#fb923c'
]

export default function ConnectionModal({ onConnect, onClose, editing }) {
  const [form, setForm] = useState(editing || {
    type: 'postgres', name: '', host: 'localhost', port: '5432',
    database: '', username: '', password: '', ssl: false,
    color: CONNECTION_COLORS[0],
    sshEnabled: false, sshHost: '', sshPort: '22', sshUser: '', sshKey: '',
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [connectionString, setConnectionString] = useState('')

  const parseConnectionString = (urlStr) => {
    try {
      const url = new URL(urlStr.trim())
      if (url.protocol === 'postgres:' || url.protocol === 'postgresql:') {
        setForm(prev => ({
          ...prev, type: 'postgres',
          host: url.hostname || 'localhost', port: url.port || '5432',
          database: url.pathname.replace(/^\//, '') || '',
          username: decodeURIComponent(url.username) || '',
          password: decodeURIComponent(url.password) || '',
        }))
        setConnectionString('')
        setTestResult({ type: 'success', text: 'Connection URL parsed successfully!' })
      } else if (url.protocol === 'mysql:') {
        setForm(prev => ({
          ...prev, type: 'mysql',
          host: url.hostname || 'localhost', port: url.port || '3306',
          database: url.pathname.replace(/^\//, '') || '',
          username: decodeURIComponent(url.username) || '',
          password: decodeURIComponent(url.password) || '',
        }))
        setConnectionString('')
        setTestResult({ type: 'success', text: 'MySQL connection URL parsed successfully!' })
      } else {
        setTestResult({ type: 'error', text: 'Supported URL schemes: postgres://, mysql://' })
      }
    } catch {
      setTestResult({ type: 'error', text: 'Invalid URL. Expected: postgres://user:pass@host:5432/dbname' })
    }
  }

  const DEFAULT_PORTS = { postgres: '5432', mysql: '3306', clickhouse: '8123' }

  const update = (key, val) => {
    setForm(prev => ({
      ...prev, [key]: val,
      ...(key === 'type' ? { port: DEFAULT_PORTS[val] || '5432' } : {}),
    }))
    setTestResult(null)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.dbAccess.testConnection({ ...form, port: parseInt(form.port) })
      setTestResult(result.success ? { type: 'success', text: 'Connection successful!' } : { type: 'error', text: result.error })
    } catch (err) { setTestResult({ type: 'error', text: err.message }) }
    setTesting(false)
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    onConnect({ ...form, port: parseInt(form.port) })
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>{editing ? 'Edit Connection' : 'New Connection'}</h2>
          <button className="modal-close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {/* Connection URL parser */}
            <div className="form-group">
              <label>Paste Connection URL <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional)</span></label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  value={connectionString}
                  onChange={e => setConnectionString(e.target.value)}
                  placeholder="postgres://user:pass@host:5432/db  or  mysql://user:pass@host:3306/db"
                  style={{ flex: 1 }}
                  onKeyDown={e => e.key === 'Enter' && connectionString.trim() && parseConnectionString(connectionString)}
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => parseConnectionString(connectionString)}
                  disabled={!connectionString.trim()}
                  style={{ flexShrink: 0 }}
                >
                  Parse
                </button>
              </div>
            </div>
            <div className="form-divider" style={{ height: '1px', background: 'var(--border-subtle)', margin: '4px 0 12px' }} />

            <div className="form-group">
              <label>Database Type</label>
              <div className="db-type-selector">
                <button type="button" className={`db-type-btn ${form.type === 'postgres' ? 'active' : ''}`} onClick={() => update('type', 'postgres')}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>
                  PostgreSQL
                </button>
                <button type="button" className={`db-type-btn ${form.type === 'mysql' ? 'active' : ''}`} onClick={() => update('type', 'mysql')}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3C7.03 3 3 7.03 3 12s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9z"/><path d="M8 12h8M12 8v8"/></svg>
                  MySQL
                </button>
                <button type="button" className={`db-type-btn ${form.type === 'clickhouse' ? 'active' : ''}`} onClick={() => update('type', 'clickhouse')}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M3 9h18"/></svg>
                  ClickHouse
                </button>
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="conn-name">Connection Name</label>
              <div className="name-with-color">
                <input id="conn-name" type="text" value={form.name} onChange={e => update('name', e.target.value)} placeholder="My Database" />
                <div className="color-picker">
                  {CONNECTION_COLORS.map(c => (
                    <button
                      key={c}
                      type="button"
                      className={`color-dot ${form.color === c ? 'active' : ''}`}
                      style={{ background: c }}
                      onClick={() => update('color', c)}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="form-row">
              <div className="form-group form-grow">
                <label htmlFor="conn-host">Host</label>
                <input id="conn-host" type="text" value={form.host} onChange={e => update('host', e.target.value)} placeholder="localhost" required />
              </div>
              <div className="form-group form-port">
                <label htmlFor="conn-port">Port</label>
                <input id="conn-port" type="text" value={form.port} onChange={e => update('port', e.target.value)} placeholder={form.type === 'postgres' ? '5432' : '8123'} required />
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="conn-db">Database</label>
              <input id="conn-db" type="text" value={form.database} onChange={e => update('database', e.target.value)}
                placeholder={form.type === 'postgres' ? 'postgres' : form.type === 'mysql' ? 'mydb (optional)' : 'default'} />
            </div>

            <div className="form-row">
              <div className="form-group form-grow">
                <label htmlFor="conn-user">Username</label>
                <input id="conn-user" type="text" value={form.username} onChange={e => update('username', e.target.value)}
                  placeholder={form.type === 'postgres' ? 'postgres' : form.type === 'mysql' ? 'root' : 'default'} />
              </div>
              <div className="form-group form-grow">
                <label htmlFor="conn-pass">Password</label>
                <input id="conn-pass" type="password" value={form.password} onChange={e => update('password', e.target.value)} placeholder="••••••••" />
              </div>
            </div>

            {(form.type === 'postgres' || form.type === 'mysql') && (
              <label className="form-checkbox">
                <input type="checkbox" checked={form.ssl} onChange={e => update('ssl', e.target.checked)} />
                <span>Use SSL</span>
              </label>
            )}

            {/* Advanced / SSH section */}
            <button type="button" className="advanced-toggle" onClick={() => setShowAdvanced(!showAdvanced)}>
              <svg className={showAdvanced ? 'expanded' : ''} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
              SSH Tunnel
            </button>

            {showAdvanced && (
              <div className="advanced-section">
                <label className="form-checkbox">
                  <input type="checkbox" checked={form.sshEnabled} onChange={e => update('sshEnabled', e.target.checked)} />
                  <span>Enable SSH Tunnel</span>
                </label>
                {form.sshEnabled && (
                  <>
                    <div className="form-row">
                      <div className="form-group form-grow">
                        <label>SSH Host</label>
                        <input type="text" value={form.sshHost} onChange={e => update('sshHost', e.target.value)} placeholder="ssh.example.com" />
                      </div>
                      <div className="form-group form-port">
                        <label>SSH Port</label>
                        <input type="text" value={form.sshPort} onChange={e => update('sshPort', e.target.value)} placeholder="22" />
                      </div>
                    </div>
                    <div className="form-group">
                      <label>SSH User</label>
                      <input type="text" value={form.sshUser} onChange={e => update('sshUser', e.target.value)} placeholder="ubuntu" />
                    </div>
                    <div className="form-group">
                      <label>SSH Private Key Path</label>
                      <input type="text" value={form.sshKey} onChange={e => update('sshKey', e.target.value)} placeholder="~/.ssh/id_rsa" />
                    </div>
                  </>
                )}
              </div>
            )}

            {testResult && (
              <div className={`test-result ${testResult.type}`}>{testResult.text}</div>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={handleTest} disabled={testing}>
              {testing ? (
                <><span className="btn-spinner-sm"></span> Testing...</>
              ) : 'Test Connection'}
            </button>
            <div className="modal-footer-right">
              <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn-primary-sm">Connect</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
