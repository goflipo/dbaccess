import React, { useState, useEffect, useRef } from 'react'
import './TabBar.css'

export default function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onCloseAllTabs, onCloseOtherTabs, onNewTab, onRenameTab, onDuplicateTab }) {
  const [contextMenu, setContextMenu] = useState(null)
  const [renamingTabId, setRenamingTabId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [showTabList, setShowTabList] = useState(false)
  const renameInputRef = useRef(null)
  const scrollRef = useRef(null)
  const tabListRef = useRef(null)

  useEffect(() => {
    const handleClickOutside = (e) => {
      setContextMenu(null)
      if (tabListRef.current && !tabListRef.current.contains(e.target)) {
        setShowTabList(false)
      }
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [])

  useEffect(() => {
    if (renamingTabId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingTabId])

  // Non-passive wheel listener so preventDefault works — redirects vertical scroll to horizontal
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e) => {
      if (e.deltaY === 0) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Scroll active tab into view when activeTabId changes
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const activeEl = el.querySelector('.tab.active')
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])

  const handleContextMenu = (e, tabId) => {
    e.preventDefault()
    setContextMenu({ mouseX: e.clientX, mouseY: e.clientY, tabId })
  }

  const startRename = (tab) => {
    setRenamingTabId(tab.id)
    setRenameValue(tab.title)
  }

  const commitRename = () => {
    if (renamingTabId && renameValue.trim()) {
      onRenameTab?.(renamingTabId, renameValue.trim())
    }
    setRenamingTabId(null)
  }

  const getTabIcon = (tab) => {
    if (tab.type === 'erd') {
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
          <rect x="14" y="14" width="7" height="7" rx="1"/><path d="M10 7h4M17 10v4"/>
        </svg>
      )
    }
    if (tab.type === 'metrics') {
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-yellow)" strokeWidth="2">
          <path d="M18 20V10M12 20V4M6 20v-6"/>
        </svg>
      )
    }
    if (tab.type === 'users') {
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-green)" strokeWidth="2">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
        </svg>
      )
    }
    if (tab.type === 'compare') {
      return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="2">
          <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/>
        </svg>
      )
    }
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/>
      </svg>
    )
  }

  return (
    <div className="tabbar">
      <div className="tabbar-tabs" ref={scrollRef}>
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? 'active' : ''} ${tab.type === 'erd' ? 'tab-erd' : tab.type === 'metrics' ? 'tab-metrics' : tab.type === 'users' ? 'tab-users' : ''}`}
            onClick={() => onSelectTab(tab.id)}
            title={tab.title}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
          >
            {tab.isRunning && <span className="tab-spinner"></span>}
            {getTabIcon(tab)}
            {renamingTabId === tab.id ? (
              <input
                ref={renameInputRef}
                className="tab-rename-input"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onClick={e => e.stopPropagation()}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                  if (e.key === 'Escape') setRenamingTabId(null)
                }}
                onBlur={commitRename}
              />
            ) : (
              <span
                className="tab-title"
                onDoubleClick={(e) => { e.stopPropagation(); startRename(tab) }}
              >
                {tab.title}
              </span>
            )}
            <button className="tab-close" onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id) }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        ))}
      </div>

      <button className="tab-new" onClick={onNewTab} title="New Tab (Ctrl+T)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
      </button>

      {/* Tab list dropdown — always visible in right corner */}
      <div className="tabbar-list-wrap" ref={tabListRef}>
        <button
          className={`tabbar-list-btn ${showTabList ? 'active' : ''}`}
          onClick={(e) => { e.stopPropagation(); setShowTabList(p => !p) }}
          title="Show all tabs"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        {showTabList && (
          <div className="tabbar-list-dropdown">
            {tabs.map(tab => (
              <button
                key={tab.id}
                className={`tabbar-list-item ${tab.id === activeTabId ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); onSelectTab(tab.id); setShowTabList(false) }}
              >
                {getTabIcon(tab)}
                <span className="tabbar-list-item-title">{tab.title}</span>
                <span
                  className="tabbar-list-item-close"
                  onClick={(ev) => { ev.stopPropagation(); onCloseTab(tab.id) }}
                  title="Close"
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          className="tab-context-menu"
          style={{ top: contextMenu.mouseY, left: contextMenu.mouseX }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="context-menu-item" onClick={() => {
            const tab = tabs.find(t => t.id === contextMenu.tabId)
            if (tab) startRename(tab)
            setContextMenu(null)
          }}>
            Rename Tab
          </button>
          <button className="context-menu-item" onClick={() => { onDuplicateTab?.(contextMenu.tabId); setContextMenu(null) }}>
            Duplicate Tab
          </button>
          <div className="ctx-menu-divider" />
          <button className="context-menu-item" onClick={() => { onCloseTab(contextMenu.tabId); setContextMenu(null) }}>
            Close Tab
          </button>
          <button className="context-menu-item" onClick={() => { onCloseOtherTabs(contextMenu.tabId); setContextMenu(null) }}>
            Close Other Tabs
          </button>
          <button className="context-menu-item" onClick={() => { onCloseAllTabs(); setContextMenu(null) }}>
            Close All Tabs
          </button>
        </div>
      )}
    </div>
  )
}
