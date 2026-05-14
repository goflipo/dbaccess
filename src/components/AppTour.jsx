import React, { useState, useEffect, useCallback } from 'react'
import './AppTour.css'

const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to DB Access!',
    body: 'Your personal desktop client for PostgreSQL, MySQL, and ClickHouse. Let\'s take a quick 30-second tour to get you started.',
    target: null,
    position: 'center',
    icon: (
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <ellipse cx="12" cy="5" rx="9" ry="3"/>
        <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
        <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/>
      </svg>
    ),
  },
  {
    id: 'new-connection',
    title: 'Add Your First Connection',
    body: 'Click the + button to connect to a database. Supports PostgreSQL, MySQL, and ClickHouse — including SSH tunnels for remote servers.',
    target: '[data-tour="new-connection"]',
    position: 'right',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 5v14M5 12h14"/>
      </svg>
    ),
  },
  {
    id: 'sidebar',
    title: 'Browse Tables & Views',
    body: 'All your tables, views, and connections appear here. Click any table to open it instantly. Right-click for more options like export, truncate, and structure.',
    target: '[data-tour="sidebar"]',
    position: 'right',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="18" rx="1"/>
        <rect x="14" y="3" width="7" height="10" rx="1"/>
        <rect x="14" y="17" width="7" height="4" rx="1"/>
      </svg>
    ),
  },
  {
    id: 'query-editor',
    title: 'Write SQL Queries',
    body: 'Full-featured SQL editor with syntax highlighting. Press Ctrl+Enter or F5 to run. Use {{params}} for dynamic parameters, and save favourites for reuse.',
    target: '[data-tour="query-editor"]',
    position: 'bottom',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="16 18 22 12 16 6"/>
        <polyline points="8 6 2 12 8 18"/>
      </svg>
    ),
  },
  {
    id: 'results',
    title: 'Interactive Results Grid',
    body: 'Results load in a fast interactive grid. Filter, sort, edit cells inline, export to CSV/JSON/SQL, and drag column headers to reorder them — order is remembered.',
    target: '[data-tour="results"]',
    position: 'top',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <path d="M3 9h18M9 3v18"/>
      </svg>
    ),
  },
  {
    id: 'safe-mode',
    title: 'Safe Mode',
    body: 'Safe Mode blocks accidental DROP, DELETE, TRUNCATE, and ALTER statements. Keep it on when exploring production databases — it\'s a lifesaver.',
    target: '[data-tour="safe-mode"]',
    position: 'top',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
    ),
  },
  {
    id: 'settings',
    title: 'Customise Your Experience',
    body: 'Change theme (dark/light), font size, table density, and rows per page. All settings are saved automatically and restored on next launch.',
    target: '[data-tour="settings"]',
    position: 'top',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
      </svg>
    ),
  },
  {
    id: 'done',
    title: "You're all set!",
    body: "Connect to your first database using the + button in the sidebar. Everything you need is right here. Enjoy DB Access!",
    target: null,
    position: 'center',
    icon: (
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
        <polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
    ),
  },
]

const PADDING = 10 // spotlight padding around target

