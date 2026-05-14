import React, { useState } from 'react'
import './CreateTableModal.css'

const PG_TYPES = ['SERIAL', 'INTEGER', 'BIGINT', 'VARCHAR(255)', 'TEXT', 'TIMESTAMP', 'BOOLEAN', 'JSONB', 'NUMERIC']
const CH_TYPES = ['UInt64', 'UInt32', 'Int64', 'Int32', 'String', 'DateTime', 'Date', 'Float64', 'Boolean']

export default function CreateTableModal({ connection, onCreate, onClose }) {
  if (!connection) return null
  const isPostgres = connection.type === 'postgres'
  const defaultTypes = isPostgres ? PG_TYPES : CH_TYPES

  const [tableName, setTableName] = useState('')
  const [schema, setSchema] = useState(isPostgres ? 'public' : 'default')
  const [columns, setColumns] = useState([
    { name: 'id', type: defaultTypes[0], isPk: true, isNotNull: true, defaultValue: '' }
  ])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const addColumn = () => {
    setColumns([...columns, { name: '', type: defaultTypes[1] || defaultTypes[0], isPk: false, isNotNull: false, defaultValue: '' }])
  }

  const removeColumn = (index) => {
    if (columns.length > 1) {
      setColumns(columns.filter((_, i) => i !== index))
    }
  }

  const updateColumn = (index, field, value) => {
    const next = [...columns]
    next[index] = { ...next[index], [field]: value }
    setColumns(next)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!tableName.trim()) return setError('Table name is required')
    if (columns.some(c => !c.name.trim())) return setError('All columns must have names')

    setLoading(true)
    setError(null)
    
    try {
      let sql = ''
      if (isPostgres) {
        const colDefs = columns.map(c => {
          let def = `${c.name} ${c.type}`
          if (c.isPk) def += ' PRIMARY KEY'
          if (c.isNotNull && !c.isPk) def += ' NOT NULL'
          if (c.defaultValue) def += ` DEFAULT ${c.defaultValue}`
          return `  ${def}`
        }).join(',\n')
        sql = `CREATE TABLE ${schema}.${tableName} (\n${colDefs}\n);`
      } else {
        const colDefs = columns.map(c => {
          let def = `${c.name} ${c.type}`
          if (c.isNotNull) def += '' // CH types are non-nullable by default unless wrapped in Nullable()
          if (c.defaultValue) def += ` DEFAULT ${c.defaultValue}`
          return `  ${def}`
        }).join(',\n')
        const pkCols = columns.filter(c => c.isPk).map(c => c.name).join(', ')
        sql = `CREATE TABLE ${schema}.${tableName} (\n${colDefs}\n) ENGINE = MergeTree()\nORDER BY (${pkCols || 'tuple()'});`
      }

      await onCreate(sql)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-content create-table-modal">
        <div className="modal-header">
          <h2>Create New Table</h2>
          <button className="close-btn" onClick={onClose}>&times;</button>
        </div>
        
        <form onSubmit={handleSubmit}>
          {error && <div className="modal-error">{error}</div>}
          
          <div className="form-row main-settings">
            <div className="form-group">
              <label>Schema / Database</label>
              <input 
                type="text" 
                value={schema} 
                onChange={e => setSchema(e.target.value)}
                placeholder="public"
              />
            </div>
            <div className="form-group flex-grow">
              <label>Table Name</label>
              <input 
                type="text" 
                autoFocus
                value={tableName} 
                onChange={e => setTableName(e.target.value)}
                placeholder="users"
                required
              />
            </div>
          </div>

          <div className="columns-section">
            <div className="section-header">
              <h3>Columns</h3>
              <button type="button" className="btn-secondary btn-small" onClick={addColumn}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                Add Column
              </button>
            </div>

            <div className="columns-list">
              <div className="columns-header">
                <div className="col-name">Name</div>
                <div className="col-type">Type</div>
                <div className="col-check">PK</div>
                <div className="col-check">Not Null</div>
                <div className="col-default">Default</div>
                <div className="col-actions"></div>
              </div>
              
              {columns.map((col, idx) => (
                <div key={idx} className="column-row">
                  <div className="col-name">
                    <input 
                      type="text" 
                      value={col.name} 
                      onChange={e => updateColumn(idx, 'name', e.target.value)}
                      placeholder="column_name"
                    />
                  </div>
                  <div className="col-type">
                    <select 
                      value={col.type} 
                      onChange={e => updateColumn(idx, 'type', e.target.value)}
                    >
                      {defaultTypes.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="col-check">
                    <input 
                      type="checkbox" 
                      checked={col.isPk} 
                      onChange={e => updateColumn(idx, 'isPk', e.target.checked)}
                    />
                  </div>
                  <div className="col-check">
                    <input 
                      type="checkbox" 
                      checked={col.isNotNull} 
                      onChange={e => updateColumn(idx, 'isNotNull', e.target.checked)}
                    />
                  </div>
                  <div className="col-default">
                    <input 
                      type="text" 
                      value={col.defaultValue} 
                      onChange={e => updateColumn(idx, 'defaultValue', e.target.value)}
                      placeholder="NULL"
                    />
                  </div>
                  <div className="col-actions">
                    <button type="button" className="action-btn delete" onClick={() => removeColumn(idx)} disabled={columns.length === 1}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={loading}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? <div className="btn-spinner"></div> : 'Create Table'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
