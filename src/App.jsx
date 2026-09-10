import React, { useState, useCallback, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import TabBar from './components/TabBar'
import QueryEditor from './components/QueryEditor'
import ResultsGrid from './components/ResultsGrid'
import ERDiagram from './components/ERDiagram'
import MetricsBoard from './components/MetricsBoard'
import UserManagementPanel from './components/UserManagementPanel'
import DBComparePanel from './components/DBComparePanel'
import BroadcastPanel from './components/BroadcastPanel'
import ConnectionModal, { DB_TYPES } from './components/ConnectionModal'
import StatusBar from './components/StatusBar'
import CreateTableModal from './components/CreateTableModal'
import KeyboardShortcutsModal from './components/KeyboardShortcutsModal'
import OpenAnythingModal from './components/OpenAnythingModal'
import QueryFavoritesModal from './components/QueryFavoritesModal'
import TableStructurePanel from './components/TableStructurePanel'
import SettingsPanel from './components/SettingsPanel'
import DeleteHistoryPanel from './components/DeleteHistoryPanel'
import DeleteConfirmModal from './components/DeleteConfirmModal'
import AppTour from './components/AppTour'
import SqlFileProgress from './components/SqlFileProgress'
import DropTableModal from './components/DropTableModal'
import ActivationScreen from './components/ActivationScreen'
import './App.css'

const genId = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 9)

// Dangerous keywords that safe mode should block
const DESTRUCTIVE_PATTERN = /\b(DROP|DELETE|TRUNCATE|ALTER)\b/i

const DEFAULT_SETTINGS = { pageSize: 100, density: 'normal', fontSize: 'medium', fontStyle: 'normal', showGridLines: true, accentColor: 'blue' }
const FONT_STYLE_MAP = {
  normal: { weight: '400', style: 'normal' },
  bold: { weight: '700', style: 'normal' },
  italic: { weight: '400', style: 'italic' },
}

