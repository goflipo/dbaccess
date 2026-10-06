import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { StateEffect, StateField, Prec } from '@codemirror/state'
import { Decoration, EditorView, keymap } from '@codemirror/view'
import { acceptCompletion } from '@codemirror/autocomplete'
import {
  search, SearchQuery, setSearchQuery,
  findNext as cmFindNext, findPrevious as cmFindPrev,
  replaceNext as cmReplaceNext, replaceAll as cmReplaceAll,
} from '@codemirror/search'
import './QueryEditor.css'

// ---------------------------------------------------------------------------
// Error decoration — defined outside component so they're stable singletons
// ---------------------------------------------------------------------------
const setErrorEffect = StateEffect.define()

const errorHighlightField = StateField.define({
  create: () => Decoration.none,
  update(decos, tr) {
    decos = decos.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setErrorEffect)) return e.value
    }
    return decos
  },
  provide: f => EditorView.decorations.from(f),
})

const errorMark = Decoration.mark({ class: 'cm-error-highlight' })

const errorTheme = EditorView.baseTheme({
  '&.cm-editor .cm-error-highlight': {
    textDecoration: 'underline wavy #ef4444',
    backgroundColor: 'rgba(239,68,68,0.12)',
  },
})

// ---------------------------------------------------------------------------
// Error position parser
// ---------------------------------------------------------------------------
function parseErrorPosition(msg, doc) {
  if (!msg || !doc) return null

  // PostgreSQL: "at character N" (1-based)
  const charMatch = msg.match(/at character (\d+)/i)
  if (charMatch) {
    const from = Math.max(0, parseInt(charMatch[1]) - 1)
    const rest = doc.slice(from)
    const tokenEnd = rest.search(/[\s,;)([\n]/)
    const to = from + (tokenEnd > 0 ? tokenEnd : Math.min(25, rest.length || 1))
    if (from < doc.length) return { from, to: Math.min(to, doc.length) }
  }

  // PostgreSQL verbose: "LINE N:"
  const lineMatch = msg.match(/\bLINE (\d+):/i)
  if (lineMatch) {
    const lineIdx = parseInt(lineMatch[1]) - 1
    const lines = doc.split('\n')
    let offset = 0
    for (let i = 0; i < lineIdx && i < lines.length; i++) offset += lines[i].length + 1
    const lineLen = (lines[lineIdx] || '').trimEnd().length
    if (lineLen > 0) return { from: offset, to: offset + lineLen }
  }

  // MySQL: near '...'
  const nearMatch = msg.match(/near '([^']{1,60})'/i)
  if (nearMatch) {
    const near = nearMatch[1].trim()
    const idx = doc.toLowerCase().indexOf(near.toLowerCase())
    if (idx >= 0) return { from: idx, to: idx + near.length }
  }

  // Function name: "function xyz() does not exist"
  const fnMatch = msg.match(/function (\w+)\s*\(/i)
  if (fnMatch) {
    const name = fnMatch[1]
    const idx = doc.toLowerCase().indexOf(name.toLowerCase())
    if (idx >= 0) return { from: idx, to: idx + name.length }
  }

  // Relation/column name: relation "xyz" does not exist
  const nameMatch = msg.match(/(?:relation|column|table) "([^"]+)"/i)
  if (nameMatch) {
    const name = nameMatch[1]
    const idx = doc.toLowerCase().indexOf(name.toLowerCase())
    if (idx >= 0) return { from: idx, to: idx + name.length }
  }

  return null
}

