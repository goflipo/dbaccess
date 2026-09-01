import React, { useState } from 'react'
import './ConnectionModal.css'

const CONNECTION_COLORS = [
  '#6c7bf7', '#3dd68c', '#f76c6c', '#f7c948', '#4ecdc4', '#a78bfa', '#f472b6', '#fb923c'
]

export const DB_TYPES = [
  { id: 'postgres',    label: 'PostgreSQL',    group: 'SQL' },
  { id: 'mysql',       label: 'MySQL',         group: 'SQL' },
  { id: 'mariadb',     label: 'MariaDB',       group: 'SQL' },
  { id: 'mssql',       label: 'SQL Server',    group: 'SQL' },
  { id: 'sqlite',      label: 'SQLite',        group: 'SQL' },
  { id: 'clickhouse',  label: 'ClickHouse',    group: 'Analytics' },
  { id: 'cockroachdb', label: 'CockroachDB',   group: 'SQL' },
  { id: 'greenplum',   label: 'Greenplum',     group: 'Analytics' },
  { id: 'redshift',    label: 'Redshift',      group: 'Analytics' },
  { id: 'snowflake',   label: 'Snowflake',     group: 'Analytics' },
  { id: 'bigquery',    label: 'BigQuery',      group: 'Analytics' },
  { id: 'vertica',     label: 'Vertica',       group: 'Analytics' },
  { id: 'mongodb',     label: 'MongoDB',       group: 'NoSQL' },
  { id: 'redis',       label: 'Redis',         group: 'NoSQL' },
  { id: 'cassandra',   label: 'Cassandra',     group: 'NoSQL' },
  { id: 'dynamodb',    label: 'DynamoDB',      group: 'NoSQL' },
  { id: 'libsql',      label: 'LibSQL',        group: 'Embedded' },
  { id: 'd1',          label: 'Cloudflare D1', group: 'Embedded' },
]

const DEFAULT_PORTS = {
  postgres: '5432', mysql: '3306', mariadb: '3306', mssql: '1433',
  clickhouse: '8123', cockroachdb: '26257', greenplum: '5432',
  redshift: '5439', snowflake: '443', mongodb: '27017',
  redis: '6379', cassandra: '9042', vertica: '5433',
  sqlite: '', libsql: '', bigquery: '', d1: '', dynamodb: '',
}

// Types that use file path instead of host
const FILE_TYPES = new Set(['sqlite'])
// Types that use a connection string
const CONNSTR_TYPES = new Set(['libsql', 'mongodb'])
// Types with special auth (no standard host/port/user/pass)
const CLOUD_TYPES = new Set(['bigquery', 'd1', 'dynamodb', 'snowflake'])

const URL_PLACEHOLDER = {
  postgres:    'postgres://user:pass@host:5432/database',
  cockroachdb: 'cockroachdb://user:pass@host:26257/database',
  greenplum:   'greenplum://user:pass@host:5432/database',
  redshift:    'redshift://user:pass@host:5439/database',
  mysql:       'mysql://user:pass@host:3306/database',
  mariadb:     'mariadb://user:pass@host:3306/database',
  mssql:       'mssql://user:pass@host:1433/database',
  clickhouse:  'clickhouse://user:pass@host:8123/database',
  mongodb:     'mongodb://user:pass@host:27017/database  or  mongodb+srv://user:pass@cluster.mongodb.net/db',
  redis:       'redis://:password@host:6379/0  or  rediss://:password@host:6379/0',
  cassandra:   'cassandra://user:pass@host:9042/keyspace',
  snowflake:   'snowflake://user:pass@account-identifier/database/schema',
  vertica:     'vertica://user:pass@host:5433/database',
  libsql:      'libsql://your-db.turso.io  or  file:/path/to/local.db',
}

function DbTypeIcon({ type }) {
  // Generic DB icon
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <ellipse cx="12" cy="6" rx="9" ry="3"/>
      <path d="M3 6v6c0 1.66 4.03 3 9 3s9-1.34 9-3V6"/>
      <path d="M3 12v6c0 1.66 4.03 3 9 3s9-1.34 9-3v-6"/>
    </svg>
  )
}

