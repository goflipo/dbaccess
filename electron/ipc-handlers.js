const dbManager = require('./database');
const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

// ---------------------------------------------------------------------------
// SQL statement splitter — streaming state machine
// Handles: line comments, block comments, single quotes, double quotes,
//          dollar-quoted strings, COPY FROM stdin blocks, psql meta-commands
// ---------------------------------------------------------------------------
function extractSqlStatements(text, state, dollarTag, commentDepth, inCopyData) {
  const statements = []
  let stmt = ''
  let i = 0

  while (i < text.length) {
    const ch = text[i]
    const next = i + 1 < text.length ? text[i + 1] : ''

    // ── Inside a COPY FROM stdin data block ──────────────────────────────────
    if (inCopyData) {
      // \. on its own line ends the COPY data block
      const lineStart = (i === 0 || text[i - 1] === '\n')
      if (lineStart && ch === '\\' && next === '.') {
        // Skip the \. line
        while (i < text.length && text[i] !== '\n') i++
        inCopyData = false
        stmt = ''
      } else {
        i++
      }
      continue
    }

    switch (state) {
      case 'line_comment':
        if (ch === '\n') state = 'normal'
        stmt += ch; i++
        break

      case 'block_comment':
        if (ch === '/' && next === '*') { commentDepth++; stmt += '/*'; i += 2 }
        else if (ch === '*' && next === '/') {
          commentDepth--; stmt += '*/'; i += 2
          if (commentDepth === 0) state = 'normal'
        } else { stmt += ch; i++ }
        break

      case 'single_quote':
        if (ch === "'" && next === "'") { stmt += "''"; i += 2 }
        else { stmt += ch; i++; if (ch === "'") state = 'normal' }
        break

      case 'double_quote':
        stmt += ch; i++
        if (ch === '"') state = 'normal'
        break

      case 'dollar_quote':
        if (ch === '$' && text.startsWith(dollarTag, i)) {
          stmt += dollarTag; i += dollarTag.length; state = 'normal'; dollarTag = ''
        } else { stmt += ch; i++ }
        break

      default: { // normal
        if (ch === '-' && next === '-') {
          state = 'line_comment'; stmt += '--'; i += 2
        } else if (ch === '/' && next === '*') {
          state = 'block_comment'; commentDepth = 1; stmt += '/*'; i += 2
        } else if (ch === "'") {
          state = 'single_quote'; stmt += ch; i++
        } else if (ch === '"') {
          state = 'double_quote'; stmt += ch; i++
        } else if (ch === '$') {
          // Detect dollar-quoting: $tag$ or $$
          const rest = text.slice(i)
          const m = rest.match(/^\$([A-Za-z0-9_]*)\$/)
          if (m) {
            dollarTag = m[0]; state = 'dollar_quote'; stmt += dollarTag; i += dollarTag.length
          } else { stmt += ch; i++ }
        } else if (ch === ';') {
          stmt += ch; i++
          const trimmed = stmt.trim()
          if (trimmed.length > 1 && trimmed !== ';') {
            // Skip psql meta-commands (\connect, \set, etc.)
            if (!trimmed.startsWith('\\')) {
              // Detect COPY ... FROM stdin; — the data follows
              if (/^COPY\s+\S.*\bFROM\s+stdin\b/i.test(trimmed)) {
                inCopyData = true
              } else {
                statements.push(trimmed)
              }
            }
          }
          stmt = ''
        } else { stmt += ch; i++ }
        break
      }
    }
  }

  return { statements, remaining: stmt, state, dollarTag, commentDepth, inCopyData }
}

// Active streaming jobs — keyed by sessionId for cancellation
const activeSqlJobs = new Map()

