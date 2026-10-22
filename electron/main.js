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
const aiManager               = require(app.isPackaged ? './ai.jsc'          : './ai');
const { registerIpcHandlers } = require(app.isPackaged ? './ipc-handlers.jsc' : './ipc-handlers');

// The first window is kept as "mainWindow" (focused on second-instance launch);
// all open windows — including ones opened via the "New Window" button — are
// tracked in `windows` so each gets its own independently-closable BrowserWindow,
// like Chrome's New Window.
let mainWindow;
const windows = new Set();

// Cached license result from the main-process pre-check.
// The renderer's first license:validate call returns this immediately so
// the window can appear fully formed (no "Verifying…" flash, no activation
// screen visible before validation completes).
let cachedLicenseResult = null;

function createWindow() {
  const isMac = process.platform === 'darwin';
  const win = new BrowserWindow({
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

  windows.add(win);
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = win;
  win.on('closed', () => {
    windows.delete(win);
    if (mainWindow === win) mainWindow = [...windows][0];
  });

  // Show only after the page has painted — no white flash, no partial content.
  win.once('ready-to-show', () => win.show());

  // Pinch/trackpad zoom stays disabled; Ctrl +/-/0 zoom in, out and reset.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const wc = win.webContents;
    const level = wc.getZoomLevel();
    if (input.key === '+' || input.key === '=') {
      wc.setZoomLevel(Math.min(level + 0.5, 5));
    } else if (input.key === '-' || input.key === '_') {
      wc.setZoomLevel(Math.max(level - 0.5, -3));
    } else if (input.key === '0') {
      wc.setZoomLevel(0);
    } else {
      return;
    }
    event.preventDefault();
  });

  if (!app.isPackaged) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  return win;
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

// ── AI assistant IPC handlers ───────────────────────────────────────────────────
// The API key is saved/read only in the main process (encrypted at rest via
// safeStorage) and never sent back to the renderer — only a save/status/clear
// surface is exposed, plus the actual generate call.
function registerAiHandlers() {
  ipcMain.handle('ai:list-providers', () => {
    return aiManager.listProviders();
  });

  ipcMain.handle('ai:list-models', async (_event, params) => {
    return await aiManager.listModels(params || {});
  });

  ipcMain.handle('ai:test-model', async (_event, params) => {
    return await aiManager.testModel(params || {});
  });

  ipcMain.handle('ai:save-config', (_event, provider, apiKey, options) => {
    return aiManager.saveAiConfig(provider, apiKey, options);
  });

  ipcMain.handle('ai:get-config-status', () => {
    return aiManager.getAiConfigStatus();
  });

  ipcMain.handle('ai:clear-config', () => {
    return aiManager.clearAiConfig();
  });

  ipcMain.handle('ai:generate-sql', async (_event, params) => {
    return await aiManager.generateSql(params || {});
  });

  ipcMain.handle('ai:cancel-generate', (_event, requestId) => {
    return aiManager.cancelGenerate(requestId);
  });
}

app.on('second-instance', () => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : [...windows][0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// ── Window-chrome IPC handlers ──────────────────────────────────────────────────
function registerWindowHandlers() {
  ipcMain.handle('window:set-titlebar-overlay', (event, options = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (process.platform === 'win32' && win && typeof win.setTitleBarOverlay === 'function') {
      win.setTitleBarOverlay(options);
    }
  });

  ipcMain.handle('window:new', () => {
    createWindow();
  });
}

app.whenReady().then(async () => {
  registerIpcHandlers(ipcMain, dialog);
  registerLicenseHandlers();
  registerAiHandlers();
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