function MainApp() {
  // ResultsGrid wires this ref so Ctrl+S commits grid edits instead of saving query to file
  const gridCommitRef = React.useRef(null)
  const tabsPersistTimerRef = React.useRef(null)
  const queryChangeTimerRef = React.useRef(null)

  const [connections, setConnections] = useState([])
  const [savedConnections, setSavedConnections] = useState([])
  const [activeConnectionId, setActiveConnectionId] = useState(() => localStorage.getItem('dbaccess:activeConnectionId') || null)
  const [showConnectionModal, setShowConnectionModal] = useState(false)
  const [showCreateTableModal, setShowCreateTableModal] = useState(null)
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0)
  const [editingConnection, setEditingConnection] = useState(null)

  const [tabs, setTabs] = useState(() => {
    try {
      const saved = localStorage.getItem('dbaccess:tabs')
      return saved ? JSON.parse(saved).map(t => ({ ...t, results: null, isRunning: false })) : []
    } catch (e) { return [] }
  })

  const [activeTabId, setActiveTabId] = useState(() => localStorage.getItem('dbaccess:activeTabId') || null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('dbaccess:sidebarCollapsed') === 'true')
  const [resultsPanelVisible, setResultsPanelVisible] = useState(() => localStorage.getItem('dbaccess:resultsPanelVisible') !== 'false')
  const [statusMessage, setStatusMessage] = useState({ text: 'Ready', type: 'info' })
  const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false)
  const [showOpenAnything, setShowOpenAnything] = useState(false)
  const [showFavoritesModal, setShowFavoritesModal] = useState(false)
  const [showTableStructure, setShowTableStructure] = useState(null) // { connId, tableName }
  const [allTablesCatalog, setAllTablesCatalog] = useState([])
  const [queryHistory, setQueryHistory] = useState(null)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('dbaccess:history')
      setQueryHistory(saved ? JSON.parse(saved) : [])
    } catch (e) { setQueryHistory([]) }
  }, [])
  const [safeMode, setSafeMode] = useState(() => localStorage.getItem('dbaccess:safeMode') !== 'false')
  const [theme, setTheme] = useState(() => localStorage.getItem('dbaccess:theme') || 'dark')
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem('dbaccess:settings')
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS
    } catch { return DEFAULT_SETTINGS }
  })
  const [showSettings, setShowSettings] = useState(false)
  const [showTour, setShowTour] = useState(() => !localStorage.getItem('dbaccess:tour-done'))

  // Delete history (persisted to localStorage, 30-day rolling window)
  const [deleteHistory, setDeleteHistory] = useState(() => {
    try {
      const saved = localStorage.getItem('dbaccess:delete-history')
      const entries = saved ? JSON.parse(saved) : []
      const now = Date.now()
      return entries.filter(e => new Date(e.expiresAt).getTime() > now)
    } catch { return [] }
  })
  const [showDeleteHistory, setShowDeleteHistory] = useState(false)
  const [truncatePending, setTruncatePending] = useState(null) // { connId, tableName, fkImpact, isLoading }
  const [dropTablePending, setDropTablePending] = useState(null) // { connId, tableNames: string[] }
  const [sqlFileExecution, setSqlFileExecution] = useState(null) // progress state for streaming SQL file execution

  const handleSaveDeleteHistory = useCallback((entry) => {
    setDeleteHistory(prev => {
      const now = Date.now()
      const fresh = prev.filter(e => new Date(e.expiresAt).getTime() > now)
      const next = [entry, ...fresh].slice(0, 500) // cap at 500 entries
      localStorage.setItem('dbaccess:delete-history', JSON.stringify(next))
      return next
    })
  }, [])

  const handleClearDeleteHistory = useCallback(() => {
    setDeleteHistory([])
    localStorage.removeItem('dbaccess:delete-history')
  }, [])

  const handleDeleteHistoryEntry = useCallback((id) => {
    setDeleteHistory(prev => {
      const next = prev.filter(e => e.id !== id)
      localStorage.setItem('dbaccess:delete-history', JSON.stringify(next))
      return next
    })
  }, [])

  const handleRestoreHistoryEntry = useCallback((entry) => {
    const tabId = genId()
    setTabs(prev => [...prev, {
      id: tabId,
      connectionId: entry.connectionId || (connections[0]?.id || ''),
      type: 'query',
      title: `Restore: ${entry.tableName}`,
      query: entry.reinsertSQL || '',
      results: null,
      isRunning: false,
    }])
    setActiveTabId(tabId)
    setShowDeleteHistory(false)
  }, [connections])

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('dbaccess:theme', theme)
    window.dbAccess?.setTitleBarOverlay?.(
      theme === 'dark'
        ? { color: '#0d1017', symbolColor: '#8891a8', height: 38 }
        : { color: '#f5f7fa', symbolColor: '#4a5370', height: 38 }
    )
  }, [theme])

  // Suppress Chromium's default spellcheck/inspect-element context menu
  // everywhere except text-editing zones — those areas render their own
  // custom menus (Sidebar/TabBar/ResultsGrid), which already call
  // preventDefault() themselves and are unaffected by this fallback.
  React.useEffect(() => {
    const handler = (e) => {
      const editable = e.target.closest?.('input, textarea, [contenteditable="true"], .cm-editor')
      if (!editable) e.preventDefault()
    }
    window.addEventListener('contextmenu', handler)
    return () => window.removeEventListener('contextmenu', handler)
  }, [])

  React.useEffect(() => {
    localStorage.setItem('dbaccess:settings', JSON.stringify(settings))
    const sizes = { small: '11px', medium: '13px', large: '15px' }
    document.documentElement.style.setProperty('--app-font-size', sizes[settings.fontSize] || '13px')
    document.documentElement.setAttribute('data-accent', settings.accentColor || 'blue')
    const fs = FONT_STYLE_MAP[settings.fontStyle] || FONT_STYLE_MAP.normal
    document.documentElement.style.setProperty('--app-font-weight', fs.weight)
    document.documentElement.style.setProperty('--app-font-style', fs.style)
  }, [settings])

  // Global safety: if any error/unhandled rejection/blur/visibility change occurs,
  // restore cursor/userSelect and exit pointer lock so the cursor isn't left hidden.
  React.useEffect(() => {
    const restoreCursor = () => {
      try { if (document.exitPointerLock) document.exitPointerLock() } catch (e) {}
      try { document.body && (document.body.style.cursor = '') } catch (e) {}
      try { document.body && (document.body.style.userSelect = '') } catch (e) {}
      try { document.documentElement && (document.documentElement.style.cursor = '') } catch (e) {}
    }
    const onVisibility = () => { if (document.hidden) restoreCursor() }

    window.addEventListener('error', restoreCursor)
    window.addEventListener('unhandledrejection', restoreCursor)
    window.addEventListener('blur', restoreCursor)
    window.addEventListener('pointerup', restoreCursor)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.removeEventListener('error', restoreCursor)
      window.removeEventListener('unhandledrejection', restoreCursor)
      window.removeEventListener('blur', restoreCursor)
      window.removeEventListener('pointerup', restoreCursor)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const handleChangeSettings = (updates) => setSettings(prev => ({ ...prev, ...updates }))

  const activeTab = tabs.find(t => t.id === activeTabId)

  // Tabs belong to whichever connection opened them. When the focused connection
  // changes (e.g. via the sidebar's connection rail), only that connection's tabs
  // show in the tab bar — the others are just hidden, not closed, and switching
  // back restores them exactly as they were.
  const visibleTabs = tabs.filter(t => !t.connectionId || t.connectionId === activeConnectionId)
  const lastActiveTabByConnRef = React.useRef({})

  useEffect(() => {
    if (activeTab?.connectionId) lastActiveTabByConnRef.current[activeTab.connectionId] = activeTab.id
  }, [activeTabId])

  useEffect(() => {
    if (!activeConnectionId) return
    if (activeTab && (!activeTab.connectionId || activeTab.connectionId === activeConnectionId)) return
    const remembered = lastActiveTabByConnRef.current[activeConnectionId]
    const rememberedTab = remembered && tabs.find(t => t.id === remembered)
    if (rememberedTab) { setActiveTabId(rememberedTab.id); return }
    const firstMatch = tabs.find(t => t.connectionId === activeConnectionId)
    setActiveTabId(firstMatch ? firstMatch.id : null)
  }, [activeConnectionId])

  const showStatus = useCallback((text, type = 'info') => {
    const safeText = typeof text === 'object' ? JSON.stringify(text) : String(text)
    setStatusMessage({ text: safeText, type })
  }, [])

  // Restore connections on load
  React.useEffect(() => {
    if (!window.dbAccess) {
      console.warn("window.dbAccess not found, probably running in browser. Using mocks.")
      return
    }
    window.dbAccess.getConnections().then(result => {
      if (result.success && result.data && result.data.length > 0) {
        setConnections(result.data)
        if (!activeConnectionId) setActiveConnectionId(result.data[0].id)
      }
    }).catch(err => console.error("Failed to restore connections", err))

    window.dbAccess.getSavedConnections().then(result => {
      if (result.success && result.data) setSavedConnections(result.data)
    }).catch(err => console.error("Failed to load saved connections", err))

    const cleanup = window.dbAccess?.onExportProgress((data) => {
      showStatus(`${data.msg}`, 'info')
    })
    return cleanup
  }, [showStatus])

  // Persist UI state
  React.useEffect(() => {
    clearTimeout(tabsPersistTimerRef.current)
    tabsPersistTimerRef.current = setTimeout(() => {
      const tabsToSave = tabs.map(({ id, connectionId, type, title, query }) => ({ id, connectionId, type, title, query }))
      localStorage.setItem('dbaccess:tabs', JSON.stringify(tabsToSave))
    }, 800)
  }, [tabs])

  React.useEffect(() => {
    if (activeTabId) localStorage.setItem('dbaccess:activeTabId', activeTabId)
    else localStorage.removeItem('dbaccess:activeTabId')
  }, [activeTabId])

  React.useEffect(() => {
    if (activeConnectionId) localStorage.setItem('dbaccess:activeConnectionId', activeConnectionId)
    else localStorage.removeItem('dbaccess:activeConnectionId')
  }, [activeConnectionId])

  React.useEffect(() => {
    localStorage.setItem('dbaccess:sidebarCollapsed', sidebarCollapsed)
  }, [sidebarCollapsed])

  React.useEffect(() => {
    localStorage.setItem('dbaccess:resultsPanelVisible', resultsPanelVisible)
  }, [resultsPanelVisible])

  // Stable callback identities for props passed to memoized Sidebar/QueryEditor/
  // ResultsGrid — inline arrow functions in JSX would defeat React.memo every render.
  const handleToggleSidebar = useCallback(() => setSidebarCollapsed(c => !c), [])
  const handleToggleResultsPanel = useCallback(() => setResultsPanelVisible(v => !v), [])
  const handleOpenNewConnectionModal = useCallback(() => {
    setEditingConnection(null)
    setShowConnectionModal(true)
  }, [])
  const handleOpenFavorites = useCallback(() => setShowFavoritesModal(true), [])

  // --- Connection handlers ---
  const handleConnect = useCallback(async (config) => {
    const id = genId()
    const connConfig = { ...config, id }
    try {
      const result = await window.dbAccess.connect(connConfig)
      if (result.success) {
        const newConn = { id, ...config, connected: true }
        setConnections(prev => [...prev, newConn])
        setActiveConnectionId(id)
        const tabId = genId()
        setTabs(prev => [...prev, {
          id: tabId, connectionId: id, title: `${config.name || config.host}`,
          query: '', results: null, isRunning: false,
        }])
        setActiveTabId(tabId)
        showStatus(`Connected to ${config.name || config.host}`, 'success')
      } else {
        showStatus(`Connection failed: ${result.error}`, 'error')
      }
    } catch (err) {
      showStatus(`Connection failed: ${err.message}`, 'error')
    }
    setShowConnectionModal(false)
    window.dbAccess?.getSavedConnections().then(res => {
      if (res.success) setSavedConnections(res.data)
    })
  }, [showStatus])

  const handleConnectSaved = useCallback(async (savedConfig) => {
    const id = savedConfig.id
    const connConfig = { ...savedConfig, id }
    try {
      showStatus(`Connecting to ${savedConfig.name || savedConfig.host}...`, 'info')
      const result = await window.dbAccess.connect(connConfig)
      if (result.success) {
        const newConn = { id, ...savedConfig, connected: true }
        setConnections(prev => [...prev, newConn])
        setActiveConnectionId(id)
        const tabId = genId()
        setTabs(prev => [...prev, {
          id: tabId, connectionId: id, title: `${savedConfig.name || savedConfig.host}`,
          query: '', results: null, isRunning: false,
        }])
        setActiveTabId(tabId)
        showStatus(`Connected to ${savedConfig.name || savedConfig.host}`, 'success')
      } else {
        showStatus(`Failed: ${result.error}`, 'error')
        setEditingConnection(savedConfig)
        setShowConnectionModal(true)
      }
    } catch (err) {
      showStatus(`Failed: ${err.message}`, 'error')
      setEditingConnection(savedConfig)
      setShowConnectionModal(true)
    }
  }, [showStatus])

  const handleDeleteSaved = useCallback(async (id) => {
    await window.dbAccess.deleteSavedConnection(id)
    setSavedConnections(prev => prev.filter(c => c.id !== id))
    showStatus('Saved connection removed', 'info')
  }, [showStatus])

  const handleDisconnect = useCallback(async (connId) => {
    await window.dbAccess.disconnect(connId)
    setConnections(prev => prev.filter(c => c.id !== connId))
    setTabs(prev => prev.filter(t => t.connectionId !== connId))
    setActiveConnectionId(prev => prev === connId ? null : prev)
    setActiveTabId(prev => {
      const remainingTabs = tabs.filter(t => t.connectionId !== connId)
      if (remainingTabs.length > 0) return remainingTabs[remainingTabs.length - 1].id
      return null
    })
    showStatus('Disconnected', 'info')
  }, [tabs, showStatus])

  const handleDeleteConnection = useCallback(async (connId) => {
    await window.dbAccess.disconnect(connId)
    setConnections(prev => prev.filter(c => c.id !== connId))
    setTabs(prev => prev.filter(t => t.connectionId !== connId))
    setActiveConnectionId(prev => prev === connId ? null : prev)
    setActiveTabId(prev => {
      const remainingTabs = tabs.filter(t => t.connectionId !== connId)
      if (remainingTabs.length > 0) return remainingTabs[remainingTabs.length - 1].id
      return null
    })
    showStatus('Connection deleted', 'info')
  }, [tabs, showStatus])

  // --- Query history ---
  const saveToHistory = useCallback((sql, connId) => {
    if (!sql || sql.trim().length < 5) return
    const conn = connections.find(c => c.id === connId)
    const entry = {
      id: genId(),
      sql: sql.trim(),
      connectionName: conn ? (conn.name || conn.host) : 'Unknown',
      timestamp: Date.now()
    }
    setQueryHistory(prev => {
      if (prev[0]?.sql === entry.sql) return prev
      const next = [entry, ...prev].slice(0, 100)
      localStorage.setItem('dbaccess:history', JSON.stringify(next))
      return next
    })
  }, [connections])

  // --- Safe Mode enforcement ---
  const checkSafeMode = useCallback(async (query) => {
    if (!safeMode) return true
    if (DESTRUCTIVE_PATTERN.test(query)) {
      const keyword = query.match(DESTRUCTIVE_PATTERN)?.[0]?.toUpperCase()
      const confirmed = await window.dbAccess.confirm({
        type: 'warning',
        title: 'Safe Mode Warning',
        message: `This query contains a potentially destructive operation: ${keyword}`,
        detail: `Are you sure you want to execute this query?\n\n"${query.substring(0, 200)}${query.length > 200 ? '…' : ''}"`,
        confirmLabel: 'Run Query',
        cancelLabel: 'Cancel',
      })
      return confirmed
    }
    return true
  }, [safeMode])

  // --- Run query ---
  const handleRunQuery = useCallback(async (query) => {
    if (!activeTab || !activeTab.connectionId) return { success: false, error: 'No active tab/connection' }
    if (!(await checkSafeMode(query))) {
      showStatus('Query blocked by Safe Mode', 'error')
      return { success: false, error: 'Blocked by Safe Mode' }
    }
    saveToHistory(query, activeTab.connectionId)
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, isRunning: true, queryError: null } : t))
    try {
      const result = await window.dbAccess.executeQuery(activeTab.connectionId, query)
      if (result.success) {
        setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, results: result, isRunning: false, queryError: null } : t))
        showStatus(`Query executed in ${result.data.duration}ms — ${result.data.rowCount} rows`, 'success')
      } else {
        setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, results: result, isRunning: false, queryError: { message: result.error } } : t))
        showStatus(`Error: ${result.error}`, 'error')
      }
      return result
    } catch (err) {
      setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, isRunning: false, queryError: { message: err.message } } : t))
      showStatus(`Error: ${err.message}`, 'error')
      return { success: false, error: err.message }
    }
  }, [activeTab, activeTabId, checkSafeMode, saveToHistory, showStatus])


  // --- Explain query ---
  const handleExplainQuery = useCallback(async (query) => {
    if (!activeTab || !activeTab.connectionId) return
    showStatus('Running EXPLAIN...', 'info')
    try {
      const result = await window.dbAccess.explainQuery(activeTab.connectionId, query)
      if (result.success) {
        // Show explain plan in a new tab as a text result
        const tabId = genId()
        const conn = connections.find(c => c.id === activeTab.connectionId)
        const planText = result.data.plan
        // Fake the results structure so ResultsGrid can show it
        const fakeResult = {
          success: true,
          data: {
            columns: [{ name: 'QUERY PLAN', dataType: 'text' }],
            rows: planText.split('\n').map(line => ({ 'QUERY PLAN': line })),
            rowCount: planText.split('\n').length,
            duration: 0,
            command: 'EXPLAIN',
          }
        }
        setTabs(prev => [...prev, {
          id: tabId,
          connectionId: activeTab.connectionId,
          type: 'query',
          title: 'Explain Plan',
          query: `-- EXPLAIN ANALYZE\n${query}`,
          results: fakeResult,
          isRunning: false,
        }])
        setActiveTabId(tabId)
        showStatus('Explain plan loaded', 'success')
      } else {
        showStatus(`Explain failed: ${result.error}`, 'error')
      }
    } catch (err) {
      showStatus(`Explain error: ${err.message}`, 'error')
    }
  }, [activeTab, connections, showStatus])

  // --- Export / Import ---
  const handleExport = useCallback(async (format) => {
    if (!activeTab?.results?.data) return showStatus('No data to export', 'error')
    const result = await window.dbAccess.exportData(activeTab.results.data, format)
    if (result.success) showStatus(`Exported to ${result.filePath}`, 'success')
    else if (result.error !== 'Export cancelled') showStatus(`Export failed: ${result.error}`, 'error')
  }, [activeTab, showStatus])

  const handleImport = useCallback(async (tableName) => {
    if (!activeConnectionId) return showStatus('No active connection', 'error')
    const result = await window.dbAccess.importData(activeConnectionId, tableName)
    if (result.success) showStatus(`Imported ${result.insertedCount} rows`, 'success')
    else if (result.error !== 'Import cancelled') showStatus(`Import failed: ${result.error}`, 'error')
  }, [activeConnectionId, showStatus])

  // --- Tab management ---
  const handleNewTab = useCallback((connectionId, sql, title) => {
    let connId = connectionId || activeConnectionId
    // When called from history, connectionId may be null but title is the connectionName
    if (!connId && title) {
      const matchedConn = connections.find(c => (c.name || c.host) === title)
      if (matchedConn) connId = matchedConn.id
    }
    if (!connId) connId = activeConnectionId
    if (!connId) return
    const conn = connections.find(c => c.id === connId)
    const tabId = genId()
    setTabs(prev => [...prev, {
      id: tabId, connectionId: connId, type: 'query',
      title: title || (conn ? `${conn.name || conn.host}` : 'Query'),
      query: sql || '', results: null, isRunning: false,
    }])
    setActiveTabId(tabId)
  }, [activeConnectionId, connections])

  const handleNewERDTab = useCallback((connectionId) => {
    const connId = connectionId || activeConnectionId
    if (!connId) return
    const conn = connections.find(c => c.id === connId)
    const tabId = genId()
    setTabs(prev => [...prev, {
      id: tabId, connectionId: connId, type: 'erd', title: `${conn ? conn.name || conn.host : 'DB'} Schema`,
      query: '', results: null, isRunning: false,
    }])
    setActiveTabId(tabId)
  }, [activeConnectionId, connections])

  const handleNewMetricsTab = useCallback((connectionId) => {
    const connId = connectionId || activeConnectionId
    if (!connId) return
    const conn = connections.find(c => c.id === connId)
    const tabId = genId()
    setTabs(prev => [...prev, {
      id: tabId, connectionId: connId, type: 'metrics', title: `📊 ${conn ? conn.name || conn.host : 'Metrics'}`,
      query: '', results: null, isRunning: false,
    }])
    setActiveTabId(tabId)
    showStatus('Loading metrics...', 'info')
  }, [activeConnectionId, connections, showStatus])

  const handleNewUsersTab = useCallback((connectionId) => {
    const connId = connectionId || activeConnectionId
    if (!connId) return
    const conn = connections.find(c => c.id === connId)
    const tabId = genId()
    setTabs(prev => [...prev, {
      id: tabId, connectionId: connId, type: 'users', title: `👥 ${conn ? conn.name || conn.host : 'Users'}`,
      query: '', results: null, isRunning: false,
    }])
    setActiveTabId(tabId)
  }, [activeConnectionId, connections])

  const handleNewBroadcastTab = useCallback(() => {
    const existing = tabs.find(t => t.type === 'broadcast')
    if (existing) { setActiveTabId(existing.id); return }
    const tabId = genId()
    setTabs(prev => [...prev, {
      id: tabId, connectionId: '', type: 'broadcast', title: 'Broadcast',
      query: '', results: null, isRunning: false,
    }])
    setActiveTabId(tabId)
  }, [tabs])

  const handleNewCompareTab = useCallback(() => {
    const existing = tabs.find(t => t.type === 'compare')
    if (existing) { setActiveTabId(existing.id); return }
    const tabId = genId()
    setTabs(prev => [...prev, {
      id: tabId, connectionId: '', type: 'compare', title: 'DB Compare',
      query: '', results: null, isRunning: false,
    }])
    setActiveTabId(tabId)
  }, [tabs])

  const handleRenameConnection = useCallback(async (connId, newName) => {
    await window.dbAccess.renameConnection(connId, newName)
    setConnections(prev => prev.map(c => c.id === connId ? { ...c, name: newName } : c))
    window.dbAccess?.getSavedConnections().then(res => {
      if (res.success) setSavedConnections(res.data)
    })
    showStatus(`Connection renamed to "${newName}"`, 'success')
  }, [showStatus])

  const handleRunSqlFile = useCallback(async (connId) => {
    if (!window.dbAccess?.executeSqlFile) return
    showStatus('Opening SQL file…', 'info')
    setSqlFileExecution(null)

    const result = await window.dbAccess.executeSqlFile(connId)
    if (result.success) {
      const msg = result.cancelled
        ? `Cancelled after ${result.stmtExecuted} statements`
        : `File executed: ${result.stmtExecuted} statements${result.errCount > 0 ? `, ${result.errCount} errors` : ''}`
      showStatus(msg, result.errCount > 0 ? 'error' : 'success')
    } else if (result.error !== 'Cancelled') {
      showStatus(`SQL file error: ${result.error}`, 'error')
    }
  }, [showStatus])

  const handleRunSqlFileForActiveTab = useCallback(() => {
    handleRunSqlFile(activeTab?.connectionId)
  }, [handleRunSqlFile, activeTab?.connectionId])

  // Register progress listener once
  React.useEffect(() => {
    if (!window.dbAccess?.onSqlFileProgress) return
    const cleanup = window.dbAccess.onSqlFileProgress((data) => {
      if (data.type === 'start') {
        setSqlFileExecution({
          sessionId: data.sessionId, fileName: data.fileName,
          totalBytes: data.totalBytes, bytesProcessed: 0,
          stmtExecuted: 0, errCount: 0, status: 'running', preview: '', errors: [],
        })
      } else if (data.type === 'progress') {
        setSqlFileExecution(prev => prev ? {
          ...prev,
          bytesProcessed: data.bytesProcessed,
          stmtExecuted: data.stmtExecuted,
          errCount: data.errCount,
          preview: data.preview || prev.preview,
        } : prev)
      } else if (data.type === 'error') {
        setSqlFileExecution(prev => prev ? {
          ...prev,
          bytesProcessed: data.bytesProcessed,
          stmtExecuted: data.stmtExecuted,
          errCount: data.errCount,
          errors: [...(prev.errors || []), { stmt: data.stmt, msg: data.msg }].slice(-50),
        } : prev)
      } else if (data.type === 'done' || data.type === 'cancelled') {
        setSqlFileExecution(prev => prev ? {
          ...prev,
          bytesProcessed: data.totalBytes,
          stmtExecuted: data.stmtExecuted,
          errCount: data.errCount,
          errors: data.errors || prev.errors,
          status: data.type,
          preview: '',
        } : prev)
      }
    })
    return cleanup
  }, [])

  const handleCreateDatabase = useCallback(async (connId) => {
    const dbName = prompt('Enter new database name:')
    if (!dbName || !dbName.trim()) return
    try {
      const result = await window.dbAccess.executeQuery(connId, `CREATE DATABASE ${dbName.trim()};`)
      if (result.success) showStatus(`Database "${dbName.trim()}" created successfully`, 'success')
      else showStatus(`Error: ${result.error}`, 'error')
    } catch (err) {
      showStatus(`Error: ${err.message}`, 'error')
    }
  }, [showStatus])

  const handleCreateTableExecute = useCallback(async (sql) => {
    if (!showCreateTableModal) return
    const connId = showCreateTableModal
    try {
      showStatus('Creating table...', 'info')
      const result = await window.dbAccess.executeQuery(connId, sql)
      if (result.success) {
        showStatus('Table created successfully', 'success')
        setSidebarRefreshKey(prev => prev + 1)
      } else {
        throw new Error(result.error)
      }
    } catch (err) {
      showStatus(`Failed to create table: ${err.message}`, 'error')
      throw err
    }
  }, [showCreateTableModal, showStatus])

  const handleScaffoldNewTable = useCallback((connId) => {
    setShowCreateTableModal(connId)
  }, [])

  const handleScaffoldMaterializedView = useCallback((connId) => {
    const conn = connections.find(c => c.id === connId)
    const isPostgres = ['postgres', 'cockroachdb', 'greenplum', 'redshift'].includes(conn?.type)
    const tabId = genId()
    const scaffold = isPostgres
      ? `CREATE MATERIALIZED VIEW public.my_materialized_view AS\nSELECT\n  column1,\n  column2,\n  COUNT(*) AS total\nFROM public.source_table\nGROUP BY column1, column2;`
      : `CREATE MATERIALIZED VIEW my_materialized_view\nENGINE = SummingMergeTree()\nORDER BY (column1, column2)\nAS SELECT\n  column1,\n  column2,\n  count() AS total\nFROM source_table\nGROUP BY column1, column2;`
    setTabs(prev => [...prev, {
      id: tabId, connectionId: connId, type: 'query', title: 'Materialized View',
      query: scaffold, results: null, isRunning: false,
    }])
    setActiveTabId(tabId)
    showStatus('Edit the CREATE MATERIALIZED VIEW template and run it', 'info')
  }, [connections, showStatus])

  const handleExportFullDatabase = useCallback(async (connId, format) => {
    try {
      showStatus(`Preparing ${format.toUpperCase()} export...`, 'info')
      const result = await window.dbAccess.exportFullDatabase(connId, format)
      if (result.success) {
        showStatus(`Database export successful: ${result.filePath}`, 'success')
      } else if (result.error !== 'Cancelled') {
        showStatus(`Export failed: ${result.error}`, 'error')
      }
    } catch (err) {
      showStatus(`Export error: ${err.message}`, 'error')
    }
  }, [showStatus])

  const handleDeleteTable = useCallback((connId, tableName) => {
    setDropTablePending({ connId, tableNames: [tableName] })
  }, [])

  const handleDeleteMultipleTables = useCallback((connId, tableNames) => {
    setDropTablePending({ connId, tableNames })
  }, [])

  const handleConfirmDropTables = useCallback(async (cascade) => {
    if (!dropTablePending) return
    const { connId, tableNames } = dropTablePending
    setDropTablePending(null)
    const conn = connections.find(c => c.id === connId)
    const connType = conn?.type || 'postgres'
    try {
      showStatus(`Dropping ${tableNames.length} table${tableNames.length > 1 ? 's' : ''}...`, 'info')
      const isMysqlWire = ['mysql', 'mariadb'].includes(connType)
      const isPgWire = ['postgres', 'cockroachdb', 'greenplum', 'redshift'].includes(connType)
      if (isMysqlWire && cascade) {
        await window.dbAccess.executeQuery(connId, 'SET FOREIGN_KEY_CHECKS = 0;')
      }
      for (const tableName of tableNames) {
        const sql = isPgWire
          ? `DROP TABLE ${tableName}${cascade ? ' CASCADE' : ''};`
          : `DROP TABLE ${tableName};`
        const result = await window.dbAccess.executeQuery(connId, sql)
        if (!result.success) {
          if (isMysqlWire && cascade) {
            await window.dbAccess.executeQuery(connId, 'SET FOREIGN_KEY_CHECKS = 1;').catch(() => {})
          }
          showStatus(`Failed to drop ${tableName.split('.').pop()}: ${result.error}`, 'error')
          return
        }
      }
      if (isMysqlWire && cascade) {
        await window.dbAccess.executeQuery(connId, 'SET FOREIGN_KEY_CHECKS = 1;')
      }
      showStatus(
        tableNames.length === 1
          ? `Table ${tableNames[0].split('.').pop()} dropped`
          : `${tableNames.length} tables dropped`,
        'success'
      )
      setSidebarRefreshKey(prev => prev + 1)
    } catch (err) {
      if (connType === 'mysql' && cascade) {
        await window.dbAccess.executeQuery(connId, 'SET FOREIGN_KEY_CHECKS = 1;').catch(() => {})
      }
      showStatus(`Error dropping table: ${err.message}`, 'error')
    }
  }, [dropTablePending, connections, showStatus])

  const handleTruncateTable = useCallback(async (connId, tableName) => {
    // Show modal with FK impact check
    setTruncatePending({ connId, tableName, fkImpact: [], isLoading: true })
    if (window.dbAccess?.getFkImpact) {
      const res = await window.dbAccess.getFkImpact(connId, tableName, []).catch(() => ({ success: false }))
      setTruncatePending({ connId, tableName, fkImpact: res.success ? (res.data || []) : [], isLoading: false })
    } else {
      setTruncatePending(prev => prev ? { ...prev, isLoading: false } : prev)
    }
  }, [])

  const handleConfirmTruncate = useCallback(async () => {
    if (!truncatePending) return
    const { connId, tableName } = truncatePending
    setTruncatePending(null)
    try {
      showStatus(`Truncating ${tableName}...`, 'info')
      const result = await window.dbAccess.executeQuery(connId, `TRUNCATE TABLE ${tableName};`)
      if (result.success) {
        showStatus(`Table ${tableName} truncated`, 'success')
        // Log to history (no row data for truncate)
        handleSaveDeleteHistory({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          timestamp: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          connectionId: connId,
          connectionName: connections.find(c => c.id === connId)?.name || '',
          tableName,
          operation: 'truncate',
          rowCount: 0,
          rows: [],
          cascadeRows: [],
          cascadeRowCount: 0,
          restorable: false,
        })
      } else {
        showStatus(`Truncate failed: ${result.error}`, 'error')
      }
    } catch (err) {
      showStatus(`Error truncating table: ${err.message}`, 'error')
    }
  }, [truncatePending, showStatus, connections, handleSaveDeleteHistory])

  const handleSetQuery = useCallback((sql) => {
    if (!activeTabId) return
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, query: sql } : t))
  }, [activeTabId])

  const handleRefreshQuery = useCallback(() => {
    if (!activeTab?.query?.trim()) return
    handleRunQuery(activeTab.query)
  }, [activeTab, handleRunQuery])

  const handleRenameTab = useCallback((tabId, newTitle) => {
    if (!newTitle?.trim()) return
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, title: newTitle.trim() } : t))
  }, [])

  const handleDuplicateTab = useCallback((tabId) => {
    const tab = tabs.find(t => t.id === tabId)
    if (!tab) return
    const newTabId = genId()
    setTabs(prev => [...prev, { ...tab, id: newTabId, results: null, isRunning: false }])
    setActiveTabId(newTabId)
  }, [tabs])

  const handleShowTableStructure = useCallback((connId, tableName) => {
    setShowTableStructure({ connId, tableName })
  }, [])

  const handleImportCSVFromSidebar = useCallback(async (connId) => {
    const tableName = prompt('Enter target table name for CSV import:')
    if (!tableName || !tableName.trim()) return
    const result = await window.dbAccess.importData(connId, tableName.trim())
    if (result.success) showStatus(`Imported ${result.insertedCount} rows into ${tableName.trim()}`, 'success')
    else if (result.error !== 'Import cancelled') showStatus(`Import failed: ${result.error}`, 'error')
  }, [showStatus])

  const handleImportForActiveTab = useCallback(() => {
    handleImportCSVFromSidebar(activeTab?.connectionId)
  }, [handleImportCSVFromSidebar, activeTab?.connectionId])

  const handleCloseTab = useCallback((tabId) => {
    setTabs(prev => {
      const remaining = prev.filter(t => t.id !== tabId)
      if (activeTabId === tabId) {
        // Only replace with another tab from the currently focused connection —
        // never jump the view into a different (hidden) connection's tab.
        const visibleRemaining = remaining.filter(t => !t.connectionId || t.connectionId === activeConnectionId)
        setActiveTabId(visibleRemaining.length > 0 ? visibleRemaining[visibleRemaining.length - 1].id : null)
      }
      return remaining
    })
  }, [activeTabId, activeConnectionId])

  // "Close All" / "Close Others" only act on the currently visible tabs (the
  // focused connection's) — tabs hidden because they belong to another
  // connection are left untouched, matching visibleTabs' filter above.
  const handleCloseAllTabs = useCallback(() => {
    setTabs(prev => prev.filter(t => t.connectionId && t.connectionId !== activeConnectionId))
    setActiveTabId(null)
  }, [activeConnectionId])

  const handleCloseOtherTabs = useCallback((tabId) => {
    setTabs(prev => prev.filter(t => t.id === tabId || (t.connectionId && t.connectionId !== activeConnectionId)))
    setActiveTabId(tabId)
  }, [activeConnectionId])

  const handleTableClick = useCallback(async (tableName, connectionId, activeDb) => {
    const connId = connectionId || activeConnectionId
    if (!connId) return

    // Switch to existing tab instead of opening a duplicate
    const existing = tabs.find(t =>
      t.tableFullName === tableName && t.connectionId === connId && !t.type
    )
    if (existing) {
      setActiveTabId(existing.id)
      setActiveConnectionId(connId)
      return
    }

    const tabId = genId()
    const connObj = connections.find(c => c.id === connId)
    // Without ctid, row edits/deletes fall back to matching on every column's
    // value, which silently no-ops (or deletes the wrong row) on duplicate rows
    // or values that don't round-trip exactly (floats, timestamps, jsonb key order).
    const isPostgres = !connObj?.type || ['postgres', 'cockroachdb', 'greenplum', 'redshift'].includes(connObj?.type)
    const query = isPostgres
      ? `SELECT ${tableName}.*, ctid AS __db_ctid FROM ${tableName} LIMIT 100;`
      : `SELECT * FROM ${tableName} LIMIT 100;`
    const dbName = activeDb || connObj?.database || ''
    const shortName = tableName.split('.').pop()
    const tabTitle = dbName ? `${dbName}.${shortName}` : tableName
    setTabs(prev => [...prev, {
      id: tabId, connectionId: connId, title: tabTitle, tableFullName: tableName,
      query, results: null, isRunning: true,
    }])
    setActiveTabId(tabId)
    setActiveConnectionId(connId)
    try {
      const result = await window.dbAccess.executeQuery(connId, query)
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, results: result, isRunning: false } : t))
      if (result.success) showStatus(`${tableName} — ${result.data.rowCount} rows (${result.data.duration}ms)`, 'success')
      else showStatus(`Error: ${result.error}`, 'error')
    } catch (err) {
      setTabs(prev => prev.map(t => t.id === tabId ? { ...t, isRunning: false } : t))
      showStatus(`Error: ${err.message}`, 'error')
    }
  }, [activeConnectionId, tabs, showStatus])

  const handleOpenAnythingTrigger = useCallback(async () => {
    const connected = connections.filter(c => c.connected)
    const catalog = []
    for (const conn of connected) {
      const result = await window.dbAccess.getTables(conn.id)
      if (result.success) {
        result.data.forEach(t => {
          catalog.push({ ...t, connectionId: conn.id, connectionName: conn.name || conn.host })
        })
      }
    }
    setAllTablesCatalog(catalog)
    setShowOpenAnything(true)
  }, [connections])

  const handleOpenAnythingSelect = useCallback((item) => {
    handleTableClick(item.fullName, item.connectionId)
    setShowOpenAnything(false)
  }, [handleTableClick])

  const handleQueryChange = useCallback((value) => {
    clearTimeout(queryChangeTimerRef.current)
    queryChangeTimerRef.current = setTimeout(() => {
      setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, query: value } : t))
    }, 300)
  }, [activeTabId])

  // --- Favorites ---
  const handleSaveFavorite = useCallback(async (query) => {
    const name = prompt('Enter a name for this favorite query:')
    if (!name?.trim()) return
    const conn = connections.find(c => c.id === activeTab?.connectionId)
    await window.dbAccess.saveFavorite({
      name: name.trim(),
      sql: query.trim(),
      connectionName: conn ? conn.name || conn.host : '',
      createdAt: Date.now(),
    })
    showStatus(`Query saved as "${name.trim()}"`, 'success')
  }, [activeTab, connections, showStatus])

  const handleFavoriteSelect = useCallback((fav) => {
    if (!activeTabId) return
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, query: fav.sql } : t))
    setShowFavoritesModal(false)
    showStatus(`Loaded favorite: "${fav.name}"`, 'success')
  }, [activeTabId, showStatus])

  // --- Save query to file ---
  const handleSaveQuery = useCallback(async () => {
    if (!activeTab || !activeTab.query) return
    try {
      const content = activeTab.query
      const filters = [{ name: 'SQL Files', extensions: ['sql'] }, { name: 'All Files', extensions: ['*'] }]
      const result = await window.dbAccess.saveRawFile(content, `${activeTab.title || 'query'}.sql`, filters, false)
      if (result.success) showStatus(`Query saved to ${result.filePath}`, 'success')
    } catch (err) {
      showStatus(`Save failed: ${err.message}`, 'error')
    }
  }, [activeTab, showStatus])

  // --- Global keyboard shortcuts ---
  React.useEffect(() => {
    const handleKeyDown = (e) => {
      const isMod = e.ctrlKey || e.metaKey
      if (isMod && e.shiftKey && (e.key === 'N' || e.key === 'n')) { e.preventDefault(); window.dbAccess.newWindow() }
      else if (isMod && e.key === 't') { e.preventDefault(); handleNewTab() }
      else if (isMod && e.key === 'w') { e.preventDefault(); if (activeTabId) handleCloseTab(activeTabId) }
      else if (isMod && e.key === 's') {
        e.preventDefault()
        // If the results grid has staged cell edits, commit them. Otherwise save query to file.
        if (gridCommitRef.current && gridCommitRef.current()) return
        handleSaveQuery()
      }
      else if (isMod && e.key === '\\') { e.preventDefault(); setSidebarCollapsed(prev => !prev) }
      else if (isMod && e.key === '[') {
        e.preventDefault()
        setTabs(prev => {
          // Cycle only within the focused connection's visible tabs.
          const visible = prev.filter(t => !t.connectionId || t.connectionId === activeConnectionId)
          if (visible.length <= 1) return prev
          const idx = visible.findIndex(t => t.id === activeTabId)
          setActiveTabId(visible[(idx - 1 + visible.length) % visible.length].id)
          return prev
        })
      } else if (isMod && e.key === ']') {
        e.preventDefault()
        setTabs(prev => {
          const visible = prev.filter(t => !t.connectionId || t.connectionId === activeConnectionId)
          if (visible.length <= 1) return prev
          const idx = visible.findIndex(t => t.id === activeTabId)
          setActiveTabId(visible[(idx + 1) % visible.length].id)
          return prev
        })
      } else if (isMod && e.key === 'k') {
        e.preventDefault(); handleOpenAnythingTrigger()
      } else if (isMod && e.key === 'r') {
        e.preventDefault(); handleRefreshQuery()
      } else if (isMod && (e.key === '?' || (e.shiftKey && e.key === 'K'))) {
        e.preventDefault(); setShowKeyboardShortcuts(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleNewTab, handleCloseTab, handleSaveQuery, handleOpenAnythingTrigger, handleRefreshQuery, activeTabId, activeConnectionId, tabs.length])

  // --- Titlebar connection-status pill ---
  const titlebarConn = connections.find(c => c.id === (activeTab?.connectionId || activeConnectionId))
  const titlebarPill = titlebarConn ? [
    titlebarConn.name,
    [
      DB_TYPES.find(d => d.id === titlebarConn.type)?.label || titlebarConn.type?.toUpperCase() || 'DB',
      titlebarConn.host,
      titlebarConn.database,
      activeTab?.tableFullName,
    ].filter(Boolean).join(' : '),
  ].filter(Boolean).join('  |  ') : ''

  return (
    <div className="app">
      <div className="app-titlebar">
        <div className="app-titlebar-left">
          <div className="app-titlebar-drag">
            <img src="/logo.png" alt="DB Access Logo" width="20" height="20" style={{ objectFit: 'contain' }} onError={(e) => e.target.style.display='none'} />
            <span className="app-title">DB Access</span>
          </div>
          <button className="app-titlebar-icon-btn" onClick={handleToggleSidebar} title="Toggle Sidebar (Ctrl+\)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
          </button>
          <button className="app-titlebar-icon-btn" onClick={() => setSidebarRefreshKey(k => k + 1)} title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
          </button>
        </div>
        <div className="app-titlebar-center">
          {titlebarPill && <div className="app-titlebar-pill" title={titlebarPill}>{titlebarPill}</div>}
        </div>
        <div className="app-titlebar-right">
          <button className="app-titlebar-icon-btn" onClick={() => window.dbAccess.newWindow()} title="New Window (Ctrl+Shift+N)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="12" y1="14" x2="12" y2="17"/><line x1="10.5" y1="15.5" x2="13.5" y2="15.5"/></svg>
          </button>
          {titlebarConn && (
            <button className="app-titlebar-icon-btn" onClick={() => handleNewMetricsTab(titlebarConn.id)} title="Database Metrics">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>
            </button>
          )}
          <button className="app-titlebar-icon-btn" onClick={() => setShowKeyboardShortcuts(true)} title="Keyboard Shortcuts (Ctrl+?)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
          </button>
          <button
            className={`app-titlebar-icon-btn ${resultsPanelVisible ? 'active' : ''}`}
            onClick={handleToggleResultsPanel}
            title={resultsPanelVisible ? 'Hide Results Panel' : 'Show Results Panel'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 14h18"/></svg>
          </button>
        </div>
      </div>
      <div className="app-body">
        <Sidebar
          connections={connections}
          savedConnections={savedConnections}
          activeConnectionId={activeConnectionId}
          collapsed={sidebarCollapsed}
          refreshKey={sidebarRefreshKey}
          queryHistory={queryHistory}
          onToggle={handleToggleSidebar}
          onSelectConnection={setActiveConnectionId}
          onNewConnection={handleOpenNewConnectionModal}
          onConnectSaved={handleConnectSaved}
          onDeleteSaved={handleDeleteSaved}
          onDisconnect={handleDisconnect}
          onDeleteConnection={handleDeleteConnection}
          onTableClick={handleTableClick}
          onNewTab={handleNewTab}
          onNewERDTab={handleNewERDTab}
          onNewMetricsTab={handleNewMetricsTab}
          onNewUsersTab={handleNewUsersTab}
          onNewCompareTab={handleNewCompareTab}
          onNewBroadcastTab={handleNewBroadcastTab}
          onRenameConnection={handleRenameConnection}
          onRunSqlFile={handleRunSqlFile}
          onCreateDatabase={handleCreateDatabase}
          onScaffoldNewTable={handleScaffoldNewTable}
          onScaffoldMaterializedView={handleScaffoldMaterializedView}
          onImportCSV={handleImportCSVFromSidebar}
          onExportDatabase={handleExportFullDatabase}
          onDeleteTable={handleDeleteTable}
          onTruncateTable={handleTruncateTable}
          onShowTableStructure={handleShowTableStructure}
          onDeleteMultipleTables={handleDeleteMultipleTables}
        />
        <div className="app-main">
          <TabBar
            tabs={visibleTabs}
            activeTabId={activeTabId}
            onSelectTab={setActiveTabId}
            onCloseTab={handleCloseTab}
            onCloseAllTabs={handleCloseAllTabs}
            onCloseOtherTabs={handleCloseOtherTabs}
            onNewTab={() => handleNewTab()}
            onRenameTab={handleRenameTab}
            onDuplicateTab={handleDuplicateTab}
          />
          {activeTab ? (
            <div className="app-workspace" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
              {activeTab.type === 'erd' ? (
                <ERDiagram connectionId={activeTab.connectionId} dbAccess={window.dbAccess} />
              ) : activeTab.type === 'metrics' ? (
                <MetricsBoard connectionId={activeTab.connectionId} />
              ) : activeTab.type === 'users' ? (
                <UserManagementPanel connectionId={activeTab.connectionId} />
              ) : activeTab.type === 'broadcast' ? (
                <BroadcastPanel connections={connections} />
              ) : activeTab.type === 'compare' ? (
                <DBComparePanel connections={connections} />
              ) : (
                <>
                  <QueryEditor
                    value={activeTab.query}
                    onChange={handleQueryChange}
                    onRun={handleRunQuery}
                    onExport={handleExport}
                    onImport={handleImport}
                    onExplain={handleExplainQuery}
                    onOpenFavorites={handleOpenFavorites}
                    onSaveFavorite={handleSaveFavorite}
                    isRunning={activeTab.isRunning}
                    activeConnectionId={activeTab.connectionId}
                    connectionName={connections.find(c => c.id === activeTab.connectionId)?.name || ''}
                    queryError={activeTab.queryError}
                    onRunSqlFile={handleRunSqlFileForActiveTab}
                    theme={theme}
                    fillHeight={!resultsPanelVisible}
                  />
                  {resultsPanelVisible && (
                    <ResultsGrid
                      results={activeTab.results}
                      isRunning={activeTab.isRunning}
                      onExport={handleExport}
                      onRunQuery={handleRunQuery}
                      onRefresh={handleRefreshQuery}
                      onSetQuery={handleSetQuery}
                      onImport={handleImportForActiveTab}
                      sourceTable={activeTab.tableFullName || null}
                      pageSize={settings.pageSize}
                      density={settings.density}
                      showGridLines={settings.showGridLines}
                      connectionId={activeTab.connectionId}
                      connectionName={connections.find(c => c.id === activeTab.connectionId)?.name || ''}
                      onSaveDeleteHistory={handleSaveDeleteHistory}
                      ctrlSRef={gridCommitRef}
                    />
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="app-empty">
              <div className="app-empty-content">
                <img src="/logo.png" alt="DB Access Logo" style={{ maxWidth: '200px', marginBottom: '20px', opacity: 0.8 }} onError={(e) => { e.target.style.display='none' }} />
                <h2>Welcome to DB Access</h2>
                <p>Connect to a database to start querying</p>
              </div>
            </div>
          )}
        </div>
      </div>
      <StatusBar
        message={statusMessage}
        connectionCount={connections.length}
        activeConnection={connections.find(c => c.id === activeConnectionId)}
        safeMode={safeMode}
        onToggleSafeMode={(val) => {
          setSafeMode(val)
          localStorage.setItem('dbaccess:safeMode', val)
        }}
        theme={theme}
        onToggleTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
        onOpenSettings={() => setShowSettings(v => !v)}
        onOpenDeleteHistory={() => setShowDeleteHistory(v => !v)}
        deleteHistoryCount={deleteHistory.length}
        onOpenCompare={handleNewCompareTab}
      />
      {showSettings && (
        <SettingsPanel
          settings={settings}
          onChangeSettings={handleChangeSettings}
          safeMode={safeMode}
          onToggleSafeMode={(val) => { setSafeMode(val); localStorage.setItem('dbaccess:safeMode', val) }}
          theme={theme}
          onToggleTheme={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
          onClose={() => setShowSettings(false)}
          onRestartTour={() => {
            localStorage.removeItem('dbaccess:tour-done')
            setShowSettings(false)
            setShowTour(true)
          }}
        />
      )}

      {/* Delete History Panel */}
      {showDeleteHistory && (
        <DeleteHistoryPanel
          history={deleteHistory}
          onClose={() => setShowDeleteHistory(false)}
          onRestoreEntry={handleRestoreHistoryEntry}
          onClearAll={handleClearDeleteHistory}
          onDeleteEntry={handleDeleteHistoryEntry}
        />
      )}

      {/* Truncate Confirmation Modal */}
      {truncatePending && (
        <DeleteConfirmModal
          mode="truncate"
          tableName={truncatePending.tableName}
          rows={[]}
          fkImpact={truncatePending.fkImpact}
          isLoading={truncatePending.isLoading}
          onConfirm={handleConfirmTruncate}
          onCancel={() => setTruncatePending(null)}
        />
      )}

      {/* Drop Table Modal */}
      {dropTablePending && (
        <DropTableModal
          tables={dropTablePending.tableNames}
          connectionType={connections.find(c => c.id === dropTablePending.connId)?.type || 'postgres'}
          onConfirm={handleConfirmDropTables}
          onCancel={() => setDropTablePending(null)}
        />
      )}

      {/* Modals */}
      {showConnectionModal && (
        <ConnectionModal
          onConnect={handleConnect}
          onClose={() => setShowConnectionModal(false)}
          editing={editingConnection}
        />
      )}
      {showCreateTableModal && (
        <CreateTableModal
          connection={connections.find(c => c.id === showCreateTableModal)}
          onCreate={handleCreateTableExecute}
          onClose={() => setShowCreateTableModal(null)}
        />
      )}
      {showKeyboardShortcuts && (
        <KeyboardShortcutsModal onClose={() => setShowKeyboardShortcuts(false)} />
      )}
      {showOpenAnything && (
        <OpenAnythingModal
          items={allTablesCatalog}
          onSelect={handleOpenAnythingSelect}
          onClose={() => setShowOpenAnything(false)}
        />
      )}
      {showFavoritesModal && (
        <QueryFavoritesModal
          currentQuery={activeTab?.query || ''}
          currentConnectionName={connections.find(c => c.id === activeTab?.connectionId)?.name || ''}
          onSelect={handleFavoriteSelect}
          onClose={() => setShowFavoritesModal(false)}
        />
      )}
      {showTour && (
        <AppTour onComplete={() => {
          localStorage.setItem('dbaccess:tour-done', 'true')
          setShowTour(false)
        }} />
      )}

      {sqlFileExecution && (
        <SqlFileProgress
          execution={sqlFileExecution}
          onCancel={() => {
            if (sqlFileExecution.sessionId) window.dbAccess?.cancelSqlFile(sqlFileExecution.sessionId)
            setSqlFileExecution(prev => prev ? { ...prev, status: 'cancelled' } : prev)
          }}
          onClose={() => setSqlFileExecution(null)}
        />
      )}

      {showTableStructure && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowTableStructure(null)}>
          <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '12px', width: '640px', maxHeight: '72vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <TableStructurePanel
              connectionId={showTableStructure.connId}
              tableName={showTableStructure.tableName}
              onClose={() => setShowTableStructure(null)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ── License gate wrapper ──────────────────────────────────────────────────────
// Sits above MainApp so MainApp's hooks are always called the same number of
// times regardless of license state (Rules of Hooks compliance).
const ACTIVATION_DISABLED = true // TODO: re-enable license gate

export default function App() {
  const [licenseStatus, setLicenseStatus] = useState('checking')
  const [startupMessage, setStartupMessage]  = useState('')

  useEffect(() => {
    if (ACTIVATION_DISABLED) {
      setLicenseStatus('valid')
      return
    }

    // Fail CLOSED: if the license bridge is missing for any reason, block access.
    if (!window.dbAccess?.license) {
      setLicenseStatus('invalid')
      return
    }

    // 15-second hard timeout — if IPC hangs for any reason, block access.
    const timeout = setTimeout(() => setLicenseStatus('invalid'), 15000)

    window.dbAccess.license.validate()
      .then(result => {
        clearTimeout(timeout)
        if (result.valid) {
          setLicenseStatus('valid')
        } else {
          if (result.reason) setStartupMessage(result.reason)
          setLicenseStatus('invalid')
        }
      })
      .catch(() => {
        clearTimeout(timeout)
        setLicenseStatus('invalid')
      })

    return () => clearTimeout(timeout)
  }, [])

  // License was pre-validated in the main process before the window was shown,
  // so this 'checking' state resolves in a single IPC round-trip (no server call).
  // Render nothing — the window is already painted in backgroundColor so there
  // is no visible flash before the real UI appears.
  if (licenseStatus === 'checking') {
    return null
  }

  if (licenseStatus === 'invalid') {
    return <ActivationScreen
      startupMessage={startupMessage}
      onActivated={() => setLicenseStatus('valid')}
    />
  }

  return <MainApp />
}
