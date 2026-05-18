// Load .env from app root — no external dependency, silently skipped if file is missing
try {
  const _fs = require('fs');
  const _path = require('path');
  const _envPath = _path.join(__dirname, '..', '.env');
  if (_fs.existsSync(_envPath)) {
    _fs.readFileSync(_envPath, 'utf-8').split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq === -1) return;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in process.env)) process.env[key] = val;
    });
  }
} catch {}

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { registerIpcHandlers } = require('./ipc-handlers');

// Fix: suppress GPU disk-cache Access Denied errors on Windows.
// Must be called BEFORE app.whenReady() and BEFORE requiring license.js
// (which calls app.getPath after ready).
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// license.js is required here (after the switch above) but its path constants
// are computed lazily inside functions, so app.getPath is never called before ready.
const licenseManager = require('./license');

let mainWindow;

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0d1017',
    icon: path.join(__dirname, '../build/icon.png'),
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'win32' ? {
      titleBarOverlay: {
        color: '#0d1017',
        symbolColor: '#8891a8',
        height: 38,
      }
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// ── License IPC handlers ───────────────────────────────────────────────────────
function registerLicenseHandlers() {
  ipcMain.handle('license:activate', async (_event, apiKey) => {
    return await licenseManager.activateLicense(apiKey);
  });

  ipcMain.handle('license:validate', async () => {
    return await licenseManager.validateLicense();
  });

  ipcMain.handle('license:check-version', async () => {
    return await licenseManager.checkAppVersion();
  });

  ipcMain.handle('license:clear', () => {
    licenseManager.clearLicense();
    return { success: true };
  });
}

app.whenReady().then(() => {
  registerIpcHandlers(ipcMain, dialog);
  registerLicenseHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
