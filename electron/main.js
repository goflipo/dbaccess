const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

// Only one running instance at a time — a second launch focuses the existing
// window instead of spawning a new process, matching standard Windows app behavior.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// Force userData to the same path the NSIS installer uses ($APPDATA\DB Access),
// regardless of what app.getName() returns in packaged vs dev mode.
// Must be called before app.ready and before any app.getPath('userData') calls.
app.setPath('userData', path.join(app.getPath('appData'), 'DB Access'));

// Correct Windows taskbar grouping/pinning/notification identity.
app.setAppUserModelId('com.shaileshgokhale.dbaccess');

// Fix: suppress GPU disk-cache Access Denied errors on Windows.
// Must be called BEFORE app.whenReady() and BEFORE requiring license.js
// (which calls app.getPath after ready).
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// In production the sensitive modules are V8 bytecode (.jsc).
// require('bytenode') registers the .jsc extension handler so subsequent
// require() calls resolve .jsc files transparently.
if (app.isPackaged) require('bytenode');

const licenseManager         = require(app.isPackaged ? './license.jsc'      : './license');
const { registerIpcHandlers } = require(app.isPackaged ? './ipc-handlers.jsc' : './ipc-handlers');

let mainWindow;

// Cached license result from the main-process pre-check.
// The renderer's first license:validate call returns this immediately so
// the window can appear fully formed (no "Verifying…" flash, no activation
// screen visible before validation completes).
let cachedLicenseResult = null;

function createWindow() {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,           // hidden until ready-to-show fires
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

  // Show only after the page has painted — no white flash, no partial content.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Disable pinch/trackpad zoom and the Ctrl+=/-/0 zoom accelerators — a
  // native desktop app's UI doesn't rescale like a webpage.
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && ['+', '-', '=', '0'].includes(input.key)) {
      event.preventDefault();
    }
  });

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// ── License IPC handlers ───────────────────────────────────────────────────────
function registerLicenseHandlers() {
  ipcMain.handle('license:activate', async (_event, apiKey, customerName, customerEmail) => {
    return await licenseManager.activateLicense(apiKey, customerName, customerEmail);
  });

  ipcMain.handle('license:validate', async () => {
    // Return the pre-computed result on the first call so the renderer never
    // has to wait for a network round-trip after the window appears.
    if (cachedLicenseResult !== null) {
      const result = cachedLicenseResult;
      cachedLicenseResult = null; // consume once; subsequent calls hit the server normally
      return result;
    }
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

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── Window-chrome IPC handlers ──────────────────────────────────────────────────
function registerWindowHandlers() {
  ipcMain.handle('window:set-titlebar-overlay', (_event, options = {}) => {
    if (process.platform === 'win32' && mainWindow && typeof mainWindow.setTitleBarOverlay === 'function') {
      mainWindow.setTitleBarOverlay(options);
    }
  });
}

app.whenReady().then(async () => {
  registerIpcHandlers(ipcMain, dialog);
  registerLicenseHandlers();
  registerWindowHandlers();

  // Validate license BEFORE creating the window so the window appears in
  // the correct state (main app or activation screen) with no intermediate flash.
  try {
    cachedLicenseResult = await licenseManager.validateLicense();
  } catch {
    cachedLicenseResult = { valid: false, reason: 'License check failed. Please try again.' };
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