// ---------------------------------------------------------------------------
// Error suggestion lookup table
// ---------------------------------------------------------------------------
const ERROR_SUGGESTIONS = [
  {
    pattern: /uuid_generate_v4\(\)\s+does not exist/i,
    hint: 'The uuid-ossp extension is not installed in this database.',
    fix: 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
  },
  {
    pattern: /gen_random_uuid\(\)\s+does not exist/i,
    hint: 'pgcrypto extension is needed for gen_random_uuid().',
    fix: 'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
  },
  {
    pattern: /function (.+?) does not exist/i,
    hint: m => `Function ${m[1]} is not available. It may be in an extension or have different argument types.`,
    fix: null,
  },
  {
    pattern: /invalid input syntax for type json/i,
    hint: 'JSON value is malformed — use double-quoted keys, no trailing commas, and only valid JSON values (true/false/null, not single-quoted strings).',
    fix: null,
  },
  {
    pattern: /invalid input syntax for type uuid/i,
    hint: 'Value is not a valid UUID. UUIDs must be in the format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.',
    fix: null,
  },
  {
    pattern: /relation "(.+)" does not exist/,
    hint: m => `Table "${m[1]}" not found. Check the schema prefix (e.g. public.${m[1]}) or verify the table exists.`,
    fix: `SELECT table_schema, table_name FROM information_schema.tables WHERE table_type='BASE TABLE' ORDER BY table_schema, table_name;`,
  },
  {
    pattern: /column "(.+)" of relation "(.+)" does not exist/,
    hint: m => `Column "${m[1]}" doesn't exist in table "${m[2]}". Check spelling.`,
    fix: null,
  },
  {
    pattern: /column "(.+)" does not exist/,
    hint: m => `Column "${m[1]}" not found. Check the column name spelling.`,
    fix: null,
  },
  {
    pattern: /syntax error at or near "(.+)"/i,
    hint: m => `Syntax error near "${m[1]}". Check for a missing comma, parenthesis, or incorrect keyword.`,
    fix: null,
  },
  {
    pattern: /permission denied for (?:table|relation) "(.+)"/i,
    hint: m => `No permission to access "${m[1]}". Ask your DBA to grant the required privilege.`,
    fix: null,
  },
  {
    pattern: /duplicate key value violates unique constraint "(.+)"/i,
    hint: 'A record with this key already exists. Use INSERT … ON CONFLICT DO NOTHING or ON CONFLICT DO UPDATE.',
    fix: null,
  },
  {
    pattern: /null value in column "(.+)"/i,
    hint: m => `Column "${m[1]}" is NOT NULL but received NULL. Provide a value for every required column.`,
    fix: null,
  },
  {
    pattern: /foreign key constraint/i,
    hint: 'Foreign key violation: the referenced row in the parent table does not exist.',
    fix: null,
  },
  {
    pattern: /deadlock detected/i,
    hint: 'Deadlock between concurrent transactions. Retry the query, or reorder operations to avoid circular waits.',
    fix: null,
  },
  {
    pattern: /too many connections/i,
    hint: 'Database connection limit reached. Close idle connections or increase max_connections in postgresql.conf.',
    fix: null,
  },
]

