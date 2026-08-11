import React, { useState, useEffect, useCallback } from 'react'
import './UserManagementPanel.css'

export default function UserManagementPanel({ connectionId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('roles')
  const [showCreateUser, setShowCreateUser] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', password: '', superuser: false, createdb: false, createrole: false })
  const [creating, setCreating] = useState(false)
  const [statusMsg, setStatusMsg] = useState(null)

  const fetchData = useCallback(async () => {
    if (!connectionId || !window.dbAccess) return
    setLoading(true)
    try {
      const result = await window.dbAccess.getUserManagement(connectionId)
      if (result.success) { setData(result.data); setError(null) }
      else setError(result.error)
    } catch (e) { setError(e.message) }
    setLoading(false)
  }, [connectionId])

  useEffect(() => { fetchData() }, [fetchData])

  const showStatus = (msg, type = 'success') => {
    setStatusMsg({ msg, type })
    setTimeout(() => setStatusMsg(null), 4000)
  }

  const handleCreateUser = async () => {
    if (!newUser.username.trim() || !newUser.password.trim()) return
    setCreating(true)
    try {
      const result = await window.dbAccess.createUser(
        connectionId,
        newUser.username.trim(),
        newUser.password,
        { superuser: newUser.superuser, createdb: newUser.createdb, createrole: newUser.createrole }
      )
      if (result.success) {
        showStatus(`User "${newUser.username}" created`)
        setShowCreateUser(false)
        setNewUser({ username: '', password: '', superuser: false, createdb: false, createrole: false })
        fetchData()
      } else {
        showStatus(result.error, 'error')
      }
    } catch (e) { showStatus(e.message, 'error') }
    setCreating(false)
  }

  const handleDropUser = async (username) => {
    const ok = await window.dbAccess.confirm({
      type: 'warning',
      title: 'Drop User',
      message: `Drop user "${username}"?`,
      detail: 'This cannot be undone.',
      confirmLabel: 'Drop',
      cancelLabel: 'Cancel',
    })
    if (!ok) return
    try {
      const result = await window.dbAccess.dropUser(connectionId, username)
      if (result.success) { showStatus(`User "${username}" dropped`); fetchData() }
      else showStatus(result.error, 'error')
    } catch (e) { showStatus(e.message, 'error') }
  }

  if (loading) return (
    <div className="usermgmt usermgmt-loading">
      <div className="usermgmt-spinner"></div>
      <p>Loading user management...</p>
    </div>
  )

  if (error) return (
    <div className="usermgmt usermgmt-error">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent-red)" strokeWidth="2">
        <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>
      </svg>
      <p>{error}</p>
      <button className="usermgmt-retry-btn" onClick={fetchData}>Retry</button>
    </div>
  )

  const roles = data?.roles || []
  const databases = data?.databases || []
  const loginRoles = roles.filter(r => r.rolcanlogin)
  const groupRoles = roles.filter(r => !r.rolcanlogin)

  return (
    <div className="usermgmt">
      {/* Header */}
      <div className="usermgmt-header">
        <div className="usermgmt-header-left">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
          </svg>
          <span>User Management</span>
          <span className="usermgmt-count">{loginRoles.length} users · {groupRoles.length} roles</span>
        </div>
        <div className="usermgmt-header-actions">
          <button className="usermgmt-create-btn" onClick={() => setShowCreateUser(true)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Create User
          </button>
          <button className="usermgmt-refresh-btn" onClick={fetchData} title="Refresh">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div className={`usermgmt-status usermgmt-status-${statusMsg.type}`}>
          {statusMsg.msg}
        </div>
      )}

      {/* Create User Panel */}
      {showCreateUser && (
        <div className="usermgmt-create-panel">
          <div className="usermgmt-create-title">Create New User</div>
          <div className="usermgmt-create-fields">
            <input
              type="text"
              placeholder="Username"
              value={newUser.username}
              onChange={e => setNewUser(p => ({ ...p, username: e.target.value }))}
              className="usermgmt-input"
            />
            <input
              type="password"
              placeholder="Password"
              value={newUser.password}
              onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))}
              className="usermgmt-input"
            />
          </div>
          <div className="usermgmt-create-opts">
            {[
              ['superuser', 'Superuser'],
              ['createdb', 'Create DB'],
              ['createrole', 'Create Roles'],
            ].map(([key, label]) => (
              <label key={key} className="usermgmt-checkbox">
                <input
                  type="checkbox"
                  checked={newUser[key]}
                  onChange={e => setNewUser(p => ({ ...p, [key]: e.target.checked }))}
                />
                {label}
              </label>
            ))}
          </div>
          <div className="usermgmt-create-actions">
            <button className="usermgmt-btn-primary" onClick={handleCreateUser} disabled={creating || !newUser.username.trim() || !newUser.password.trim()}>
              {creating ? 'Creating...' : 'Create User'}
            </button>
            <button className="usermgmt-btn-ghost" onClick={() => setShowCreateUser(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="usermgmt-tabs">
        <button className={`usermgmt-tab ${activeTab === 'roles' ? 'active' : ''}`} onClick={() => setActiveTab('roles')}>
          Users &amp; Roles <span className="usermgmt-tab-count">{roles.length}</span>
        </button>
        <button className={`usermgmt-tab ${activeTab === 'databases' ? 'active' : ''}`} onClick={() => setActiveTab('databases')}>
          Databases <span className="usermgmt-tab-count">{databases.length}</span>
        </button>
      </div>

      <div className="usermgmt-content">
        {activeTab === 'roles' && (
          <table className="usermgmt-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Login</th>
                <th>Superuser</th>
                <th>Create DB</th>
                <th>Create Role</th>
                <th>Replication</th>
                <th>Conn Limit</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {roles.map((role, i) => (
                <tr key={i}>
                  <td className="usermgmt-role-name">
                    <span className={`role-icon ${role.rolcanlogin ? 'user-icon' : 'group-icon'}`}>
                      {role.rolcanlogin ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
                        </svg>
                      ) : (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
                          <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
                        </svg>
                      )}
                    </span>
                    {role.rolname}
                    {role.rolsuper && <span className="role-badge super">SUPER</span>}
                  </td>
                  <td><span className={`bool-badge ${role.rolcanlogin ? 'yes' : 'no'}`}>{role.rolcanlogin ? 'Yes' : 'No'}</span></td>
                  <td><span className={`bool-badge ${role.rolsuper ? 'yes' : 'no'}`}>{role.rolsuper ? 'Yes' : 'No'}</span></td>
                  <td><span className={`bool-badge ${role.rolcreatedb ? 'yes' : 'no'}`}>{role.rolcreatedb ? 'Yes' : 'No'}</span></td>
                  <td><span className={`bool-badge ${role.rolcreaterole ? 'yes' : 'no'}`}>{role.rolcreaterole ? 'Yes' : 'No'}</span></td>
                  <td><span className={`bool-badge ${role.rolreplication ? 'yes' : 'no'}`}>{role.rolreplication ? 'Yes' : 'No'}</span></td>
                  <td>{role.rolconnlimit === -1 ? '∞' : role.rolconnlimit}</td>
                  <td className="usermgmt-expires">{role.rolvaliduntil ? new Date(role.rolvaliduntil).toLocaleDateString() : '—'}</td>
                  <td>
                    {role.rolcanlogin && role.rolname !== 'postgres' && (
                      <button className="usermgmt-drop-btn" onClick={() => handleDropUser(role.rolname)} title="Drop user">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                        </svg>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {activeTab === 'databases' && (
          <table className="usermgmt-table">
            <thead>
              <tr>
                <th>Database</th>
                <th>Owner</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {databases.map((db, i) => (
                <tr key={i}>
                  <td className="usermgmt-role-name">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="2">
                      <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
                    </svg>
                    {db.datname}
                  </td>
                  <td>{db.owner}</td>
                  <td>{db.size}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
