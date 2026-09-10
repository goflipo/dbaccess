import React, { useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect } from 'react'
import DeleteConfirmModal from './DeleteConfirmModal'
import TableStructurePanel from './TableStructurePanel'
import './ResultsGrid.css'

const operators = [
  { value: 'contains', label: 'Contains' },
  { value: 'equals', label: '=' },
  { value: 'not_equals', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'lt', label: '<' },
  { value: 'gte', label: '≥' },
  { value: 'lte', label: '≤' },
  { value: 'starts_with', label: 'Starts with' },
  { value: 'ends_with', label: 'Ends with' },
  { value: 'null', label: 'Is NULL' },
  { value: 'not_null', label: 'Is NOT NULL' },
]

// JS Date.toString() pattern — produced when Electron contextBridge serialises Date objects
// e.g. "Thu Apr 23 2026 04:15:09 GMT+0000 (Coordinated Universal Time)"
const JS_DATE_TOSTRING_RE = /^\w{3} \w{3} {1,2}\d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT/

const parseAnyDate = (v) => {
  if (v instanceof Date) return v
  if (typeof v === 'string' && JS_DATE_TOSTRING_RE.test(v)) {
    const d = new Date(v)
    if (!isNaN(d.getTime())) return d
  }
  return null
}

const formatCellValue = (val) => {
  if (val === null || val === undefined) return ''
  const d = parseAnyDate(val)
  if (d) return d.toISOString().replace('T', ' ').replace(/\.000Z$/, ' UTC').replace(/Z$/, ' UTC')
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

// Format a JS value into a safe SQL literal.
const sqlLiteral = (v) => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  // Real Date instances (ideal path)
  if (v instanceof Date) return `'${v.toISOString()}'`
  // Objects (jsonb, arrays, etc.)
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`
  const str = String(v)
  // Electron contextBridge converts Date→string via .toString(); detect and fix
  const d = parseAnyDate(str)
  if (d) return `'${d.toISOString()}'`
  return `'${str.replace(/'/g, "''")}'`
}
const applyOperator = (val, op, filterVal) => {
  const strVal = formatCellValue(val)
  const numVal = Number(val)
  const numFilter = Number(filterVal)
  switch (op) {
    case 'contains': return strVal.toLowerCase().includes(filterVal.toLowerCase())
    case 'equals': return strVal === filterVal
    case 'not_equals': return strVal !== filterVal
    case 'gt': return !isNaN(numVal) && !isNaN(numFilter) && numVal > numFilter
    case 'lt': return !isNaN(numVal) && !isNaN(numFilter) && numVal < numFilter
    case 'gte': return !isNaN(numVal) && !isNaN(numFilter) && numVal >= numFilter
    case 'lte': return !isNaN(numVal) && !isNaN(numFilter) && numVal <= numFilter
    case 'starts_with': return strVal.toLowerCase().startsWith(filterVal.toLowerCase())
    case 'ends_with': return strVal.toLowerCase().endsWith(filterVal.toLowerCase())
    case 'null': return val === null || val === undefined
    case 'not_null': return val !== null && val !== undefined
    default: return true
  }
}

