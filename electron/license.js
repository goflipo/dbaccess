const { app, safeStorage } = require('electron');
const path  = require('path');
const fs    = require('fs');
const crypto = require('crypto');
const http  = require('http');
const https = require('https');

// ─── Change this URL when you deploy the licensing server remotely ────────────
const LICENSE_SERVER_URL = 'http://localhost:3500';
// ─────────────────────────────────────────────────────────────────────────────

// Lazy — computed inside functions so app.getPath is never called before app.ready
const getLicenseFile = () => path.join(app.getPath('userData'), 'license.dat');
const getDeviceFile  = () => path.join(app.getPath('userData'), 'device.dat');

// Returns a stable device ID stored in userData (survives app reinstalls on same machine)
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

// Hardware fingerprint — hashed so it's anonymous
function getMachineFingerprint() {
  const os = require('os');
  const raw = [os.hostname(), os.platform(), os.arch(), os.cpus()[0]?.model || ''].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

// Encrypt and save the raw API key to disk
function saveLicense(apiKey) {
  try {
    let stored;
    if (safeStorage.isEncryptionAvailable()) {
      stored = safeStorage.encryptString(apiKey).toString('base64');
    } else {
      stored = Buffer.from(apiKey).toString('base64');
    }
    fs.writeFileSync(getLicenseFile(), JSON.stringify({ key: stored, v: 1 }), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// Read and decrypt the stored key
function loadStoredKey() {
  try {
    const licenseFile = getLicenseFile();
    if (!fs.existsSync(licenseFile)) return null;
    const data = JSON.parse(fs.readFileSync(licenseFile, 'utf-8'));
    if (!data.key) return null;
    const buf = Buffer.from(data.key, 'base64');
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString('utf-8');
  } catch {
    return null;
  }
}

// Simple HTTP/HTTPS request helper
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

async function activateLicense(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
    return { success: false, error: 'Please enter a valid API key' };
  }

  const deviceId    = getOrCreateDeviceId();
  const fingerprint = getMachineFingerprint();
  let appVersion = '1.0.0';
  try { appVersion = require('../package.json').version; } catch {}

  try {
    const res = await callServer('POST', '/api/license/activate', {
      apikey:               apiKey.trim(),
      device_id:            deviceId,
      machine_fingerprint:  fingerprint,
      app_version:          appVersion,
    });

    if (res.body.success) {
      saveLicense(apiKey.trim());
      return { success: true };
    }
    return { success: false, error: res.body.error || 'Activation failed' };
  } catch (err) {
    return { success: false, error: 'Cannot reach license server. Please check your internet connection.' };
  }
}

async function validateLicense() {
  const apiKey = loadStoredKey();
  if (!apiKey) return { valid: false, reason: 'No license found' };

  const deviceId = getOrCreateDeviceId();
  let appVersion = '1.0.0';
  try { appVersion = require('../package.json').version; } catch {}

  try {
    const res = await callServer('POST', '/api/license/validate', {
      apikey:      apiKey,
      device_id:   deviceId,
      app_version: appVersion,
    });

    if (res.body.success) return { valid: true };
    return { valid: false, reason: res.body.error || 'License invalid' };
  } catch {
    // Server unreachable — grant offline grace if key is stored
    return { valid: true, offline: true };
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