function registerIpcHandlers(ipcMain, dialog) {
  ipcMain.handle('db:connect', async (event, config) => {
    try { 
      const result = await dbManager.connect(config); 
      if (result.success) dbManager.saveConnectionConfig(config);
      return result;
    }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:get-connections', async () => {
    try { return { success: true, data: dbManager.getAllConnections() }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:get-saved-connections', async () => {
    try { return { success: true, data: dbManager.getSavedConnections() }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:delete-saved-connection', async (event, id) => {
    try { dbManager.deleteConnectionConfig(id); return { success: true }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:rename-connection', async (event, id, newName) => {
    try { dbManager.renameConnectionConfig(id, newName); return { success: true }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  // Legacy small-file handler kept for backwards compat — replaced by streaming below

  ipcMain.handle('db:run-sql-file', async (event, connectionId) => {
    // Redirect to streaming version
    return { success: false, error: 'Use db:execute-sql-file for streaming execution' };
  });

  ipcMain.handle('db:execute-sql-file', async (event, connectionId) => {
    let dedicatedClient = null
    const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2)

    const send = (data) => {
      try { if (!event.sender.isDestroyed()) event.sender.send('sql-file-progress', data) } catch (_) {}
    }

    try {
      const parentWindow = BrowserWindow.getFocusedWindow();
      const dlg = await dialog.showOpenDialog(parentWindow, {
        title: 'Execute SQL File',
        filters: [{ name: 'SQL Files', extensions: ['sql', 'txt'] }, { name: 'All Files', extensions: ['*'] }],
        properties: ['openFile'],
      });
      if (dlg.canceled || dlg.filePaths.length === 0) return { success: false, error: 'Cancelled' };

      const filePath = dlg.filePaths[0];
      const fileName = path.basename(filePath);
      const totalBytes = fs.statSync(filePath).size;
      const session = { cancelled: false }
      activeSqlJobs.set(sessionId, session)

      send({ type: 'start', sessionId, fileName, totalBytes })

      const conn = dbManager.getConnection(connectionId)
      if (!conn) {
        send({ type: 'done', sessionId, stmtExecuted: 0, errCount: 1, bytesProcessed: 0, totalBytes, fileName, errors: [{ stmt: '', msg: 'Connection not found' }] })
        return { success: false, error: 'Connection not found' }
      }

      // Acquire a single persistent connection for all statements — avoids
      // pool overhead of connect/release on every statement for large files.
      let runQuery
      if (conn.type === 'postgres') {
        dedicatedClient = await conn.client.connect()
        runQuery = (sql) => dedicatedClient.query(sql)
      } else if (conn.type === 'mysql') {
        dedicatedClient = await conn.client.getConnection()
        runQuery = (sql) => dedicatedClient.query(sql)
      } else {
        runQuery = (sql) => conn.client.query({ query: sql, format: 'JSONEachRow' })
      }

      let buffer = '', parseState = 'normal', dollarTag = '', commentDepth = 0, inCopyData = false
      let bytesProcessed = 0, stmtExecuted = 0, errCount = 0
      const errors = []
      let lastProgressMs = 0

      const flushProgress = (preview) => {
        const now = Date.now()
        if (now - lastProgressMs >= 100) {
          lastProgressMs = now
          send({ type: 'progress', sessionId, stmtExecuted, errCount, bytesProcessed, totalBytes, fileName, preview: preview || '' })
        }
      }

      const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 256 * 1024 })

      for await (const chunk of stream) {
        if (session.cancelled) break

        buffer += chunk
        bytesProcessed += Buffer.byteLength(chunk, 'utf8')

        const parsed = extractSqlStatements(buffer, parseState, dollarTag, commentDepth, inCopyData)
        buffer    = parsed.remaining
        parseState   = parsed.state
        dollarTag    = parsed.dollarTag
        commentDepth = parsed.commentDepth
        inCopyData   = parsed.inCopyData

        for (const stmt of parsed.statements) {
          if (session.cancelled) break
          stmtExecuted++
          const preview = stmt.replace(/\s+/g, ' ').substring(0, 90)
          try {
            await runQuery(stmt)
          } catch (err) {
            errCount++
            const entry = { stmt: stmt.replace(/\s+/g, ' ').substring(0, 200), msg: err.message }
            errors.push(entry)
            if (errors.length <= 50) send({ type: 'error', sessionId, ...entry, stmtExecuted, errCount, bytesProcessed, totalBytes, fileName })
          }
          flushProgress(preview)
        }

        // Always send progress after each chunk so the bar moves even during
        // COPY data blocks where no statements are extracted.
        flushProgress()

        // Yield the Node.js event loop after each chunk so the main process
        // stays responsive to other IPC messages and timer callbacks.
        await new Promise(resolve => setImmediate(resolve))
      }

      // Execute any trailing statement that had no closing semicolon
      const tail = buffer.trim()
      if (tail && tail !== ';' && !session.cancelled && !tail.startsWith('\\')) {
        stmtExecuted++
        try { await runQuery(tail) }
        catch (err) { errCount++; errors.push({ stmt: tail.substring(0, 200), msg: err.message }) }
      }

      activeSqlJobs.delete(sessionId)
      const finalType = session.cancelled ? 'cancelled' : 'done'
      send({ type: finalType, sessionId, stmtExecuted, errCount, bytesProcessed: totalBytes, totalBytes, fileName, errors: errors.slice(0, 50) })

      return { success: true, sessionId, stmtExecuted, errCount, cancelled: session.cancelled }
    } catch (err) {
      send({ type: 'done', sessionId, stmtExecuted: 0, errCount: 1, bytesProcessed: 0, totalBytes: 0, fileName: '', errors: [{ stmt: '', msg: err.message }] })
      return { success: false, error: err.message }
    } finally {
      activeSqlJobs.delete(sessionId)
      if (dedicatedClient) {
        try { dedicatedClient.release() } catch (_) {}
      }
    }
  });

  ipcMain.handle('db:cancel-sql-file', async (event, sessionId) => {
    const session = activeSqlJobs.get(sessionId)
    if (session) { session.cancelled = true; activeSqlJobs.delete(sessionId) }
    return { success: true }
  });

  ipcMain.handle('db:disconnect', async (event, connectionId) => {
    try { await dbManager.disconnect(connectionId); return { success: true }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:test-connection', async (event, config) => {
    try {
      const testConfig = { ...config, id: '__test__' };
      await dbManager.connect(testConfig);
      await dbManager.disconnect('__test__');
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:execute-query', async (event, connectionId, query) => {
    try {
      const result = await dbManager.executeQuery(connectionId, query);
      return { success: true, data: result };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:explain-query', async (event, connectionId, query) => {
    try {
      const result = await dbManager.explainQuery(connectionId, query);
      return { success: true, data: result };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:get-databases', async (event, connectionId) => {
    try { return { success: true, data: await dbManager.getDatabases(connectionId) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:get-tables', async (event, connectionId, database) => {
    try { return { success: true, data: await dbManager.getTables(connectionId, database) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:get-current-database', async (event, connectionId) => {
    try { return { success: true, data: await dbManager.getCurrentDatabase(connectionId) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:switch-database', async (event, connectionId, newDatabase) => {
    try { return await dbManager.switchDatabase(connectionId, newDatabase); }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:get-table-structure', async (event, connectionId, table) => {
    try { return { success: true, data: await dbManager.getTableStructure(connectionId, table) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:get-table-extras', async (event, connectionId, table) => {
    try { return { success: true, data: await dbManager.getTableExtras(connectionId, table) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:get-fk-impact', async (event, connectionId, tableName, rows) => {
    try { return { success: true, data: await dbManager.getFkImpact(connectionId, tableName, rows || []) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:get-schema-full', async (event, connectionId) => {
    try { return { success: true, data: await dbManager.getSchemaFull(connectionId) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  // --- User Management ---
  ipcMain.handle('db:get-user-management', async (event, connectionId) => {
    try { return { success: true, data: await dbManager.getUserManagement(connectionId) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:create-user', async (event, connectionId, username, password, options) => {
    try { return await dbManager.createUser(connectionId, username, password, options); }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:drop-user', async (event, connectionId, username) => {
    try { return await dbManager.dropUser(connectionId, username); }
    catch (error) { return { success: false, error: error.message }; }
  });

  // --- DB Compare & Sync ---
  ipcMain.handle('db:compare-schema', async (event, srcConnId, tgtConnId) => {
    try { return { success: true, data: await dbManager.compareSchema(srcConnId, tgtConnId) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:compare-data', async (event, srcConnId, tgtConnId, tableNames) => {
    try { return { success: true, data: await dbManager.compareData(srcConnId, tgtConnId, tableNames) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:generate-sync-script', async (event, schemaDiff, direction) => {
    try { return { success: true, data: dbManager.generateSyncScript(schemaDiff, direction) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:apply-sync', async (event, connId, script) => {
    try { return { success: true, data: await dbManager.applySyncScript(connId, script) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  // --- Metrics ---
  ipcMain.handle('db:get-metrics', async (event, connectionId) => {
    try { return { success: true, data: await dbManager.getMetrics(connectionId) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  // --- Query Favorites ---
  ipcMain.handle('db:get-favorites', async () => {
    try { return { success: true, data: dbManager.getFavorites() }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:save-favorite', async (event, favorite) => {
    try { return dbManager.saveFavorite(favorite); }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:delete-favorite', async (event, id) => {
    try { return dbManager.deleteFavorite(id); }
    catch (error) { return { success: false, error: error.message }; }
  });

  // --- Export ---
  ipcMain.handle('db:export-data', async (event, data, format) => {
    try {
      const { columns, rows } = data;
      let fileContent = '', defaultExt = '', filters = [];

      if (format === 'csv') {
        const { stringify } = require('csv-stringify/sync');
        const header = columns.map(c => c.name);
        fileContent = stringify([header, ...rows.map(row => header.map(col => row[col]))]);
        defaultExt = 'csv';
        filters = [{ name: 'CSV Files', extensions: ['csv'] }];
      } else if (format === 'json') {
        fileContent = JSON.stringify(rows, null, 2);
        defaultExt = 'json';
        filters = [{ name: 'JSON Files', extensions: ['json'] }];
      } else if (format === 'sql') {
        const colNames = columns.map(c => c.name).join(', ');
        fileContent = rows.map(row => {
          const values = columns.map(c => {
            const val = row[c.name];
            if (val === null || val === undefined) return 'NULL';
            if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
            if (val instanceof Date) return `'${val.toISOString()}'`;
            if (typeof val === 'number') return val;
            if (Array.isArray(val)) {
              if (val.length === 0) return "'{}'";
              const els = val.map(el => {
                if (el === null || el === undefined) return 'NULL';
                if (typeof el === 'number' || typeof el === 'boolean') return el;
                return `"${String(el).replace(/"/g, '\\"')}"`;
              }).join(',');
              return `'{ ${els} }'`;
            }
            if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
            return `'${String(val).replace(/'/g, "''")}'`;
          }).join(', ');
          return `INSERT INTO exported_table (${colNames}) VALUES (${values});`;
        }).join('\n');
        defaultExt = 'sql';
        filters = [{ name: 'SQL Files', extensions: ['sql'] }];
      }

      const parentWindow = BrowserWindow.getFocusedWindow();
      const result = await dialog.showSaveDialog(parentWindow, { title: 'Export Data', defaultPath: `export.${defaultExt}`, filters });
      if (!result.canceled && result.filePath) {
        fs.writeFileSync(result.filePath, fileContent, 'utf-8');
        return { success: true, filePath: result.filePath };
      }
      return { success: false, error: 'Export cancelled' };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:import-data', async (event, connectionId, tableName) => {
    try {
      const parentWindow = BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(parentWindow, {
        title: 'Import CSV File',
        filters: [{ name: 'CSV Files', extensions: ['csv'] }, { name: 'All Files', extensions: ['*'] }],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) return { success: false, error: 'Import cancelled' };

      const fileContent = fs.readFileSync(result.filePaths[0], 'utf-8');
      const { parse } = require('csv-parse/sync');
      const records = parse(fileContent, { columns: true, skip_empty_lines: true, trim: true });
      if (records.length === 0) return { success: false, error: 'No data found in file' };

      const conn = dbManager.getConnection(connectionId);
      if (!conn) throw new Error('Connection not found');
      const columns = Object.keys(records[0]);
      let insertedCount = 0;

      if (conn.type === 'postgres') {
        const qTablePg = tableName.split('.').map(p => `"${p.replace(/"/g, '""')}"`).join('.');
        for (const record of records) {
          const values = columns.map((_, i) => `$${i + 1}`).join(', ');
          const quotedColumns = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
          await conn.client.query(`INSERT INTO ${qTablePg} (${quotedColumns}) VALUES (${values})`, columns.map(col => record[col]));
          insertedCount++;
        }
      } else if (conn.type === 'mysql') {
        const qTableMy = tableName.split('.').map(p => `\`${p.replace(/`/g, '``')}\``).join('.');
        const quotedColumns = columns.map(c => `\`${c.replace(/`/g, '``')}\``).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        for (const record of records) {
          await conn.client.query(
            `INSERT INTO ${qTableMy} (${quotedColumns}) VALUES (${placeholders})`,
            columns.map(col => record[col])
          );
          insertedCount++;
        }
      } else if (conn.type === 'clickhouse') {
        await conn.client.insert({ table: tableName, values: records, format: 'JSONEachRow' });
        insertedCount = records.length;
      }
      return { success: true, insertedCount, filePath: result.filePaths[0] };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:save-raw-file', async (event, content, defaultPath, filters, isBase64 = false) => {
    try {
      const parentWindow = BrowserWindow.getFocusedWindow();
      const result = await dialog.showSaveDialog(parentWindow, { title: 'Export File', defaultPath, filters });
      
      if (!result.canceled && result.filePath) {
        if (isBase64) {
          const base64Data = content.replace(/^data:image\/.*?;base64,/, "");
          const buffer = Buffer.from(base64Data, 'base64');
          fs.writeFileSync(result.filePath, buffer);
        } else {
          fs.writeFileSync(result.filePath, content, 'utf-8');
        }
        return { success: true, filePath: result.filePath };
      }
      return { success: false, error: 'Cancelled' };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('db:export-full-database', async (event, connectionId, format) => {
    try {
      const parentWindow = BrowserWindow.getFocusedWindow();
      let targetPath = '';

      const dbInfo = await dbManager.getCurrentDatabase(connectionId).catch(() => null);
      const dbName = dbInfo?.db || 'database';
      if (format === 'sql') {
        const result = await dialog.showSaveDialog(parentWindow, {
          title: 'Export Database as SQL',
          defaultPath: `${dbName}.sql`,
          filters: [{ name: 'SQL Files', extensions: ['sql'] }]
        });
        if (result.canceled || !result.filePath) return { success: false, error: 'Cancelled' };
        targetPath = result.filePath;
        fs.writeFileSync(targetPath, `-- Full Database Export\n-- Generated on ${new Date().toISOString()}\n\n`, 'utf-8');
      } else {
        const result = await dialog.showOpenDialog(parentWindow, {
          title: 'Select Folder for CSV Export',
          properties: ['openDirectory', 'createDirectory']
        });
        if (result.canceled || result.filePaths.length === 0) return { success: false, error: 'Cancelled' };
        targetPath = result.filePaths[0];
      }

      await dbManager.exportFullDatabase(connectionId, format, targetPath, (msg, current, total) => {
        event.sender.send('db:export-progress', { msg, current, total });
      });

      return { success: true, filePath: targetPath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerIpcHandlers };
