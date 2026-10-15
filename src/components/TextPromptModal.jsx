import React, { useState, useEffect, useRef } from 'react'
import './TextPromptModal.css'

// In-app replacement for window.prompt(), which Electron does not support.
export default function TextPromptModal({ title, label, placeholder, confirmLabel = 'OK', onSubmit, onCancel }) {
  const [value, setValue] = useState('')
  const inputRef = useRef(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const submit = () => {
    const v = value.trim()
    if (v) onSubmit(v)
  }

  return (
    <div className="tpm-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="tpm-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="tpm-title">{title}</div>
        {label && <label className="tpm-label">{label}</label>}
        <input
          ref={inputRef}
          className="tpm-input"
          value={value}
          placeholder={placeholder}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submit()
            else if (e.key === 'Escape') onCancel()
          }}
        />
        <div className="tpm-actions">
          <button className="tpm-btn" onClick={onCancel}>Cancel</button>
          <button className="tpm-btn tpm-btn-primary" onClick={submit} disabled={!value.trim()}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
