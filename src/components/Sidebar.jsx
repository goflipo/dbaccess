import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useTransition } from 'react'
import './Sidebar.css'

function Sidebar({
  connections, activeConnectionId,
  onNewConnection, onToggle, collapsed,
  onTableClick, onDisconnect, onDeleteConnection,
  onNewTab, onNewERDTab, onImportCSV, onRunSqlFile,
  onScaffoldNewTable, onScaffoldMaterializedView, onCreateDatabase,
  onExportDatabase, onDeleteTable, onTruncateTable, onShowTableStructure,
  savedConnections, onConnectSaved, onDeleteSaved, onRenameConnection,
  queryHistory, refreshKey, onSelectConnection,
  onNewUsersTab, onNewMetricsTab, onNewCompareTab, onNewBroadcastTab,
  onDeleteMultipleTables,
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('dbaccess:sidebarWidth')
    return saved ? parseInt(saved, 10) : 260
  })

  const handleResizeStart = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    const MIN = 160, MAX = 520

    let cleaned = false
    let safeOnMove = null
    let safeOnUp = null

    const onMove = (ev) => {
      setSidebarWidth(Math.max(MIN, Math.min(MAX, startW + ev.clientX - startX)))
    }

    const onUp = (ev) => {
      const finalW = Math.max(MIN, Math.min(MAX, startW + ev.clientX - startX))
      setSidebarWidth(finalW)
      localStorage.setItem('dbaccess:sidebarWidth', String(finalW))
    }

    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      if (safeOnMove) document.removeEventListener('mousemove', safeOnMove)
      if (safeOnUp) document.removeEventListener('mouseup', safeOnUp)
      document.removeEventListener('mouseleave', safeOnUp)
      window.removeEventListener('blur', safeOnUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    safeOnMove = (ev) => {
      try {
        onMove(ev)
      } catch (err) {
        console.error('Error during sidebar resize move:', err)
        cleanup()
      }
    }

    safeOnUp = (ev) => {
      try {
        onUp(ev)
      } catch (err) {
        console.error('Error during sidebar resize end:', err)
      } finally {
        cleanup()
      }
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', safeOnMove)
    document.addEventListener('mouseup', safeOnUp)
    document.addEventListener('mouseleave', safeOnUp)
    window.addEventListener('blur', safeOnUp)
  }, [sidebarWidth])

  const [expandedConns, setExpandedConns] = useState(new Set())
  const [contextMenu, setContextMenu] = useState(null)
  const [renamingConn, setRenamingConn] = useState(null)
  const [filterText, setFilterText] = useState('')
  const [viewMode, setViewMode] = useState('items')
  const [historySearch, setHistorySearch] = useState('')
  const [favorites, setFavorites] = useState([])
  const [favoritesSearch, setFavoritesSearch] = useState('')
  const [isPending, startTransition] = useTransition()
  // Internally loaded tables per connection
  const [tables, setTables] = useState({})
  const [loadingTables, setLoadingTables] = useState({})
  const [tableLoadErrors, setTableLoadErrors] = useState({})
  const [activeDbs, setActiveDbs] = useState({})   // { connId: 'mydb' }  — currently selected DB
  const [dbLists, setDbLists] = useState({})        // { connId: ['db1','db2',...] }
  const [showDbPicker, setShowDbPicker] = useState({})
  // Table structure previews
  const [tableStructure, setTableStructure] = useState({})
  const [expandedTables, setExpandedTables] = useState(new Set())
  // Pinned tables: Set of 'connId:fullTableName'
  const [pinnedTables, setPinnedTables] = useState(() => {
    try {
      const saved = localStorage.getItem('dbaccess:pinnedTables')
      return saved ? new Set(JSON.parse(saved)) : new Set()
    } catch (e) { return new Set() }
  })
  const [menuPos, setMenuPos] = useState({ top: -9999, left: -9999 })
  const menuRef = useRef(null)
  const [openSubmenu, setOpenSubmenu] = useState(null)
  const submenuRef = useRef(null)
  const [submenuStyle, setSubmenuStyle] = useState({})

  // Flip the open context-menu submenu up/left when it would otherwise overflow the window
  useLayoutEffect(() => {
    if (!openSubmenu || !submenuRef.current) { setSubmenuStyle({}); return }
    const rect = submenuRef.current.getBoundingClientRect()
    const MARGIN = 8
    const style = {}
    if (rect.bottom > window.innerHeight - MARGIN) { style.top = 'auto'; style.bottom = -4 }
    if (rect.right > window.innerWidth - MARGIN) { style.left = 'auto'; style.right = '100%' }
    setSubmenuStyle(style)
  }, [openSubmenu])
  // Multi-table selection: { connId: Set<fullTableName> }
  const [selectedTables, setSelectedTables] = useState({})
  // Anchor for shift-click range selection: { connId: fullName }
  const lastSelectAnchorRef = useRef({})

  const isTableSelected = (connId, fullName) => selectedTables[connId]?.has(fullName) ?? false
  const getSelectionCount = (connId) => selectedTables[connId]?.size ?? 0
  const clearSelection = useCallback((connId) => {
    setSelectedTables(prev => ({ ...prev, [connId]: new Set() }))
    delete lastSelectAnchorRef.current[connId]
  }, [])
  const toggleTableSelect = useCallback((e, connId, fullName, orderedTables) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.shiftKey && lastSelectAnchorRef.current[connId] && orderedTables) {
      const anchor = lastSelectAnchorRef.current[connId]
      const anchorIdx = orderedTables.findIndex(t => t.fullName === anchor)
      const clickedIdx = orderedTables.findIndex(t => t.fullName === fullName)
      if (anchorIdx !== -1 && clickedIdx !== -1) {
        const from = Math.min(anchorIdx, clickedIdx)
        const to = Math.max(anchorIdx, clickedIdx)
        const rangeNames = orderedTables.slice(from, to + 1).map(t => t.fullName)
        setSelectedTables(prev => {
          const prevSet = new Set(prev[connId] || [])
          rangeNames.forEach(n => prevSet.add(n))
          return { ...prev, [connId]: prevSet }
        })
        return
      }
    }
    lastSelectAnchorRef.current[connId] = fullName
    setSelectedTables(prev => {
      const prevSet = new Set(prev[connId] || [])
      if (prevSet.has(fullName)) prevSet.delete(fullName)
      else prevSet.add(fullName)
      return { ...prev, [connId]: prevSet }
    })
  }, [])

  // After the context menu renders, measure it and clamp to viewport
  useEffect(() => {
    if (!contextMenu || !menuRef.current) return
    const el = menuRef.current
    const { width, height } = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const MARGIN = 8
    let left = contextMenu.mouseX
    let top = contextMenu.mouseY
    if (left + width + MARGIN > vw) left = vw - width - MARGIN
    if (left < MARGIN) left = MARGIN
    if (top + height + MARGIN > vh) top = vh - height - MARGIN
    if (top < MARGIN) top = MARGIN
    setMenuPos({ top, left })
  }, [contextMenu])

  const togglePin = useCallback((connId, fullTableName) => {
    const key = `${connId}:${fullTableName}`
    setPinnedTables(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      localStorage.setItem('dbaccess:pinnedTables', JSON.stringify([...next]))
      return next
    })
  }, [])

  const handleCloneTable = useCallback((connId, tableName) => {
    const newName = prompt(`Enter name for the cloned table:`)
    if (!newName?.trim()) return
    const conn = connections.find(c => c.id === connId)
    let sql
    if (conn?.type === 'postgres') {
      sql = `-- Clone structure only (indexes, constraints, defaults included)\nCREATE TABLE ${newName.trim()} (LIKE ${tableName} INCLUDING ALL);\n\n-- To also copy all data, run:\n-- INSERT INTO ${newName.trim()} SELECT * FROM ${tableName};`
    } else if (conn?.type === 'mysql') {
      sql = `-- Clone table structure (MySQL)\nCREATE TABLE \`${newName.trim()}\` LIKE ${tableName};\n\n-- To also copy all data, run:\n-- INSERT INTO \`${newName.trim()}\` SELECT * FROM ${tableName};`
    } else {
      sql = `-- Clone table structure (ClickHouse)\nCREATE TABLE ${newName.trim()} AS ${tableName};\n\n-- Then copy data:\nINSERT INTO ${newName.trim()} SELECT * FROM ${tableName};`
    }
    onNewTab(connId, sql, `Clone: ${tableName.split('.').pop()}`)
  }, [connections, onNewTab])

  useEffect(() => {
    const handleClickOutside = () => { setContextMenu(null); setShowDbPicker({}) }
    window.addEventListener('click', handleClickOutside)
    return () => window.removeEventListener('click', handleClickOutside)
  }, [])

  // Close any open flyout submenu whenever the context menu itself opens/closes
  useEffect(() => { setOpenSubmenu(null) }, [contextMenu])

  // Load saved query favorites when the Queries tab is opened
  useEffect(() => {
    if (viewMode !== 'queries' || !window.dbAccess) return
    let cancelled = false
    window.dbAccess.getFavorites().then(result => {
      if (!cancelled && result.success) setFavorites(result.data)
    })
    return () => { cancelled = true }
  }, [viewMode])

  const handleDeleteFavorite = useCallback(async (e, id) => {
    e.stopPropagation()
    await window.dbAccess.deleteFavorite(id)
    setFavorites(prev => prev.filter(f => f.id !== id))
  }, [])

  // Load database list and then tables for a connection
  const loadTablesForConnection = useCallback(async (connId, overrideDb) => {
    if (!window.dbAccess) return
    setLoadingTables(prev => ({ ...prev, [connId]: true }))
    setTableLoadErrors(prev => ({ ...prev, [connId]: null }))
    try {
      // 1. Get the current active database from server side
      let targetDb = overrideDb || activeDbs[connId]
      if (!targetDb) {
        const curRes = await window.dbAccess.getCurrentDatabase(connId)
        if (curRes.success) {
          targetDb = curRes.data.db
          setActiveDbs(prev => ({ ...prev, [connId]: targetDb }))
        }
      }

      // 2. Fetch all available databases for the picker
      const dbRes = await window.dbAccess.getDatabases(connId)
      if (dbRes.success) {
        setDbLists(prev => ({ ...prev, [connId]: dbRes.data }))
      }

      // 3. If the user picked a different DB, switch the backend connection first
      if (overrideDb && overrideDb !== activeDbs[connId]) {
        const switchRes = await window.dbAccess.switchDatabase(connId, overrideDb)
        if (!switchRes.success) throw new Error(switchRes.error)
        setActiveDbs(prev => ({ ...prev, [connId]: overrideDb }))
      }

      // 4. Load tables from the active database
      const result = await window.dbAccess.getTables(connId)
      if (result.success) {
        setTables(prev => ({ ...prev, [connId]: result.data }))
      } else {
        throw new Error(result.error || 'Failed to load tables')
      }
    } catch (err) {
      console.error('Failed to load tables for connection:', connId, err)
      setTableLoadErrors(prev => ({ ...prev, [connId]: err.message }))
    } finally {
      setLoadingTables(prev => ({ ...prev, [connId]: false }))
    }
  }, [activeDbs])

  // Reload tables when refreshKey changes (after table creation, deletion etc.)
  useEffect(() => {
    connections.forEach(conn => {
      if (expandedConns.has(conn.id) || filterText) {
        loadTablesForConnection(conn.id)
      }
    })
  }, [refreshKey])

  const toggleConn = (id) => {
    const next = new Set(expandedConns)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
      // Load tables when expanding
      if (!tables[id]) {
        loadTablesForConnection(id)
      }
    }
    setExpandedConns(next)
    onSelectConnection?.(id)
  }

  const toggleTableExpand = async (connId, tableName) => {
    const key = `${connId}:${tableName}`
    const next = new Set(expandedTables)
    if (next.has(key)) {
      next.delete(key)
    } else {
      next.add(key)
      // Load structure if not loaded
      if (!tableStructure[key] && window.dbAccess) {
        try {
          const result = await window.dbAccess.getTableStructure(connId, tableName)
          if (result.success) {
            setTableStructure(prev => ({ ...prev, [key]: result.data }))
          }
        } catch (err) {
          console.error('Failed to load table structure:', err)
        }
      }
    }
    setExpandedTables(next)
  }

  const handleContextMenu = (e, connId, isSaved) => {
    e.preventDefault()
    setContextMenu({ mouseX: e.clientX, mouseY: e.clientY, type: 'connection', connId, isSaved })
  }

  const handleTableContextMenu = (e, connId, tableName) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ mouseX: e.clientX, mouseY: e.clientY, type: 'table', connId, tableName, activeDb: activeDbs[connId] })
  }

  const handleRenameSubmit = (e) => {
    if (e.key === 'Enter') {
      onRenameConnection(renamingConn.id, renamingConn.name, renamingConn.isSaved)
      setRenamingConn(null)
    } else if (e.key === 'Escape') {
      setRenamingConn(null)
    }
  }

  const dbIcon = (type) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      {type === 'postgres' ? (
        <><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></>
      ) : type === 'mysql' ? (
        <><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M12 8v8M8 10l4-2 4 2"/></>
      ) : (
        <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M3 9h18"/></>
      )}
    </svg>
  )

  const formatTimeAgo = (ts) => {
    const diff = Date.now() - ts
    if (diff < 60000) return 'Just now'
    if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`
    if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`
    return new Date(ts).toLocaleDateString()
  }

  // With 2+ connections, a card rail on the left lets you switch which one
  // the main panel is focused on, instead of stacking every connection's
  // table tree in one long scrolling list.
  const showConnRail = connections.length >= 2
  const focusedConnId = showConnRail
    ? (connections.some(c => c.id === activeConnectionId) ? activeConnectionId : connections[0]?.id)
    : null

  // Jumping to a connection via the rail should land straight on its table
  // tree, without a separate click to expand it.
  // NOTE: this hook must run on every render (kept above the `collapsed`
  // early-return below) — conditionally skipping it violates the Rules of
  // Hooks and crashes the whole sidebar when the collapsed state toggles.
  useEffect(() => {
    if (collapsed || !showConnRail || !focusedConnId) return
    setExpandedConns(prev => prev.has(focusedConnId) ? prev : new Set(prev).add(focusedConnId))
    if (!tables[focusedConnId] && !loadingTables[focusedConnId]) {
      loadTablesForConnection(focusedConnId)
    }
  }, [collapsed, showConnRail, focusedConnId])

  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <button className="sidebar-toggle" onClick={onToggle} title="Expand sidebar">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
        </button>
        <button className="sidebar-action-icon" onClick={onNewConnection} title="New Connection">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
    )
  }

  return (
    <div className="sidebar" data-tour="sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
      <div className="sidebar-resize-handle" onMouseDown={handleResizeStart} title="Drag to resize sidebar" />
      {showConnRail && (
        <div className="sidebar-conn-rail">
          {connections.map(conn => (
            <button
              key={conn.id}
              className={`conn-rail-card ${conn.id === focusedConnId ? 'active' : ''}`}
              onClick={() => onSelectConnection(conn.id)}
              onContextMenu={(e) => handleContextMenu(e, conn.id, false)}
              title={conn.name || conn.host}
            >
              <span className={`conn-rail-dot ${conn.connected ? 'connected' : ''}`}></span>
              <span className="conn-rail-icon">{dbIcon(conn.type)}</span>
              <span className="conn-rail-name">{conn.name || conn.host}</span>
              <span className="conn-rail-db">{activeDbs[conn.id] ? `db : ${activeDbs[conn.id]}` : (conn.type === 'postgres' ? 'PostgreSQL' : conn.type === 'mysql' ? 'MySQL' : 'ClickHouse')}</span>
            </button>
          ))}
        </div>
      )}
      <div className="sidebar-main">
      <div className="sidebar-mode-toggle">
        <button className={`mode-btn ${viewMode === 'items' ? 'active' : ''}`} onClick={() => startTransition(() => setViewMode('items'))}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>
          Items
        </button>
        <button className={`mode-btn ${viewMode === 'queries' ? 'active' : ''}`} onClick={() => startTransition(() => setViewMode('queries'))}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          Queries
        </button>
        <button className={`mode-btn ${viewMode === 'history' ? 'active' : ''}`} onClick={() => startTransition(() => setViewMode('history'))}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          {isPending && viewMode !== 'history' ? <span className="sidebar-history-spinner" style={{marginLeft: 4}} /> : 'History'}
        </button>
      </div>
      <div className="sidebar-header">
        <span className="sidebar-label">{viewMode === 'items' ? 'CONNECTIONS' : viewMode === 'queries' ? 'SAVED QUERIES' : 'RECENT QUERIES'}</span>
        <div className="sidebar-header-actions">
          {viewMode === 'items' && (
            <>
              <button className="sidebar-btn" onClick={onNewBroadcastTab} title="Multi-DB Broadcast — run one query on multiple databases">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              </button>
              <button className="sidebar-btn" onClick={onNewConnection} title="New Connection" data-tour="new-connection">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
              </button>
            </>
          )}
          <button className="sidebar-btn" onClick={onToggle} title="Collapse sidebar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
        </div>
      </div>

      <div className="sidebar-content">
        <div className="sidebar-filter-wrapper">
          <input
            type="text"
            className="sidebar-filter-input"
            placeholder={viewMode === 'items' ? "Filter tables..." : viewMode === 'queries' ? "Search queries..." : "Search history..."}
            value={viewMode === 'items' ? filterText : viewMode === 'queries' ? favoritesSearch : historySearch}
            onChange={e => viewMode === 'items' ? setFilterText(e.target.value) : viewMode === 'queries' ? setFavoritesSearch(e.target.value) : setHistorySearch(e.target.value)}
          />
          {(filterText || historySearch || favoritesSearch) && <button className="sidebar-filter-clear" onClick={() => { setFilterText(''); setHistorySearch(''); setFavoritesSearch('') }}>✕</button>}
        </div>

        {viewMode === 'queries' ? (
          <div className="sidebar-history-list">
            {favorites
              .filter(f => f.name.toLowerCase().includes(favoritesSearch.toLowerCase()) || f.sql.toLowerCase().includes(favoritesSearch.toLowerCase()))
              .map(f => (
                <div key={f.id} className="history-item" onClick={() => onNewTab && onNewTab(null, f.sql, f.connectionName)}>
                  <div className="history-item-header">
                    <span className="history-conn">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="var(--accent-yellow)" stroke="var(--accent-yellow)" strokeWidth="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                      {f.name}
                    </span>
                    <button className="sidebar-delete-btn" onClick={(e) => handleDeleteFavorite(e, f.id)} title="Delete favorite">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                    </button>
                  </div>
                  <div className="history-sql">{f.sql}</div>
                </div>
              ))}
            {favorites.length === 0 && <div className="sidebar-empty">No saved queries yet</div>}
          </div>
        ) : viewMode === 'history' ? (
          <div className="sidebar-history-list">
            {queryHistory === null ? (
              <div className="sidebar-history-loader">
                <span className="sidebar-history-spinner" />
                <span>Loading history…</span>
              </div>
            ) : (queryHistory)
              .filter(h => h.sql.toLowerCase().includes(historySearch.toLowerCase()) || h.connectionName.toLowerCase().includes(historySearch.toLowerCase()))
              .slice(0, 50)
              .map(h => (
                <div key={h.id} className="history-item" onClick={() => onNewTab && onNewTab(null, h.sql, h.connectionName)}>
                  <div className="history-item-header">
                    <span className="history-conn">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>
                      {h.connectionName}
                    </span>
                    <span className="history-time">{formatTimeAgo(h.timestamp)}</span>
                  </div>
                  <div className="history-sql">{h.sql}</div>
                </div>
              ))}
            {queryHistory !== null && queryHistory.length === 0 && <div className="sidebar-empty">No history yet</div>}
          </div>
        ) : (
          <>
            {connections.length === 0 && (!savedConnections || savedConnections.length === 0) && (
              <div className="sidebar-empty">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>
                <p>No connections yet</p>
                <button className="sidebar-empty-btn" onClick={onNewConnection}>Add Connection</button>
              </div>
            )}

            {/* Active connections */}
            {connections.filter(c =>
              (c.name || c.host).toLowerCase().includes(filterText.toLowerCase()) ||
              (tables[c.id] || []).some(t => t.name.toLowerCase().includes(filterText.toLowerCase()))
            ).filter(c => !showConnRail || c.id === focusedConnId).map(conn => (
              <div key={conn.id} className={`sidebar-conn ${conn.id === activeConnectionId ? 'active' : ''}`} onContextMenu={(e) => handleContextMenu(e, conn.id, false)}>
                {/* ── Connection header ── */}
                <div className="sidebar-conn-header" onClick={() => toggleConn(conn.id)}>
                  <svg className={`sidebar-chevron ${expandedConns.has(conn.id) ? 'expanded' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
                  <span className={`sidebar-conn-dot ${conn.connected ? 'connected' : ''}`}></span>
                  {dbIcon(conn.type)}
                  {renamingConn?.id === conn.id ? (
                    <input
                      autoFocus type="text"
                      value={renamingConn.name}
                      onChange={e => setRenamingConn({ ...renamingConn, name: e.target.value })}
                      onKeyDown={handleRenameSubmit}
                      onBlur={() => setRenamingConn(null)}
                      onClick={e => e.stopPropagation()}
                      className="sidebar-rename-input"
                    />
                  ) : (
                    <span className="sidebar-conn-name">{conn.name || conn.host}</span>
                  )}
                  {/* Active database badge */}
                  {activeDbs[conn.id] && (
                    <span className="sidebar-active-db-badge" title={`Connected database: ${activeDbs[conn.id]}`}>
                      {activeDbs[conn.id]}
                    </span>
                  )}
                  <span className="sidebar-conn-type">{conn.type === 'postgres' ? 'PG' : conn.type === 'mysql' ? 'MY' : 'CH'}</span>
                </div>

                {/* ── Action buttons ── */}
                <div className="sidebar-conn-actions">
                  {/* Switch DB button — opens floating dropdown */}
                  <div style={{ position: 'relative' }}>
                    <button
                      className="sidebar-action-btn switch-db-btn"
                      title="Switch database"
                      onClick={e => {
                        e.stopPropagation()
                        setShowDbPicker(prev => ({ ...prev, [conn.id]: !prev[conn.id] }))
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <ellipse cx="12" cy="5" rx="9" ry="3"/>
                        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
                        <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/>
                      </svg>
                    </button>
                    {/* Floating database picker dropdown */}
                    {showDbPicker[conn.id] && dbLists[conn.id]?.length > 0 && (
                      <div className="sidebar-db-dropdown" onClick={e => e.stopPropagation()}>
                        <div className="sidebar-db-dropdown-header">Switch Database</div>
                        {(dbLists[conn.id] || []).map(dbName => (
                          <button
                            key={dbName}
                            className={`sidebar-db-dropdown-item ${activeDbs[conn.id] === dbName ? 'active' : ''}`}
                            onClick={e => {
                              e.stopPropagation()
                              setShowDbPicker({})
                              loadTablesForConnection(conn.id, dbName)
                            }}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <ellipse cx="12" cy="5" rx="9" ry="3"/>
                              <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
                            </svg>
                            {dbName}
                            {activeDbs[conn.id] === dbName && (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2.5" style={{ marginLeft: 'auto' }}>
                                <path d="M20 6L9 17l-5-5"/>
                              </svg>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button className="sidebar-action-btn" onClick={(e) => { e.stopPropagation(); onNewERDTab(conn.id) }} title="ER Diagram">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>
                  </button>
                  <button className="sidebar-action-btn" onClick={(e) => { e.stopPropagation(); onNewTab(conn.id) }} title="New Query Tab">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                  </button>
                  <button className="sidebar-action-btn metrics-btn" onClick={(e) => { e.stopPropagation(); onNewMetricsTab?.(conn.id) }} title="Metrics Board">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                  </button>
<button className="sidebar-action-btn users-btn" onClick={(e) => { e.stopPropagation(); onNewUsersTab?.(conn.id) }} title="User Management">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
                  </button>
                  <button className="sidebar-action-btn delete" onClick={(e) => { e.stopPropagation(); onDeleteConnection(conn.id) }} title="Delete connection">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  </button>
                  <button className="sidebar-action-btn error" onClick={(e) => { e.stopPropagation(); onDisconnect(conn.id) }} title="Disconnect">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18.36 6.64a9 9 0 11-12.73 0M12 2v10"/></svg>
                  </button>
                </div>

                {(expandedConns.has(conn.id) || filterText) && (
                  <div className="sidebar-tables">
                    {/* Error display */}
                    {tableLoadErrors[conn.id] && (
                      <div className="sidebar-table-error">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
                        </svg>
                        <span>{tableLoadErrors[conn.id]}</span>
                        <button onClick={e => { e.stopPropagation(); loadTablesForConnection(conn.id) }}>Retry</button>
                      </div>
                    )}

                    {loadingTables[conn.id] ? (
                      <div className="sidebar-table-loading">
                        <div className="sidebar-mini-spinner"></div>
                        <span>Loading tables...</span>
                      </div>
                    ) : (
                      (() => {
                        const allItems = (tables[conn.id] || []).filter(t => t.name.toLowerCase().includes(filterText.toLowerCase()))
                        const baseTables = allItems.filter(t => t.type === 'BASE TABLE')
                          .sort((a, b) => {
                            const aPin = pinnedTables.has(`${conn.id}:${a.fullName}`) ? 0 : 1
                            const bPin = pinnedTables.has(`${conn.id}:${b.fullName}`) ? 0 : 1
                            return aPin - bPin
                          })
                        const views = allItems.filter(t => t.type === 'VIEW')
                        const orderedTables = [...baseTables, ...views]

                        const renderTableRow = (table) => {
                          const structKey = `${conn.id}:${table.fullName}`
                          const isExpanded = expandedTables.has(structKey)
                          const cols = tableStructure[structKey]
                          const isView = table.type === 'VIEW'
                          const isPinned = pinnedTables.has(`${conn.id}:${table.fullName}`)
                          const isSelected = isTableSelected(conn.id, table.fullName)
                          return (
                            <div key={table.fullName} className="sidebar-table-group">
                              <div
                                className={`sidebar-table ${isPinned ? 'table-pinned' : ''} ${isSelected ? 'table-selected' : ''}`}
                                onContextMenu={(e) => handleTableContextMenu(e, conn.id, table.fullName)}
                              >
                                {/* Checkbox — visible on hover or when selected */}
                                <div
                                  className={`sidebar-table-checkbox ${isSelected ? 'checked' : ''}`}
                                  title={isSelected ? 'Deselect' : 'Select for multi-delete'}
                                  onClick={(e) => toggleTableSelect(e, conn.id, table.fullName, orderedTables)}
                                >
                                  {isSelected ? (
                                    <svg width="10" height="10" viewBox="0 0 12 12" fill="#6366f1">
                                      <rect width="12" height="12" rx="3"/>
                                      <path d="M2.5 6l2.5 2.5 4.5-4.5" stroke="white" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
                                    </svg>
                                  ) : (
                                    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                                      <rect x="0.75" y="0.75" width="10.5" height="10.5" rx="2.25"/>
                                    </svg>
                                  )}
                                </div>
                                <button
                                  className="sidebar-table-expand"
                                  onClick={(e) => { e.stopPropagation(); toggleTableExpand(conn.id, table.fullName) }}
                                >
                                  <svg className={isExpanded ? 'expanded' : ''} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
                                </button>
                                <div className="sidebar-table-main" onClick={() => onTableClick(table.fullName, conn.id, activeDbs[conn.id])}>
                                  {isView ? (
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-teal)" strokeWidth="1.5"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                  ) : (
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>
                                  )}
                                  <span className="sidebar-table-name">{table.name}</span>
                                  {isPinned && (
                                    <svg width="9" height="9" viewBox="0 0 24 24" fill="var(--accent-yellow)" stroke="none" title="Pinned" style={{ flexShrink: 0 }}>
                                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                                    </svg>
                                  )}
                                  <span className="sidebar-table-schema">{table.schema}</span>
                                </div>
                              </div>
                              {isExpanded && cols && (
                                <div className="sidebar-table-columns">
                                  {cols.map((col, ci) => (
                                    <div key={ci} className="sidebar-col-item">
                                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2">
                                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                                      </svg>
                                      <span className="sidebar-col-name">{col.column_name || col.name}</span>
                                      <span className="sidebar-col-type">{col.data_type || col.type}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        }

                        return (
                          <>
                            {baseTables.length > 0 && (
                              <>
                                <div className="sidebar-objects-section-label">Tables ({baseTables.length})</div>
                                {baseTables.map(renderTableRow)}
                              </>
                            )}
                            {views.length > 0 && (
                              <>
                                <div className="sidebar-objects-section-label sidebar-views-label">Views ({views.length})</div>
                                {views.map(renderTableRow)}
                              </>
                            )}
                            {allItems.length === 0 && !loadingTables[conn.id] && (
                              <div className="sidebar-table-empty">No tables found</div>
                            )}
                          </>
                        )
                      })()
                    )}

                    {getSelectionCount(conn.id) > 0 && (
                      <div className="sidebar-selection-bar">
                        <span className="sidebar-sel-count">{getSelectionCount(conn.id)} selected</span>
                        <button className="sidebar-sel-clear" onClick={() => clearSelection(conn.id)}>Clear</button>
                        <button className="sidebar-sel-delete" onClick={() => { onDeleteMultipleTables(conn.id, [...selectedTables[conn.id]]); clearSelection(conn.id) }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                          </svg>
                          Drop {getSelectionCount(conn.id)}
                        </button>
                      </div>
                    )}

                  </div>
                )}
              </div>
            ))}

            {/* Saved connections */}
            {savedConnections && savedConnections.length > 0 && (
              <div className="sidebar-section">
                <div className="sidebar-section-header">
                  <span className="sidebar-label">SAVED</span>
                </div>
                {savedConnections
                  .filter(s => !connections.find(c => c.id === s.id))
                  .map(saved => (
                    <div key={saved.id} className="sidebar-conn saved-conn" onContextMenu={(e) => handleContextMenu(e, saved.id, true)}>
                      <div className="sidebar-conn-header" onClick={() => onConnectSaved(saved)}>
                        {dbIcon(saved.type)}
                        {renamingConn?.id === saved.id ? (
                          <input 
                            autoFocus 
                            type="text" 
                            value={renamingConn.name} 
                            onChange={e => setRenamingConn({ ...renamingConn, name: e.target.value })} 
                            onKeyDown={handleRenameSubmit} 
                            onBlur={() => setRenamingConn(null)}
                            onClick={e => e.stopPropagation()} 
                            className="sidebar-rename-input"
                          />
                        ) : (
                          <span className="sidebar-conn-name">{saved.name || saved.host}</span>
                        )}
                        <span className="sidebar-conn-type">{saved.type === 'postgres' ? 'PG' : 'CH'}</span>
                      </div>
                      <div className="sidebar-conn-actions">
                        <button className="sidebar-delete-btn" onClick={(e) => { e.stopPropagation(); onDeleteSaved(saved.id) }} title="Remove saved connection">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </>
        )}
      </div>
      </div>

      {contextMenu && (
        <div 
          ref={menuRef}
          className="sidebar-context-menu" 
          style={{ top: menuPos.top, left: menuPos.left, visibility: menuPos.top === -9999 ? 'hidden' : 'visible' }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'connection' ? (
            <>
              <button className="context-menu-item" onClick={() => { 
                const target = contextMenu.isSaved 
                  ? savedConnections.find(c => c.id === contextMenu.connId)
                  : connections.find(c => c.id === contextMenu.connId)
                setRenamingConn({ id: contextMenu.connId, name: target?.name || target?.host || '', isSaved: contextMenu.isSaved })
                setContextMenu(null)
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
                Rename Connection
              </button>
              {!contextMenu.isSaved && (
                <>
                    <div className="context-menu-divider"></div>
                    <button className="context-menu-item" onClick={() => { onNewERDTab(contextMenu.connId); setContextMenu(null) }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
                      View ER Diagram
                    </button>
                    <button className="context-menu-item" onClick={() => { onNewMetricsTab?.(contextMenu.connId); setContextMenu(null) }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                      Metrics Board
                    </button>
                    <button className="context-menu-item" onClick={() => { onNewCompareTab?.(); setContextMenu(null) }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>
                      DB Compare & Sync
                    </button>
                    <button className="context-menu-item" onClick={() => { onNewBroadcastTab?.(); setContextMenu(null) }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                      Multi-DB Broadcast
                    </button>
                    <button className="context-menu-item" onClick={() => { onNewUsersTab?.(contextMenu.connId); setContextMenu(null) }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                      User Management
                    </button>
                    <div className="context-menu-divider"></div>
                    <button className="context-menu-item" onClick={() => { onImportCSV(contextMenu.connId); setContextMenu(null) }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
                      Import from CSV
                    </button>
                    <button className="context-menu-item" onClick={() => { onRunSqlFile(contextMenu.connId); setContextMenu(null) }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
                      Run SQL File...
                    </button>
                    <div className="context-menu-divider"></div>
                    <button className="context-menu-item" onClick={() => { onScaffoldNewTable(contextMenu.connId); setContextMenu(null) }}>Create Table...</button>
                    <button className="context-menu-item" onClick={() => { onScaffoldMaterializedView(contextMenu.connId); setContextMenu(null) }}>Create Materialized View</button>
                    <button className="context-menu-item" onClick={() => { onCreateDatabase(contextMenu.connId); setContextMenu(null) }}>Create Database</button>
                    <div className="context-menu-divider"></div>
                    <button className="context-menu-item" onClick={() => { onExportDatabase(contextMenu.connId, 'sql'); setContextMenu(null) }}>Export Database (SQL)...</button>
                    <button className="context-menu-item" onClick={() => { onExportDatabase(contextMenu.connId, 'csv'); setContextMenu(null) }}>Export Database (CSV)...</button>
                </>
              )}
              <div className="context-menu-divider"></div>
              <button className="context-menu-item context-menu-danger" onClick={() => { 
                if (contextMenu.isSaved) onDeleteSaved(contextMenu.connId)
                else onDeleteConnection(contextMenu.connId)
                setContextMenu(null)
              }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                {contextMenu.isSaved ? 'Delete Saved Profile' : 'Delete Connection'}
              </button>
            </>
          ) : (
            <>
              <button className="context-menu-item" onClick={() => { 
                onNewTab(contextMenu.connId, `SELECT * FROM ${contextMenu.tableName} LIMIT 100;`, contextMenu.tableName)
                setContextMenu(null)
              }}>Open in new tab</button>
              
              <button className="context-menu-item" onClick={() => {
                onTableClick(contextMenu.tableName, contextMenu.connId, contextMenu.activeDb)
                setContextMenu(null)
              }}>Open structure</button>

              <button className="context-menu-item" onClick={() => {
                onShowTableStructure?.(contextMenu.connId, contextMenu.tableName)
                setContextMenu(null)
              }}>Item overview</button>

              <button className="context-menu-item" onClick={() => {
                navigator.clipboard.writeText(contextMenu.tableName).catch(() => {})
                setContextMenu(null)
              }}>Copy name</button>

              <button className="context-menu-item" onClick={() => {
                togglePin(contextMenu.connId, contextMenu.tableName)
                setContextMenu(null)
              }}>
                {pinnedTables.has(`${contextMenu.connId}:${contextMenu.tableName}`) ? 'Unpin from top' : 'Pin to top'}
              </button>
              
              <div className="context-menu-divider"></div>
              
              <div
                className={`context-menu-item sidebar-context-submenu-trigger ${openSubmenu === 'export' ? 'submenu-open' : ''}`}
                onMouseEnter={() => setOpenSubmenu('export')}
                onMouseLeave={() => setOpenSubmenu(null)}
              >
                <span>Export</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                {openSubmenu === 'export' && (
                  <div ref={submenuRef} className="sidebar-context-submenu" style={submenuStyle}>
                    <button className="context-menu-item" onClick={() => { onExportDatabase(contextMenu.connId, 'csv'); setContextMenu(null) }}>To CSV</button>
                    <button className="context-menu-item" onClick={() => { onExportDatabase(contextMenu.connId, 'sql'); setContextMenu(null) }}>To SQL</button>
                  </div>
                )}
              </div>

              <div
                className={`context-menu-item sidebar-context-submenu-trigger ${openSubmenu === 'import' ? 'submenu-open' : ''}`}
                onMouseEnter={() => setOpenSubmenu('import')}
                onMouseLeave={() => setOpenSubmenu(null)}
              >
                <span>Import</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                {openSubmenu === 'import' && (
                  <div ref={submenuRef} className="sidebar-context-submenu" style={submenuStyle}>
                    <button className="context-menu-item" onClick={() => { onImportCSV(contextMenu.connId); setContextMenu(null) }}>From CSV</button>
                  </div>
                )}
              </div>

              <div
                className={`context-menu-item sidebar-context-submenu-trigger ${openSubmenu === 'new' ? 'submenu-open' : ''}`}
                onMouseEnter={() => setOpenSubmenu('new')}
                onMouseLeave={() => setOpenSubmenu(null)}
              >
                <span>New</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                {openSubmenu === 'new' && (
                  <div ref={submenuRef} className="sidebar-context-submenu" style={submenuStyle}>
                    <button className="context-menu-item" onClick={() => { onScaffoldNewTable(contextMenu.connId); setContextMenu(null) }}>Table</button>
                  </div>
                )}
              </div>

              <div
                className={`context-menu-item sidebar-context-submenu-trigger ${openSubmenu === 'copyscript' ? 'submenu-open' : ''}`}
                onMouseEnter={() => setOpenSubmenu('copyscript')}
                onMouseLeave={() => setOpenSubmenu(null)}
              >
                <span>Copy Script As</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                {openSubmenu === 'copyscript' && (
                  <div ref={submenuRef} className="sidebar-context-submenu" style={submenuStyle}>
                    <button className="context-menu-item" onClick={() => {
                      navigator.clipboard.writeText(`SELECT * FROM ${contextMenu.tableName};`); setContextMenu(null)
                    }}>SELECT statement</button>
                    <button className="context-menu-item" onClick={() => {
                      navigator.clipboard.writeText(`INSERT INTO ${contextMenu.tableName} () VALUES ();`); setContextMenu(null)
                    }}>INSERT statement</button>
                    <button className="context-menu-item" onClick={() => {
                      navigator.clipboard.writeText(`UPDATE ${contextMenu.tableName} SET col = val WHERE id = ?;`); setContextMenu(null)
                    }}>UPDATE statement</button>
                  </div>
                )}
              </div>

              <div className="context-menu-divider"></div>

              <button className="context-menu-item" onClick={() => {
                handleCloneTable(contextMenu.connId, contextMenu.tableName)
                setContextMenu(null)
              }}>Clone...</button>

              <button className="context-menu-item context-menu-danger" onClick={() => {
                onTruncateTable?.(contextMenu.connId, contextMenu.tableName)
                setContextMenu(null)
              }}>Truncate...</button>
              
              {isTableSelected(contextMenu.connId, contextMenu.tableName) && getSelectionCount(contextMenu.connId) > 1 ? (
                <button className="context-menu-item context-menu-danger" onClick={() => {
                  onDeleteMultipleTables(contextMenu.connId, [...selectedTables[contextMenu.connId]])
                  clearSelection(contextMenu.connId)
                  setContextMenu(null)
                }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                  </svg>
                  Delete {getSelectionCount(contextMenu.connId)} tables...
                </button>
              ) : (
                <button className="context-menu-item context-menu-danger" onClick={() => {
                  onDeleteTable(contextMenu.connId, contextMenu.tableName)
                  setContextMenu(null)
                }}>Delete...</button>
              )}

            </>
          )}
        </div>
      )}
    </div>
  )
}

export default React.memo(Sidebar)