export default function ConnectionModal({ onConnect, onClose, editing }) {
  const [form, setForm] = useState(editing || {
    type: 'postgres', name: '', host: '', port: '5434',
    database: '', username: '', password: '', ssl: false,
    color: CONNECTION_COLORS[0],
    sshEnabled: false, sshHost: '', sshPort: '22', sshUser: '', sshKey: '',
    // Extended fields
    filePath: '', connectionString: '', account: '', warehouse: '', schema: '',
    datacenter: 'datacenter1', region: 'us-east-1',
    projectId: '', keyFilePath: '', credentials: '',
    accountId: '', databaseId: '', apiToken: '',
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [connectionString, setConnectionString] = useState('')
  const [typeSearch, setTypeSearch] = useState('')

  const parseConnectionString = (urlStr) => {
    const raw = urlStr.trim()
    if (!raw) return

    // Regex: scheme://[user[:pass]@]host[:port][/database[/schema]]
    // Handles non-standard schemes (postgres, mysql, redis, etc.) that new URL() may misparse
    const RE = /^([a-zA-Z][a-zA-Z0-9+\-.]+):\/\/(?:([^:@/?#]*)(?::([^@/?#]*))?@)?([^/:?#]*)(?::(\d+))?(?:\/([^?#]*))?/

    // file: and libsql:// — pass straight through as connection string
    if (raw.startsWith('file:') || raw.startsWith('libsql://') || raw.startsWith('wss://')) {
      setForm(prev => ({ ...prev, type: 'libsql', connectionString: raw }))
      setConnectionString('')
      setTestResult({ type: 'success', text: 'LibSQL / Turso URL set!' })
      return
    }

    // mongodb+srv uses the full URL as connection string
    if (raw.startsWith('mongodb')) {
      setForm(prev => ({ ...prev, type: 'mongodb', connectionString: raw }))
      setConnectionString('')
      setTestResult({ type: 'success', text: 'MongoDB connection string set!' })
      return
    }

    const m = raw.match(RE)
    if (!m) {
      setTestResult({ type: 'error', text: 'Could not parse URL. Format: scheme://user:pass@host:port/database' })
      return
    }

    const scheme   = m[1].toLowerCase()
    const user     = m[2] ? decodeURIComponent(m[2]) : ''
    const pass     = m[3] ? decodeURIComponent(m[3]) : ''
    const host     = m[4] || 'localhost'
    const portStr  = m[5] || ''
    const pathParts = (m[6] || '').split('/')
    const db       = pathParts[0] || ''
    const schema   = pathParts[1] || ''

    const SCHEME_MAP = {
      'postgres':    { type: 'postgres',    defaultPort: '5432' },
      'postgresql':  { type: 'postgres',    defaultPort: '5432' },
      'greenplum':   { type: 'greenplum',   defaultPort: '5432' },
      'mysql':       { type: 'mysql',       defaultPort: '3306' },
      'mariadb':     { type: 'mariadb',     defaultPort: '3306' },
      'mssql':       { type: 'mssql',       defaultPort: '1433' },
      'sqlserver':   { type: 'mssql',       defaultPort: '1433' },
      'clickhouse':  { type: 'clickhouse',  defaultPort: '8123' },
      'redis':       { type: 'redis',       defaultPort: '6379' },
      'rediss':      { type: 'redis',       defaultPort: '6379', ssl: true },
      'cassandra':   { type: 'cassandra',   defaultPort: '9042' },
      'cockroachdb': { type: 'cockroachdb', defaultPort: '26257' },
      'redshift':    { type: 'redshift',    defaultPort: '5439' },
      'snowflake':   { type: 'snowflake',   defaultPort: '' },
      'vertica':     { type: 'vertica',     defaultPort: '5433' },
      'libsql':      { type: 'libsql',      defaultPort: '' },
    }

    const mapping = SCHEME_MAP[scheme]
    if (!mapping) {
      setTestResult({ type: 'error', text: `Unknown scheme "${scheme}". Supported: postgres, postgresql, greenplum, cockroachdb, redshift, mysql, mariadb, mssql, sqlserver, clickhouse, mongodb, redis, rediss, cassandra, snowflake, vertica, libsql, file:` })
      return
    }

    const port = portStr || mapping.defaultPort

    if (mapping.type === 'snowflake') {
      setForm(prev => ({ ...prev, type: 'snowflake', account: host, username: user, password: pass, database: db, schema }))
    } else if (mapping.type === 'libsql') {
      setForm(prev => ({ ...prev, type: 'libsql', connectionString: raw, password: pass }))
    } else {
      setForm(prev => ({
        ...prev,
        type: mapping.type,
        host, port,
        database: db,
        username: user,
        password: pass,
        ...(mapping.ssl ? { ssl: true } : {}),
      }))
    }

    setConnectionString('')
    setTestResult({ type: 'success', text: `${mapping.type.charAt(0).toUpperCase() + mapping.type.slice(1)} connection string parsed!` })
  }

  const update = (key, val) => {
    setForm(prev => ({
      ...prev, [key]: val,
      ...(key === 'type' ? { port: DEFAULT_PORTS[val] || '' } : {}),
    }))
    setTestResult(null)
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.dbAccess.testConnection({ ...form, port: parseInt(form.port) || form.port })
      setTestResult(result.success ? { type: 'success', text: 'Connection successful!' } : { type: 'error', text: result.error })
    } catch (err) { setTestResult({ type: 'error', text: err.message }) }
    setTesting(false)
  }

  const handleSubmit = (e) => {
    e.preventDefault()
    onConnect({ ...form, port: parseInt(form.port) || form.port })
  }

  const t = form.type
  const isFile = FILE_TYPES.has(t)
  const isCloud = CLOUD_TYPES.has(t)
  const isConnStr = CONNSTR_TYPES.has(t)
  const needsSsl = !isFile && !isCloud
  const needsSsh = !isFile && !isCloud && t !== 'redis'

  const groups = ['SQL', 'Analytics', 'NoSQL', 'Embedded']
  const filteredTypes = typeSearch
    ? DB_TYPES.filter(d => d.label.toLowerCase().includes(typeSearch.toLowerCase()))
    : DB_TYPES

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-header">
          <h2>{editing ? 'Edit Connection' : 'New Connection'}</h2>
          <button className="modal-close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body modal-body-split">
            {/* Left: DB type selector */}
            <div className="db-type-panel">
              <input
                className="db-type-search"
                type="text"
                placeholder="Search databases..."
                value={typeSearch}
                onChange={e => setTypeSearch(e.target.value)}
              />
              {groups.map(group => {
                const items = filteredTypes.filter(d => d.group === group)
                if (!items.length) return null
                return (
                  <div key={group} className="db-type-group">
                    <div className="db-type-group-label">{group}</div>
                    {items.map(db => (
                      <button
                        key={db.id}
                        type="button"
                        className={`db-type-list-btn ${form.type === db.id ? 'active' : ''}`}
                        onClick={() => update('type', db.id)}
                      >
                        <DbTypeIcon type={db.id} />
                        {db.label}
                      </button>
                    ))}
                  </div>
                )
              })}
            </div>

            {/* Right: Connection fields */}
            <div className="db-conn-fields">
              {/* Connection URL parser — only for network DBs */}
              {!isFile && !isCloud && (
                <>
                  <div className="form-group">
                    <label>Paste Connection URL <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(auto-detects DB type)</span></label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <input
                        type="text"
                        value={connectionString}
                        onChange={e => setConnectionString(e.target.value)}
                        placeholder={URL_PLACEHOLDER[t] || 'scheme://user:pass@host:port/database'}
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
                  <div className="form-divider" />
                </>
              )}

              {/* Connection Name */}
              <div className="form-group">
                <label htmlFor="conn-name">Connection Name</label>
                <div className="name-with-color">
                  <input id="conn-name" type="text" value={form.name} onChange={e => update('name', e.target.value)}
                    placeholder={DB_TYPES.find(d => d.id === t)?.label || 'My Database'} />
                  <div className="color-picker">
                    {CONNECTION_COLORS.map(c => (
                      <button key={c} type="button" className={`color-dot ${form.color === c ? 'active' : ''}`}
                        style={{ background: c }} onClick={() => update('color', c)} />
                    ))}
                  </div>
                </div>
              </div>

              {/* SQLite / DuckDB: file path */}
              {isFile && (
                <div className="form-group">
                  <label>Database File Path</label>
                  <input type="text" value={form.database}
                    onChange={e => update('database', e.target.value)}
                    placeholder="/path/to/database.db  (leave empty for :memory:)"
                  />
                </div>
              )}

              {/* LibSQL */}
              {t === 'libsql' && (
                <>
                  <div className="form-group">
                    <label>URL</label>
                    <input type="text" value={form.connectionString}
                      onChange={e => update('connectionString', e.target.value)}
                      placeholder="file:local.db  or  libsql://your-db.turso.io" />
                  </div>
                  <div className="form-group">
                    <label>Auth Token <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional)</span></label>
                    <input type="password" value={form.password}
                      onChange={e => update('password', e.target.value)}
                      placeholder="eyJ..." />
                  </div>
                </>
              )}

              {/* Cloudflare D1 */}
              {t === 'd1' && (
                <>
                  <div className="form-group">
                    <label>Account ID</label>
                    <input type="text" value={form.accountId} onChange={e => update('accountId', e.target.value)} placeholder="a1b2c3d4..." />
                  </div>
                  <div className="form-group">
                    <label>Database ID</label>
                    <input type="text" value={form.databaseId} onChange={e => update('databaseId', e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
                  </div>
                  <div className="form-group">
                    <label>API Token</label>
                    <input type="password" value={form.apiToken} onChange={e => update('apiToken', e.target.value)} placeholder="Bearer token from Cloudflare dashboard" />
                  </div>
                </>
              )}

              {/* Google BigQuery */}
              {t === 'bigquery' && (
                <>
                  <div className="form-group">
                    <label>Project ID</label>
                    <input type="text" value={form.projectId} onChange={e => update('projectId', e.target.value)} placeholder="my-gcp-project" />
                  </div>
                  <div className="form-group">
                    <label>Service Account Key File <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(JSON path)</span></label>
                    <input type="text" value={form.keyFilePath} onChange={e => update('keyFilePath', e.target.value)} placeholder="/path/to/service-account.json" />
                  </div>
                  <div className="form-group">
                    <label>Or paste credentials JSON <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional)</span></label>
                    <textarea rows={3} style={{ width: '100%', resize: 'vertical' }}
                      value={form.credentials} onChange={e => update('credentials', e.target.value)}
                      placeholder='{"type":"service_account","project_id":"..."}' />
                  </div>
                </>
              )}

              {/* Amazon DynamoDB */}
              {t === 'dynamodb' && (
                <>
                  <div className="form-group">
                    <label>AWS Region</label>
                    <input type="text" value={form.region} onChange={e => update('region', e.target.value)} placeholder="us-east-1" />
                  </div>
                  <div className="form-group">
                    <label>Access Key ID</label>
                    <input type="text" value={form.username} onChange={e => update('username', e.target.value)} placeholder="AKIAIOSFODNN7EXAMPLE" />
                  </div>
                  <div className="form-group">
                    <label>Secret Access Key</label>
                    <input type="password" value={form.password} onChange={e => update('password', e.target.value)} placeholder="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" />
                  </div>
                  <div className="form-group">
                    <label>Endpoint <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional, for local DynamoDB)</span></label>
                    <div className="form-row" style={{ marginBottom: 0 }}>
                      <div className="form-group form-grow" style={{ marginBottom: 0 }}>
                        <input type="text" value={form.host} onChange={e => update('host', e.target.value)} placeholder="localhost" />
                      </div>
                      <div className="form-group form-port" style={{ marginBottom: 0 }}>
                        <input type="text" value={form.port} onChange={e => update('port', e.target.value)} placeholder="8000" />
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Snowflake */}
              {t === 'snowflake' && (
                <>
                  <div className="form-group">
                    <label>Account Identifier</label>
                    <input type="text" value={form.account} onChange={e => update('account', e.target.value)} placeholder="orgname-accountname" />
                  </div>
                  <div className="form-row">
                    <div className="form-group form-grow">
                      <label>Username</label>
                      <input type="text" value={form.username} onChange={e => update('username', e.target.value)} placeholder="myuser" />
                    </div>
                    <div className="form-group form-grow">
                      <label>Password</label>
                      <input type="password" value={form.password} onChange={e => update('password', e.target.value)} placeholder="••••••••" />
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-group form-grow">
                      <label>Database <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional)</span></label>
                      <input type="text" value={form.database} onChange={e => update('database', e.target.value)} placeholder="MY_DB" />
                    </div>
                    <div className="form-group form-grow">
                      <label>Warehouse <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional)</span></label>
                      <input type="text" value={form.warehouse} onChange={e => update('warehouse', e.target.value)} placeholder="COMPUTE_WH" />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Schema <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional)</span></label>
                    <input type="text" value={form.schema} onChange={e => update('schema', e.target.value)} placeholder="PUBLIC" />
                  </div>
                </>
              )}

              {/* MongoDB with connection string */}
              {t === 'mongodb' && (
                <div className="form-group">
                  <label>Connection String <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional override)</span></label>
                  <input type="text" value={form.connectionString}
                    onChange={e => update('connectionString', e.target.value)}
                    placeholder="mongodb://user:pass@host:27017/db" />
                </div>
              )}

              {/* Cassandra: datacenter */}
              {t === 'cassandra' && (
                <div className="form-group">
                  <label>Local Data Center</label>
                  <input type="text" value={form.datacenter} onChange={e => update('datacenter', e.target.value)} placeholder="datacenter1" />
                </div>
              )}

              {/* Standard host/port/db/user/pass for network-based DBs */}
              {!isFile && !isCloud && t !== 'libsql' && (
                <>
                  <div className="form-row">
                    <div className="form-group form-grow">
                      <label htmlFor="conn-host">Host</label>
                      <input id="conn-host" type="text" value={form.host} onChange={e => update('host', e.target.value)}
                        placeholder="localhost" required />
                    </div>
                    <div className="form-group form-port">
                      <label htmlFor="conn-port">Port</label>
                      <input id="conn-port" type="text" value={form.port} onChange={e => update('port', e.target.value)}
                        placeholder={DEFAULT_PORTS[t] || '5432'} />
                    </div>
                  </div>

                  <div className="form-group">
                    <label htmlFor="conn-db">
                      {t === 'redis' ? 'Database Index' : t === 'cassandra' ? 'Keyspace' : 'Database'}
                      {['mysql', 'mariadb', 'mongodb', 'cassandra', 'redis', 'snowflake'].includes(t) &&
                        <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}> (optional)</span>}
                    </label>
                    <input id="conn-db" type="text" value={form.database} onChange={e => update('database', e.target.value)}
                      placeholder={t === 'redis' ? '0' : t === 'postgres' ? 'postgres' : t === 'clickhouse' ? 'default' : ''} />
                  </div>

                  <div className="form-row">
                    <div className="form-group form-grow">
                      <label htmlFor="conn-user">Username</label>
                      <input id="conn-user" type="text" value={form.username} onChange={e => update('username', e.target.value)}
                        placeholder={t === 'postgres' || t === 'cockroachdb' ? 'postgres' : t === 'mysql' || t === 'mariadb' ? 'root' : t === 'clickhouse' ? 'default' : 'admin'} />
                    </div>
                    <div className="form-group form-grow">
                      <label htmlFor="conn-pass">Password</label>
                      <input id="conn-pass" type="password" value={form.password} onChange={e => update('password', e.target.value)} placeholder="••••••••" />
                    </div>
                  </div>

                  {needsSsl && (
                    <label className="form-checkbox">
                      <input type="checkbox" checked={form.ssl} onChange={e => update('ssl', e.target.checked)} />
                      <span>Use SSL / TLS</span>
                    </label>
                  )}
                </>
              )}

              {/* SSH Tunnel — only for network DBs */}
              {needsSsh && (
                <>
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
                </>
              )}

              {testResult && (
                <div className={`test-result ${testResult.type}`}>{testResult.text}</div>
              )}
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={handleTest} disabled={testing || isFile}>
              {testing ? (<><span className="btn-spinner-sm"></span> Testing...</>) : 'Test Connection'}
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