function findSuggestion(errorMsg) {
  if (!errorMsg) return null
  for (const s of ERROR_SUGGESTIONS) {
    const m = errorMsg.match(s.pattern)
    if (m) {
      return {
        hint: typeof s.hint === 'function' ? s.hint(m) : s.hint,
        fix: s.fix,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Count search matches and find which one is currently selected
// ---------------------------------------------------------------------------
function getMatchInfo(view, query) {
  if (!view || !query || !query.search) return { current: 0, total: 0 }
  const sel = view.state.selection.main
  let total = 0, current = 0
  try {
    const cursor = query.getCursor(view.state.doc)
    while (!cursor.next().done) {
      total++
      if (cursor.value.from === sel.from) current = total
    }
  } catch (_) {}
  return { current, total }
}

// ---------------------------------------------------------------------------
// Detect {{param}} placeholders in SQL
// ---------------------------------------------------------------------------
const extractParams = (query) => {
  const matches = [...query.matchAll(/\{\{(\w+)\}\}/g)]
  return [...new Set(matches.map(m => m[1]))]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
function QueryEditor({
  value, onChange, onRun, onExport, onImport, isRunning,
  activeConnectionId, onOpenFavorites, onSaveFavorite,
  onExplain, connectionName, queryError, onRunSqlFile,
  theme: appTheme = 'dark', fillHeight = false, dbType,
}) {
  const [editorHeight, setEditorHeight] = useState(220)
  const [showImportInput, setShowImportInput] = useState(false)
  const [importTable, setImportTable] = useState('')
  const [showFindReplace, setShowFindReplace] = useState(false)
  const [showAiPanel, setShowAiPanel] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiLogs, setAiLogs] = useState([])
  const [showAiLogs, setShowAiLogs] = useState(false)
  const aiRequestIdRef = useRef(null)
  const [errorCopied, setErrorCopied] = useState(false)
  const [aiErrorCopied, setAiErrorCopied] = useState(false)
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [showReplace, setShowReplace] = useState(false)
  const [matchInfo, setMatchInfo] = useState({ current: 0, total: 0 })
  const [params, setParams] = useState({})
  const [showParamsPanel, setShowParamsPanel] = useState(false)
  const [hasSelection, setHasSelection] = useState(false)
  const [errorDismissed, setErrorDismissed] = useState(false)
  const [sqlSchema, setSqlSchema] = useState({})
  const editorViewRef = useRef(null)
  const findInputRef = useRef(null)
  const selTimerRef = useRef(null)

  // Memoize param detection so it doesn't re-run on every render
  const detectedParams = useMemo(() => extractParams(value || ''), [value])
  const hasParams = detectedParams.length > 0

  // Disable expensive autocompletion for very large documents
  const isLargeDoc = value && value.length > 20000

  // Reset error dismiss state when a new error arrives
  useEffect(() => {
    setErrorDismissed(false)
  }, [queryError])

  // Apply / clear error decoration in CodeMirror
  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return

    if (!queryError || errorDismissed) {
      view.dispatch({ effects: setErrorEffect.of(Decoration.none) })
      return
    }

    const doc = view.state.doc.toString()
    const pos = parseErrorPosition(queryError.message, doc)
    if (pos && pos.from >= 0 && pos.to <= doc.length && pos.from < pos.to) {
      view.dispatch({ effects: setErrorEffect.of(Decoration.set([errorMark.range(pos.from, pos.to)])) })
    } else {
      view.dispatch({ effects: setErrorEffect.of(Decoration.none) })
    }
  }, [queryError, errorDismissed])

  const suggestion = queryError ? findSuggestion(queryError.message) : null

  // Load table/column names for the active connection so the SQL editor can
  // suggest them (CodeMirror's sql() extension takes a flat {name: [cols]} map).
  useEffect(() => {
    if (!activeConnectionId) { setSqlSchema({}); return }
    let cancelled = false
    window.dbAccess.getSchemaFull(activeConnectionId).then((result) => {
      if (cancelled || !result?.success) return
      const map = {}
      for (const t of result.data?.tables || []) {
        const cols = (t.columns || []).map(c => c.name)
        map[t.name] = cols
        if (t.fullName && t.fullName !== t.name) map[t.fullName] = cols
      }
      setSqlSchema(map)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [activeConnectionId])

  // Auto-show params panel when params detected
  useEffect(() => {
    if (hasParams) setShowParamsPanel(true)
    else setShowParamsPanel(false)
  }, [JSON.stringify(detectedParams)])

  // Sync search query into CodeMirror for live match highlighting + count
  useEffect(() => {
    const view = editorViewRef.current
    if (!view) return
    const query = new SearchQuery({
      search: showFindReplace ? findText : '',
      caseSensitive,
      regexp: useRegex,
      wholeWord,
      replace: replaceText,
    })
    try {
      view.dispatch({ effects: setSearchQuery.of(query) })
      setMatchInfo(showFindReplace && findText ? getMatchInfo(view, query) : { current: 0, total: 0 })
    } catch (_) {
      setMatchInfo({ current: 0, total: 0 })
    }
  }, [findText, caseSensitive, useRegex, wholeWord, replaceText, showFindReplace])

  useEffect(() => {
    if (showFindReplace && findInputRef.current) {
      setTimeout(() => findInputRef.current?.focus(), 0)
    }
  }, [showFindReplace])

  // Always read current content from the editor view, not from the (possibly debounced) prop
  const getCurrentContent = () => {
    if (editorViewRef.current) return editorViewRef.current.state.doc.toString()
    return value || ''
  }

  const handleRun = () => {
    let queryToRun
    if (editorViewRef.current) {
      const state = editorViewRef.current.state
      const sel = state.selection.main
      queryToRun = sel.from !== sel.to ? state.sliceDoc(sel.from, sel.to) : state.doc.toString()
    } else {
      queryToRun = value || ''
    }
    if (hasParams) {
      for (const [name, val] of Object.entries(params)) {
        queryToRun = queryToRun.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), val)
      }
    }
    if (!queryToRun.trim()) return
    onRun(queryToRun)
  }

  const handleExplain = () => {
    let queryToRun
    if (editorViewRef.current) {
      const state = editorViewRef.current.state
      const sel = state.selection.main
      queryToRun = sel.from !== sel.to ? state.sliceDoc(sel.from, sel.to) : state.doc.toString()
    } else {
      queryToRun = value || ''
    }
    if (queryToRun.trim() && onExplain) onExplain(queryToRun.trim())
  }

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault(); handleRun()
    } else if (e.key === 'F5') {
      e.preventDefault(); handleRun()
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'f') {
      e.preventDefault()
      setShowFindReplace(v => { if (!v) setTimeout(() => findInputRef.current?.focus(), 0); return !v })
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
      e.preventDefault()
      setShowFindReplace(true); setShowReplace(true)
      setTimeout(() => findInputRef.current?.focus(), 0)
    } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'f') {
      e.preventDefault(); formatSQL()
    } else if ((e.ctrlKey || e.metaKey) && e.key === '/') {
      e.preventDefault(); toggleComment()
    } else if (e.key === 'Escape' && showFindReplace) {
      setShowFindReplace(false)
    }
  }

  const formatSQL = () => {
    if (!editorViewRef.current) return
    try {
      let formatted = getCurrentContent().trim()
        .replace(/\s+/g, ' ')
        .replace(/\s*(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|CROSS|FULL|ON|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|AND|OR|SET|VALUES|INTO|UNION|EXCEPT|INTERSECT|RETURNING|WITH)\s*/gi, '\n$1 ')
        .split('\n').map(l => l.trim()).filter(l => l).join('\n')
      onChange(formatted)
    } catch (e) { console.error('Format error:', e) }
  }

  const minifySQL = () => {
    const minified = getCurrentContent().replace(/\s+/g, ' ').trim()
    onChange(minified)
  }

  const handleAiGenerate = async () => {
    if (!aiPrompt.trim() || aiLoading) return
    const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`
    aiRequestIdRef.current = requestId
    setAiLoading(true); setAiError(''); setAiLogs([])
    try {
      const result = await window.dbAccess.ai.generateSql({
        prompt: aiPrompt.trim(),
        schema: sqlSchema,
        dialect: dbType || 'sql',
        requestId,
      })
      setAiLogs(result.logs || [])
      if (result.success) {
        onChange(result.sql)
        setAiPrompt('')
        setShowAiPanel(false)
        onRun(result.sql)
      } else if (!result.cancelled) {
        setAiError(result.error || 'Failed to generate SQL')
        setShowAiLogs(true)
      }
    } catch (err) {
      setAiError(err.message || 'Failed to generate SQL')
      setShowAiLogs(true)
    } finally {
      setAiLoading(false)
      aiRequestIdRef.current = null
    }
  }

  const handleAiStop = () => {
    if (aiRequestIdRef.current) window.dbAccess.ai.cancelGenerate(aiRequestIdRef.current)
    setAiLoading(false)
    setAiError('Cancelled')
  }

  const copyErrorText = (text, setCopied) => {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const toggleComment = () => {
    if (!editorViewRef.current) return
    const state = editorViewRef.current.state
    const sel = state.selection.main
    const startLine = state.doc.lineAt(sel.from).number
    const endLine = state.doc.lineAt(sel.to).number
    let newValue = getCurrentContent().split('\n')
    let isCommented = newValue[startLine - 1]?.trim().startsWith('--')
    for (let i = startLine - 1; i < endLine; i++) {
      if (isCommented) newValue[i] = newValue[i]?.replace(/^\s*--\s?/, '') || ''
      else newValue[i] = '-- ' + (newValue[i] || '')
    }
    onChange(newValue.join('\n'))
  }

  const clearEditor = async () => {
    const ok = await window.dbAccess.confirm({ title: 'Clear Editor', message: 'Clear all SQL code?' })
    if (ok) onChange('')
  }

  const buildQuery = () => new SearchQuery({
    search: findText, caseSensitive, regexp: useRegex, wholeWord, replace: replaceText,
  })

  const handleFindNext = () => {
    const view = editorViewRef.current
    if (!view || !findText) return
    cmFindNext(view)
    setMatchInfo(getMatchInfo(view, buildQuery()))
  }

  const handleFindPrev = () => {
    const view = editorViewRef.current
    if (!view || !findText) return
    cmFindPrev(view)
    setMatchInfo(getMatchInfo(view, buildQuery()))
  }

  const handleReplaceNext = () => {
    const view = editorViewRef.current
    if (!view || !findText) return
    const q = buildQuery()
    view.dispatch({ effects: setSearchQuery.of(q) })
    cmReplaceNext(view)
    setMatchInfo(getMatchInfo(view, q))
  }

  const handleReplaceAll = () => {
    const view = editorViewRef.current
    if (!view || !findText) return
    const q = buildQuery()
    view.dispatch({ effects: setSearchQuery.of(q) })
    cmReplaceAll(view)
    setMatchInfo({ current: 0, total: 0 })
  }

  const handleImportSubmit = () => {
    if (importTable.trim()) {
      onImport(importTable.trim())
      setShowImportInput(false); setImportTable('')
    }
  }

  const startResize = (e) => {
    e.preventDefault()
    const startY = e.clientY; const startH = editorHeight
    const onMove = (e) => setEditorHeight(Math.max(80, Math.min(600, startH + e.clientY - startY)))
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // CodeMirror extensions — rebuilt only when the schema (table/column list) changes
  const cmExtensions = useMemo(() => [
    sql({ schema: sqlSchema, upperCaseKeywords: true }),
    errorHighlightField,
    errorTheme,
    search(),
    Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
  ], [sqlSchema])

  return (
    <div
      className="query-editor" data-tour="query-editor" onKeyDown={handleKeyDown}
      style={fillHeight ? { flex: 1, minHeight: 80 } : { height: editorHeight, minHeight: 80 }}
    >
      <div className="editor-toolbar" onMouseDown={e => {
        if (!e.target.matches('input, textarea, select')) e.preventDefault()
      }}>
        {/* Run */}
        <button
          className={`toolbar-btn run-btn ${isRunning ? 'running' : ''} ${hasSelection ? 'run-selection' : ''}`}
          onClick={handleRun}
          disabled={isRunning}
          title={hasSelection ? 'Run Selected Text (Ctrl+Enter)' : 'Run Query (Ctrl+Enter)'}
        >
          {isRunning ? (
            <><span className="btn-spinner"></span> Running...</>
          ) : hasSelection ? (
            <><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Run Selection</>
          ) : (
            <><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> Run</>
          )}
        </button>

        {/* Run File */}
        {onRunSqlFile && (
          <button className="toolbar-btn-sm run-file-btn" onClick={onRunSqlFile} disabled={isRunning} title="Execute a SQL file from disk (supports 200 MB+)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="9" y1="15" x2="15" y2="15"/>
            </svg>
            Run File
          </button>
        )}

        {/* Explain */}
        <button className="toolbar-btn-sm explain-btn" onClick={handleExplain} disabled={isRunning || !value?.trim()} title="Explain Query Plan">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
          </svg>
          Explain
        </button>

        {/* Ask AI */}
        <button
          className={`toolbar-btn-sm ai-ask-btn ${showAiPanel ? 'active' : ''}`}
          onClick={() => { setShowAiPanel(v => !v); setAiError('') }}
          title="Ask AI to write a query from a description"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 3l1.9 4.8L19 9.5l-4.8 1.7L12 16l-1.9-4.8L5 9.5l4.8-1.7L12 3z"/>
            <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z"/>
          </svg>
          Ask AI
        </button>

        <div className="toolbar-sep"></div>

        {/* Transaction */}
        <div className="toolbar-txn-group">
          <span className="toolbar-label">Txn:</span>
          <button className="toolbar-btn-sm txn-begin" onClick={() => onRun('BEGIN;')} disabled={isRunning} title="Begin Transaction">BEGIN</button>
          <button className="toolbar-btn-sm txn-commit" onClick={() => onRun('COMMIT;')} disabled={isRunning} title="Commit Transaction">COMMIT</button>
          <button className="toolbar-btn-sm txn-rollback" onClick={() => onRun('ROLLBACK;')} disabled={isRunning} title="Rollback Transaction">ROLLBACK</button>
        </div>

        <div className="toolbar-sep"></div>

        {/* Favorites */}
        <button className="toolbar-btn-sm fav-btn" onClick={onOpenFavorites} title="Query Favorites (saved queries)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          Favorites
        </button>
        {value?.trim() && onSaveFavorite && (
          <button className="toolbar-btn-sm" onClick={() => onSaveFavorite(value)} title="Save query as favorite">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--accent-yellow)" stroke="var(--accent-yellow)" strokeWidth="1">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            Save
          </button>
        )}

        <div className="toolbar-sep"></div>

        {/* Find/Format/Comment/Clear */}
        <button className="toolbar-btn-sm" onClick={() => { setShowFindReplace(v => !v); setTimeout(() => findInputRef.current?.focus(), 0) }} title="Find & Replace (Ctrl+F)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          Find
        </button>
        <button className="toolbar-btn-sm" onClick={formatSQL} title="Format SQL (Ctrl+Shift+F)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
          Format
        </button>
        <button className="toolbar-btn-sm" onClick={minifySQL} title="Minify SQL">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6l4-4 4 4M8 18l4 4 4-4M12 2v20"/></svg>
          Minify
        </button>
        <button className="toolbar-btn-sm" onClick={toggleComment} title="Toggle Comment (Ctrl+/)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          Comment
        </button>
        <button className="toolbar-btn-sm" onClick={clearEditor} title="Clear Editor">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6v12M16 6v12M5 6l1 14a2 2 0 002 2h8a2 2 0 002-2l1-14M10 11v6M14 11v6"/></svg>
          Clear
        </button>

        <div className="toolbar-sep"></div>

        {/* Export */}
        <div className="toolbar-export-group">
          <span className="toolbar-label">Export:</span>
          <button className="toolbar-btn-sm" onClick={() => onExport('csv')} title="Export as CSV">CSV</button>
          <button className="toolbar-btn-sm" onClick={() => onExport('json')} title="Export as JSON">JSON</button>
          <button className="toolbar-btn-sm" onClick={() => onExport('sql')} title="Export as SQL">SQL</button>
        </div>

        <div className="toolbar-sep"></div>

        {/* Import */}
        {showImportInput ? (
          <div className="toolbar-import-input">
            <input type="text" value={importTable} onChange={e => setImportTable(e.target.value)}
              placeholder="Table name..." autoFocus onKeyDown={e => e.key === 'Enter' && handleImportSubmit()} />
            <button className="toolbar-btn-sm import-go" onClick={handleImportSubmit}>Import</button>
            <button className="toolbar-btn-sm" onClick={() => setShowImportInput(false)}>✕</button>
          </div>
        ) : (
          <button className="toolbar-btn-sm" onClick={() => setShowImportInput(true)} title="Import CSV into table">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
            Import
          </button>
        )}

        {/* Params indicator */}
        {hasParams && (
          <>
            <div className="toolbar-sep"></div>
            <button
              className={`toolbar-btn-sm params-btn ${showParamsPanel ? 'active' : ''}`}
              onClick={() => setShowParamsPanel(v => !v)}
              title="Query Parameters"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M7 7H3a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2v-9a2 2 0 00-2-2h-4"/>
                <path d="M19 5v4M5 5v4M12 2v7"/>
              </svg>
              Params ({detectedParams.length})
            </button>
          </>
        )}
      </div>

      {/* AI Panel */}
      {showAiPanel && (
        <div className="ai-panel">
          <div className="ai-panel-row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ai-panel-icon">
              <path d="M12 3l1.9 4.8L19 9.5l-4.8 1.7L12 16l-1.9-4.8L5 9.5l4.8-1.7L12 3z"/>
            </svg>
            <input
              type="text"
              className="ai-panel-input"
              placeholder="Describe the query you want, e.g. 'top 10 customers by order total this month'"
              value={aiPrompt}
              onChange={e => setAiPrompt(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAiGenerate()
                if (e.key === 'Escape') { if (aiLoading && aiRequestIdRef.current) window.dbAccess.ai.cancelGenerate(aiRequestIdRef.current); setShowAiPanel(false) }
              }}
              autoFocus
              disabled={aiLoading}
            />
            {aiLoading ? (
              <button className="ai-panel-generate ai-panel-stop" onClick={handleAiStop} title="Stop generating">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>
                Stop
              </button>
            ) : (
              <button className="ai-panel-generate" onClick={handleAiGenerate} disabled={!aiPrompt.trim()}>
                Generate
              </button>
            )}
            <button className="ai-panel-close" onClick={() => { if (aiLoading && aiRequestIdRef.current) window.dbAccess.ai.cancelGenerate(aiRequestIdRef.current); setShowAiPanel(false) }}>✕</button>
          </div>
          {aiError && (
            <div className="ai-panel-error-row">
              <div className="ai-panel-error">{aiError}</div>
              <button
                className="ai-panel-error-copy"
                onClick={() => copyErrorText(aiError, setAiErrorCopied)}
                title="Copy error message"
              >
                {aiErrorCopied ? (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                )}
              </button>
            </div>
          )}
          {aiLogs.length > 0 && (
            <div className="ai-panel-logs-wrap">
              <button className="ai-panel-logs-toggle" onClick={() => setShowAiLogs(v => !v)}>
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" style={{ transform: showAiLogs ? 'rotate(90deg)' : 'none' }}><path d="M9 18l6-6-6-6"/></svg>
                {showAiLogs ? 'Hide' : 'Show'} details ({aiLogs.length})
              </button>
              {showAiLogs && (
                <div className="ai-panel-logs">
                  {aiLogs.map((line, i) => <div key={i} className="ai-panel-log-line">{line}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Query Parameters Panel */}
      {showParamsPanel && hasParams && (
        <div className="params-panel">
          <div className="params-panel-header">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/>
            </svg>
            <span>Query Parameters</span>
            <span className="params-hint">Use <code>{'{{param}}'}</code> in your SQL</span>
          </div>
          <div className="params-fields">
            {detectedParams.map(name => (
              <div key={name} className="param-field">
                <label className="param-label">
                  <span className="param-braces">{'{{'}</span>{name}<span className="param-braces">{'}}'}</span>
                </label>
                <input
                  type="text"
                  className="param-input"
                  placeholder={`Value for ${name}...`}
                  value={params[name] || ''}
                  onChange={e => setParams(p => ({ ...p, [name]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Find & Replace */}
      {showFindReplace && (
        <div className="find-replace-panel">
          <div className="fr-find-row">
            <button
              className={`fr-toggle-replace${showReplace ? ' open' : ''}`}
              onClick={() => setShowReplace(v => !v)}
              title={showReplace ? 'Collapse Replace' : 'Expand Replace'}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                {showReplace
                  ? <path d="M7 10l5 5 5-5z"/>
                  : <path d="M10 7l5 5-5 5z"/>}
              </svg>
            </button>
            <input
              ref={findInputRef}
              type="text"
              className={`fr-input${findText && matchInfo.total === 0 ? ' fr-no-match' : ''}`}
              value={findText}
              onChange={e => setFindText(e.target.value)}
              placeholder="Find"
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? handleFindPrev() : handleFindNext() }
                else if (e.key === 'Escape') setShowFindReplace(false)
              }}
            />
            <div className="fr-options">
              <button className={`fr-opt-btn${caseSensitive ? ' active' : ''}`} onClick={() => setCaseSensitive(v => !v)} title="Case Sensitive (Alt+C)">Aa</button>
              <button className={`fr-opt-btn${wholeWord ? ' active' : ''}`} onClick={() => setWholeWord(v => !v)} title="Whole Word (Alt+W)">ab</button>
              <button className={`fr-opt-btn${useRegex ? ' active' : ''}`} onClick={() => setUseRegex(v => !v)} title="Use Regular Expression (Alt+R)">.*</button>
            </div>
            <span className={`fr-count${findText && matchInfo.total === 0 ? ' fr-no-match' : ''}`}>
              {!findText ? '' : matchInfo.total === 0 ? 'No results' : `${matchInfo.current} of ${matchInfo.total}`}
            </span>
            <div className="fr-nav">
              <button className="fr-nav-btn" onClick={handleFindPrev} disabled={matchInfo.total === 0} title="Previous Match (Shift+Enter)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14l5-5 5 5z"/></svg>
              </button>
              <button className="fr-nav-btn" onClick={handleFindNext} disabled={matchInfo.total === 0} title="Next Match (Enter)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
              </button>
            </div>
            <button className="fr-close" onClick={() => setShowFindReplace(false)} title="Close (Escape)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
          {showReplace && (
            <div className="fr-replace-row">
              <span className="fr-replace-spacer"/>
              <input
                type="text"
                className="fr-input"
                value={replaceText}
                onChange={e => setReplaceText(e.target.value)}
                placeholder="Replace"
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); handleReplaceNext() }
                  else if (e.key === 'Escape') setShowFindReplace(false)
                }}
              />
              <button className="fr-replace-btn" onClick={handleReplaceNext} disabled={matchInfo.total === 0}>Replace</button>
              <button className="fr-replace-btn" onClick={handleReplaceAll} disabled={matchInfo.total === 0}>Replace All</button>
            </div>
          )}
        </div>
      )}

      {/* Error Suggestion Panel */}
      {queryError && !errorDismissed && (
        <div className="error-suggestion-panel">
          <div className="error-suggestion-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5">
              <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
            </svg>
            <span className="error-suggestion-msg">{queryError.message}</span>
            <button
              className="error-suggestion-dismiss"
              onClick={() => copyErrorText(queryError.message, setErrorCopied)}
              title="Copy error message"
            >
              {errorCopied ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              )}
            </button>
            <button className="error-suggestion-dismiss" onClick={() => setErrorDismissed(true)} title="Dismiss">✕</button>
          </div>
          {suggestion && (
            <div className="error-suggestion-body">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent-yellow)" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
              </svg>
              <span className="error-suggestion-hint">{suggestion.hint}</span>
              {suggestion.fix && (
                <div className="error-suggestion-fix">
                  <code className="error-suggestion-code">{suggestion.fix}</code>
                  <button
                    className="error-suggestion-copy"
                    onClick={() => navigator.clipboard.writeText(suggestion.fix)}
                    title="Copy to clipboard"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                    </svg>
                    Copy
                  </button>
                  <button
                    className="error-suggestion-run"
                    onClick={() => onRun(suggestion.fix)}
                    title="Run this fix"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                    Run Fix
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="editor-container">
        <CodeMirror
          value={value}
          height="100%"
          style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
          theme={appTheme === 'dark' ? oneDark : 'light'}
          extensions={cmExtensions}
          onChange={onChange}
          onCreateEditor={(view) => { editorViewRef.current = view }}
          onUpdate={(viewUpdate) => {
            if (!viewUpdate.selectionSet) return
            clearTimeout(selTimerRef.current)
            selTimerRef.current = setTimeout(() => {
              const sel = viewUpdate.state.selection.main
              setHasSelection(sel.from !== sel.to)
            }, 80)
          }}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: true,
            foldGutter: !isLargeDoc,
            dropCursor: true,
            allowMultipleSelections: true,
            bracketMatching: true,
            autocompletion: !isLargeDoc,
            highlightActiveLine: !isLargeDoc,
            searchKeymap: false,
          }}
        />
      </div>
      {!fillHeight && <div className="editor-resize" onMouseDown={startResize}>
        <div className="editor-resize-handle"></div>
      </div>}
    </div>
  )
}

export default React.memo(QueryEditor)
