const { app, safeStorage } = require('electron');
const path  = require('path');
const fs    = require('fs');
const crypto = require('crypto');
const http  = require('http');
const https = require('https');

// Server URL assembled at runtime — not a single grep-able string.
// For production: change proto to 'https', host to your domain, port to ''.
const LICENSE_SERVER_URL = (() => {
  const proto = Buffer.from('687474703a2f2f', 'hex').toString(); // http://
  const host  = 'localhost';
  const port  = ':3500';
  return proto + host + port;
})();

// 7-day offline grace in milliseconds
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// Lazy — computed inside functions so app.getPath is never called before app.ready
const getLicenseFile = () => path.join(app.getPath('userData'), 'license.dat');
const getDeviceFile  = () => path.join(app.getPath('userData'), 'device.dat');

function getOrCreateDeviceId() {
  try {
    const deviceFile = getDeviceFile();
    if (fs.existsSync(deviceFile)) {
      const data = JSON.parse(fs.readFileSync(deviceFile, 'utf-8'));
      if (data.deviceId) return data.deviceId;
    }
    const deviceId = crypto.randomUUID();
    fs.writeFileSync(deviceFile, JSON.stringify({ deviceId }), 'utf-8');
    return deviceId;
  } catch {
    return crypto.randomUUID();
  }
}