function ResultsGrid({ results, isRunning, onExport, onRunQuery, onSetQuery, onRefresh, onImport, sourceTable, pageSize = 100, density = 'normal', showGridLines = true, connectionId, connectionName, onSaveDeleteHistory, ctrlSRef }) {
  const tableRef = useRef(null)
  const cellEditRef = useRef(null)
  const [filterText, setFilterText] = useState('')
  const [showFilterPanel, setShowFilterPanel] = useState(false)
  const [advancedFilters, setAdvancedFilters] = useState([])
  const [editingCell, setEditingCell] = useState(null)
  const [editValue, setEditValue] = useState('')
  const [pendingChanges, setPendingChanges] = useState({})
  const [newRows, setNewRows] = useState([])
  const [editingNewCell, setEditingNewCell] = useState(null)
  const [sortCol, setSortCol] = useState(null)
  const [sortDir, setSortDir] = useState('asc')
  const [currentPage, setCurrentPage] = useState(0)
  const [selectedRow, setSelectedRow] = useState(null)
  const [selectedRows, setSelectedRows] = useState(new Set())
  const [showJsonSidebar, setShowJsonSidebar] = useState(false)
  const [copiedCell, setCopiedCell] = useState(null)
  const [colWidths, setColWidths] = useState({})
  const [hiddenColumns, setHiddenColumns] = useState(new Set())
  const [viewMode, setViewMode] = useState('data') // 'data' | 'structure' | 'index'

  // Reset to the Data view whenever the underlying table/connection changes
  useEffect(() => { setViewMode('data') }, [sourceTable, connectionId])
  const [showColVisibility, setShowColVisibility] = useState(false)
  const [toastMsg, setToastMsg] = useState(null)
  const [columnOrder, setColumnOrder] = useState(null)
  const [dragOverCol, setDragOverCol] = useState(null)
  const dragColRef = useRef(null)
  const [pendingDelete, setPendingDelete] = useState(null) // { rows, fkImpact, isLoading }
  const resizingRef = useRef(null)
  const lastShiftAnchorRef = useRef(null)
  const [contextMenu, setContextMenu] = useState(null)
  const [menuPos, setMenuPos] = useState({ top: -9999, left: -9999 })
  const menuRef = useRef(null)
  const [activeSubmenu, setActiveSubmenu] = useState(null)
  const submenuTimerRef = useRef(null)
  const submenuRef = useRef(null)
  const [submenuStyle, setSubmenuStyle] = useState({})

  const showToast = (msg, type = 'info') => {
    setToastMsg({ msg, type })
    setTimeout(() => setToastMsg(null), 2200)
  }

  // Flip the open submenu up/left when it would otherwise overflow the window
  useLayoutEffect(() => {
    if (!activeSubmenu || !submenuRef.current) { setSubmenuStyle({}); return }
    const rect = submenuRef.current.getBoundingClientRect()
    const MARGIN = 8
    const style = {}
    if (rect.bottom > window.innerHeight - MARGIN) { style.top = 'auto'; style.bottom = -4 }
    if (rect.right > window.innerWidth - MARGIN) { style.left = 'auto'; style.right = '100%' }
    setSubmenuStyle(style)
  }, [activeSubmenu])

  // Reposition context menu after it renders so it never goes off-screen
  useEffect(() => {
    if (!contextMenu || !menuRef.current) return
    const el = menuRef.current
    const { width, height } = el.getBoundingClientRect()
    const MARGIN = 8
    let left = contextMenu.rawX
    let top = contextMenu.rawY
    if (left + width + MARGIN > window.innerWidth) left = window.innerWidth - width - MARGIN
    if (left < MARGIN) left = MARGIN
    if (top + height + MARGIN > window.innerHeight) top = window.innerHeight - height - MARGIN
    if (top < MARGIN) top = MARGIN
    setMenuPos({ top, left })
  }, [contextMenu])

  // Reset transient state when a new result arrives
  useEffect(() => {
    setCurrentPage(0)
    setSortCol(null)
    setSortDir('asc')
    setFilterText('')
    setAdvancedFilters([])
    setEditingCell(null)
    setPendingChanges({})
    setNewRows([])
    setEditingNewCell(null)
    setSelectedRow(null)
    setSelectedRows(new Set())
    setCopiedCell(null)
    setShowColVisibility(false)
    // Restore persisted column order, or fall back to natural order
    const cols = results?.data?.columns || []
    const key = sourceTable
      ? `dbaccess:col-order:${sourceTable}`
      : cols.length > 0 ? `dbaccess:col-order:q:${cols.slice(0, 6).map(c => c.name).join(',')}` : null
    if (key) {
      try {
        const saved = localStorage.getItem(key)
        if (saved) {
          const order = JSON.parse(saved)
          const names = new Set(cols.map(c => c.name))
          if (order.length > 0 && order.every(n => names.has(n))) {
            setColumnOrder(order)
            lastShiftAnchorRef.current = null
            return
          }
        }
      } catch {}
    }
    setColumnOrder(null)
    lastShiftAnchorRef.current = null
  }, [results])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (!e.target.closest('.col-visibility-dropdown') && !e.target.closest('.col-vis-btn')) {
        setShowColVisibility(false)
      }
      // Context menu is closed via its backdrop overlay — do NOT close it here
    }
    window.addEventListener('click', handleClickOutside)
    return () => window.removeEventListener('click', handleClickOutside)
  }, [])

  // Focus the cell edit input whenever a cell enters edit mode
  useEffect(() => {
    if (editingCell && cellEditRef.current) {
      const el = cellEditRef.current
      el.focus()
      const len = el.value?.length ?? 0
      try { el.setSelectionRange(len, len) } catch {}
    }
  }, [editingCell?.ri, editingCell?.ci])

  // Keyboard: Escape closes editing/context menus
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
        setActiveSubmenu(null)
        setEditingCell(null)
        setEditingNewCell(null)
        setShowColVisibility(false)
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'r' && onRefresh) {
        e.preventDefault()
        onRefresh()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onRefresh])

  // Clean up the ctrlSRef when this component unmounts
  useEffect(() => {
    return () => { if (ctrlSRef) ctrlSRef.current = null }
  }, [ctrlSRef])

  if (isRunning) {
    return (
      <div className="results-grid results-loading">
        <div className="loading-indicator">
          <div className="loading-spinner"></div>
          <span>Executing query...</span>
        </div>
      </div>
    )
  }

  if (!results) {
    return (
      <div className="results-grid results-empty">
        <div className="results-empty-content">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--border-strong)" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/>
          </svg>
          <p>Run a query to see results</p>
          <p className="results-empty-hint">Press <kbd>Ctrl+Enter</kbd> or <kbd>F5</kbd> to execute</p>
        </div>
      </div>
    )
  }

  if (!results.success) {
    return (
      <div className="results-grid results-error">
        <div className="error-content">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>
          </svg>
          <div>
            <div className="error-title">Query Error</div>
            <div className="error-message">{results.error}</div>
          </div>
        </div>
      </div>
    )
  }

  const { columns = [], rows = [], rowCount, duration, command } = results.data || {}

  if (!columns || columns.length === 0) {
    return (
      <div className="results-grid results-success">
        <div className="success-content">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
          <span>{command} executed successfully — {rowCount !== null && rowCount !== undefined ? `${rowCount} rows affected` : 'Done'} ({duration}ms)</span>
          {onRefresh && (
            <button className="results-action-btn" onClick={onRefresh} title="Re-run (F5)">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
              Refresh
            </button>
          )}
        </div>
      </div>
    )
  }

  const visibleColumns = columns.filter(c => !hiddenColumns.has(c.name) && c.name !== '__db_ctid')

  const orderedVisibleColumns = (() => {
    if (!columnOrder || columnOrder.length === 0) return visibleColumns
    const orderMap = Object.fromEntries(columnOrder.map((name, i) => [name, i]))
    return [...visibleColumns].sort((a, b) => (orderMap[a.name] ?? 9999) - (orderMap[b.name] ?? 9999))
  })()

  // --- Filtering ---
  const quickFiltered = filterText
    ? rows.filter(row =>
        visibleColumns.some(col => {
          const val = row[col.name]
          return val !== null && val !== undefined && String(val).toLowerCase().includes(filterText.toLowerCase())
        })
      )
    : rows

  const advancedFiltered = advancedFilters.length > 0
    ? quickFiltered.filter(row =>
        advancedFilters.every(f => {
          if (!f.isActive) return true
          return applyOperator(row[f.col], f.op, f.val)
        })
      )
    : quickFiltered

  // --- Sorting ---
  const sortedRows = sortCol !== null
    ? [...advancedFiltered].sort((a, b) => {
        const aVal = a[sortCol]
        const bVal = b[sortCol]
        if (aVal === null || aVal === undefined) return sortDir === 'asc' ? 1 : -1
        if (bVal === null || bVal === undefined) return sortDir === 'asc' ? -1 : 1
        const aNum = Number(aVal)
        const bNum = Number(bVal)
        if (!isNaN(aNum) && !isNaN(bNum)) return sortDir === 'asc' ? aNum - bNum : bNum - aNum
        const cmp = String(aVal).localeCompare(String(bVal))
        return sortDir === 'asc' ? cmp : -cmp
      })
    : advancedFiltered

  const filteredRows = sortedRows
  const totalPages = Math.ceil(filteredRows.length / pageSize)
  const pagedRows = filteredRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  // --- Filter CRUD ---
  const addFilter = () => {
    setAdvancedFilters(prev => [...prev, {
      id: Date.now().toString(36),
      col: visibleColumns[0]?.name || '',
      op: 'contains', val: '', isActive: true
    }])
  }
  const updateFilter = (id, update) => setAdvancedFilters(prev => prev.map(f => f.id === id ? { ...f, ...update } : f))
  const removeFilter = (id) => setAdvancedFilters(prev => prev.filter(f => f.id !== id))

  // --- Sort ---
  const handleSort = (colName) => {
    if (sortCol === colName) {
      if (sortDir === 'asc') setSortDir('desc')
      else { setSortCol(null); setSortDir('asc') }
    } else {
      setSortCol(colName)
      setSortDir('asc')
    }
    setCurrentPage(0)
  }

  // --- Cell editing ---
  const handleCellDoubleClick = (ri, ci, val) => {
    const isJsonVal = typeof val === 'object' && val !== null
    const strVal = formatCellValue(val)
    // Lock widget type at open time — avoids input→textarea remount during typing
    const useTextarea = isJsonVal || strVal.includes('\n') || strVal.length > 80
    setEditingCell({ ri, ci, originalValue: val, useTextarea })
    setEditValue(strVal)
  }

  const handleEditSave = () => {
    if (!editingCell) return
    const { ri, ci, originalValue } = editingCell
    if (editValue !== formatCellValue(originalValue ?? '')) {
      setPendingChanges(prev => ({ ...prev, [`${ri}:${ci}`]: editValue }))
    }
    setEditingCell(null)
  }

  const handleDiscardChanges = () => {
    setPendingChanges({})
    setNewRows([])
    setEditingNewCell(null)
  }

  const handleCommitChanges = async () => {
    if (!sourceTable) {
      showToast('Open a direct table view to commit edits.', 'error')
      return
    }
    const editCount = Object.keys(pendingChanges).length
    const insertCount = newRows.length
    if (editCount === 0 && insertCount === 0) return

    try {
      let sql = 'BEGIN;\n'

      // UPDATE existing rows
      if (editCount > 0) {
        const rowsToUpdate = {}
        Object.entries(pendingChanges).forEach(([key, newVal]) => {
          const [ri, ci] = key.split(':').map(Number)
          if (!rowsToUpdate[ri]) rowsToUpdate[ri] = {}
          rowsToUpdate[ri][columns[ci].name] = newVal
        })
        Object.entries(rowsToUpdate).forEach(([ri, colChanges]) => {
          const row = rows[Number(ri)]
          const setClause = Object.entries(colChanges)
            .map(([col, val]) => `"${col}" = ${sqlLiteral(val)}`)
            .join(', ')
          let whereClause
          if (row && row.__db_ctid !== undefined && row.__db_ctid !== null) {
            whereClause = `ctid = ${sqlLiteral(row.__db_ctid)}`
          } else {
            whereClause = columns
              .map(col => {
                const val = row[col.name]
                return val === null || val === undefined
                  ? `"${col.name}" IS NULL`
                  : `"${col.name}" = ${sqlLiteral(val)}`
              })
              .join(' AND ')
          }
          sql += `UPDATE ${sourceTable} SET ${setClause} WHERE ${whereClause};\n`
        })
      }

      // INSERT new rows
      if (insertCount > 0) {
        const insertCols = columns.filter(c => c.name !== '__db_ctid')
        const colList = insertCols.map(c => `"${c.name}"`).join(', ')
        newRows.forEach(newRow => {
          const valList = insertCols.map(c => {
            const v = newRow.values[c.name]
            if (v === null || v === undefined || v === '') return 'NULL'
            return sqlLiteral(v)
          }).join(', ')
          sql += `INSERT INTO ${sourceTable} (${colList}) VALUES (${valList});\n`
        })
      }

      sql += 'COMMIT;'

      const res = await window.dbAccess.executeQuery(connectionId, sql)
      if (res?.success) {
        setPendingChanges({})
        setNewRows([])
        setEditingNewCell(null)
        const parts = []
        if (editCount > 0) parts.push(`${editCount} edit${editCount !== 1 ? 's' : ''}`)
        if (insertCount > 0) parts.push(`${insertCount} row${insertCount !== 1 ? 's' : ''} inserted`)
        // Each UPDATE/INSERT statement should affect exactly one row; if the
        // reported total is short, at least one UPDATE's WHERE matched nothing
        // (e.g. the row changed/was removed elsewhere) — surface that instead
        // of a blanket success, same as the delete flow does.
        const expectedMin = editCount + insertCount
        const affected = res.data?.rowCount
        if (typeof affected === 'number' && affected < expectedMin) {
          showToast(`${parts.join(', ')} attempted, but only ${affected} row${affected !== 1 ? 's' : ''} actually changed — some edits may not have matched (row changed or removed elsewhere).`, 'error')
        } else {
          showToast(parts.join(', ') + ' saved', 'success')
        }
        onRefresh?.()
      } else {
        showToast(`Commit failed: ${res?.error || 'Unknown error'}`, 'error')
      }
    } catch (err) {
      showToast(`Commit failed: ${err.message}`, 'error')
    }
  }

  const handleAddRow = () => {
    if (!sourceTable) { showToast('Open a direct table view to add rows.', 'error'); return }
    const values = {}
    columns.forEach(col => {
      if (col.name === '__db_ctid') return
      const type = (col.dataType || '').toLowerCase()
      if (type.includes('timestamp') || type.includes('datetime') || type === 'date') {
        values[col.name] = new Date().toISOString().replace('T', ' ').slice(0, 19)
      } else {
        values[col.name] = ''
      }
    })
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
    setNewRows(prev => [...prev, { id, values }])
  }
  // Tell App.jsx's Ctrl+S handler whether we have pending edits/inserts to commit.
  if (ctrlSRef) {
    ctrlSRef.current = (Object.keys(pendingChanges).length > 0 || newRows.length > 0)
      ? () => { handleCommitChanges(); return true }
      : null
  }

  // --- Copy ---
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(formatCellValue(text)).catch(() => {})
  }

  const handleCellClick = (e, ri) => {
    // Prevent browser text-selection on modifier clicks (Ctrl, Shift, Meta)
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) e.preventDefault()
    if (e && (e.ctrlKey || e.metaKey)) {
      setSelectedRows(prev => {
        const next = new Set(prev)
        if (next.has(ri)) next.delete(ri)
        else next.add(ri)
        return next
      })
    } else if (e && e.shiftKey && lastShiftAnchorRef.current !== null) {
      const anchor = lastShiftAnchorRef.current
      const anchorPos = filteredRows.findIndex(r => rows.indexOf(r) === anchor)
      const curPos = filteredRows.findIndex(r => rows.indexOf(r) === ri)
      if (anchorPos !== -1 && curPos !== -1) {
        const start = Math.min(anchorPos, curPos)
        const end = Math.max(anchorPos, curPos)
        setSelectedRows(new Set(filteredRows.slice(start, end + 1).map(r => rows.indexOf(r))))
      }
    } else {
      setSelectedRows(new Set([ri]))
    }
    lastShiftAnchorRef.current = ri
    setSelectedRow(ri)
    setCopiedCell(null)
  }

  const handleCopyAs = (format) => {
    if (!contextMenu || !contextMenu.row) return

    const multiRows = selectedRows.size > 1
      ? [...selectedRows].sort((a, b) => a - b).map(idx => rows[idx]).filter(Boolean)
      : [contextMenu.row]
    const keys = Object.keys(multiRows[0])

    const escapeCsv = (val) => {
      const str = formatCellValue(val)
      if (str.includes(',') || str.includes('"') || str.includes('\n')) return `"${str.replace(/"/g, '""')}"`
      return str
    }

    let result = ''
    switch (format) {
      case 'json':
        result = JSON.stringify(multiRows.length === 1 ? multiRows[0] : multiRows, null, 2)
        break
      case 'markdown': {
        const header = '| ' + keys.join(' | ') + ' |'
        const sep = '| ' + keys.map(() => '---').join(' | ') + ' |'
        const dataRows = multiRows.map(row =>
          '| ' + keys.map(k => formatCellValue(row[k]).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |'
        )
        result = [header, sep, ...dataRows].join('\n')
        break
      }
      case 'tsv':
        result = multiRows.map(row => keys.map(k => formatCellValue(row[k]).replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t')).join('\n')
        break
      case 'tsv_header':
        result = keys.join('\t') + '\n' + multiRows.map(row => keys.map(k => formatCellValue(row[k]).replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t')).join('\n')
        break
      case 'csv':
        result = multiRows.map(row => keys.map(k => escapeCsv(row[k])).join(',')).join('\n')
        break
      case 'csv_header':
        result = keys.map(escapeCsv).join(',') + '\n' + multiRows.map(row => keys.map(k => escapeCsv(row[k])).join(',')).join('\n')
        break
      case 'insert': {
        const tableName = sourceTable || 'table_name'
        const insertKeys = keys.filter(k => k !== '__db_ctid')
        const cols = insertKeys.map(k => `"${k}"`).join(', ')
        result = multiRows.map(row => {
          const sqlVals = insertKeys.map(k => sqlLiteral(row[k])).join(', ')
          return `INSERT INTO ${tableName} (${cols}) VALUES (${sqlVals});`
        }).join('\n')
        break
      }
      default:
        result = multiRows.map(row => keys.map(k => formatCellValue(row[k]).replace(/\n/g, ' ')).join(' ')).join('\n')
        break
    }
    copyToClipboard(result)
    setContextMenu(null); setActiveSubmenu(null)
  }

  // Copy ALL visible results as CSV
  const handleCopyAllCSV = () => {
    const header = orderedVisibleColumns.map(c => c.name).join(',')
    const rowsCsv = filteredRows.map(row =>
      orderedVisibleColumns.map(col => {
        const v = row[col.name]
        const str = formatCellValue(v)
        if (str.includes(',') || str.includes('"') || str.includes('\n')) return `"${str.replace(/"/g, '""')}"`
        return str
      }).join(',')
    )
    copyToClipboard([header, ...rowsCsv].join('\n'))
  }

  // Copy all as JSON
  const handleCopyAllJSON = () => {
    copyToClipboard(JSON.stringify(filteredRows.map(row => {
      const obj = {}
      orderedVisibleColumns.forEach(col => { obj[col.name] = row[col.name] })
      return obj
    }), null, 2))
  }

  // --- Column resize ---
  const handleColResizeStart = (e, colName) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = colWidths[colName] || 150
    const onMove = (ev) => {
      const newW = Math.max(60, startW + ev.clientX - startX)
      setColWidths(prev => ({ ...prev, [colName]: newW }))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // --- Column drag-to-reorder ---
  const handleColDragStart = (e, colName) => {
    dragColRef.current = colName
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', colName)
  }
  const handleColDragOver = (e, colName) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragColRef.current !== colName) setDragOverCol(colName)
  }
  const handleColDrop = (e, targetColName) => {
    e.preventDefault()
    const src = dragColRef.current
    if (!src || src === targetColName) { setDragOverCol(null); return }
    setColumnOrder(prev => {
      const base = prev?.length > 0 ? [...prev] : columns.map(c => c.name)
      const si = base.indexOf(src), ti = base.indexOf(targetColName)
      if (si === -1 || ti === -1) return prev
      base.splice(si, 1)
      base.splice(ti, 0, src)
      // Persist so the order survives app restarts
      const key = sourceTable
        ? `dbaccess:col-order:${sourceTable}`
        : columns.length > 0 ? `dbaccess:col-order:q:${columns.slice(0, 6).map(c => c.name).join(',')}` : null
      if (key) try { localStorage.setItem(key, JSON.stringify(base)) } catch {}
      return base
    })
    setDragOverCol(null)
    dragColRef.current = null
  }
  const handleColDragEnd = () => { setDragOverCol(null); dragColRef.current = null }

  // --- Context menu ---
  const handleCellContextMenu = (e, ri, row, ci, val) => {
    e.preventDefault()
    setSelectedRow(ri)
    setSelectedRows(prev => prev.has(ri) ? prev : new Set([ri]))
    setMenuPos({ top: -9999, left: -9999 })
    setActiveSubmenu(null)
    setContextMenu({ rawX: e.clientX, rawY: e.clientY, ri, row, ci, val })
  }

  // Column visibility toggle
  const toggleColVisibility = (colName) => {
    setHiddenColumns(prev => {
      const next = new Set(prev)
      if (next.has(colName)) next.delete(colName)
      else next.add(colName)
      return next
    })
  }

  const selectedRowData = selectedRow !== null && rows[selectedRow] ? rows[selectedRow] : null

  const buildDeleteConditions = (rowsToDelete) =>
    rowsToDelete.map(row => {
      if (row && row.__db_ctid !== undefined && row.__db_ctid !== null) {
        return `(ctid = ${sqlLiteral(row.__db_ctid)})`
      }
      return `(${columns.map(col => {
        const v = row[col.name]
        if (v === null || v === undefined) return `"${col.name}" IS NULL`
        return `"${col.name}" = ${sqlLiteral(v)}`
      }).join(' AND ')})`
    }).join('\nOR ')

  const handleDeleteSelectedRows = async () => {
    if (!sourceTable) { showToast('Open a direct table view to delete rows.', 'error'); return }
    const rowsToDelete = [...selectedRows].map(idx => rows[idx]).filter(Boolean)
    if (rowsToDelete.length === 0) return
    // Open modal immediately with loading state while we fetch FK impact
    setPendingDelete({ rows: rowsToDelete, fkImpact: [], isLoading: true })
    let fkImpact = []
    if (connectionId && window.dbAccess?.getFkImpact) {
      const res = await window.dbAccess.getFkImpact(connectionId, sourceTable, rowsToDelete).catch(() => ({ success: false }))
      if (res.success) fkImpact = res.data || []
    }
    setPendingDelete({ rows: rowsToDelete, fkImpact, isLoading: false })
  }

  const handleConfirmDelete = async (mode) => {
    if (!pendingDelete) return
    const { rows: rowsToDelete, fkImpact } = pendingDelete
    setPendingDelete(null)
    const doCascade = mode === 'cascade'
    const cascadeRows = []
    try {
      let sql = 'BEGIN;\n'
      if (doCascade && fkImpact.length > 0) {
        for (const fk of fkImpact) {
          if (fk.affectedCount === 0) continue
          const srcVals = rowsToDelete.map(r => r[fk.srcColumn]).filter(v => v !== null && v !== undefined)
          if (srcVals.length === 0) continue
          const inList = srcVals.map(v => sqlLiteral(v)).join(', ')
          sql += `DELETE FROM "${fk.refSchema}"."${fk.refTable}" WHERE "${fk.refColumn}" IN (${inList});\n`
          // Store all cascade rows in history (use preview rows we already have)
          if (fk.affectedRows?.length > 0) {
            cascadeRows.push({ tableName: fk.fullTableName, rowCount: fk.affectedCount, rows: fk.affectedRows })
          }
        }
      }
      sql += `DELETE FROM ${sourceTable}\nWHERE ${buildDeleteConditions(rowsToDelete)};\n`
      sql += 'COMMIT;'
      const delRes = await onRunQuery(sql)
      if (delRes?.success) {
        const affected = delRes.data?.rowCount
        if (typeof affected === 'number' && affected === 0) {
          // Query ran without error but matched nothing — surface this instead of
          // reporting a false success (e.g. rows already changed/removed elsewhere).
          showToast('No matching rows were deleted — they may have already changed or been removed.', 'error')
        } else {
          if (onSaveDeleteHistory) {
            onSaveDeleteHistory({
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              timestamp: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              connectionId,
              connectionName: connectionName || '',
              tableName: sourceTable,
              operation: 'delete',
              rowCount: rowsToDelete.length,
              rows: rowsToDelete,
              cascadeRows,
              cascadeRowCount: cascadeRows.reduce((s, c) => s + c.rowCount, 0),
              restorable: true,
            })
          }
          showToast(`Deleted ${rowsToDelete.length} row${rowsToDelete.length !== 1 ? 's' : ''}${doCascade && cascadeRows.length > 0 ? ' + cascade' : ''}`, 'success')
        }
        if (onRefresh) await onRefresh()
        else if (sourceTable) await onRunQuery(`SELECT * FROM ${sourceTable};`)
        setSelectedRows(new Set())
      } else {
        showToast(`Delete failed: ${delRes?.error || 'Unknown error'}`, 'error')
      }
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, 'error')
    }
  }

  // --- Paste: read clipboard and scaffold INSERT ---
  const handlePaste = async () => {
    if (!sourceTable) { showToast('Open a direct table view to paste rows.', 'error'); setContextMenu(null); setActiveSubmenu(null); return }
    try {
      const text = await navigator.clipboard.readText()
      try {
        const obj = JSON.parse(text)
        const entries = Array.isArray(obj) ? obj : [obj]
        const cols = Object.keys(entries[0]).map(c => `"${c}"`).join(', ')
        const valRows = entries.map(row =>
          '(' + Object.values(row).map(v => {
            if (v === null || v === undefined) return 'NULL'
            if (typeof v === 'number') return v
            return `'${String(v).replace(/'/g, "''")}'`
          }).join(', ') + ')'
        ).join(',\n')
        onSetQuery?.(`INSERT INTO ${sourceTable} (${cols})\nVALUES\n${valRows};`)
        showToast('Pasted from clipboard as INSERT', 'success')
        setContextMenu(null); setActiveSubmenu(null)
        return
      } catch (_) {/* not JSON */}
      const vals = text.split('\t').map(v => `'${v.replace(/'/g, "''")}'`).join(', ')
      const cols = columns.map(c => `"${c.name}"`).join(', ')
      onSetQuery?.(`INSERT INTO ${sourceTable} (${cols})\nVALUES (${vals});`)
      showToast('Pasted clipboard as row values', 'success')
    } catch (err) {
      showToast('Clipboard read failed: ' + err.message, 'error')
    }
    setContextMenu(null); setActiveSubmenu(null)
  }

  // --- Quick Filter: add a column filter from context menu ---
  const handleQuickFilter = (op) => {
    const col = columns[contextMenu?.ci]?.name
    const val = contextMenu?.val
    if (!col) return
    setAdvancedFilters(prev => [...prev, {
      id: Date.now().toString(36),
      col,
      op,
      val: val === null || val === undefined ? '' : formatCellValue(val),
      isActive: true
    }])
    setShowFilterPanel(true)
    setContextMenu(null); setActiveSubmenu(null)
  }

  // --- Submenu helpers (delay so mouse can travel from trigger to submenu) ---
  const openSubmenu = (name) => {
    clearTimeout(submenuTimerRef.current)
    setActiveSubmenu(name)
  }
  const closeSubmenu = () => {
    submenuTimerRef.current = setTimeout(() => setActiveSubmenu(null), 120)
  }
  const holdSubmenu = () => clearTimeout(submenuTimerRef.current)

  // --- Export current page ---
  const handleExportCurrentPage = () => {
    const pageRows = filteredRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
    const header = orderedVisibleColumns.map(c => c.name).join(',')
    const body = pageRows.map(row =>
      orderedVisibleColumns.map(col => {
        const str = formatCellValue(row[col.name])
        if (str.includes(',') || str.includes('"') || str.includes('\n')) return `"${str.replace(/"/g, '""')}"`
        return str
      }).join(',')
    ).join('\n')
    const csv = header + '\n' + body
    // Trigger download via window.dbAccess if available, otherwise blob download
    if (window.dbAccess?.saveRawFile) {
      window.dbAccess.saveRawFile(csv, 'export_page.csv', [{ name: 'CSV', extensions: ['csv'] }], false)
    } else {
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'export_page.csv'; a.click()
      URL.revokeObjectURL(url)
    }
    showToast(`Exported ${pageRows.length} rows`, 'success')
    setContextMenu(null); setActiveSubmenu(null)
  }

  return (
    <div className={`results-grid ${showJsonSidebar ? 'with-json-sidebar' : ''}`} data-tour="results">
      <div className="results-main">
        <div className="results-header">
          <div className="results-info">
            <span className="results-count">{filteredRows.length.toLocaleString()} rows</span>
            {filteredRows.length !== rows.length && (
              <span className="results-filtered-hint">(of {rows.length.toLocaleString()})</span>
            )}
            <span className="results-duration">{duration}ms</span>
          </div>
          <div className="results-header-center">
            <input
              type="text"
              className="results-filter"
              placeholder="Quick filter..."
              value={filterText}
              onChange={(e) => { setFilterText(e.target.value); setCurrentPage(0) }}
            />
            <button className={`results-btn-filter ${showFilterPanel ? 'active' : ''}`} onClick={() => setShowFilterPanel(!showFilterPanel)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M7 12h10M10 18h4"/></svg>
              Filters {advancedFilters.length > 0 && `(${advancedFilters.length})`}
            </button>
          </div>
          <div className="results-actions">
            {/* Refresh */}
            {onRefresh && (
              <button className="results-action-btn" onClick={onRefresh} title="Refresh query (F5 / Ctrl+R)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
                Refresh
              </button>
            )}

            {/* Column visibility */}
            <div style={{ position: 'relative' }}>
              <button
                className={`results-action-btn col-vis-btn ${hiddenColumns.size > 0 ? 'active-warn' : ''}`}
                onClick={e => { e.stopPropagation(); setShowColVisibility(v => !v) }}
                title="Show/hide columns"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>{hiddenColumns.size > 0 && <line x1="3" y1="3" x2="21" y2="21" stroke="var(--accent-red)" strokeWidth="2"/>}</svg>
                Columns {hiddenColumns.size > 0 && `(${hiddenColumns.size} hidden)`}
              </button>
              {showColVisibility && (
                <div className="col-visibility-dropdown" onClick={e => e.stopPropagation()}>
                  <div className="col-vis-header">
                    <span>Columns</span>
                    {hiddenColumns.size > 0 && (
                      <button className="col-vis-show-all" onClick={() => setHiddenColumns(new Set())}>Show all</button>
                    )}
                  </div>
                  {columns.map(col => (
                    <label key={col.name} className="col-vis-item">
                      <input
                        type="checkbox"
                        checked={!hiddenColumns.has(col.name)}
                        onChange={() => toggleColVisibility(col.name)}
                      />
                      <span>{col.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* JSON Sidebar */}
            <button
              className={`results-action-btn json-toggle ${showJsonSidebar ? 'active' : ''}`}
              onClick={() => setShowJsonSidebar(!showJsonSidebar)}
              title="Row Inspector (JSON sidebar)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h6M4 11h6M4 15h6M14 7h6M14 11h6M14 15h6"/></svg>
              Inspect
            </button>

            {/* Add Row */}
            {sourceTable && (
              <button className="results-action-btn add-row-btn" onClick={handleAddRow} title="Add a new row inline">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                Add Row
              </button>
            )}

            {/* Pending changes / inserts */}
            {(Object.keys(pendingChanges).length > 0 || newRows.length > 0) && (
              <>
                <button className="results-action-btn discard" onClick={handleDiscardChanges} title="Discard all staged edits and new rows">
                  Discard ({Object.keys(pendingChanges).length + newRows.length})
                </button>
                <button className="results-action-btn commit" onClick={handleCommitChanges} title="Commit to database (Ctrl+S)">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                  Save{Object.keys(pendingChanges).length > 0 ? ` ${Object.keys(pendingChanges).length} edit${Object.keys(pendingChanges).length !== 1 ? 's' : ''}` : ''}
                  {newRows.length > 0 ? ` + ${newRows.length} new` : ''}
                </button>
              </>
            )}

            {/* Multi-row selection actions */}
            {selectedRows.size > 0 && (
              <div className="results-selection-bar">
                <span className="selection-count">{selectedRows.size} row{selectedRows.size !== 1 ? 's' : ''}</span>
                {sourceTable && (
                  <button className="results-action-btn selection-delete" onClick={handleDeleteSelectedRows} title={`Delete ${selectedRows.size} selected rows`}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
                    Delete {selectedRows.size}
                  </button>
                )}
                <button className="results-action-btn" onClick={() => setSelectedRows(new Set())} title="Clear selection">✕</button>
              </div>
            )}

            {/* Export */}
            <div className="results-export-group">
              <button className="results-action-btn" onClick={() => onExport('csv')} title="Export as CSV">CSV</button>
              <button className="results-action-btn" onClick={() => onExport('json')} title="Export as JSON">JSON</button>
              <button className="results-action-btn" onClick={() => onExport('sql')} title="Export as SQL">SQL</button>
            </div>
          </div>
        </div>

        {showFilterPanel && (
          <div className="advanced-filter-panel">
            {advancedFilters.map(f => (
              <div key={f.id} className="filter-row">
                <input type="checkbox" checked={f.isActive} onChange={e => updateFilter(f.id, { isActive: e.target.checked })} />
                <select value={f.col} onChange={e => updateFilter(f.id, { col: e.target.value })}>
                  {visibleColumns.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
                <select value={f.op} onChange={e => updateFilter(f.id, { op: e.target.value })}>
                  {operators.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                {f.op !== 'null' && f.op !== 'not_null' && (
                  <input type="text" placeholder="Value..." value={f.val} onChange={e => updateFilter(f.id, { val: e.target.value })} />
                )}
                <button className="filter-remove-btn" onClick={() => removeFilter(f.id)}>✕</button>
              </div>
            ))}
            <div className="filter-panel-footer">
              <button className="filter-add-btn" onClick={addFilter}>+ Add Filter</button>
              {advancedFilters.length > 0 && <button className="filter-clear-btn" onClick={() => setAdvancedFilters([])}>Clear All</button>}
            </div>
          </div>
        )}

        {viewMode !== 'data' ? (
          <TableStructurePanel
            key={viewMode}
            connectionId={connectionId}
            tableName={sourceTable}
            initialTab={viewMode === 'index' ? 'indexes' : 'columns'}
          />
        ) : (
        <div className="results-table-wrapper" ref={tableRef}>
          <table className={`results-table density-${density}${showGridLines ? '' : ' no-grid-lines'}`}>
            <thead>
              <tr>
                <th className="row-num-header">#</th>
                {orderedVisibleColumns.map((col, i) => (
                  <th
                    key={col.name}
                    draggable
                    onDragStart={(e) => handleColDragStart(e, col.name)}
                    onDragOver={(e) => handleColDragOver(e, col.name)}
                    onDragLeave={() => setDragOverCol(null)}
                    onDrop={(e) => handleColDrop(e, col.name)}
                    onDragEnd={handleColDragEnd}
                    onClick={() => handleSort(col.name)}
                    className={`sortable-header${dragOverCol === col.name ? ' col-drag-over' : ''}`}
                    style={colWidths[col.name] ? { width: colWidths[col.name], minWidth: colWidths[col.name] } : {}}
                    title={`${col.name} — drag to reorder, click to sort, right-click to hide`}
                    onContextMenu={e => {
                      e.preventDefault()
                      toggleColVisibility(col.name)
                    }}
                  >
                    <span className="col-drag-grip" onMouseDown={e => e.stopPropagation()}>⠿</span>
                    <span className="col-name">{col.name}</span>
                    {col.dataType && col.dataType !== '__db_ctid' && (
                      <span className="col-type-tag">{col.dataType}</span>
                    )}
                    {sortCol === col.name && (
                      <span className="sort-indicator">{sortDir === 'asc' ? '▲' : '▼'}</span>
                    )}
                    <div className="col-resize-handle" draggable={false} onMouseDown={(e) => handleColResizeStart(e, col.name)} onClick={e => e.stopPropagation()} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((row, pageRi) => {
                const actualRi = currentPage * pageSize + pageRi
                const globalIdx = rows.indexOf(row)
                return (
                  <tr
                    key={actualRi}
                    className={selectedRows.has(globalIdx) ? 'row-selected' : ''}
                    onClick={(e) => handleCellClick(e, globalIdx)}
                  >
                    <td className={`row-num ${selectedRows.has(globalIdx) ? 'row-num-selected' : ''}`}>
                      {selectedRows.has(globalIdx) ? '✓' : globalIdx + 1}
                    </td>
                    {orderedVisibleColumns.map((col, ci) => {
                      const originalCi = columns.indexOf(col)
                      const isPending = pendingChanges[`${globalIdx}:${originalCi}`] !== undefined
                      const val = isPending ? pendingChanges[`${globalIdx}:${originalCi}`] : row[col.name]
                      const isNull = val === null || val === undefined
                      const isEditing = editingCell?.ri === globalIdx && editingCell?.ci === originalCi
                      const isCopied = copiedCell === `${globalIdx}:${originalCi}`
                      const isJsonObj = typeof val === 'object' && val !== null
                      const isBool = typeof val === 'boolean'
                      const isDate = !isNull && !isBool && parseAnyDate(val) !== null

                      return (
                        <td
                          key={ci}
                          className={`${isNull ? 'cell-null' : ''} ${isPending ? 'cell-staged' : ''} ${isCopied ? 'cell-copied' : ''} ${isJsonObj ? 'cell-json' : ''} ${isBool ? 'cell-bool' : ''} ${isDate ? 'cell-date' : ''}`}
                          title={isNull ? 'NULL' : formatCellValue(val)}
                          onDoubleClick={() => handleCellDoubleClick(globalIdx, originalCi, val)}
                          onContextMenu={(e) => handleCellContextMenu(e, globalIdx, row, originalCi, val)}
                          style={colWidths[col.name] ? { maxWidth: colWidths[col.name] } : {}}
                        >
                          {isEditing ? (
                            editingCell.useTextarea ? (
                              <textarea
                                ref={cellEditRef}
                                className="cell-edit-input cell-edit-textarea"
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') { e.stopPropagation(); setEditingCell(null) }
                                  if (e.key === 'Tab') { e.preventDefault(); handleEditSave() }
                                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSave() }
                                }}
                                onBlur={handleEditSave}
                                rows={Math.min(8, Math.max(2, editValue.split('\n').length))}
                              />
                            ) : (
                            <input
                              ref={cellEditRef}
                              className="cell-edit-input"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); handleEditSave() }
                                if (e.key === 'Escape') { e.stopPropagation(); setEditingCell(null) }
                                if (e.key === 'Tab') { e.preventDefault(); handleEditSave() }
                              }}
                              onBlur={handleEditSave}
                            />
                            )
                          ) : (
                            isNull ? <span className="null-badge">NULL</span> :
                            isJsonObj ? <span className="json-badge">{JSON.stringify(val).substring(0, 50)}…</span> :
                            formatCellValue(val)
                          )}
                          {isCopied && <span className="copied-badge">Copied!</span>}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
              {/* Pending INSERT rows */}
              {newRows.map((newRow) => (
                <tr key={newRow.id} className="row-new">
                  <td className="row-num row-num-new" title="Remove this row">
                    <button
                      className="new-row-remove-btn"
                      onClick={() => setNewRows(prev => prev.filter(r => r.id !== newRow.id))}
                    >✕</button>
                  </td>
                  {orderedVisibleColumns.map((col, ci) => {
                    const isEditingThis = editingNewCell?.rowId === newRow.id && editingNewCell?.colName === col.name
                    const val = newRow.values[col.name] ?? ''
                    return (
                      <td
                        key={ci}
                        className="cell-new"
                        onClick={() => setEditingNewCell({ rowId: newRow.id, colName: col.name })}
                      >
                        {isEditingThis ? (
                          <input
                            autoFocus
                            className="cell-edit-input"
                            value={val}
                            onChange={(e) => setNewRows(prev => prev.map(r =>
                              r.id === newRow.id ? { ...r, values: { ...r.values, [col.name]: e.target.value } } : r
                            ))}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={() => setEditingNewCell(null)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); setEditingNewCell(null) }
                              if (e.key === 'Escape') { e.stopPropagation(); setEditingNewCell(null) }
                            }}
                          />
                        ) : (
                          val === '' ? <span className="cell-new-placeholder">—</span> : val
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}

        <div className="results-footer">
          <div className="results-view-tabs">
            <button className={`results-view-tab ${viewMode === 'data' ? 'active' : ''}`} onClick={() => setViewMode('data')}>Data</button>
            <button className={`results-view-tab ${viewMode === 'structure' ? 'active' : ''}`} disabled={!sourceTable} title={!sourceTable ? 'Open a table to view its structure' : ''} onClick={() => setViewMode('structure')}>Structure</button>
            <button className={`results-view-tab ${viewMode === 'index' ? 'active' : ''}`} disabled={!sourceTable} title={!sourceTable ? 'Open a table to view its indexes' : ''} onClick={() => setViewMode('index')}>Index</button>
          </div>
          {viewMode === 'data' && (
            <div className="results-footer-right">
              <span className="results-footer-count">{filteredRows.length.toLocaleString()} row{filteredRows.length !== 1 ? 's' : ''}</span>
              {totalPages > 1 && (
                <div className="results-pagination">
                  <button className="pagination-btn" disabled={currentPage === 0} onClick={() => setCurrentPage(0)} title="First page">⟪</button>
                  <button className="pagination-btn" disabled={currentPage === 0} onClick={() => setCurrentPage(p => Math.max(0, p - 1))}>← Prev</button>
                  <span className="pagination-info">
                    Page {currentPage + 1} of {totalPages}
                    <span className="pagination-range">({(currentPage * pageSize + 1).toLocaleString()}–{Math.min((currentPage + 1) * pageSize, filteredRows.length).toLocaleString()})</span>
                  </span>
                  <button className="pagination-btn" disabled={currentPage >= totalPages - 1} onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}>Next →</button>
                  <button className="pagination-btn" disabled={currentPage >= totalPages - 1} onClick={() => setCurrentPage(totalPages - 1)} title="Last page">⟫</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showJsonSidebar && (
        <div className="json-sidebar">
          <div className="json-sidebar-header">
            <h3>Row Inspector</h3>
            <button className="json-sidebar-close" onClick={() => setShowJsonSidebar(false)}>✕</button>
          </div>
          {selectedRowData ? (
            <div className="json-sidebar-content">
              <div className="json-sidebar-actions">
                <button className="json-copy-btn" onClick={() => copyToClipboard(JSON.stringify(selectedRowData, null, 2))}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                  Copy JSON
                </button>
                <button className="json-copy-btn" onClick={handleCopyAllCSV}>Copy All CSV</button>
                <button className="json-copy-btn" onClick={handleCopyAllJSON}>Copy All JSON</button>
              </div>
              <div className="json-fields">
                {columns.map((col, ci) => {
                  const val = selectedRowData[col.name]
                  const isNull = val === null || val === undefined
                  const isObj = typeof val === 'object' && val !== null
                  return (
                    <div key={ci} className="json-field" onClick={() => { copyToClipboard(val); setCopiedCell(`json-${ci}`) }}>
                      <div className="json-field-key">{col.name}</div>
                      <div className={`json-field-value ${isNull ? 'json-null' : ''} ${isObj ? 'json-object' : ''}`}>
                        {isNull ? 'null' : isObj ? JSON.stringify(val, null, 2) : String(val)}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="json-sidebar-empty">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5"><path d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5"/></svg>
              <p>Click a row to inspect</p>
            </div>
          )}
        </div>
      )}

      {contextMenu && (
        <>
        <div
          className="ctx-backdrop"
          onMouseDown={() => { setContextMenu(null); setActiveSubmenu(null) }}
        />
        <div
          ref={menuRef}
          className="results-context-menu"
          style={{ top: menuPos.top, left: menuPos.left, visibility: menuPos.top === -9999 ? 'hidden' : 'visible' }}
        >
          <button onClick={() => { setShowJsonSidebar(true); setContextMenu(null); setActiveSubmenu(null) }}>
            <span>Quick Look Editor</span>
            <kbd>Ctrl Enter</kbd>
          </button>
          <button onClick={() => { onRefresh?.(); setContextMenu(null); setActiveSubmenu(null) }}>
            <span>Refresh</span>
            <kbd>Ctrl Alt R</kbd>
          </button>

          <div className="ctx-divider" />

          <button onClick={handlePaste}>
            <span>Paste</span>
            <kbd>Ctrl V</kbd>
          </button>

          <button onClick={() => {
            if (!sourceTable) { showToast('Open a direct table view to add rows.', 'error'); setContextMenu(null); setActiveSubmenu(null); return }
            const cols = columns.map(c => `"${c.name}"`).join(', ')
            const vals = columns.map(() => "''").join(', ')
            onSetQuery?.(`INSERT INTO ${sourceTable} (${cols})\nVALUES (${vals});`)
            setContextMenu(null); setActiveSubmenu(null)
          }}>
            <span>Add row</span>
            <kbd>Ctrl I</kbd>
          </button>

          <button onClick={() => {
            if (!sourceTable) { showToast('Open a direct table view to duplicate a row.', 'error'); setContextMenu(null); setActiveSubmenu(null); return }
            const row = contextMenu.row
            const cols = columns.map(c => `"${c.name}"`).join(', ')
            const vals = columns.map(col => {
              const v = row[col.name]
              if (v === null || v === undefined) return 'NULL'
              if (typeof v === 'number') return v
              return `'${String(v).replace(/'/g, "''")}'`
            }).join(', ')
            onSetQuery?.(`INSERT INTO ${sourceTable} (${cols})\nVALUES (${vals});`)
            setContextMenu(null); setActiveSubmenu(null)
          }}>
            <span>Duplicate</span>
            <kbd>Ctrl D</kbd>
          </button>

          <div className="ctx-divider" />

          <div
            className={`ctx-submenu-trigger ${activeSubmenu === 'setvalue' ? 'ctx-submenu-open' : ''}`}
            onMouseEnter={() => openSubmenu('setvalue')}
            onMouseLeave={closeSubmenu}
          >
            <span>Set Value</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            {activeSubmenu === 'setvalue' && (
              <div ref={submenuRef} className="ctx-submenu" style={submenuStyle} onMouseEnter={holdSubmenu} onMouseLeave={closeSubmenu}>
                <button onClick={() => { setPendingChanges(prev => ({ ...prev, [`${contextMenu.ri}:${contextMenu.ci}`]: '' })); setContextMenu(null); setActiveSubmenu(null) }}>Empty String</button>
                <button onClick={() => { setPendingChanges(prev => ({ ...prev, [`${contextMenu.ri}:${contextMenu.ci}`]: null })); setContextMenu(null); setActiveSubmenu(null) }}>NULL</button>
              </div>
            )}
          </div>

          <div className="ctx-divider" />

          <button onClick={() => {
            const multiRows = selectedRows.size > 1
              ? [...selectedRows].sort((a, b) => a - b).map(idx => rows[idx]).filter(Boolean)
              : [contextMenu.row]
            copyToClipboard(JSON.stringify(multiRows.length === 1 ? multiRows[0] : multiRows, null, 2))
            setContextMenu(null); setActiveSubmenu(null)
          }}>
            <span>Copy{selectedRows.size > 1 ? ` (${selectedRows.size} rows)` : ''}</span>
            <kbd>Ctrl C</kbd>
          </button>
          <button onClick={() => { copyToClipboard(contextMenu.val); setContextMenu(null); setActiveSubmenu(null) }}>Copy Cell Value</button>
          <button onClick={() => {
            const colName = columns[contextMenu.ci]?.name
            if (colName) copyToClipboard(rows.map(r => r[colName]).join('\n'))
            setContextMenu(null); setActiveSubmenu(null)
          }}>Copy All Column Values</button>

          <div
            className={`ctx-submenu-trigger ${activeSubmenu === 'copyas' ? 'ctx-submenu-open' : ''}`}
            onMouseEnter={() => openSubmenu('copyas')}
            onMouseLeave={closeSubmenu}
          >
            <span>Copy As</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            {activeSubmenu === 'copyas' && (
              <div ref={submenuRef} className="ctx-submenu" style={submenuStyle} onMouseEnter={holdSubmenu} onMouseLeave={closeSubmenu}>
                <button onClick={() => handleCopyAs('json')}>JSON</button>
                <div className="ctx-divider" />
                <button onClick={() => handleCopyAs('markdown')}>Markdown Table</button>
                <div className="ctx-divider" />
                <button onClick={() => handleCopyAs('tsv')}>TSV</button>
                <button onClick={() => handleCopyAs('tsv_header')}>TSV with Header</button>
                <div className="ctx-divider" />
                <button onClick={() => handleCopyAs('csv')}>CSV</button>
                <button onClick={() => handleCopyAs('csv_header')}>CSV with Header</button>
                <div className="ctx-divider" />
                <button onClick={() => handleCopyAs('insert')}>INSERT Statement</button>
              </div>
            )}
          </div>

          <div
            className={`ctx-submenu-trigger ${activeSubmenu === 'filter' ? 'ctx-submenu-open' : ''}`}
            onMouseEnter={() => openSubmenu('filter')}
            onMouseLeave={closeSubmenu}
          >
            <span>Quick Filter</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            {activeSubmenu === 'filter' && (
              <div ref={submenuRef} className="ctx-submenu" style={submenuStyle} onMouseEnter={holdSubmenu} onMouseLeave={closeSubmenu}>
                <button onClick={() => handleQuickFilter('equals')}>= Equals this value</button>
                <button onClick={() => handleQuickFilter('not_equals')}>≠ Not equals this value</button>
                <div className="ctx-divider" />
                <button onClick={() => handleQuickFilter('contains')}>Contains this value</button>
                <button onClick={() => handleQuickFilter('starts_with')}>Starts with this value</button>
                <button onClick={() => handleQuickFilter('ends_with')}>Ends with this value</button>
                <div className="ctx-divider" />
                <button onClick={() => handleQuickFilter('gt')}>&gt; Greater than</button>
                <button onClick={() => handleQuickFilter('lt')}>&lt; Less than</button>
                <div className="ctx-divider" />
                <button onClick={() => handleQuickFilter('null')}>Is NULL</button>
                <button onClick={() => handleQuickFilter('not_null')}>Is NOT NULL</button>
              </div>
            )}
          </div>

          <div
            className={`ctx-submenu-trigger ${activeSubmenu === 'import' ? 'ctx-submenu-open' : ''}`}
            onMouseEnter={() => openSubmenu('import')}
            onMouseLeave={closeSubmenu}
          >
            <span>Import</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            {activeSubmenu === 'import' && (
              <div ref={submenuRef} className="ctx-submenu" style={submenuStyle} onMouseEnter={holdSubmenu} onMouseLeave={closeSubmenu}>
                <button onClick={() => {
                  if (onImport) { onImport(); setContextMenu(null); setActiveSubmenu(null) }
                  else { showToast('Import handler not connected.', 'error'); setContextMenu(null); setActiveSubmenu(null) }
                }}>From CSV file...</button>
                <button onClick={handlePaste}>From Clipboard (Paste)</button>
              </div>
            )}
          </div>

          <button onClick={handleExportCurrentPage}>
            <span>Export current page...</span>
          </button>

          <div className="ctx-divider" />

          {selectedRows.size > 1 ? (
            <button className="ctx-danger" onClick={async () => {
              setContextMenu(null); setActiveSubmenu(null)
              await handleDeleteSelectedRows()
            }}>
              <span>Delete {selectedRows.size} selected rows</span>
              <kbd>Delete</kbd>
            </button>
          ) : (
            <button className="ctx-danger" onClick={async () => {
              setContextMenu(null); setActiveSubmenu(null)
              if (!sourceTable) { showToast('Open a direct table view to delete rows.', 'error'); return }
              const row = contextMenu.row
              if (!row) return
              const rowIdx = rows.indexOf(row)
              setSelectedRows(new Set([rowIdx >= 0 ? rowIdx : 0]))
              // Use the same FK-aware modal flow
              setPendingDelete({ rows: [row], fkImpact: [], isLoading: true })
              let fkImpact = []
              if (connectionId && window.dbAccess?.getFkImpact) {
                const res = await window.dbAccess.getFkImpact(connectionId, sourceTable, [row]).catch(() => ({ success: false }))
                if (res.success) fkImpact = res.data || []
              }
              setPendingDelete({ rows: [row], fkImpact, isLoading: false })
            }}>
              <span>Delete Row</span>
              <kbd>Delete</kbd>
            </button>
          )}
        </div>
        </>
      )}

      {/* Delete confirmation modal */}
      {pendingDelete && (
        <DeleteConfirmModal
          mode="delete"
          tableName={sourceTable}
          rows={pendingDelete.rows}
          fkImpact={pendingDelete.fkImpact}
          isLoading={pendingDelete.isLoading}
          onConfirm={handleConfirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {/* Toast notification */}
      {toastMsg && (
        <div className={`results-toast results-toast-${toastMsg.type}`}>
          {toastMsg.msg}
        </div>
      )}
    </div>
  )
}

export default React.memo(ResultsGrid)
