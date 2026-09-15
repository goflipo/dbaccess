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
            <SettingsRow label="Accent color">
              <AccentSwatches
                value={settings.accentColor}
                onChange={v => onChangeSettings({ accentColor: v })}
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
            <SettingsRow label="Text style">
              <ToggleGroup
                options={[
                  { value: 'normal', label: 'Normal' },
                  { value: 'bold', label: 'Bold' },
                  { value: 'italic', label: 'Italic' },
                ]}
                value={settings.fontStyle}
                onChange={v => onChangeSettings({ fontStyle: v })}
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
            <SettingsRow label="Grid lines">
              <ToggleGroup
                options={[
                  { value: true, label: 'On' },
                  { value: false, label: 'Off' },
                ]}
                value={settings.showGridLines}
                onChange={v => onChangeSettings({ showGridLines: v })}
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

          <AiAssistantSettings />

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

const ACCENT_COLORS = [
  { value: 'blue', hex: '#4a90e2' },
  { value: 'green', hex: '#2fae6c' },
  { value: 'purple', hex: '#9a8cf0' },
  { value: 'orange', hex: '#e8974b' },
  { value: 'red', hex: '#e2574a' },
  { value: 'teal', hex: '#2fa9a3' },
]

function AccentSwatches({ value, onChange }) {
  return (
    <div className="settings-accent-group">
      {ACCENT_COLORS.map(c => (
        <button
          key={c.value}
          className={`settings-accent-swatch${value === c.value ? ' active' : ''}`}
          style={{ background: c.hex }}
          title={c.value}
          onClick={() => onChange(c.value)}
        />
      ))}
    </div>
  )
}

const FALLBACK_PROVIDERS = [
  { id: 'claude', label: 'Claude (Anthropic)', needsBaseUrl: false, defaultModel: 'claude-3-5-sonnet-20241022', endpoint: 'api.anthropic.com' },
  { id: 'openai', label: 'OpenAI', needsBaseUrl: false, defaultModel: 'gpt-4o-mini', endpoint: 'api.openai.com' },
  { id: 'gemini', label: 'Google Gemini', needsBaseUrl: false, defaultModel: 'gemini-1.5-flash', endpoint: 'generativelanguage.googleapis.com' },
  { id: 'groq', label: 'Groq', needsBaseUrl: false, defaultModel: 'llama-3.3-70b-versatile', endpoint: 'api.groq.com' },
  { id: 'mistral', label: 'Mistral', needsBaseUrl: false, defaultModel: 'mistral-large-latest', endpoint: 'api.mistral.ai' },
  { id: 'deepseek', label: 'DeepSeek', needsBaseUrl: false, defaultModel: 'deepseek-chat', endpoint: 'api.deepseek.com' },
  { id: 'xai', label: 'xAI (Grok)', needsBaseUrl: false, defaultModel: 'grok-2-latest', endpoint: 'api.x.ai' },
  { id: 'openrouter', label: 'OpenRouter', needsBaseUrl: false, defaultModel: 'openai/gpt-4o-mini', endpoint: 'openrouter.ai' },
  { id: 'perplexity', label: 'Perplexity', needsBaseUrl: false, defaultModel: 'llama-3.1-sonar-large-128k-online', endpoint: 'api.perplexity.ai' },
  { id: 'nvidia', label: 'NVIDIA NIM', needsBaseUrl: false, defaultModel: '', endpoint: 'integrate.api.nvidia.com' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', needsBaseUrl: true, defaultModel: '', endpoint: null },
]

function AiAssistantSettings() {
  const [providers, setProviders] = React.useState(FALLBACK_PROVIDERS)
  const [status, setStatus] = React.useState(null) // { provider, hasKey, baseUrl, model }
  const [provider, setProvider] = React.useState('claude')
  const [apiKey, setApiKey] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [model, setModel] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState('')

  React.useEffect(() => {
    window.dbAccess?.ai?.listProviders().then(list => { if (list?.length) setProviders(list) })
    window.dbAccess?.ai?.getStatus().then(s => {
      if (!s) return
      setStatus(s)
      if (s.provider && s.provider !== 'none') {
        setProvider(s.provider)
        setBaseUrl(s.baseUrl || '')
        setModel(s.model || '')
      }
    })
  }, [])

  const current = providers.find(p => p.id === provider) || providers[0]

  const handleSave = async () => {
    if (!apiKey.trim()) return
    if (current.needsBaseUrl && !baseUrl.trim()) {
      setMessage('Base URL is required for a custom provider')
      return
    }
    if (!current.defaultModel && !model.trim()) {
      setMessage('Model is required for this provider')
      return
    }
    setSaving(true); setMessage('')
    const res = await window.dbAccess.ai.saveConfig(provider, apiKey.trim(), { baseUrl: baseUrl.trim(), model: model.trim() })
    setSaving(false)
    if (res.success) {
      setApiKey('')
      setStatus({ provider, hasKey: true, baseUrl: baseUrl.trim(), model: model.trim() })
      setMessage('Key saved on this device')
    } else {
      setMessage(res.error || 'Failed to save key')
    }
  }

  const handleClear = async () => {
    await window.dbAccess.ai.clearConfig()
    setStatus({ provider: 'none', hasKey: false, baseUrl: '', model: '' })
    setMessage('Key removed')
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title">AI Assistant</div>
      <SettingsRow label="Provider">
        <select
          className="settings-ai-select"
          value={provider}
          onChange={e => { setProvider(e.target.value); setMessage('') }}
        >
          {providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </SettingsRow>
      {current.endpoint && (
        <div className="settings-ai-endpoint">
          Your key will be sent to <strong>{current.endpoint}</strong> — make sure it's a key issued by that service (e.g. a key from another provider hosting the same model, like NVIDIA NIM, won't work here — use "Custom" for that instead).
        </div>
      )}
      {current.needsBaseUrl && (
        <div className="settings-ai-key-row">
          <input
            type="text"
            className="settings-ai-key-input"
            placeholder="Base URL, e.g. https://api.example.com/v1"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
          />
        </div>
      )}
      <div className="settings-ai-key-row">
        <input
          type="text"
          className="settings-ai-key-input"
          placeholder={current.defaultModel ? `Model (optional) — default: ${current.defaultModel}` : 'Model (required) — e.g. deepseek-ai/deepseek-v4-flash-0731'}
          value={model}
          onChange={e => setModel(e.target.value)}
        />
      </div>
      <div className="settings-ai-key-row">
        <input
          type="password"
          className="settings-ai-key-input"
          placeholder={status?.hasKey && status.provider === provider ? `${current.label} key saved — paste a new one to replace it` : `Paste your ${current.label} API key…`}
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSave()}
        />
        <button className="settings-ai-save-btn" onClick={handleSave} disabled={saving || !apiKey.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {status?.hasKey && (
          <button className="settings-ai-clear-btn" onClick={handleClear} title="Remove saved key">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        )}
      </div>
      {message && <div className="settings-ai-message">{message}</div>}
      <div className="settings-ai-hint">
        Your key is encrypted and stored only on this device. It's used directly by the app to call {current.label} when you use "Ask AI" in the query editor — never sent anywhere else.
      </div>
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
