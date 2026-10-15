import React, { useState, useMemo } from 'react'
import './SideBySideCompare.css'

const TABLE_STATUS = {
  same:       { label: 'Same',        cls: 'same' },
  different:  { label: 'Differs',     cls: 'diff' },
  onlySource: { label: 'Source only', cls: 'src' },
  onlyTarget: { label: 'Target only', cls: 'tgt' },
}

// Align source/target columns by name: source order first, then target-only columns.
function alignColumns(srcCols, tgtCols) {
  const tgtMap = new Map(tgtCols.map(c => [c.name, c]))
  const srcNames = new Set(srcCols.map(c => c.name))
  const rows = srcCols.map(s => {
    const t = tgtMap.get(s.name)
    if (!t) return { name: s.name, src: s, tgt: null, status: 'src' }
    const same = s.type === t.type && s.nullable === t.nullable
    return { name: s.name, src: s, tgt: t, status: same ? 'same' : 'diff' }
  })
  for (const t of tgtCols) {
    if (!srcNames.has(t.name)) rows.push({ name: t.name, src: null, tgt: t, status: 'tgt' })
  }
  return rows
}

function ColCell({ col, status }) {
  if (!col) return <div className="sbs-cell sbs-cell-missing">— missing</div>
  return (
    <div className={`sbs-cell sbs-cell-${status}`}>
      <span className="sbs-col-name">{col.name}</span>
      <span className="sbs-col-type">{col.type}</span>
      {col.nullable === 'NO' && <span className="sbs-col-tag">NOT NULL</span>}
    </div>
  )
}

export default function SideBySideCompare({ schemaDiff, srcLabel, tgtLabel, selected: selectedProp, onSelectedChange }) {
  const tables = schemaDiff.all || []
  // Selection may be controlled by the parent (so it survives view-tab switches) or kept locally.
  const isControlled = selectedProp !== undefined
  const [inner, setInner] = useState(() => new Set(tables.map(t => t.name)))
  const selected = isControlled ? selectedProp : inner
  const setSelected = (updater) => {
    const next = typeof updater === 'function' ? updater(selected) : updater
    if (isControlled) onSelectedChange?.(next)
    else setInner(next)
  }
  const [expanded, setExpanded] = useState(new Set())
  const [filter, setFilter] = useState('')
  const [hideSame, setHideSame] = useState(false)

  const visible = useMemo(() => tables.filter(t =>
    (!hideSame || t.status !== 'same') &&
    (!filter || t.name.toLowerCase().includes(filter.toLowerCase()))
  ), [tables, hideSame, filter])

  const counts = tables.filter(t => selected.has(t.name))
    .reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc }, {})

  const toggle = (setter, key) => setter(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })
  const allVisibleSelected = visible.length > 0 && visible.every(t => selected.has(t.name))
  const toggleAllVisible = () => setSelected(prev => {
    const next = new Set(prev)
    visible.forEach(t => allVisibleSelected ? next.delete(t.name) : next.add(t.name))
    return next
  })

  return (
    <div className="sbs">
      <div className="sbs-toolbar">
        <label className="sbs-check">
          <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
          Select all
        </label>
        <input className="sbs-filter" placeholder="Filter tables…" value={filter} onChange={e => setFilter(e.target.value)} />
        <label className="sbs-check">
          <input type="checkbox" checked={hideSame} onChange={e => setHideSame(e.target.checked)} />
          Hide identical
        </label>
        <button className="sbs-link" onClick={() => setExpanded(new Set(visible.map(t => t.name)))}>Expand all</button>
        <button className="sbs-link" onClick={() => setExpanded(new Set())}>Collapse all</button>
        <div className="sbs-legend">
          <span className="sbs-dot sbs-dot-same" />Same ({counts.same || 0})
          <span className="sbs-dot sbs-dot-src" />Only in source ({counts.onlySource || 0})
          <span className="sbs-dot sbs-dot-tgt" />Only in target ({counts.onlyTarget || 0})
          <span className="sbs-dot sbs-dot-diff" />Differs ({counts.different || 0})
        </div>
      </div>

      <div className="sbs-head">
        <div className="sbs-head-cell">Source — {srcLabel}</div>
        <div className="sbs-head-cell">Target — {tgtLabel}</div>
      </div>

      <div className="sbs-body">
        {visible.length === 0 && <div className="sbs-empty">No tables to show.</div>}
        {visible.map(t => {
          const st = TABLE_STATUS[t.status]
          const open = expanded.has(t.name)
          const rows = open ? alignColumns(t.srcColumns, t.tgtColumns) : []
          return (
            <div key={t.name} className={`sbs-table sbs-table-${st.cls} ${selected.has(t.name) ? '' : 'sbs-table-off'}`}>
              <div className="sbs-table-head">
                <input type="checkbox" checked={selected.has(t.name)} onChange={() => toggle(setSelected, t.name)} />
                <div className="sbs-table-main" onClick={() => toggle(setExpanded, t.name)}>
                  <svg className={`sbs-chevron ${open ? 'open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6"/></svg>
                  <div className={`sbs-table-side ${t.status === 'onlyTarget' ? 'sbs-table-side-missing' : ''}`}>
                    {t.status === 'onlyTarget' ? '— missing' : <>{t.name}<span className="sbs-meta">{t.srcColumns.length} cols</span></>}
                  </div>
                  <div className={`sbs-table-side ${t.status === 'onlySource' ? 'sbs-table-side-missing' : ''}`}>
                    {t.status === 'onlySource' ? '— missing' : <>{t.name}<span className="sbs-meta">{t.tgtColumns.length} cols</span></>}
                  </div>
                  <span className={`sbs-pill sbs-pill-${st.cls}`}>{st.label}</span>
                </div>
              </div>
              {open && (
                <div className="sbs-cols">
                  {rows.map(r => (
                    <div key={r.name} className="sbs-col-row">
                      <ColCell col={r.src} status={r.status} />
                      <ColCell col={r.tgt} status={r.status} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="sbs-footer">{selected.size} of {tables.length} tables selected</div>
    </div>
  )
}
