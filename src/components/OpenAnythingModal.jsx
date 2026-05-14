import React, { useState, useEffect, useRef } from 'react'
import './OpenAnythingModal.css'

export default function OpenAnythingModal({ items, onSelect, onClose }) {
  const [search, setSearch] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef(null)

  const filteredItems = items
    .filter(item => 
      item.name.toLowerCase().includes(search.toLowerCase()) || 
      item.connectionName.toLowerCase().includes(search.toLowerCase())
    )
    .slice(0, 10)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setSelectedIndex(0)
  }, [search])

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => (prev + 1) % filteredItems.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => (prev - 1 + filteredItems.length) % filteredItems.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredItems[selectedIndex]) {
        onSelect(filteredItems[selectedIndex])
      }
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div className="open-anything-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="open-anything-modal">
        <div className="open-anything-search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search tables, views, or connections..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="open-anything-results">
          {filteredItems.map((item, idx) => (
            <div 
              key={`${item.connectionId}-${item.fullName}`}
              className={`open-anything-item ${idx === selectedIndex ? 'selected' : ''}`}
              onClick={() => onSelect(item)}
            >
              <div className="item-icon">
                {item.type === 'BASE TABLE' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                )}
              </div>
              <div className="item-info">
                <span className="item-name">{item.name}</span>
                <span className="item-meta">{item.connectionName} • {item.schema}</span>
              </div>
              {idx === selectedIndex && <span className="item-enter">↵</span>}
            </div>
          ))}
          {filteredItems.length === 0 && (
            <div className="open-anything-empty">No results found for "{search}"</div>
          )}
        </div>
        <div className="open-anything-footer">
          <span>Arrows to navigate</span>
          <span>Enter to open</span>
          <span>Esc to dismiss</span>
        </div>
      </div>
    </div>
  )
}
