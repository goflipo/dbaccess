import React, { useState, useEffect } from 'react'
import './TableStructurePanel.css'

export default function TableStructurePanel({ connectionId, tableName, onClose }) {
  const [activeTab, setActiveTab] = useState('columns')
  const [structure, setStructure] = useState([])
  const [indexes, setIndexes] = useState([])
  const [foreignKeys, setForeignKeys] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!connectionId || !tableName) return
    setLoading(true)
    setError(null)

    const load = async () => {
      try {
        // Load column structure
        const structRes = await window.dbAccess.getTableStructure(connectionId, tableName)
        if (structRes.success) setStructure(structRes.data)
        else throw new Error(structRes.error)

        // Load indexes & foreign keys from schema
        const schemaRes = await window.dbAccess.getTableExtras(connectionId, tableName)
        if (schemaRes && schemaRes.success) {
          setIndexes(schemaRes.data.indexes || [])
          setForeignKeys(schemaRes.data.foreignKeys || [])
        }
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [connectionId, tableName])

  const getNullableLabel = (val) => {
    if (val === 'NO' || val === '0' || val === false) return <span className="tsp-badge tsp-badge-no">NOT NULL</span>
    return <span className="tsp-badge tsp-badge-yes">NULL</span>
  }

  const getTypeColor = (type) => {
    if (!type) return ''
    const t = String(type).toLowerCase()
    if (t.includes('int') || t.includes('serial') || t.includes('bigint')) return 'tsp-type-int'
    if (t.includes('char') || t.includes('text') || t.includes('string')) return 'tsp-type-str'
    if (t.includes('bool')) return 'tsp-type-bool'
    if (t.includes('timestamp') || t.includes('date') || t.includes('time')) return 'tsp-type-date'
    if (t.includes('float') || t.includes('double') || t.includes('numeric') || t.includes('decimal')) return 'tsp-type-float'
    if (t.includes('json')) return 'tsp-type-json'
    return ''
  }

  const tabs = [
    { id: 'columns', label: 'Columns', icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg> },
    { id: 'indexes', label: 'Indexes', icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h7"/></svg> },
    { id: 'foreignkeys', label: 'Foreign Keys', icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg> },
  ]

  return (
    <div className="tsp-panel">
      <div className="tsp-header">
        <div className="tsp-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>
          <span>{tableName}</span>
          <span className="tsp-subtitle">Structure</span>
        </div>
        {onClose && (
          <button className="tsp-close" onClick={onClose} title="Close structure panel">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        )}
      </div>

      <div className="tsp-tabs">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`tsp-tab ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.icon}
            {t.label}
            {t.id === 'columns' && structure.length > 0 && (
              <span className="tsp-count">{structure.length}</span>
            )}
            {t.id === 'indexes' && indexes.length > 0 && (
              <span className="tsp-count">{indexes.length}</span>
            )}
            {t.id === 'foreignkeys' && foreignKeys.length > 0 && (
              <span className="tsp-count">{foreignKeys.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="tsp-content">
        {loading && (
          <div className="tsp-center">
            <div className="tsp-spinner"></div>
            <span>Loading structure...</span>
          </div>
        )}
        {!loading && error && (
          <div className="tsp-center tsp-error">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
            <span>{error}</span>
          </div>
        )}
        {!loading && !error && activeTab === 'columns' && (
          <table className="tsp-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Column</th>
                <th>Type</th>
                <th>Nullable</th>
                <th>Default</th>
              </tr>
            </thead>
            <tbody>
              {structure.map((col, i) => {
                const name = col.column_name || col.name
                const type = col.data_type || col.type
                const nullable = col.is_nullable !== undefined ? col.is_nullable : (col.nullable ?? 'YES')
                const def = col.column_default ?? col.default_expression ?? '-'
                return (
                  <tr key={i}>
                    <td className="tsp-row-num">{i + 1}</td>
                    <td className="tsp-col-name">{name}</td>
                    <td className={`tsp-col-type ${getTypeColor(type)}`}>{type}</td>
                    <td>{getNullableLabel(nullable)}</td>
                    <td className="tsp-col-default">{def || '-'}</td>
                  </tr>
                )
              })}
              {structure.length === 0 && (
                <tr><td colSpan={5} className="tsp-empty-cell">No columns found</td></tr>
              )}
            </tbody>
          </table>
        )}
        {!loading && !error && activeTab === 'indexes' && (
          indexes.length > 0 ? (
            <table className="tsp-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Columns</th>
                  <th>Unique</th>
                  <th>Primary</th>
                </tr>
              </thead>
              <tbody>
                {indexes.map((idx, i) => (
                  <tr key={i}>
                    <td className="tsp-col-name">{idx.indexname || idx.name}</td>
                    <td className="tsp-col-type">{idx.indexdef || idx.columns || '-'}</td>
                    <td>{idx.is_unique ? <span className="tsp-badge tsp-badge-yes">YES</span> : <span className="tsp-badge tsp-badge-no">NO</span>}</td>
                    <td>{idx.is_primary ? <span className="tsp-badge tsp-badge-pk">PK</span> : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="tsp-center tsp-muted">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6h16M4 12h16M4 18h7"/></svg>
              <p>No indexes found</p>
              <p className="tsp-hint">Note: Index info requires direct table extras support</p>
            </div>
          )
        )}
        {!loading && !error && activeTab === 'foreignkeys' && (
          foreignKeys.length > 0 ? (
            <table className="tsp-table">
              <thead>
                <tr>
                  <th>Column</th>
                  <th>References</th>
                  <th>On Delete</th>
                </tr>
              </thead>
              <tbody>
                {foreignKeys.map((fk, i) => (
                  <tr key={i}>
                    <td className="tsp-col-name">{fk.column_name || fk.sourceColumn}</td>
                    <td className="tsp-col-type">{fk.foreign_table_name || fk.targetTable}.{fk.foreign_column_name || fk.targetColumn}</td>
                    <td>{fk.delete_rule || fk.on_delete || 'NO ACTION'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="tsp-center tsp-muted">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
              <p>No foreign keys defined</p>
            </div>
          )
        )}
      </div>
    </div>
  )
}
