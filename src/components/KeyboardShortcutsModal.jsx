import React from 'react'
import './KeyboardShortcutsModal.css'

export default function KeyboardShortcutsModal({ onClose }) {
  const shortcuts = [
    { category: 'Query Execution', shortcuts: [
      { keys: 'Ctrl+Enter / F5', action: 'Run query (or selected text)' },
      { keys: 'Ctrl+R', action: 'Refresh — re-run last query' },
      { keys: 'Ctrl+S', action: 'Save query to file' },
      { keys: 'Ctrl+A', action: 'Select all text in editor' },
    ]},
    { category: 'Transaction Controls', shortcuts: [
      { keys: 'BEGIN button', action: 'Start a new transaction (BEGIN;)' },
      { keys: 'COMMIT button', action: 'Commit current transaction (COMMIT;)' },
      { keys: 'ROLLBACK button', action: 'Roll back current transaction (ROLLBACK;)' },
    ]},
    { category: 'Editor', shortcuts: [
      { keys: 'Ctrl+F', action: 'Find & Replace' },
      { keys: 'Ctrl+H', action: 'Open Replace dialog' },
      { keys: 'Ctrl+Shift+F', action: 'Format SQL (Beautify)' },
      { keys: 'Ctrl+/', action: 'Toggle line comment' },
    ]},
    { category: 'Query Tools', shortcuts: [
      { keys: 'Explain button', action: 'Run EXPLAIN ANALYZE on query' },
      { keys: 'Favorites button', action: 'Open saved query favorites' },
      { keys: 'Save button', action: 'Save current query as favorite' },
      { keys: 'Minify button', action: 'Minify SQL (compress whitespace)' },
      { keys: '{{param}}', action: 'Query parameter — replaced before execution' },
    ]},
    { category: 'Tabs & Navigation', shortcuts: [
      { keys: 'Ctrl+T', action: 'New query tab' },
      { keys: 'Ctrl+W', action: 'Close active tab' },
      { keys: 'Ctrl+[', action: 'Switch to previous tab' },
      { keys: 'Ctrl+]', action: 'Switch to next tab' },
      { keys: 'Ctrl+K', action: 'Open Anything (search all tables)' },
      { keys: 'Ctrl+\\', action: 'Toggle sidebar' },
      { keys: 'Double-click tab title', action: 'Rename tab inline' },
      { keys: 'Tab right-click', action: 'Rename / Duplicate / Close tab' },
    ]},
    { category: 'Results Grid', shortcuts: [
      { keys: 'Ctrl+R', action: 'Refresh / re-run query' },
      { keys: 'Ctrl+S', action: 'Commit staged cell edits to the database' },
      { keys: 'Escape', action: 'Cancel cell edit / close menus' },
      { keys: 'Double-click cell', action: 'Edit cell value (inline edit)' },
      { keys: 'Enter', action: 'Save cell edit and stage change' },
      { keys: 'Shift+Enter', action: 'Insert newline (in multiline / JSON cells)' },
      { keys: 'Tab', action: 'Save and move to next cell' },
      { keys: 'Column header click', action: 'Sort ascending / descending' },
      { keys: 'Column header right-click', action: 'Hide that column' },
      { keys: 'Columns button', action: 'Toggle column visibility panel' },
      { keys: 'Right-click row', action: 'Copy / Edit / Delete row, Inspect JSON' },
    ]},
    { category: 'Connection & Setup', shortcuts: [
      { keys: '📊 Metrics icon', action: 'Open Metrics Board tab' },
      { keys: '👥 Users icon', action: 'Open User Management tab' },
      { keys: 'ER Diagram icon', action: 'Open Entity-Relationship diagram' },
      { keys: 'Paste Connection URL', action: 'Auto-fill form from postgres://user:pass@host/db' },
    ]},
    { category: 'Safe Mode', shortcuts: [
      { keys: 'Status bar toggle', action: 'Toggle Safe Mode on/off' },
      { keys: 'DROP / DELETE / TRUNCATE / ALTER', action: 'Prompts confirmation when Safe Mode is ON' },
    ]},
    { category: 'General', shortcuts: [
      { keys: 'Ctrl+?', action: 'Show this shortcuts reference' },
      { keys: 'Escape', action: 'Close modals & dropdown panels' },
    ]},
  ]


  return (
    <div className="shortcuts-modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="shortcuts-modal">
        <div className="shortcuts-header">
          <h2>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M6 16h12"/></svg>
            Keyboard Shortcuts
          </h2>
          <button className="shortcuts-close" onClick={onClose}>✕</button>
        </div>
        <div className="shortcuts-content">
          {shortcuts.map((group, idx) => (
            <div key={idx} className="shortcuts-group">
              <h3>{group.category}</h3>
              <table className="shortcuts-table">
                <tbody>
                  {group.shortcuts.map((shortcut, sidx) => (
                    <tr key={sidx}>
                      <td className="shortcut-keys">
                        {shortcut.keys.split(' / ').map((k, i) => (
                          <React.Fragment key={i}>
                            {i > 0 && <span className="key-separator"> / </span>}
                            <kbd>{k}</kbd>
                          </React.Fragment>
                        ))}
                      </td>
                      <td className="shortcut-action">{shortcut.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <div className="shortcuts-footer">
          <p>💡 Tip: Click column headers in results to sort. Double-click cells to edit inline.</p>
        </div>
      </div>
    </div>
  )
}
