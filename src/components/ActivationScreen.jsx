import React, { useState } from 'react';
import './ActivationScreen.css';

export default function ActivationScreen({ onActivated, startupMessage = '' }) {
  const [apiKey, setApiKey]           = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setEmail]     = useState('');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [success, setSuccess]         = useState(false);

  const formatKey = (value) => {
    const raw = value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 16);
    const parts = raw.match(/.{1,4}/g) || [];
    return parts.join('-');
  };

  const handleKeyChange = (e) => {
    setError('');
    setApiKey(formatKey(e.target.value));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmedKey = apiKey.trim();

    if (trimmedKey.replace(/-/g, '').length < 16) {
      setError('Please enter a complete 16-character API key (XXXX-XXXX-XXXX-XXXX)');
      return;
    }

    if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim())) {
      setError('Please enter a valid email address');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const result = await window.dbAccess.license.activate(
        trimmedKey,
        customerName.trim() || undefined,
        customerEmail.trim() || undefined,
      );
      if (result.success) {
        setSuccess(true);
        setTimeout(() => onActivated(), 1200);
      } else {
        setError(result.error || 'Activation failed. Please try again.');
      }
    } catch {
      setError('Unexpected error. Please restart the application.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="activation-root">
      <div className="activation-card">
        <div className="activation-logo">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
            <ellipse cx="12" cy="6" rx="9" ry="3.5" stroke="var(--accent-primary)" strokeWidth="1.5"/>
            <path d="M3 6v5c0 1.93 4.03 3.5 9 3.5s9-1.57 9-3.5V6" stroke="var(--accent-primary)" strokeWidth="1.5"/>
            <path d="M3 11v5c0 1.93 4.03 3.5 9 3.5s9-1.57 9-3.5v-5" stroke="var(--accent-primary)" strokeWidth="1.5"/>
          </svg>
        </div>

        <h1 className="activation-title">DB Access</h1>
        <p className="activation-subtitle">Enter your license key to activate the application</p>

        {startupMessage && (
          <div className="activation-startup-msg">{startupMessage}</div>
        )}

        {success ? (
          <div className="activation-success">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="#22c55e" strokeWidth="1.5"/>
              <path d="M7 12.5l3.5 3.5 6.5-7" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span>License activated! Loading...</span>
          </div>
        ) : (
          <form className="activation-form" onSubmit={handleSubmit}>
            <div className="activation-field">
              <label className="activation-label">API Key <span className="activation-required">*</span></label>
              <input
                className={`activation-input${error ? ' activation-input-error' : ''}`}
                type="text"
                placeholder="XXXX-XXXX-XXXX-XXXX"
                value={apiKey}
                onChange={handleKeyChange}
                disabled={loading}
                autoFocus
                spellCheck={false}
                maxLength={19}
              />
            </div>

            <div className="activation-field">
              <label className="activation-label">Your Name <span className="activation-optional">(optional)</span></label>
              <input
                className="activation-input"
                type="text"
                placeholder="Jane Smith"
                value={customerName}
                onChange={e => setCustomerName(e.target.value)}
                disabled={loading}
                maxLength={255}
              />
            </div>

            <div className="activation-field">
              <label className="activation-label">Email <span className="activation-optional">(optional)</span></label>
              <input
                className="activation-input"
                type="email"
                placeholder="jane@example.com"
                value={customerEmail}
                onChange={e => { setError(''); setEmail(e.target.value); }}
                disabled={loading}
                maxLength={255}
              />
            </div>

            {error && <p className="activation-error">{error}</p>}

            <button
              type="submit"
              className="activation-btn"
              disabled={loading || apiKey.replace(/-/g, '').length < 16}
            >
              {loading ? (
                <>
                  <span className="activation-spinner" />
                  Verifying...
                </>
              ) : (
                'Activate License'
              )}
            </button>
          </form>
        )}

        <p className="activation-footer">
          Don't have a key? Contact your administrator.
        </p>
      </div>
    </div>
  );
}
