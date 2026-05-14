import React from 'react'
import './SettingsPanel.css'

export default function SettingsPanel({ settings, onChangeSettings, safeMode, onToggleSafeMode, theme, onToggleTheme, onClose, onRestartTour }) {
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <div className="settings-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
            Settings
          </div>
          <button className="settings-close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="settings-body">
          <div className="settings-section">
            <div className="settings-section-title">Appearance</div>
            <SettingsRow label="Theme">
              <ToggleGroup
                options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
                value={theme}
                onChange={v => v !== theme && onToggleTheme()}
              />
            </SettingsRow>
            <SettingsRow label="Font size">
              <ToggleGroup
                options={[
                  { value: 'small', label: 'Small' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'large', label: 'Large' },
                ]}
                value={settings.fontSize}
                onChange={v => onChangeSettings({ fontSize: v })}
              />
            </SettingsRow>
            <SettingsRow label="Table density">
              <ToggleGroup
                options={[
                  { value: 'compact', label: 'Compact' },
                  { value: 'normal', label: 'Normal' },
                  { value: 'comfortable', label: 'Comfortable' },
                ]}
                value={settings.density}
                onChange={v => onChangeSettings({ density: v })}
              />
            </SettingsRow>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Query</div>
            <SettingsRow label="Safe mode">
              <ToggleGroup
                options={[
                  { value: 'on', label: 'On', accent: 'green' },
                  { value: 'off', label: 'Off', accent: 'red' },
                ]}
                value={safeMode ? 'on' : 'off'}
                onChange={v => onToggleSafeMode(v === 'on')}
              />
            </SettingsRow>
            <SettingsRow label="Rows per page">
              <ToggleGroup
                options={[50, 100, 250, 500].map(n => ({ value: n, label: String(n) }))}
                value={settings.pageSize}
                onChange={v => onChangeSettings({ pageSize: v })}
              />
            </SettingsRow>
          </div>

          <div className="settings-section">
            <div className="settings-section-title">Support</div>
            <div className="settings-support-card">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 8v4M12 16h.01"/>
              </svg>
              <div className="settings-support-text">
                <span>Found a bug or have a suggestion?</span>
                <a
                  href="mailto:gokhaleshail@gmail.com?subject=DB Access – Issue / Feedback"
                  className="settings-support-email"
                >
                  gokhaleshail@gmail.com
                </a>
              </div>
              <a
                href="mailto:gokhaleshail@gmail.com?subject=DB Access – Issue / Feedback"
                className="settings-email-btn"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                  <polyline points="22,6 12,13 2,6"/>
                </svg>
                Email Us
              </a>
            </div>
          </div>
        </div>

        <div className="settings-footer">
          <span className="settings-hint">Settings are saved automatically</span>
          <button className="settings-tour-btn" onClick={() => { onClose(); onRestartTour?.() }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
            Restart tour
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsRow({ label, children }) {
  return (
    <div className="settings-row">
      <span className="settings-row-label">{label}</span>
      {children}
    </div>
  )
}

function ToggleGroup({ options, value, onChange }) {
  return (
    <div className="settings-toggle-group">
      {options.map(opt => (
        <button
          key={opt.value}
          className={`settings-toggle-btn${value === opt.value ? ' active' : ''}${opt.accent && value === opt.value ? ` accent-${opt.accent}` : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
