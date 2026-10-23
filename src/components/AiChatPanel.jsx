import React, { useState, useEffect, useRef } from 'react'
import './AiChatPanel.css'

const STORAGE_KEY = 'dbaccess:aiChat'
const ALL_DBS_KEY = 'dbaccess:aiChatAllDbs'
const MAX_MESSAGES = 60
const HISTORY_PAIRS = 3
const PREVIEW_ROWS = 50
const COMPARE_SHOWN = 200

const loadMessages = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY))
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

const loadAllDbs = () => {
  try { return localStorage.getItem(ALL_DBS_KEY) !== 'false' } catch { return true }
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

const toSchemaMap = (tables) => {
  const map = {}
  for (const t of tables || []) {
    const cols = (t.columns || []).map(c => c.name)
    map[t.name] = cols
    if (t.fullName && t.fullName !== t.name) map[t.fullName] = cols
  }
  return map
}

const connLabel = (c) => `${c.name || c.host}${c.database ? ` [${c.database}]` : ''}`

// Match the "-- db: <label>" the model wrote to a connection (exact label first, then looser)
const resolveConn = (dbText, connections) => {
  if (!dbText) return null
  const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim()
  const t = norm(dbText)
  return connections.find(c => norm(connLabel(c)) === t)
    || connections.find(c => c.database && t.includes(norm(c.database)))
    || connections.find(c => c.name && t.includes(norm(c.name)))
    || null
}

const isReadOnlySql = (sql) => /^\s*(select|with)\b/i.test(sql.replace(/^(\s*--[^\n]*\n)+/g, ''))

const queriesOf = (m) => (m.queries?.length ? m.queries : [{ db: null, sql: m.sql }])

// Last few exchanges, so follow-ups like "now only for last week" make sense
const buildHistory = (messages) => {
  const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-HISTORY_PAIRS * 2)
  return turns.map(m => (m.role === 'user' ? `User: ${m.text}` : `Assistant SQL: ${queriesOf(m).map(q => q.sql).join('\n')}`)).join('\n')
}

