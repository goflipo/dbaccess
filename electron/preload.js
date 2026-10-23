const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dbAccess', {
  // --- Window chrome ---
  setTitleBarOverlay: (options) => ipcRenderer.invoke('window:set-titlebar-overlay', options),
  newWindow: () => ipcRenderer.invoke('window:new'),
  confirm: (options) => ipcRenderer.invoke('dialog:confirm', options),

  // --- Connection ---
  connect: (config) => ipcRenderer.invoke('db:connect', config),
  getConnections: () => ipcRenderer.invoke('db:get-connections'),
  getSavedConnections: () => ipcRenderer.invoke('db:get-saved-connections'),
  deleteSavedConnection: (id) => ipcRenderer.invoke('db:delete-saved-connection', id),
  renameConnection: (id, newName) => ipcRenderer.invoke('db:rename-connection', id, newName),
  runSqlFile: (connectionId) => ipcRenderer.invoke('db:run-sql-file', connectionId),
  executeSqlFile: (connectionId) => ipcRenderer.invoke('db:execute-sql-file', connectionId),
  cancelSqlFile: (sessionId) => ipcRenderer.invoke('db:cancel-sql-file', sessionId),
  onSqlFileProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('sql-file-progress', listener);
    return () => ipcRenderer.removeListener('sql-file-progress', listener);
  },
  disconnect: (connectionId) => ipcRenderer.invoke('db:disconnect', connectionId),
  testConnection: (config) => ipcRenderer.invoke('db:test-connection', config),

  // --- Query ---
  executeQuery: (connectionId, query) => ipcRenderer.invoke('db:execute-query', connectionId, query),
  explainQuery: (connectionId, query) => ipcRenderer.invoke('db:explain-query', connectionId, query),

  // --- Schema ---
  getDatabases: (connectionId) => ipcRenderer.invoke('db:get-databases', connectionId),
  getTables: (connectionId, database) => ipcRenderer.invoke('db:get-tables', connectionId, database),
  getCurrentDatabase: (connectionId) => ipcRenderer.invoke('db:get-current-database', connectionId),
  switchDatabase: (connectionId, newDatabase) => ipcRenderer.invoke('db:switch-database', connectionId, newDatabase),
  getTableStructure: (connectionId, table) => ipcRenderer.invoke('db:get-table-structure', connectionId, table),
  getTableExtras: (connectionId, table) => ipcRenderer.invoke('db:get-table-extras', connectionId, table),
  getSchemaFull: (connectionId) => ipcRenderer.invoke('db:get-schema-full', connectionId),
  getFkImpact: (connectionId, tableName, rows) => ipcRenderer.invoke('db:get-fk-impact', connectionId, tableName, rows),

  // --- User Management ---
  getUserManagement: (connectionId) => ipcRenderer.invoke('db:get-user-management', connectionId),
  createUser: (connectionId, username, password, options) => ipcRenderer.invoke('db:create-user', connectionId, username, password, options),
  dropUser: (connectionId, username) => ipcRenderer.invoke('db:drop-user', connectionId, username),

  // --- DB Compare & Sync ---
  compareSchema: (srcConnId, tgtConnId) => ipcRenderer.invoke('db:compare-schema', srcConnId, tgtConnId),
  compareData: (srcConnId, tgtConnId, tableNames) => ipcRenderer.invoke('db:compare-data', srcConnId, tgtConnId, tableNames),
  generateSyncScript: (schemaDiff, direction) => ipcRenderer.invoke('db:generate-sync-script', schemaDiff, direction),
  applySync: (connId, script) => ipcRenderer.invoke('db:apply-sync', connId, script),

  // --- DB Migration ---
  migrationPlan: (srcId, tgtId, options) => ipcRenderer.invoke('migration:plan', srcId, tgtId, options),
  migrationRun: (runId, srcId, tgtId, options) => ipcRenderer.invoke('migration:run', runId, srcId, tgtId, options),
  migrationCancel: (runId) => ipcRenderer.invoke('migration:cancel', runId),
  migrationVerify: (srcId, tgtId, tables) => ipcRenderer.invoke('migration:verify', srcId, tgtId, tables),
  onMigrationProgress: (cb) => {
    const handler = (_event, evt) => cb(evt);
    ipcRenderer.on('migration:progress', handler);
    return () => ipcRenderer.removeListener('migration:progress', handler);
  },

  // --- Metrics ---
  getMetrics: (connectionId) => ipcRenderer.invoke('db:get-metrics', connectionId),

  // --- Query Favorites ---
  getFavorites: () => ipcRenderer.invoke('db:get-favorites'),
  saveFavorite: (favorite) => ipcRenderer.invoke('db:save-favorite', favorite),
  deleteFavorite: (id) => ipcRenderer.invoke('db:delete-favorite', id),

  // --- Import / Export ---
  exportData: (data, format) => ipcRenderer.invoke('db:export-data', data, format),
  importData: (connectionId, tableName) => ipcRenderer.invoke('db:import-data', connectionId, tableName),
  saveRawFile: (content, defaultPath, filters, isBase64) => ipcRenderer.invoke('db:save-raw-file', content, defaultPath, filters, isBase64),
  exportFullDatabase: (connectionId, format) => ipcRenderer.invoke('db:export-full-database', connectionId, format),
  onExportProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('db:export-progress', listener);
    return () => ipcRenderer.removeListener('db:export-progress', listener);
  },

  // --- Licensing ---
  license: {
    activate:     (apiKey, name, email) => ipcRenderer.invoke('license:activate', apiKey, name, email),
    validate:     ()       => ipcRenderer.invoke('license:validate'),
    checkVersion: ()       => ipcRenderer.invoke('license:check-version'),
    clear:        ()       => ipcRenderer.invoke('license:clear'),
  },

  // --- AI assistant (natural-language-to-SQL) ---
  ai: {
    listProviders: ()                        => ipcRenderer.invoke('ai:list-providers'),
    listModels:    (params)                  => ipcRenderer.invoke('ai:list-models', params),
    testModel:     (params)                  => ipcRenderer.invoke('ai:test-model', params),
    saveConfig:    (provider, apiKey, options) => ipcRenderer.invoke('ai:save-config', provider, apiKey, options),
    getStatus:     ()                        => ipcRenderer.invoke('ai:get-config-status'),
    clearConfig:   ()                        => ipcRenderer.invoke('ai:clear-config'),
    generateSql:   (params)                  => ipcRenderer.invoke('ai:generate-sql', params),
    askEr:         (params)                  => ipcRenderer.invoke('ai:er-ask', params),
    cancelGenerate: (requestId)               => ipcRenderer.invoke('ai:cancel-generate', requestId),
  },
});