export default function AppTour({ onComplete }) {
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState(null)
  const [tooltipStyle, setTooltipStyle] = useState({})

  const current = STEPS[step]
  const isFirst = step === 0
  const isLast = step === STEPS.length - 1
  const isCentered = current.position === 'center'

  const measure = useCallback(() => {
    if (!current.target) { setRect(null); return }
    const el = document.querySelector(current.target)
    if (!el) { setRect(null); return }
    const r = el.getBoundingClientRect()
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
  }, [current.target])

  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  // Compute tooltip position after rect is known
  useEffect(() => {
    if (!rect) {
      // No target element found — center the tooltip as fallback
      const TW = 310, TH = 200
      setTooltipStyle({
        top: Math.max(8, (window.innerHeight - TH) / 2),
        left: Math.max(8, (window.innerWidth - TW) / 2),
      })
      return
    }
    const TW = 310  // tooltip width
    const TH = 200  // estimated tooltip height
    const M = 16    // gap between spotlight and tooltip
    const vw = window.innerWidth
    const vh = window.innerHeight
    const sl = rect.left - PADDING
    const st = rect.top - PADDING
    const sw = rect.width + PADDING * 2
    const sh = rect.height + PADDING * 2

    let style = {}
    switch (current.position) {
      case 'right':
        style = {
          top: Math.max(8, Math.min(st + sh / 2 - TH / 2, vh - TH - 8)),
          left: Math.min(sl + sw + M, vw - TW - 8),
        }
        break
      case 'left':
        style = {
          top: Math.max(8, Math.min(st + sh / 2 - TH / 2, vh - TH - 8)),
          left: Math.max(8, sl - TW - M),
        }
        break
      case 'bottom':
        style = {
          top: Math.min(st + sh + M, vh - TH - 8),
          left: Math.max(8, Math.min(sl + sw / 2 - TW / 2, vw - TW - 8)),
        }
        break
      case 'top':
        style = {
          top: Math.max(8, st - TH - M),
          left: Math.max(8, Math.min(sl + sw / 2 - TW / 2, vw - TW - 8)),
        }
        break
      default:
        style = {}
    }
    setTooltipStyle(style)
  }, [rect, current.position])

  const goNext = () => {
    if (isLast) onComplete()
    else setStep(s => s + 1)
  }
  const goPrev = () => setStep(s => Math.max(0, s - 1))
  const skip = () => onComplete()

  // Arrow indicator pointing from tooltip toward spotlight
  const arrowClass = {
    right: 'tour-arrow-left',
    left: 'tour-arrow-right',
    bottom: 'tour-arrow-top',
    top: 'tour-arrow-bottom',
  }[current.position] || ''

  return (
    <div className="tour-root">
      {/* Dark overlay — clicking skips tour */}
      <div className="tour-overlay" onClick={skip} />

      {/* Spotlight cutout */}
      {rect && (
        <div
          className="tour-spotlight"
          style={{
            top: rect.top - PADDING,
            left: rect.left - PADDING,
            width: rect.width + PADDING * 2,
            height: rect.height + PADDING * 2,
          }}
        />
      )}

      {/* Centred card (welcome / done steps) */}
      {isCentered && (
        <div className="tour-card tour-card-center">
          <div className={`tour-icon-wrap ${step === 0 ? 'tour-icon-primary' : 'tour-icon-green'}`}>
            {current.icon}
          </div>
          <h2 className="tour-title">{current.title}</h2>
          <p className="tour-body">{current.body}</p>
          <div className="tour-dots">
            {STEPS.map((_, i) => (
              <span key={i} className={`tour-dot ${i === step ? 'tour-dot-active' : ''}`} />
            ))}
          </div>
          <div className="tour-footer tour-footer-center">
            {!isFirst && (
              <button className="tour-btn tour-btn-ghost" onClick={goPrev}>← Back</button>
            )}
            <button className="tour-btn tour-btn-primary" onClick={goNext}>
              {isLast ? 'Get Started' : 'Start Tour →'}
            </button>
            {!isLast && (
              <button className="tour-btn tour-btn-skip" onClick={skip}>Skip tour</button>
            )}
          </div>
        </div>
      )}

      {/* Positioned tooltip (non-center steps) */}
      {!isCentered && (
        <div className={`tour-card tour-card-tip ${arrowClass}`} style={tooltipStyle}>
          <div className="tour-tip-header">
            <div className="tour-tip-icon">{current.icon}</div>
            <div className="tour-step-count">{step} / {STEPS.length - 2}</div>
          </div>
          <h3 className="tour-title">{current.title}</h3>
          <p className="tour-body">{current.body}</p>
          <div className="tour-dots">
            {STEPS.map((_, i) => (
              <span key={i} className={`tour-dot ${i === step ? 'tour-dot-active' : ''}`} />
            ))}
          </div>
          <div className="tour-footer">
            <button className="tour-btn tour-btn-ghost" onClick={goPrev}>← Back</button>
            <div className="tour-footer-right">
              <button className="tour-btn tour-btn-skip" onClick={skip}>Skip</button>
              <button className="tour-btn tour-btn-primary" onClick={goNext}>
                {isLast ? 'Finish' : 'Next →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