function getMachineFingerprint() {
  const os = require('os');
  const raw = [os.hostname(), os.platform(), os.arch(), os.cpus()[0]?.model || ''].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function getAppVersion() {
  try { return require('../package.json').version; } catch { return '1.0.0'; }
}

// ── License file I/O (stores key + JWT together) ──────────────────────────────

function saveLocalLicense(apiKey, jwtToken) {
  try {
    const payload = JSON.stringify({ key: apiKey, jwt: jwtToken || '', v: 2 });
    let stored;
    if (safeStorage.isEncryptionAvailable()) {
      stored = safeStorage.encryptString(payload).toString('base64');
    } else {
      stored = Buffer.from(payload).toString('base64');
    }
    fs.writeFileSync(getLicenseFile(), stored, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function loadLocalLicense() {
  try {
    const licenseFile = getLicenseFile();
    if (!fs.existsSync(licenseFile)) return null;

    const stored = fs.readFileSync(licenseFile, 'utf-8').trim();
    const buf = Buffer.from(stored, 'base64');

    let raw;
    if (safeStorage.isEncryptionAvailable()) {
      raw = safeStorage.decryptString(buf);
    } else {
      raw = buf.toString('utf-8');
    }

    const data = JSON.parse(raw);

    // v1 format only had { key, v:1 } — upgrade in place
    if (data.v === 1) return { key: data.key, jwt: null };
    if (data.v === 2) return { key: data.key, jwt: data.jwt || null };
    return null;
  } catch {
    return null;
  }
}

// ── JWT helpers (no signature verify — server verifies; we only read exp) ─────

function decodeJwtLocally(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // base64url → base64 → JSON
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(parts[1].length / 4) * 4, '='
    );
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

// Returns true if the JWT is not yet expired
function isJwtFresh(token) {
  const payload = decodeJwtLocally(token);
  if (!payload || !payload.exp) return false;
  return Date.now() < payload.exp * 1000;
}

// Returns true if the JWT expired less than OFFLINE_GRACE_MS ago
function isWithinOfflineGrace(token) {
  const payload = decodeJwtLocally(token);
  if (!payload || !payload.exp) return false;
  const expiredAt = payload.exp * 1000;
  return Date.now() < expiredAt + OFFLINE_GRACE_MS;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function callServer(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const url     = new URL(LICENSE_SERVER_URL + endpoint);
    const isHttps = url.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 10000,
    };

    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { reject(new Error('Invalid response from license server')); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('License server timed out')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function activateLicense(apiKey, customerName, customerEmail) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
    return { success: false, error: 'Please enter a valid API key' };
  }

  const deviceId    = getOrCreateDeviceId();
  const fingerprint = getMachineFingerprint();

  try {
    const res = await callServer('POST', '/api/license/activate', {
      apikey:              apiKey.trim(),
      device_id:           deviceId,
      machine_fingerprint: fingerprint,
      app_version:         getAppVersion(),
      ...(customerName  ? { customer_name:  customerName.trim().slice(0, 255)  } : {}),
      ...(customerEmail ? { customer_email: customerEmail.trim().slice(0, 255) } : {}),
    });

    if (res.body.success) {
      saveLocalLicense(apiKey.trim(), res.body.token || null);
      return { success: true };
    }
    return { success: false, error: res.body.error || 'Activation failed' };
  } catch {
    return {
      success: false,
      networkError: true,
      error: 'Cannot reach license server. Please check your internet connection.',
    };
  }
}

async function validateLicense() {
  // ── 1. Pending key written by NSIS installer ──────────────────────────────
  // Format: key=value lines (apikey, customer_name, customer_email)
  try {
    const pendingFile = path.join(app.getPath('userData'), 'pending_license.txt');
    if (fs.existsSync(pendingFile)) {
      const content = fs.readFileSync(pendingFile, 'utf-8').trim();
      if (content) {
        // Parse key=value pairs; fall back to treating entire content as raw key
        const kv = {};
        if (content.includes('=')) {
          content.split(/\r?\n/).forEach(line => {
            const idx = line.indexOf('=');
            if (idx !== -1) kv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          });
        } else {
          kv.apikey = content;
        }

        const rawKey = kv.apikey;
        if (rawKey) {
          const result = await activateLicense(rawKey, kv.customer_name, kv.customer_email);
          if (result.success) {
            try { fs.unlinkSync(pendingFile); } catch {}
            return { valid: true };
          }
          if (result.networkError) {
            // Server unreachable on FIRST activation — do NOT grant access.
            // The pending file is kept so the next launch retries automatically.
            // 7-day offline grace only applies to already-activated installs with a JWT.
            return { valid: false, reason: 'Cannot reach license server. Please connect to the internet and relaunch the application to complete activation.' };
          }
          // Key is invalid or revoked — delete and fall through to activation screen
          try { fs.unlinkSync(pendingFile); } catch {}
        }
      }
    }
  } catch { /* ignore — continue to normal validation */ }

  // ── 2. Already-activated install ──────────────────────────────────────────
  const stored = loadLocalLicense();
  if (!stored || !stored.key) return { valid: false, reason: 'No license found' };

  // ── 2a. JWT fast-path: no server call if token is still fresh ────────────
  if (stored.jwt && isJwtFresh(stored.jwt)) {
    return { valid: true };
  }

  // ── 2b. JWT expired (or missing) — renew via server ──────────────────────
  const deviceId = getOrCreateDeviceId();

  try {
    const res = await callServer('POST', '/api/license/validate', {
      apikey:      stored.key,
      device_id:   deviceId,
      app_version: getAppVersion(),
    });

    if (res.body.success) {
      // Persist the fresh JWT so next launch skips the server call
      if (res.body.token) saveLocalLicense(stored.key, res.body.token);
      return { valid: true };
    }
    return { valid: false, reason: res.body.error || 'License invalid' };
  } catch {
    // ── 2c. Server unreachable — 7-day offline grace using last JWT ────────
    if (stored.jwt && isWithinOfflineGrace(stored.jwt)) {
      return { valid: true, offline: true };
    }
    return { valid: false, reason: 'Cannot reach license server and offline grace period has expired' };
  }
}

async function checkAppVersion() {
  try {
    const res = await callServer('GET', '/api/app/version', null);
    return res.body;
  } catch {
    return null;
  }
}

function clearLicense() {
  try { const f = getLicenseFile(); if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
}

function hasStoredLicense() {
  try { return fs.existsSync(getLicenseFile()); } catch { return false; }
}

module.exports = {
  activateLicense,
  validateLicense,
  checkAppVersion,
  clearLicense,
  hasStoredLicense,
};
