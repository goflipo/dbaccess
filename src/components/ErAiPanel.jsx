import React, { useState, useRef, useEffect } from 'react'
import './ErAiPanel.css'

const SUGGEST_Q = 'Which relationships are probably missing? Look at columns like user_id / xxx_id that have no foreign key declared and suggest the foreign keys they should have.'

const QUICK = [
  { label: 'Suggest missing relations', question: SUGGEST_Q, infer: true },
  { label: 'Tables without any relation', question: 'Which tables have no foreign key relations at all (neither referencing nor referenced)?' },
  { label: 'Core tables', question: 'Which are the most central tables (referenced by the most other tables)? Briefly say what each is for.' },
]

const quote = (n) => n
const fkSql = (r) => {
  const col = String(r.sourceColumn).replace(/\W/g, '_')
  const tbl = String(r.sourceTable).split('.').pop().replace(/\W/g, '_')
  return `ALTER TABLE ${quote(r.sourceTable)} ADD CONSTRAINT fk_${tbl}_${col} FOREIGN KEY (${r.sourceColumn}) REFERENCES ${quote(r.targetTable)} (${r.targetColumn});`
}

export default function ErAiPanel({ connectionId, tables, foreignKeys, onHighlight, onShowRelations, onOpenSql, onClose }) {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const reqRef = useRef(null)
  const endRef = useRef(null)

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [messages, busy])
  useEffect(() => () => { if (reqRef.current) window.dbAccess?.ai?.cancelGenerate?.(reqRef.current) }, [])

  const tableIds = new Set(tables.map(t => t.fullName))
  const colsOf = {}
  tables.forEach(t => { colsOf[t.fullName] = new Set((t.columns || []).map(c => c.name)) })
  const declared = new Set((foreignKeys || []).map(f => `${f.sourceTable}.${f.sourceColumn}>${f.targetTable}.${f.targetColumn}`))

  const send = async (question) => {
    const q = (question || input).trim()
    if (!q || busy) return
    setInput('')
    setMessages(m => [...m, { role: 'user', text: q }])
    setBusy(true)
    const requestId = `er-${Date.now()}`
    reqRef.current = requestId
    try {
      const res = await window.dbAccess.ai.askEr({ question: q, tables, foreignKeys, requestId })
      if (res.cancelled) { setMessages(m => [...m, { role: 'note', text: 'Cancelled' }]); return }
      if (!res.success) { setMessages(m => [...m, { role: 'error', text: res.error || 'AI request failed' }]); return }
      // Trust nothing from the model: keep only tables/columns that exist and relations that are really new
      const hit = (res.tables || []).filter(t => tableIds.has(t))
      const rels = (res.relations || []).filter(r =>
        colsOf[r.sourceTable]?.has(r.sourceColumn) && colsOf[r.targetTable]?.has(r.targetColumn) &&
        !declared.has(`${r.sourceTable}.${r.sourceColumn}>${r.targetTable}.${r.targetColumn}`))
      setMessages(m => [...m, { role: 'assistant', text: res.answer, tables: hit, relations: rels, truncated: res.truncated }])
      if (hit.length > 0) onHighlight(hit)
      if (rels.length > 0) onShowRelations(rels)
    } catch (err) {
      setMessages(m => [...m, { role: 'error', text: err.message }])
    } finally {
      setBusy(false)
      reqRef.current = null
    }
  }

  const stop = () => { if (reqRef.current) window.dbAccess.ai.cancelGenerate(reqRef.current) }
  const copy = async (key, text) => {
    try { await navigator.clipboard.writeText(text) } catch { /* ignore */ }
    setCopied(key)
    setTimeout(() => setCopied(c => (c === key ? '' : c)), 1500)
  }

  return (
    <div className="erai">
      <div className="erai-header">
        <span className="erai-title">Ask AI about this diagram</span>
        <button className="erai-x" onClick={onClose} title="Close">×</button>
      </div>

      <div className="erai-messages">
        {messages.length === 0 && (
          <div className="erai-empty">
            Ask about the schema, e.g. <em>"orders se kaun si tables judi hain?"</em> or <em>"user delete karun to kya cascade hoga?"</em>.
            Matching tables get highlighted on the diagram.
            <div className="erai-quick">
              {QUICK.map(q => (
                <button key={q.label} disabled={busy} onClick={() => send(q.question)}>{q.label}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`erai-msg erai-${m.role}`}>
            {m.role === 'assistant' ? (
              <>
                <div className="erai-text">{m.text || '(no answer)'}</div>
                {m.tables.length > 0 && (
                  <div className="erai-tables">
                    <button onClick={() => onHighlight(m.tables)}>Highlight {m.tables.length} table{m.tables.length > 1 ? 's' : ''}</button>
                    <button onClick={() => onHighlight([])}>Clear</button>
                  </div>
                )}
                {m.relations.length > 0 && (
                  <div className="erai-rels">
                    <div className="erai-rels-title">Suggested relations ({m.relations.length})</div>
                    {m.relations.map((r, j) => (
                      <div key={j} className="erai-rel">
                        <code>{r.sourceTable.split('.').pop()}.{r.sourceColumn} → {r.targetTable.split('.').pop()}.{r.targetColumn}</code>
                        {r.reason && <span>{r.reason}</span>}
                      </div>
                    ))}
                    <div className="erai-tables">
                      <button onClick={() => onShowRelations(m.relations)}>Show on diagram</button>
                      <button onClick={() => copy(`sql-${i}`, m.relations.map(fkSql).join('\n'))}>{copied === `sql-${i}` ? 'Copied!' : 'Copy SQL'}</button>
                      {onOpenSql && <button onClick={() => onOpenSql(m.relations.map(fkSql).join('\n'))}>Open in tab</button>}
                    </div>
                  </div>
                )}
                {m.truncated && <div className="erai-warn">Schema was too large and got cut for the AI — answers may miss some tables.</div>}
              </>
            ) : (
              <div className="erai-text">{m.text}</div>
            )}
          </div>
        ))}
        {busy && <div className="erai-msg erai-assistant erai-typing">Thinking…</div>}
        <div ref={endRef} />
      </div>

      <div className="erai-input-row">
        <textarea
          className="erai-input" rows={2} value={input} placeholder="Ask about tables, relations…"
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          disabled={busy}
        />
        {busy
          ? <button className="erai-send erai-stop" onClick={stop}>Stop</button>
          : <button className="erai-send" onClick={() => send()} disabled={!input.trim()}>Send</button>}
      </div>
    </div>
  )
}
