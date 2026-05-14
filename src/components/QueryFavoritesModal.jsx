import React, { useState, useEffect, useCallback } from 'react'
import './QueryFavoritesModal.css'

export default function QueryFavoritesModal({ onClose, onSelect, currentQuery, currentConnectionName }) {
  const [favorites, setFavorites] = useState([])
  const [search, setSearch] = useState('')
  const [saveName, setSaveName] = useState('')
  const [showSave, setShowSave] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadFavorites = useCallback(async () => {
    if (!window.dbAccess) return
    const result = await window.dbAccess.getFavorites()
    if (result.success) setFavorites(result.data)
  }, [])

  useEffect(() => {
    loadFavorites()
  }, [loadFavorites])

  const handleSave = async () => {
    if (!saveName.trim() || !currentQuery?.trim()) return
    setSaving(true)
    await window.dbAccess.saveFavorite({
      name: saveName.trim(),
      sql: currentQuery.trim(),
      connectionName: currentConnectionName || '',
      createdAt: Date.now(),
    })
    setSaving(false)
    setSaveName('')
    setShowSave(false)
    loadFavorites()
  }

  const handleDelete = async (id) => {
    await window.dbAccess.deleteFavorite(id)
    loadFavorites()
  }

  const filtered = favorites.filter(f =>
    f.name.toLowerCase().includes(search.toLowerCase()) ||
    f.sql.toLowerCase().includes(search.toLowerCase()) ||
    (f.connectionName || '').toLowerCase().includes(search.toLowerCase())
  )

  const formatDate = (ts) => {
    if (!ts) return ''
    const d = new Date(ts)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="fav-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="fav-modal">
        <div className="fav-header">
          <div className="fav-header-left">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            <h2>Query Favorites</h2>
            <span className="fav-count">{favorites.length}</span>
          </div>
          <button className="fav-close" onClick={onClose}>✕</button>
        </div>

        <div className="fav-toolbar">
          <input
            type="text"
            className="fav-search"
            placeholder="Search favorites..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          {currentQuery?.trim() && (
            <button className="fav-save-btn" onClick={() => setShowSave(!showSave)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
              Save Current
            </button>
          )}
        </div>

        {showSave && (
          <div className="fav-save-row">
            <input
              type="text"
              className="fav-name-input"
              placeholder="Favorite name..."
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              autoFocus
            />
            <button className="fav-confirm-btn" onClick={handleSave} disabled={saving || !saveName.trim()}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button className="fav-cancel-btn" onClick={() => { setShowSave(false); setSaveName('') }}>Cancel</button>
          </div>
        )}

        <div className="fav-list">
          {filtered.length === 0 ? (
            <div className="fav-empty">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
              <p>{search ? 'No favorites match your search' : 'No favorites saved yet'}</p>
              {!search && currentQuery?.trim() && (
                <p className="fav-hint">Click "Save Current" to add the active query</p>
              )}
            </div>
          ) : (
            filtered.map(f => (
              <div key={f.id} className="fav-item" onClick={() => onSelect(f)}>
                <div className="fav-item-header">
                  <span className="fav-item-name">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--accent-yellow)" stroke="var(--accent-yellow)" strokeWidth="1">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                    {f.name}
                  </span>
                  <div className="fav-item-actions">
                    <span className="fav-item-date">{formatDate(f.createdAt)}</span>
                    <button
                      className="fav-delete-btn"
                      onClick={e => { e.stopPropagation(); handleDelete(f.id) }}
                      title="Delete favorite"
                    >✕</button>
                  </div>
                </div>
                {f.connectionName && (
                  <div className="fav-item-conn">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
                    </svg>
                    {f.connectionName}
                  </div>
                )}
                <pre className="fav-item-sql">{f.sql.length > 200 ? f.sql.substring(0, 200) + '…' : f.sql}</pre>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
