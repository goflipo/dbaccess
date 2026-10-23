import React, { useState, useEffect, useRef } from 'react'
import './CommandPalette.css'

export default function CommandPalette({ commands, onClose }) {
  const [search, setSearch] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef(null)

  const filtered = commands
    .filter(cmd =>
      cmd.label.toLowerCase().includes(search.toLowerCase()) ||
      (cmd.group || '').toLowerCase().includes(search.toLowerCase())
    )
    .slice(0, 20)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setSelectedIndex(0)
  }, [search])

  const runCommand = (cmd) => {
    onClose()
    // Defer so the palette unmounts before the action runs (e.g. opening
    // another modal right on top of this one's closing animation).
    setTimeout(() => cmd.action(), 0)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(prev => (prev + 1) % filtered.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(prev => (prev - 1 + filtered.length) % filtered.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[selectedIndex]) runCommand(filtered[selectedIndex])
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div className="cmdp-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdp-modal">
        <div className="cmdp-search">
          <span className="cmdp-prompt">&gt;</span>
          <input
            ref={inputRef}
            type="text"
            placeholder="Type a command..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="cmdp-results">
          {filtered.map((cmd, idx) => (
            <div
              key={cmd.id}
              className={`cmdp-item ${idx === selectedIndex ? 'selected' : ''}`}
              onClick={() => runCommand(cmd)}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <div className="cmdp-item-info">
                <span className="cmdp-item-label">{cmd.label}</span>
                {cmd.group && <span className="cmdp-item-group">{cmd.group}</span>}
              </div>
              {cmd.shortcut && <span className="cmdp-item-shortcut">{cmd.shortcut}</span>}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="cmdp-empty">No matching commands for "{search}"</div>
          )}
        </div>
        <div className="cmdp-footer">
          <span>Arrows to navigate</span>
          <span>Enter to run</span>
          <span>Esc to dismiss</span>
        </div>
      </div>
    </div>
  )
}