export default function AiChatPanel({ open, onClose, connections = [], activeConnectionId, onInsertSql, onRunSql, onNewTab }) {
  const [messages, setMessages] = useState(loadMessages)
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [copiedId, setCopiedId] = useState(null)
  const [allDbs, setAllDbs] = useState(loadAllDbs)
  const [runs, setRuns] = useState({}) // { "<msgId>:<index>" | "<msgId>:cmp": result } — kept in memory only
  const requestIdRef = useRef(null)
  const schemaCacheRef = useRef({})
  const bottomRef = useRef(null)
  const inputRef = useRef(null)

  const activeConn = connections.find(c => c.id === activeConnectionId) || null
  const multiMode = allDbs && connections.length > 1

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES).map(({ logs, ...rest }) => rest)))
    } catch { /* storage unavailable */ }
  }, [messages])

  useEffect(() => {
    try { localStorage.setItem(ALL_DBS_KEY, String(allDbs)) } catch { /* storage unavailable */ }
  }, [allDbs])

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading, runs, open])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const push = (msg) => setMessages(prev => [...prev, { id: newId(), ...msg }])

  const getSchema = async (connId) => {
    const cached = schemaCacheRef.current[connId]
    if (cached && Object.keys(cached).length > 0) return cached
    const res = await window.dbAccess.getSchemaFull(connId).catch(() => null)
    const map = res?.success ? toSchemaMap(res.data?.tables) : {}
    schemaCacheRef.current[connId] = map
    return map
  }

  const send = async () => {
    const text = input.trim()
    if (!text || loading) return
    if (!activeConn) {
      push({ role: 'error', text: 'Open a connection first — the assistant needs a database to read the schema from.' })
      return
    }
    const history = buildHistory(messages)
    const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`
    requestIdRef.current = requestId
    push({ role: 'user', text })
    setInput('')
    setLoading(true)
    try {
      const prompt = history ? `Earlier in this chat:\n${history}\n\nNew request (it may refer to the above): ${text}` : text
      const params = { prompt, requestId }
      if (multiMode) {
        const databases = await Promise.all(connections.map(async c => ({
          label: connLabel(c), dialect: c.type || 'sql', schema: await getSchema(c.id),
        })))
        params.databases = databases
        params.defaultDatabase = connLabel(activeConn)
        params.dialect = activeConn.type || 'sql'
        params.schema = {}
      } else {
        params.schema = await getSchema(activeConn.id)
        params.dialect = activeConn.type || 'sql'
      }
      const result = await window.dbAccess.ai.generateSql(params)
      if (result.success) {
        push({
          role: 'assistant', sql: result.sql, queries: result.queries, compare: result.compare,
          explanation: result.explanation, logs: result.logs,
        })
      } else if (!result.cancelled) {
        push({ role: 'error', text: result.error || 'Failed to generate SQL', logs: result.logs })
      }
    } catch (err) {
      push({ role: 'error', text: err.message || 'Failed to generate SQL' })
    } finally {
      setLoading(false)
      requestIdRef.current = null
    }
  }

  const stop = () => {
    if (requestIdRef.current) window.dbAccess.ai.cancelGenerate(requestIdRef.current)
    setLoading(false)
    push({ role: 'note', text: 'Stopped' })
  }

  const copy = (id, text) => {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const clearChat = () => {
    if (loading) stop()
    setMessages([])
    setRuns({})
  }

  // Insert: same connection as the active tab -> editor; another connection -> new tab on that connection
  const insertQuery = (q) => {
    const conn = resolveConn(q.db, connections)
    if (conn && conn.id !== activeConnectionId) onNewTab?.(conn.id, q.sql, connLabel(conn))
    else onInsertSql?.(q.sql)
  }

  // Run: active connection -> normal results grid; another connection -> preview inside the chat
  const runQuery = async (msgId, idx, q) => {
    const conn = resolveConn(q.db, connections)
    if (!conn || conn.id === activeConnectionId) { onRunSql?.(q.sql); return }
    const key = `${msgId}:${idx}`
    setRuns(prev => ({ ...prev, [key]: { loading: true } }))
    const res = await window.dbAccess.executeQuery(conn.id, q.sql).catch(err => ({ success: false, error: err.message }))
    setRuns(prev => ({
      ...prev,
      [key]: res.success
        ? { columns: (res.data.columns || []).map(c => c.name), rows: res.data.rows || [], rowCount: res.data.rowCount }
        : { error: res.error },
    }))
  }

  // Compare: run both queries read-only, then diff the first column in the app
  const runCompare = async (m) => {
    const key = `${m.id}:cmp`
    const qs = queriesOf(m)
    const left = qs[m.compare.left - 1]
    const right = qs[m.compare.right - 1]
    const fail = (error) => setRuns(prev => ({ ...prev, [key]: { error } }))
    if (!left || !right) return fail('The AI referred to a query that does not exist.')
    const lc = resolveConn(left.db, connections) || activeConn
    const rc = resolveConn(right.db, connections) || activeConn
    if (!lc || !rc) return fail('Could not tell which connection each query belongs to.')
    if (!isReadOnlySql(left.sql) || !isReadOnlySql(right.sql)) return fail('Compare only runs SELECT queries.')
    setRuns(prev => ({ ...prev, [key]: { loading: true } }))
    const [a, b] = await Promise.all([
      window.dbAccess.executeQuery(lc.id, left.sql).catch(err => ({ success: false, error: err.message })),
      window.dbAccess.executeQuery(rc.id, right.sql).catch(err => ({ success: false, error: err.message })),
    ])
    if (!a.success) return fail(`${connLabel(lc)}: ${a.error}`)
    if (!b.success) return fail(`${connLabel(rc)}: ${b.error}`)
    const firstCol = (r) => (r.data.columns?.[0]?.name)
    const valuesOf = (r) => {
      const col = firstCol(r)
      return col ? r.data.rows.map(row => row[col]).filter(v => v !== null && v !== undefined).map(String) : []
    }
    const lv = [...new Set(valuesOf(a))]
    const rv = new Set(valuesOf(b))
    const out = lv.filter(v => (m.compare.op === 'NOT IN' ? !rv.has(v) : rv.has(v)))
    setRuns(prev => ({
      ...prev,
      [key]: {
        values: out, leftTotal: lv.length, rightTotal: rv.size,
        leftName: connLabel(lc), rightName: connLabel(rc), op: m.compare.op, column: firstCol(a),
      },
    }))
  }

  const renderRun = (run) => {
    if (!run) return null
    if (run.loading) return <div className="aichat-run-note">Running…</div>
    if (run.error) return <div className="aichat-run-error">{run.error}</div>
    return (
      <div className="aichat-run">
        <div className="aichat-run-note">{run.rows.length} row{run.rows.length !== 1 ? 's' : ''}{run.rows.length > PREVIEW_ROWS ? ` (showing first ${PREVIEW_ROWS})` : ''}</div>
        {run.columns.length > 0 && (
          <div className="aichat-run-scroll">
            <table>
              <thead><tr>{run.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {run.rows.slice(0, PREVIEW_ROWS).map((row, i) => (
                  <tr key={i}>{run.columns.map(c => <td key={c}>{row[c] === null || row[c] === undefined ? 'NULL' : String(row[c])}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  const renderCompare = (m, run) => {
    if (!run) return null
    if (run.loading) return <div className="aichat-run-note">Running both queries…</div>
    if (run.error) return <div className="aichat-run-error">{run.error}</div>
    const verb = run.op === 'NOT IN' ? `in ${run.leftName} but not in ${run.rightName}` : `in both ${run.leftName} and ${run.rightName}`
    return (
      <div className="aichat-run">
        <div className="aichat-run-note">
          <strong>{run.values.length}</strong> value{run.values.length !== 1 ? 's' : ''} {verb}
          {' '}({run.leftTotal} distinct in {run.leftName}, {run.rightTotal} in {run.rightName})
        </div>
        {run.values.length > 0 && (
          <>
            <div className="aichat-run-scroll">
              <table>
                <thead><tr><th>{run.column}</th></tr></thead>
                <tbody>{run.values.slice(0, COMPARE_SHOWN).map(v => <tr key={v}><td>{v}</td></tr>)}</tbody>
              </table>
            </div>
            {run.values.length > COMPARE_SHOWN && <div className="aichat-run-note">Showing first {COMPARE_SHOWN}; Copy gets all {run.values.length}.</div>}
            <div className="aichat-actions">
              <button onClick={() => copy(`${m.id}:cmpcopy`, run.values.join('\n'))}>{copiedId === `${m.id}:cmpcopy` ? 'Copied' : 'Copy all'}</button>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <aside className={`aichat ${open ? '' : 'aichat-hidden'}`}>
      <div className="aichat-header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="aichat-header-icon">
          <path d="M12 3l1.9 4.8L19 9.5l-4.8 1.7L12 16l-1.9-4.8L5 9.5l4.8-1.7L12 3z"/>
        </svg>
        <div className="aichat-title">
          <span>Ask AI</span>
          <span className="aichat-sub">
            {multiMode ? `All ${connections.length} connected databases` : (activeConn ? connLabel(activeConn) : '')}
          </span>
        </div>
        <button className="aichat-icon-btn" onClick={clearChat} disabled={messages.length === 0} title="Clear chat">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
        <button className="aichat-icon-btn" onClick={onClose} title="Close">✕</button>
      </div>

      {connections.length > 0 && (
        <div className="aichat-dbs">
          <div className="aichat-dbs-chips">
            {connections.map(c => {
              const isDefault = c.id === activeConnectionId
              const inScope = isDefault || multiMode
              return (
                <span
                  key={c.id}
                  className={`aichat-chip ${isDefault ? 'aichat-chip-default' : ''} ${inScope ? '' : 'aichat-chip-off'}`}
                  title={isDefault ? 'Default database — used when your question names no database' : (inScope ? 'Available to the AI' : 'Not sent to the AI (turn on "Use all connected databases")')}
                >
                  {isDefault && <span className="aichat-chip-dot" />}
                  {connLabel(c)}
                  {isDefault && <span className="aichat-chip-badge">default</span>}
                </span>
              )
            })}
          </div>
          {connections.length > 1 && (
            <label className="aichat-scope" title="Send the schema of every connected database, so questions can span them. Turn off for faster answers about the default database only.">
              <input type="checkbox" checked={allDbs} onChange={e => setAllDbs(e.target.checked)} />
              Use all connected databases
            </label>
          )}
        </div>
      )}

      <div className="aichat-messages">
        {messages.length === 0 && (
          <div className="aichat-empty">
            Describe the query you want in plain words, e.g.
            <em>“show all rows of main_account where type is pe”</em>
            With several databases connected you can also ask things like
            <em>“ips in goflipo_db that are not in operator_db”</em>
          </div>
        )}
        {messages.map(m => {
          if (m.role === 'user') return <div key={m.id} className="aichat-msg aichat-user">{m.text}</div>
          if (m.role === 'note') return <div key={m.id} className="aichat-note">{m.text}</div>
          if (m.role === 'error') {
            return (
              <div key={m.id} className="aichat-msg aichat-error">
                <div>{m.text}</div>
                {m.logs?.length > 0 && (
                  <details className="aichat-details">
                    <summary>Details ({m.logs.length})</summary>
                    {m.logs.map((l, i) => <div key={i} className="aichat-log">{l}</div>)}
                  </details>
                )}
              </div>
            )
          }
          const qs = queriesOf(m)
          const canCompare = m.compare && qs[m.compare.left - 1] && qs[m.compare.right - 1]
          return (
            <div key={m.id} className="aichat-msg aichat-assistant">
              {m.explanation && <div className="aichat-explain">{m.explanation}</div>}
              {qs.map((q, i) => {
                const conn = resolveConn(q.db, connections)
                return (
                  <div key={i} className="aichat-query">
                    {(q.db || qs.length > 1) && (
                      <div className={`aichat-db-tag ${conn && conn.id === activeConnectionId ? 'aichat-db-tag-default' : ''}`}>
                        {qs.length > 1 ? `${i + 1}. ` : ''}{conn ? connLabel(conn) : (q.db || 'database')}
                        {conn && conn.id === activeConnectionId ? ' · default' : ''}
                      </div>
                    )}
                    <pre className="aichat-sql">{q.sql}</pre>
                    <div className="aichat-actions">
                      <button onClick={() => insertQuery(q)}>{conn && conn.id !== activeConnectionId ? 'Open in tab' : 'Insert'}</button>
                      <button onClick={() => runQuery(m.id, i, q)}>Run</button>
                      <button onClick={() => copy(`${m.id}:${i}`, q.sql)}>{copiedId === `${m.id}:${i}` ? 'Copied' : 'Copy'}</button>
                    </div>
                    {renderRun(runs[`${m.id}:${i}`])}
                  </div>
                )
              })}
              {canCompare && (
                <div className="aichat-compare">
                  <button className="aichat-compare-btn" onClick={() => runCompare(m)}>
                    Compare: query {m.compare.left} {m.compare.op} query {m.compare.right}
                  </button>
                  {renderCompare(m, runs[`${m.id}:cmp`])}
                </div>
              )}
            </div>
          )
        })}
        {loading && <div className="aichat-msg aichat-assistant aichat-typing">Thinking…</div>}
        <div ref={bottomRef} />
      </div>

      <div className="aichat-input-row">
        <textarea
          ref={inputRef}
          className="aichat-input"
          rows={2}
          placeholder="Ask for a query… (Enter to send, Shift+Enter for new line)"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
            if (e.key === 'Escape') onClose()
          }}
        />
        {loading ? (
          <button className="aichat-send aichat-stop" onClick={stop}>Stop</button>
        ) : (
          <button className="aichat-send" onClick={send} disabled={!input.trim()}>Send</button>
        )}
      </div>
    </aside>
  )
}
