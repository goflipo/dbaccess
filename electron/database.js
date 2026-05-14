// ── Timezone fix ───────────────────────────────────────────────────────────
// The pg library sends the Node.js process timezone to PostgreSQL on connect.
// On Windows/India this resolves to "GMT+0530" which PostgreSQL doesn't accept.
// Pin both PGTZ (pg-specific) and TZ (Node.js process) to UTC so pg always
// sends a valid value.  Must be set BEFORE requiring pg.
process.env.PGTZ = 'UTC';
process.env.TZ   = 'UTC';
// ───────────────────────────────────────────────────────────────────────────

const { Pool } = require('pg');
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const net = require('net');

// PostgreSQL OID → human-readable type name
const PG_OID_TYPES = {
  16: 'bool', 17: 'bytea', 18: 'char', 19: 'name',
  20: 'int8', 21: 'int2', 23: 'int4', 25: 'text',
  26: 'oid', 114: 'json', 600: 'point', 700: 'float4',
  701: 'float8', 790: 'money', 829: 'macaddr', 869: 'inet',
  1042: 'bpchar', 1043: 'varchar', 1082: 'date', 1083: 'time',
  1114: 'timestamp', 1184: 'timestamptz', 1186: 'interval',
  1560: 'bit', 1562: 'varbit', 1700: 'numeric', 2950: 'uuid',
  3802: 'jsonb', 3904: 'int4range', 3926: 'int8range',
};

// MySQL field type IDs → human-readable type name
const MYSQL_FIELD_TYPES = {
  0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float',
  5: 'double', 7: 'timestamp', 8: 'bigint', 9: 'mediumint', 10: 'date',
  11: 'time', 12: 'datetime', 13: 'year', 15: 'varchar', 16: 'bit',
  246: 'decimal', 247: 'enum', 248: 'set', 249: 'tinyblob',
  250: 'mediumblob', 251: 'longblob', 252: 'blob', 253: 'varchar',
  254: 'char', 255: 'geometry',
};

class DatabaseManager {
  constructor() {
    this.connections = new Map();
    this.sshTunnels = new Map();
  }

  // --- SSH Tunnel helper ---
  async openSshTunnel(config) {
    return new Promise((resolve, reject) => {
      const { Client } = require('ssh2');
      const ssh = new Client();

      const sshConfig = {
        host: config.sshHost,
        port: parseInt(config.sshPort) || 22,
        username: config.sshUser,
      };

      // Key file or password auth
      if (config.sshKey && config.sshKey.trim()) {
        try {
          sshConfig.privateKey = fs.readFileSync(config.sshKey.trim());
        } catch (e) {
          // If key file not found, try password fallback
          sshConfig.password = config.sshPassword || '';
        }
      } else if (config.sshPassword) {
        sshConfig.password = config.sshPassword;
      }

      // Find a free local port
      const localPort = 10000 + Math.floor(Math.random() * 10000);
      const remoteHost = config.host || 'localhost';
      const remotePort = parseInt(config.port) || 5432;

      const server = net.createServer((sock) => {
        ssh.forwardOut(
          '127.0.0.1', sock.localPort,
          remoteHost, remotePort,
          (err, stream) => {
            if (err) { sock.destroy(); return; }
            sock.pipe(stream).pipe(sock);
          }
        );
      });

      server.listen(localPort, '127.0.0.1', () => {
        console.log(`SSH tunnel listening on 127.0.0.1:${localPort} → ${remoteHost}:${remotePort}`);
      });

      ssh.on('ready', () => {
        resolve({ ssh, server, localPort });
      });

      ssh.on('error', (err) => {
        server.close();
        reject(new Error(`SSH connection failed: ${err.message}`));
      });

      ssh.connect(sshConfig);
    });
  }

  async connect(config) {
    const { id, type, host, port, database, username, password, ssl, sshEnabled } = config;
    if (this.connections.has(id)) await this.disconnect(id);

    let effectiveHost = host;
    let effectivePort = port;

    // Set up SSH tunnel if enabled
    if (sshEnabled) {
      try {
        const tunnel = await this.openSshTunnel(config);
        this.sshTunnels.set(id, tunnel);
        effectiveHost = '127.0.0.1';
        effectivePort = tunnel.localPort;
      } catch (err) {
        throw new Error(`SSH Tunnel Error: ${err.message}`);
      }
    }

    if (type === 'postgres') {
      const pool = new Pool({
        host: effectiveHost,
        port: parseInt(effectivePort) || 5432,
        database: database || 'postgres',
        user: username,
        password,
        ssl: ssl ? { rejectUnauthorized: false } : false,
        max: 5,
        options: '-c TimeZone=UTC',
      });
      // Definitive timezone fix: run on every new physical connection so the
      // pg library cannot override it with the Windows system offset (GMT+0530).
      pool.on('connect', (client) => {
        client.query("SET TimeZone = 'UTC'").catch(() => {});
      });
      const client = await pool.connect();
      // Capture actual connected DB name
      const dbResult = await client.query('SELECT current_database()');
      const activeDb = dbResult.rows[0]?.current_database || database || 'postgres';
      client.release();
      this.connections.set(id, { client: pool, config: { ...config, database: activeDb }, type: 'postgres', activeDb });
      console.log(`[DB] Connected to PostgreSQL database: "${activeDb}" on ${effectiveHost}:${effectivePort || 5432}`);
      return { success: true, id, activeDb };
    } else if (type === 'clickhouse') {
      const { createClient } = require('@clickhouse/client');
      const client = createClient({
        url: `http://${effectiveHost}:${effectivePort || 8123}`,
        username: username || 'default',
        password: password || '',
        database: database || 'default',
      });
      await client.query({ query: 'SELECT 1', format: 'JSONEachRow' });
      this.connections.set(id, { client, config, type: 'clickhouse' });
      return { success: true, id };
    } else if (type === 'mysql') {
      const mysql = require('mysql2/promise');
      const pool = mysql.createPool({
        host: effectiveHost,
        port: parseInt(effectivePort) || 3306,
        database: database || undefined,
        user: username,
        password: password || '',
        ssl: ssl ? { rejectUnauthorized: false } : undefined,
        connectionLimit: 5,
        timezone: '+00:00',
        multipleStatements: true,
      });
      const conn2 = await pool.getConnection();
      const [dbRows] = await conn2.query('SELECT DATABASE() AS db, VERSION() AS ver');
      const activeDb = dbRows[0]?.db || database || '';
      conn2.release();
      this.connections.set(id, { client: pool, config: { ...config, database: activeDb }, type: 'mysql', activeDb });
      console.log(`[DB] Connected to MySQL database: "${activeDb}" on ${effectiveHost}:${effectivePort || 3306}`);
      return { success: true, id, activeDb };
    }
    throw new Error(`Unsupported database type: ${type}`);
  }

  async disconnect(id) {
    const conn = this.connections.get(id);
    if (conn) {
      try {
        if (conn.type === 'postgres') await conn.client.end();
        else if (conn.type === 'clickhouse') await conn.client.close();
        else if (conn.type === 'mysql') await conn.client.end();
      } catch (e) { console.error('Disconnect error:', e); }
      this.connections.delete(id);
    }

    // Close SSH tunnel if any
    const tunnel = this.sshTunnels.get(id);
    if (tunnel) {
      try {
        tunnel.server.close();
        tunnel.ssh.end();
      } catch (e) { console.error('SSH tunnel close error:', e); }
      this.sshTunnels.delete(id);
    }
  }

  async executeQuery(connectionId, query) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');
    const startTime = Date.now();

    if (conn.type === 'postgres') {
      const result = await conn.client.query(query);
      // Normalise rows: convert Date objects to ISO strings so the renderer
      // always receives plain JSON-safe values (avoids the Date.toString() bug).
      const rows = (result.rows || []).map(row => {
        const out = {};
        for (const [k, v] of Object.entries(row)) {
          out[k] = v instanceof Date ? v.toISOString() : v;
        }
        return out;
      });
      return {
        columns: result.fields ? result.fields.map(f => ({
          name: f.name,
          dataType: PG_OID_TYPES[f.dataTypeID] || String(f.dataTypeID),
          dataTypeID: f.dataTypeID,
        })) : [],
        rows, rowCount: result.rowCount,
        duration: Date.now() - startTime, command: result.command,
      };
    } else if (conn.type === 'clickhouse') {
      const resultSet = await conn.client.query({ query, format: 'JSONEachRow' });
      const rows = await resultSet.json();
      const columns = rows.length > 0 ? Object.keys(rows[0]).map(name => ({ name, dataType: 'unknown' })) : [];
      return {
        columns, rows, rowCount: rows.length,
        duration: Date.now() - startTime,
        command: query.trim().split(/\s+/)[0].toUpperCase(),
      };
    } else if (conn.type === 'mysql') {
      const [rows, fields] = await conn.client.query(query);
      const command = query.trim().split(/\s+/)[0].toUpperCase();
      // Non-SELECT: rows is an OkPacket or array of OkPackets
      if (!Array.isArray(rows)) {
        return { columns: [], rows: [], rowCount: rows.affectedRows || 0, duration: Date.now() - startTime, command };
      }
      // Multi-statement returns array of result sets — return last SELECT result set
      const resultRows = Array.isArray(rows[0]) ? rows[rows.length - 1] : rows;
      const resultFields = Array.isArray(fields?.[0]) ? fields[fields.length - 1] : fields;
      const normalizedRows = resultRows.map(row => {
        const out = {};
        for (const [k, v] of Object.entries(row)) {
          out[k] = v instanceof Date ? v.toISOString() : v;
        }
        return out;
      });
      return {
        columns: resultFields ? resultFields.map(f => ({
          name: f.name,
          dataType: MYSQL_FIELD_TYPES[f.type] || String(f.type),
          dataTypeID: f.type,
        })) : [],
        rows: normalizedRows,
        rowCount: normalizedRows.length,
        duration: Date.now() - startTime,
        command,
      };
    }
  }

  async explainQuery(connectionId, query) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');

    if (conn.type === 'postgres') {
      const result = await conn.client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${query}`);
      return { plan: result.rows.map(r => r['QUERY PLAN']).join('\n') };
    } else if (conn.type === 'clickhouse') {
      const rs = await conn.client.query({ query: `EXPLAIN PLAN ${query}`, format: 'JSONEachRow' });
      const rows = await rs.json();
      return { plan: rows.map(r => JSON.stringify(r)).join('\n') };
    } else if (conn.type === 'mysql') {
      const [rows] = await conn.client.query(`EXPLAIN ${query}`);
      return { plan: rows.map(r => Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' | ')).join('\n') };
    }
  }

  async getDatabases(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');
    if (conn.type === 'postgres') {
      const result = await conn.client.query("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
      return result.rows.map(r => r.datname);
    } else if (conn.type === 'mysql') {
      const [rows] = await conn.client.query('SHOW DATABASES');
      return rows.map(r => r.Database);
    } else {
      const rs = await conn.client.query({ query: 'SHOW DATABASES', format: 'JSONEachRow' });
      return (await rs.json()).map(r => r.name);
    }
  }

  async getTables(connectionId, database) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');
    if (conn.type === 'mysql') {
      const db = database || conn.activeDb || conn.config.database;
      if (!db) return [];
      const [rows] = await conn.client.query(
        `SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]
      );
      return rows.map(r => ({
        schema: db,
        name: r.TABLE_NAME,
        type: r.TABLE_TYPE,
        fullName: `${db}.${r.TABLE_NAME}`,
      }));
    } else if (conn.type === 'postgres') {
      // Always log which DB we're querying
      const currentDbRes = await conn.client.query('SELECT current_database() AS db').catch(() => ({ rows: [] }));
      const currentDb = currentDbRes.rows[0]?.db || '?';
      console.log(`[DB] getTables → PostgreSQL database: "${currentDb}"`);

      const result = await conn.client.query(
        `SELECT table_schema, table_name, table_type
         FROM information_schema.tables
         WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         ORDER BY table_schema, table_name`
      );
      console.log(`[DB] Found ${result.rows.length} tables/views in "${currentDb}"`);
      return result.rows.map(r => ({
        schema: r.table_schema,
        name: r.table_name,
        type: r.table_type, // 'BASE TABLE' or 'VIEW'
        fullName: `${r.table_schema}.${r.table_name}`
      }));
    } else {
      const q = database ? `SHOW TABLES FROM \`${database.replace(/`/g, '``')}\`` : 'SHOW TABLES';
      const rs = await conn.client.query({ query: q, format: 'JSONEachRow' });
      const dbName = database || conn.config?.database || 'default';
      return (await rs.json()).map(r => ({ schema: dbName, name: r.name, type: 'BASE TABLE', fullName: `${dbName}.${r.name}` }));
    }
  }

  async getCurrentDatabase(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');
    if (conn.type === 'postgres') {
      const res = await conn.client.query('SELECT current_database() AS db, current_user AS usr, version() AS ver');
      return { db: res.rows[0]?.db, user: res.rows[0]?.usr, version: res.rows[0]?.ver };
    } else if (conn.type === 'mysql') {
      const [rows] = await conn.client.query('SELECT DATABASE() AS db, USER() AS usr, VERSION() AS ver');
      return { db: rows[0]?.db || conn.activeDb, user: rows[0]?.usr, version: `MySQL ${rows[0]?.ver}` };
    } else {
      return { db: conn.config?.database || 'default', user: conn.config?.username || 'default', version: 'ClickHouse' };
    }
  }

  async switchDatabase(connectionId, newDatabase) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');
    if (conn.type === 'mysql') {
      const mysql = require('mysql2/promise');
      const cfg = conn.config;
      try { await conn.client.end(); } catch (e) { /* ignore */ }
      const pool = mysql.createPool({
        host: cfg.host, port: parseInt(cfg.port) || 3306,
        database: newDatabase, user: cfg.username, password: cfg.password || '',
        ssl: cfg.ssl ? { rejectUnauthorized: false } : undefined,
        connectionLimit: 5, timezone: '+00:00', multipleStatements: true,
      });
      this.connections.set(connectionId, { client: pool, config: { ...cfg, database: newDatabase }, type: 'mysql', activeDb: newDatabase });
      console.log(`[DB] Switched MySQL to database: "${newDatabase}"`);
      return { success: true, activeDb: newDatabase };
    }
    if (conn.type !== 'postgres') throw new Error('Database switching only supported for PostgreSQL and MySQL');

    console.log(`[DB] Switching database → "${newDatabase}"`);
    const cfg = conn.config;

    // Close old pool
    try { await conn.client.end(); } catch (e) { /* ignore */ }

    // New pool to the selected database
    const pool = new Pool({
      host: cfg.host,
      port: parseInt(cfg.port) || 5432,
      database: newDatabase,
      user: cfg.username,
      password: cfg.password,
      ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
      max: 5,
      options: '-c TimeZone=UTC',
    });
    pool.on('connect', (client) => {
      client.query("SET TimeZone = 'UTC'").catch(() => {});
    });
    const client = await pool.connect();
    client.release();

    this.connections.set(connectionId, { client: pool, config: { ...cfg, database: newDatabase }, type: 'postgres', activeDb: newDatabase });
    console.log(`[DB] Switched to database: "${newDatabase}"`);
    return { success: true, activeDb: newDatabase };
  }

  async getTableStructure(connectionId, tableName) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');
    if (conn.type === 'mysql') {
      const parts = tableName.split('.');
      const db = parts.length > 1 ? parts[0] : (conn.activeDb || conn.config.database);
      const table = parts.length > 1 ? parts[1] : parts[0];
      const [rows] = await conn.client.query(
        `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, COLUMN_TYPE AS udt_name,
                IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default
         FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`, [db, table]
      );
      return rows;
    } else if (conn.type === 'postgres') {
      const parts = tableName.split('.');
      const schema = parts.length > 1 ? parts[0] : 'public';
      const table = parts.length > 1 ? parts[1] : parts[0];
      const result = await conn.client.query(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, table]
      );
      return result.rows;
    } else {
      const quotedChTable = tableName.split('.').map(p => `\`${p.replace(/`/g, '``')}\``).join('.');
      const rs = await conn.client.query({ query: `DESCRIBE TABLE ${quotedChTable}`, format: 'JSONEachRow' });
      return await rs.json();
    }
  }

  async getFkImpact(connectionId, tableName, rows) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');
    const parts = tableName.split('.');
    const isTruncate = rows.length === 0;

    if (conn.type === 'postgres') {
      const schema = parts.length > 1 ? parts[0] : 'public';
      const table  = parts.length > 1 ? parts[1] : parts[0];
      const fkRes = await conn.client.query(`
        SELECT DISTINCT tc.table_schema AS ref_schema, tc.table_name AS ref_table,
          kcu.column_name AS ref_column, ccu.column_name AS src_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_schema = $1 AND ccu.table_name = $2
        ORDER BY tc.table_schema, tc.table_name`, [schema, table]);

      const refs = [];
      for (const fk of fkRes.rows) {
        let affectedRows = [], affectedCount = 0;
        if (isTruncate) {
          const cr = await conn.client.query(`SELECT COUNT(*) AS cnt FROM "${fk.ref_schema}"."${fk.ref_table}"`).catch(() => ({ rows: [{ cnt: 0 }] }));
          affectedCount = parseInt(cr.rows[0]?.cnt) || 0;
          if (affectedCount > 0) {
            const pr = await conn.client.query(`SELECT * FROM "${fk.ref_schema}"."${fk.ref_table}" LIMIT 5`).catch(() => ({ rows: [] }));
            affectedRows = pr.rows;
          }
        } else {
          const vals = rows.map(r => r[fk.src_column]).filter(v => v !== null && v !== undefined);
          if (vals.length > 0) {
            const ph = vals.map((_, i) => `$${i + 1}`).join(', ');
            const cr = await conn.client.query(`SELECT COUNT(*) AS cnt FROM "${fk.ref_schema}"."${fk.ref_table}" WHERE "${fk.ref_column}" IN (${ph})`, vals).catch(() => ({ rows: [{ cnt: 0 }] }));
            affectedCount = parseInt(cr.rows[0]?.cnt) || 0;
            const pr = await conn.client.query(`SELECT * FROM "${fk.ref_schema}"."${fk.ref_table}" WHERE "${fk.ref_column}" IN (${ph}) LIMIT 20`, vals).catch(() => ({ rows: [] }));
            affectedRows = pr.rows;
          }
        }
        refs.push({ refSchema: fk.ref_schema, refTable: fk.ref_table, refColumn: fk.ref_column, srcColumn: fk.src_column, fullTableName: `${fk.ref_schema}.${fk.ref_table}`, affectedRows, affectedCount });
      }
      return refs;

    } else if (conn.type === 'mysql') {
      const db    = parts.length > 1 ? parts[0] : (conn.activeDb || conn.config.database);
      const table = parts.length > 1 ? parts[1] : parts[0];
      const [fkRows] = await conn.client.query(`
        SELECT DISTINCT KCU.TABLE_SCHEMA AS ref_schema, KCU.TABLE_NAME AS ref_table,
          KCU.COLUMN_NAME AS ref_column, KCU.REFERENCED_COLUMN_NAME AS src_column
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE KCU
        JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS TC
          ON KCU.CONSTRAINT_NAME = TC.CONSTRAINT_NAME AND KCU.TABLE_SCHEMA = TC.TABLE_SCHEMA
        WHERE TC.CONSTRAINT_TYPE = 'FOREIGN KEY'
          AND KCU.REFERENCED_TABLE_SCHEMA = ? AND KCU.REFERENCED_TABLE_NAME = ?
        ORDER BY KCU.TABLE_SCHEMA, KCU.TABLE_NAME`, [db, table]);

      const refs = [];
      for (const fk of fkRows) {
        let affectedRows = [], affectedCount = 0;
        if (isTruncate) {
          const [[cr]] = await conn.client.query(`SELECT COUNT(*) AS cnt FROM \`${fk.ref_schema}\`.\`${fk.ref_table}\``).catch(() => [[{ cnt: 0 }]]);
          affectedCount = parseInt(cr?.cnt) || 0;
          if (affectedCount > 0) {
            const [pr] = await conn.client.query(`SELECT * FROM \`${fk.ref_schema}\`.\`${fk.ref_table}\` LIMIT 5`).catch(() => [[]]);
            affectedRows = pr;
          }
        } else {
          const vals = rows.map(r => r[fk.src_column]).filter(v => v !== null && v !== undefined);
          if (vals.length > 0) {
            const ph = vals.map(() => '?').join(', ');
            const [[cr]] = await conn.client.query(`SELECT COUNT(*) AS cnt FROM \`${fk.ref_schema}\`.\`${fk.ref_table}\` WHERE \`${fk.ref_column}\` IN (${ph})`, vals).catch(() => [[{ cnt: 0 }]]);
            affectedCount = parseInt(cr?.cnt) || 0;
            const [pr] = await conn.client.query(`SELECT * FROM \`${fk.ref_schema}\`.\`${fk.ref_table}\` WHERE \`${fk.ref_column}\` IN (${ph}) LIMIT 20`, vals).catch(() => [[]]);
            affectedRows = pr;
          }
        }
        refs.push({ refSchema: fk.ref_schema, refTable: fk.ref_table, refColumn: fk.ref_column, srcColumn: fk.src_column, fullTableName: `${fk.ref_schema}.${fk.ref_table}`, affectedRows, affectedCount });
      }
      return refs;
    }
    return []; // ClickHouse: no FK constraints
  }

  async getSchemaFull(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');

    if (conn.type === 'mysql') {
      const db = conn.activeDb || conn.config.database;
      const [colRows] = await conn.client.query(`
        SELECT t.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE
        FROM INFORMATION_SCHEMA.TABLES t
        JOIN INFORMATION_SCHEMA.COLUMNS c ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
        ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION
      `, [db]);
      const [fkRows] = await conn.client.query(`
        SELECT KCU.TABLE_NAME, KCU.COLUMN_NAME, KCU.REFERENCED_TABLE_NAME, KCU.REFERENCED_COLUMN_NAME
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE KCU
        JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS TC
          ON KCU.CONSTRAINT_NAME = TC.CONSTRAINT_NAME AND KCU.TABLE_SCHEMA = TC.TABLE_SCHEMA
        WHERE TC.CONSTRAINT_TYPE = 'FOREIGN KEY' AND KCU.TABLE_SCHEMA = ?
      `, [db]).catch(() => [[]]);
      const tablesMap = new Map();
      colRows.forEach(r => {
        if (!tablesMap.has(r.TABLE_NAME)) {
          tablesMap.set(r.TABLE_NAME, { schema: db, name: r.TABLE_NAME, fullName: `${db}.${r.TABLE_NAME}`, columns: [] });
        }
        tablesMap.get(r.TABLE_NAME).columns.push({ name: r.COLUMN_NAME, type: r.DATA_TYPE, nullable: r.IS_NULLABLE });
      });
      return {
        tables: Array.from(tablesMap.values()),
        foreignKeys: fkRows.map(fk => ({
          sourceTable: `${db}.${fk.TABLE_NAME}`, sourceColumn: fk.COLUMN_NAME,
          targetTable: `${db}.${fk.REFERENCED_TABLE_NAME}`, targetColumn: fk.REFERENCED_COLUMN_NAME,
        })),
      };
    } else if (conn.type === 'postgres') {
      const tablesRes = await conn.client.query(`
        SELECT t.table_schema, t.table_name, c.column_name, c.data_type, c.is_nullable
        FROM information_schema.tables t
        JOIN information_schema.columns c ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE t.table_schema NOT IN ('pg_catalog','information_schema') AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_schema, t.table_name, c.ordinal_position
      `);

      const fkRes = await conn.client.query(`
        SELECT tc.table_schema, tc.table_name, kcu.column_name, ccu.table_schema AS foreign_table_schema, 
               ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name 
        FROM information_schema.table_constraints AS tc 
        JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema NOT IN ('pg_catalog','information_schema')
      `);

      const tablesMap = new Map();
      tablesRes.rows.forEach(r => {
        const full = `${r.table_schema}.${r.table_name}`;
        if (!tablesMap.has(full)) tablesMap.set(full, { schema: r.table_schema, name: r.table_name, fullName: full, columns: [] });
        tablesMap.get(full).columns.push({ name: r.column_name, type: r.data_type, nullable: r.is_nullable });
      });

      return {
        tables: Array.from(tablesMap.values()),
        foreignKeys: fkRes.rows.map(fk => ({
          sourceTable: `${fk.table_schema}.${fk.table_name}`, sourceColumn: fk.column_name,
          targetTable: `${fk.foreign_table_schema}.${fk.foreign_table_name}`, targetColumn: fk.foreign_column_name
        }))
      };
    } else {
      const tables = await this.getTables(connectionId);
      const fullTables = [];
      for (const t of tables) {
        if (t.type === 'BASE TABLE') {
          const cols = await this.getTableStructure(connectionId, t.fullName);
          fullTables.push({ schema: t.schema, name: t.name, fullName: t.fullName, columns: cols.map(c => ({ name: c.name, type: c.type, nullable: 'YES' })) });
        }
      }
      return { tables: fullTables, foreignKeys: [] };
    }
  }

  async getTableExtras(connectionId, tableName) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');

    if (conn.type === 'mysql') {
      const parts = tableName.split('.');
      const db = parts.length > 1 ? parts[0] : (conn.activeDb || conn.config.database);
      const table = parts.length > 1 ? parts[1] : parts[0];
      const [idxRows] = await conn.client.query(`
        SELECT INDEX_NAME AS indexname,
               (NON_UNIQUE = 0) AS is_unique,
               (INDEX_NAME = 'PRIMARY') AS is_primary,
               GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS indexdef
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        GROUP BY INDEX_NAME, NON_UNIQUE
      `, [db, table]).catch(() => [[]]);
      const [fkRows] = await conn.client.query(`
        SELECT KCU.COLUMN_NAME AS column_name,
               KCU.REFERENCED_TABLE_NAME AS foreign_table_name,
               KCU.REFERENCED_COLUMN_NAME AS foreign_column_name,
               RC.DELETE_RULE AS delete_rule
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE KCU
        JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS TC
          ON KCU.CONSTRAINT_NAME = TC.CONSTRAINT_NAME AND KCU.TABLE_SCHEMA = TC.TABLE_SCHEMA
        JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS RC
          ON KCU.CONSTRAINT_NAME = RC.CONSTRAINT_NAME AND KCU.TABLE_SCHEMA = RC.CONSTRAINT_SCHEMA
        WHERE TC.CONSTRAINT_TYPE = 'FOREIGN KEY' AND KCU.TABLE_SCHEMA = ? AND KCU.TABLE_NAME = ?
      `, [db, table]).catch(() => [[]]);
      return { indexes: idxRows, foreignKeys: fkRows };
    } else if (conn.type === 'postgres') {
      const parts = tableName.split('.');
      const schema = parts.length > 1 ? parts[0] : 'public';
      const table = parts.length > 1 ? parts[1] : parts[0];

      const idxRes = await conn.client.query(`
        SELECT i.relname AS indexname, 
               ix.indisunique AS is_unique,
               ix.indisprimary AS is_primary,
               pg_get_indexdef(ix.indexrelid) AS indexdef
        FROM pg_class t
        JOIN pg_index ix ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE t.relname = $1 AND n.nspname = $2
        ORDER BY i.relname
      `, [table, schema]).catch(() => ({ rows: [] }));

      const fkRes = await conn.client.query(`
        SELECT kcu.column_name, ccu.table_name AS foreign_table_name, 
               ccu.column_name AS foreign_column_name,
               rc.delete_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu 
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu 
          ON ccu.constraint_name = tc.constraint_name
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = $1 AND tc.table_name = $2
      `, [schema, table]).catch(() => ({ rows: [] }));

      return { indexes: idxRes.rows, foreignKeys: fkRes.rows };
    } else {
      return { indexes: [], foreignKeys: [] };
    }
  }

  // --- User Management ---
  async getUserManagement(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');

    if (conn.type === 'mysql') {
      const [userRows] = await conn.client.query(
        `SELECT User AS rolname, Host, Super_priv, Create_db_priv, Create_user_priv, account_locked FROM mysql.user ORDER BY User`
      ).catch(() => [[]]);
      const [dbRows] = await conn.client.query(
        `SELECT schema_name AS datname FROM information_schema.schemata ORDER BY schema_name`
      ).catch(() => [[]]);
      return {
        roles: userRows.map(r => ({
          rolname: r.rolname,
          rolsuper: r.Super_priv === 'Y',
          rolcreatedb: r.Create_db_priv === 'Y',
          rolcreaterole: r.Create_user_priv === 'Y',
          rolcanlogin: r.account_locked !== 'Y',
          rolreplication: false,
          rolconnlimit: -1,
        })),
        databases: dbRows.map(r => ({ datname: r.datname, owner: '', size: '' })),
      };
    } else if (conn.type === 'postgres') {
      const rolesRes = await conn.client.query(`
        SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, 
               rolcanlogin, rolreplication, rolconnlimit, rolvaliduntil
        FROM pg_roles 
        ORDER BY rolname
      `);
      const dbRes = await conn.client.query(`
        SELECT datname, pg_catalog.pg_get_userbyid(datdba) AS owner,
               pg_catalog.pg_size_pretty(pg_catalog.pg_database_size(datname)) AS size
        FROM pg_database WHERE datistemplate = false ORDER BY datname
      `).catch(() => ({ rows: [] }));

      return { roles: rolesRes.rows, databases: dbRes.rows };
    } else {
      return { roles: [], databases: [] };
    }
  }

  async createUser(connectionId, username, password, options) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');
    if (conn.type === 'mysql') {
      const safeUser = username.replace(/'/g, "''");
      const safePass = (password || '').replace(/'/g, "''");
      await conn.client.query(`CREATE USER '${safeUser}'@'%' IDENTIFIED BY '${safePass}'`);
      if (options.superuser) {
        await conn.client.query(`GRANT ALL PRIVILEGES ON *.* TO '${safeUser}'@'%' WITH GRANT OPTION`);
      } else if (options.createdb) {
        await conn.client.query(`GRANT CREATE ON *.* TO '${safeUser}'@'%'`);
      }
      await conn.client.query('FLUSH PRIVILEGES');
      return { success: true };
    } else if (conn.type === 'postgres') {
      const opts = [];
      if (options.superuser) opts.push('SUPERUSER');
      if (options.createdb) opts.push('CREATEDB');
      if (options.createrole) opts.push('CREATEROLE');
      if (options.login !== false) opts.push('LOGIN');
      const safeUser = username.replace(/"/g, '""');
      const sql = `CREATE USER "${safeUser}" WITH PASSWORD '${password.replace(/'/g, "''")}' ${opts.join(' ')}`;
      await conn.client.query(sql);
      return { success: true };
    }
    throw new Error('User management not supported for this database type');
  }

  async dropUser(connectionId, username) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');
    if (conn.type === 'mysql') {
      await conn.client.query(`DROP USER IF EXISTS '${username.replace(/'/g, "''")}'@'%'`);
      await conn.client.query('FLUSH PRIVILEGES');
      return { success: true };
    } else if (conn.type === 'postgres') {
      await conn.client.query(`DROP USER IF EXISTS "${username.replace(/"/g, '""')}"`);
      return { success: true };
    }
    throw new Error('User management not supported for this database type');
  }

  // --- Metrics ---
  async getMetrics(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error('Connection not found');

    if (conn.type === 'mysql') {
      const [processRows] = await conn.client.query('SHOW PROCESSLIST').catch(() => [[]]);
      const [statusRows] = await conn.client.query('SHOW GLOBAL STATUS').catch(() => [[]]);
      const [tableRows] = await conn.client.query(`
        SELECT TABLE_NAME AS relname, TABLE_ROWS AS n_live_tup,
               (DATA_LENGTH + INDEX_LENGTH) AS total_bytes,
               DATA_LENGTH AS data_bytes
        FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY total_bytes DESC LIMIT 10
      `).catch(() => [[]]);
      const statusMap = {};
      statusRows.forEach(r => { statusMap[r.Variable_name] = r.Value; });
      const reads = parseInt(statusMap.Innodb_buffer_pool_read_requests) || 0;
      const misses = parseInt(statusMap.Innodb_buffer_pool_reads) || 0;
      return {
        type: 'mysql',
        activeConnections: [{ count: processRows.length, state: 'active' }],
        dbStats: {
          datname: conn.activeDb || conn.config.database,
          numbackends: parseInt(statusMap.Threads_connected) || 0,
          xact_commit: parseInt(statusMap.Com_commit) || 0,
          xact_rollback: parseInt(statusMap.Com_rollback) || 0,
          tup_inserted: parseInt(statusMap.Com_insert) || 0,
          tup_updated: parseInt(statusMap.Com_update) || 0,
          tup_deleted: parseInt(statusMap.Com_delete) || 0,
        },
        cacheHitRatio: reads > 0 ? ((reads - misses) / reads * 100).toFixed(2) : 0,
        topTables: tableRows.map(r => ({
          relname: r.relname, n_live_tup: r.n_live_tup,
          total_size: r.total_bytes > 1024 * 1024
            ? `${(r.total_bytes / 1024 / 1024).toFixed(1)} MB`
            : `${(r.total_bytes / 1024).toFixed(1)} KB`,
          seq_scan: 0, idx_scan: 0, n_dead_tup: 0,
        })),
        locks: [],
        timestamp: Date.now(),
      };
    } else if (conn.type === 'postgres') {
      const [actConns, dbStats, cacheHit, tableStats, locks] = await Promise.all([
        conn.client.query(`
          SELECT count(*) AS count, state 
          FROM pg_stat_activity 
          WHERE datname = current_database()
          GROUP BY state
        `).catch(() => ({ rows: [] })),
        conn.client.query(`
          SELECT datname,
            pg_size_pretty(pg_database_size(datname)) AS size,
            numbackends, xact_commit, xact_rollback,
            blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted
          FROM pg_stat_database WHERE datname = current_database()
        `).catch(() => ({ rows: [] })),
        conn.client.query(`
          SELECT 
            sum(blks_hit) * 100.0 / NULLIF(sum(blks_hit) + sum(blks_read), 0) AS cache_hit_ratio
          FROM pg_stat_database WHERE datname = current_database()
        `).catch(() => ({ rows: [] })),
        conn.client.query(`
          SELECT relname, seq_scan, idx_scan, n_live_tup, n_dead_tup,
            pg_size_pretty(pg_total_relation_size(relid)) AS total_size
          FROM pg_stat_user_tables
          ORDER BY pg_total_relation_size(relid) DESC LIMIT 10
        `).catch(() => ({ rows: [] })),
        conn.client.query(`
          SELECT count(*) AS count, mode FROM pg_locks GROUP BY mode
        `).catch(() => ({ rows: [] })),
      ]);

      return {
        type: 'postgres',
        activeConnections: actConns.rows,
        dbStats: dbStats.rows[0] || {},
        cacheHitRatio: cacheHit.rows[0]?.cache_hit_ratio || 0,
        topTables: tableStats.rows,
        locks: locks.rows,
        timestamp: Date.now(),
      };
    } else if (conn.type === 'clickhouse') {
      const [metrics, tables] = await Promise.all([
        conn.client.query({ query: 'SELECT * FROM system.metrics LIMIT 20', format: 'JSONEachRow' })
          .then(r => r.json()).catch(() => []),
        conn.client.query({ query: 'SELECT database, name, total_rows, total_bytes FROM system.tables ORDER BY total_bytes DESC LIMIT 10', format: 'JSONEachRow' })
          .then(r => r.json()).catch(() => []),
      ]);
      return { type: 'clickhouse', metrics, tables, timestamp: Date.now() };
    }
  }

  // --- Query Favorites (stored locally in userData) ---
  getFavoritesFilePath() {
    return path.join(app.getPath('userData'), 'query-favorites.json');
  }

  getFavorites() {
    try {
      const p = this.getFavoritesFilePath();
      if (!fs.existsSync(p)) return [];
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) { return []; }
  }

  saveFavorite(favorite) {
    const list = this.getFavorites();
    const existingIdx = list.findIndex(f => f.id === favorite.id);
    if (existingIdx >= 0) {
      list[existingIdx] = favorite;
    } else {
      list.push({ ...favorite, id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5) });
    }
    fs.writeFileSync(this.getFavoritesFilePath(), JSON.stringify(list, null, 2));
    return { success: true };
  }

  deleteFavorite(id) {
    const list = this.getFavorites().filter(f => f.id !== id);
    fs.writeFileSync(this.getFavoritesFilePath(), JSON.stringify(list, null, 2));
    return { success: true };
  }

  getConnection(id) { return this.connections.get(id); }

  getAllConnections() {
    return Array.from(this.connections.entries()).map(([id, conn]) => ({
      id,
      type: conn.type,
      name: conn.config.name || conn.config.host,
      host: conn.config.host,
      port: conn.config.port,
      database: conn.config.database,
      username: conn.config.username,
      connected: true,
    }));
  }

  getSavedFilePath() {
    return path.join(app.getPath('userData'), 'saved-connections.json');
  }

  getSavedConnections() {
    try {
      const p = this.getSavedFilePath();
      if (!fs.existsSync(p)) return [];
      const list = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return list.map(conf => {
        if (conf.password && safeStorage.isEncryptionAvailable()) {
          try {
            conf.password = safeStorage.decryptString(Buffer.from(conf.password, 'base64'));
          } catch(e) { /* ignore decrypt error */ }
        }
        return conf;
      });
    } catch(e) {
      console.error('Error reading saved connections:', e);
      return [];
    }
  }

  saveConnectionConfig(config) {
    const list = this.getSavedConnections();
    let existingIdx = list.findIndex(c => c.id === config.id);
    if (existingIdx < 0) {
      existingIdx = list.findIndex(c => 
        c.host === config.host && 
        c.database === config.database && 
        c.username === config.username &&
        c.type === config.type
      );
    }
    const toSave = { ...config };
    if (existingIdx >= 0) toSave.id = list[existingIdx].id;
    if (toSave.password && safeStorage.isEncryptionAvailable()) {
      toSave.password = safeStorage.encryptString(toSave.password).toString('base64');
    }
    if (existingIdx >= 0) {
      list[existingIdx] = toSave;
    } else {
      list.push(toSave);
    }
    fs.writeFileSync(this.getSavedFilePath(), JSON.stringify(list, null, 2));
  }

  deleteConnectionConfig(id) {
    const list = this.getSavedConnections();
    const filtered = list.filter(c => c.id !== id);
    fs.writeFileSync(this.getSavedFilePath(), JSON.stringify(filtered, null, 2));
  }

  renameConnectionConfig(id, newName) {
    const list = this.getSavedConnections();
    const existing = list.find(c => c.id === id);
    if (existing) {
      existing.name = newName;
      this.saveConnectionConfig(existing);
    }
    const active = this.connections.get(id);
    if (active) {
      active.config.name = newName;
    }
  }

  // ─── DB Compare & Sync ───────────────────────────────────────────────────

  async getSchemaForCompare(connId) {
    const conn = this.connections.get(connId);
    if (!conn) throw new Error('Connection not found');

    if (conn.type === 'postgres') {
      // Use pg_catalog + format_type so we get exact SQL types (integer, character varying(255),
      // numeric(10,2), etc.) instead of udt_name which produces invalid values like int4(32,0).
      const res = await conn.client.query(`
        SELECT
          n.nspname                                              AS schema,
          c.relname                                              AS table_name,
          a.attname                                              AS column_name,
          pg_catalog.format_type(a.atttypid, a.atttypmod)       AS data_type,
          CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END        AS is_nullable,
          pg_get_expr(ad.adbin, a.attrelid)                      AS column_default,
          a.attnum                                               AS ordinal_position,
          CASE WHEN EXISTS(
            SELECT 1 FROM pg_index i
            WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)
          ) THEN true ELSE false END                             AS is_primary
        FROM pg_attribute a
        JOIN pg_class c     ON c.oid = a.attrelid AND c.relkind = 'r'
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
        WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY n.nspname, c.relname, a.attnum
      `);
      const tables = new Map();
      for (const r of res.rows) {
        const key = `${r.schema}.${r.table_name}`;
        if (!tables.has(key)) tables.set(key, { schema: r.schema, name: r.table_name, fullName: key, columns: [] });
        tables.get(key).columns.push({
          name: r.column_name, type: r.data_type, nullable: r.is_nullable,
          default: r.column_default, isPrimary: !!r.is_primary,
        });
      }
      return Array.from(tables.values());

    } else if (conn.type === 'mysql') {
      const db = conn.activeDb || conn.config.database;
      const [rows] = await conn.client.query(`
        SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
               COLUMN_TYPE AS data_type, IS_NULLABLE AS is_nullable,
               COLUMN_DEFAULT AS column_default, ORDINAL_POSITION AS ordinal_position,
               CASE WHEN COLUMN_KEY = 'PRI' THEN 1 ELSE 0 END AS is_primary
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION
      `, [db]);
      const tables = new Map();
      for (const r of rows) {
        const key = `${db}.${r.table_name}`;
        if (!tables.has(key)) {
          tables.set(key, { schema: db, name: r.table_name, fullName: key, columns: [] });
        }
        tables.get(key).columns.push({
          name: r.column_name, type: r.data_type, nullable: r.is_nullable,
          default: r.column_default, isPrimary: !!r.is_primary,
        });
      }
      return Array.from(tables.values());

    } else {
      // ClickHouse
      const rs = await conn.client.query({
        query: `SELECT database, table, name AS column_name, type AS data_type,
                       default_expression AS column_default, position
                FROM system.columns WHERE database = currentDatabase()
                ORDER BY table, position`,
        format: 'JSONEachRow',
      });
      const rows = await rs.json();
      const tables = new Map();
      for (const r of rows) {
        const key = `${r.database}.${r.table}`;
        if (!tables.has(key)) {
          tables.set(key, { schema: r.database, name: r.table, fullName: key, columns: [] });
        }
        tables.get(key).columns.push({
          name: r.column_name, type: r.data_type, nullable: 'YES',
          default: r.column_default, isPrimary: false,
        });
      }
      return Array.from(tables.values());
    }
  }

  _diffColumns(srcCols, tgtCols) {
    const srcMap = new Map(srcCols.map(c => [c.name, c]));
    const tgtMap = new Map(tgtCols.map(c => [c.name, c]));
    const added = [], removed = [], changed = [];
    for (const [name, col] of srcMap) {
      if (!tgtMap.has(name)) { added.push(col); continue; }
      const t = tgtMap.get(name);
      if (col.type !== t.type || col.nullable !== t.nullable) {
        changed.push({ name, source: col, target: t });
      }
    }
    for (const [name, col] of tgtMap) {
      if (!srcMap.has(name)) removed.push(col);
    }
    return { added, removed, changed };
  }

  async compareSchema(srcConnId, tgtConnId) {
    const srcConn = this.connections.get(srcConnId);
    const tgtConn = this.connections.get(tgtConnId);
    if (!srcConn) throw new Error('Source connection not found');
    if (!tgtConn) throw new Error('Target connection not found');
    if (srcConnId === tgtConnId) throw new Error('Source and target must be different connections');
    if (srcConn.type !== tgtConn.type) throw new Error(`Cannot compare ${srcConn.type} with ${tgtConn.type} — both connections must use the same database type`);
    const [srcTables, tgtTables] = await Promise.all([
      this.getSchemaForCompare(srcConnId),
      this.getSchemaForCompare(tgtConnId),
    ]);
    const srcMap = new Map(srcTables.map(t => [t.fullName, t]));
    const tgtMap = new Map(tgtTables.map(t => [t.fullName, t]));
    const result = { onlyInSource: [], onlyInTarget: [], same: [], different: [] };

    for (const [name, srcTable] of srcMap) {
      if (!tgtMap.has(name)) { result.onlyInSource.push(srcTable); continue; }
      const diff = this._diffColumns(srcTable.columns, tgtMap.get(name).columns);
      if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
        result.same.push(name);
      } else {
        result.different.push({ table: name, srcTable, tgtTable: tgtMap.get(name), diff });
      }
    }
    for (const [name, tgtTable] of tgtMap) {
      if (!srcMap.has(name)) result.onlyInTarget.push(tgtTable);
    }
    return result;
  }

  async compareData(srcConnId, tgtConnId, tableNames) {
    const srcConn = this.connections.get(srcConnId);
    const results = [];
    for (const tableName of tableNames) {
      try {
        // Quote parts so reserved-word table/schema names don't break the query
        const parts = tableName.split('.');
        const qTable = srcConn?.type === 'mysql'
          ? parts.map(p => `\`${p}\``).join('.')
          : parts.map(p => `"${p}"`).join('.');
        const [src, tgt] = await Promise.all([
          this.executeQuery(srcConnId, `SELECT COUNT(*) AS cnt FROM ${qTable}`),
          this.executeQuery(tgtConnId, `SELECT COUNT(*) AS cnt FROM ${qTable}`),
        ]);
        const srcCount = parseInt(src.rows[0]?.cnt ?? 0);
        const tgtCount = parseInt(tgt.rows[0]?.cnt ?? 0);
        results.push({ table: tableName, sourceCount: srcCount, targetCount: tgtCount,
          status: srcCount === tgtCount ? 'same' : 'different' });
      } catch (err) {
        results.push({ table: tableName, sourceCount: -1, targetCount: -1, status: 'error', error: err.message });
      }
    }
    return results;
  }

  generateSyncScript(schemaDiff, direction) {
    const qi  = s => `"${String(s).replace(/"/g, '""')}"`;           // quote identifier
    const qf  = fullName => fullName.split('.').map(qi).join('.');    // quote schema.table

    const toCreate = direction === 'src_to_tgt' ? schemaDiff.onlyInSource : schemaDiff.onlyInTarget;
    const toDrop   = direction === 'src_to_tgt' ? schemaDiff.onlyInTarget : schemaDiff.onlyInSource;
    const lines = [
      '-- Generated by DB Compare & Sync',
      `-- Direction: ${direction === 'src_to_tgt' ? 'Source → Target' : 'Target → Source'}`,
      `-- Generated at: ${new Date().toISOString()}`,
      '',
    ];

    if (toDrop.length) {
      lines.push('-- ==========================================');
      lines.push('-- Tables to DROP (exist in target only)');
      lines.push('-- ==========================================');
      for (const t of toDrop) lines.push(`DROP TABLE IF EXISTS ${qf(t.fullName)};`);
      lines.push('');
    }

    if (toCreate.length) {
      lines.push('-- ==========================================');
      lines.push('-- Tables to CREATE');
      lines.push('-- ==========================================');
      for (const t of toCreate) {
        const colDefs = t.columns.map(c => {
          let def = `  ${qi(c.name)} ${c.type}`;
          if (c.nullable === 'NO') def += ' NOT NULL';
          if (c.default && !c.default.includes('nextval')) def += ` DEFAULT ${c.default}`;
          return def;
        });
        const pks = t.columns.filter(c => c.isPrimary).map(c => qi(c.name));
        if (pks.length) colDefs.push(`  PRIMARY KEY (${pks.join(', ')})`);
        lines.push(`CREATE TABLE IF NOT EXISTS ${qf(t.fullName)} (\n${colDefs.join(',\n')}\n);`);
        lines.push('');
      }
    }

    if (schemaDiff.different.length) {
      lines.push('-- ==========================================');
      lines.push('-- Column changes');
      lines.push('-- ==========================================');
      for (const { table, diff } of schemaDiff.different) {
        const adds    = direction === 'src_to_tgt' ? diff.added   : diff.removed;
        const drops   = direction === 'src_to_tgt' ? diff.removed : diff.added;
        const changes = diff.changed;
        for (const col of adds)
          lines.push(`ALTER TABLE ${qf(table)} ADD COLUMN ${qi(col.name)} ${col.type}${col.nullable === 'NO' ? ' NOT NULL' : ''};`);
        for (const col of drops)
          lines.push(`ALTER TABLE ${qf(table)} DROP COLUMN ${qi(col.name)};`);
        for (const { name, source, target } of changes) {
          const col = direction === 'src_to_tgt' ? source : target;
          lines.push(`ALTER TABLE ${qf(table)} ALTER COLUMN ${qi(name)} TYPE ${col.type};`);
        }
      }
    }

    return lines.join('\n');
  }

  async applySyncScript(connId, script) {
    const conn = this.connections.get(connId);
    if (!conn) throw new Error('Connection not found');
    const statements = script.split('\n')
      .filter(l => !l.trimStart().startsWith('--') && l.trim())
      .join('\n')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);

    let executed = 0;
    const errors = [];
    for (const stmt of statements) {
      try {
        if (conn.type === 'postgres') await conn.client.query(stmt);
        else if (conn.type === 'mysql') await conn.client.query(stmt);
        else await conn.client.query({ query: stmt, format: 'JSONEachRow' });
        executed++;
      } catch (err) {
        errors.push({ statement: stmt.slice(0, 120) + (stmt.length > 120 ? '…' : ''), error: err.message });
      }
    }
    return { executed, errors, total: statements.length };
  }

  // ─────────────────────────────────────────────────────────────────────────

  async exportFullDatabase(connectionId, format, targetPath, onProgress) {
    const { stringify } = require('csv-stringify/sync');
    const conn = this.getConnection(connectionId);
    if (!conn) throw new Error('Connection not found');

    const allTables = await this.getTables(connectionId);
    const baseTables = allTables.filter(t => t.type === 'BASE TABLE');
    const views      = allTables.filter(t => t.type !== 'BASE TABLE');
    const total = allTables.length;
    let current = 0;

    // ── CSV export ─────────────────────────────────────────────────────────────
    if (format !== 'sql') {
      for (const table of allTables) {
        current++;
        if (onProgress) onProgress(`Exporting ${current}/${total}: ${table.name}`, current, total);
        try {
          const structure = await this.getTableStructure(connectionId, table.fullName);
          const { rows } = await this.executeQuery(connectionId, `SELECT * FROM ${table.fullName}`);
          const filePath = path.join(targetPath, `${table.schema}_${table.name}.csv`);
          if (rows.length > 0) {
            const header = Object.keys(rows[0]);
            fs.writeFileSync(filePath, stringify([header, ...rows.map(r => header.map(k => r[k]))]), 'utf-8');
          } else {
            const header = structure.map(c => c.column_name || c.name);
            fs.writeFileSync(filePath, stringify([header]), 'utf-8');
          }
        } catch (err) { console.error(`Failed to export ${table.fullName}:`, err); }
      }
      return;
    }

    // ── SQL export header (comments only — DB-specific SETs added below) ───────
    fs.writeFileSync(targetPath, [
      `-- Generated by DB Access`,
      `-- Date: ${new Date().toISOString()}`,
      `-- Database: ${conn.config?.database || conn.activeDb || ''}`,
      `-- Type: ${conn.type.toUpperCase()}`,
      ``,
    ].join('\n'), 'utf-8');
    const w = (text) => fs.appendFileSync(targetPath, text, 'utf-8');

    // ── PostgreSQL SQL export ──────────────────────────────────────────────────
    if (conn.type === 'postgres') {
      w(`SET standard_conforming_strings = on;\n`);
      w(`SET client_encoding = 'UTF8';\n\n`);

      // ── 0. Schemas ────────────────────────────────────────────────────────
      try {
        const nsRes = await conn.client.query(`
          SELECT nspname FROM pg_namespace
          WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast')
            AND nspname NOT LIKE 'pg_%'
          ORDER BY nspname
        `);
        const nonPublic = nsRes.rows.filter(r => r.nspname !== 'public');
        if (nonPublic.length) {
          w(`-- Schemas\n`);
          for (const r of nonPublic) w(`CREATE SCHEMA IF NOT EXISTS "${r.nspname}";\n`);
          w('\n');
        }
      } catch (err) { w(`-- Error exporting schemas: ${err.message}\n\n`); }

      // ── 1. Extensions ─────────────────────────────────────────────────────
      try {
        const extRes = await conn.client.query(
          `SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname`
        );
        if (extRes.rows.length) {
          w(`-- Extensions\n`);
          for (const r of extRes.rows) w(`CREATE EXTENSION IF NOT EXISTS "${r.extname}";\n`);
          w('\n');
        }
      } catch (_) {}

      // ── 2. Custom types ───────────────────────────────────────────────────
      // Enums — separate query per type to avoid array_agg JS-parsing issues
      try {
        const enumRes = await conn.client.query(`
          SELECT n.nspname AS schema, t.typname AS name, t.oid
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typtype = 'e'
            AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
          ORDER BY n.nspname, t.typname
        `);
        if (enumRes.rows.length) {
          w(`-- Enum Types\n`);
          for (const type of enumRes.rows) {
            try {
              const valRes = await conn.client.query(
                `SELECT enumlabel FROM pg_enum WHERE enumtypid = $1 ORDER BY enumsortorder`,
                [type.oid]
              );
              if (!valRes.rows.length) continue;
              const vals = valRes.rows.map(r => `'${r.enumlabel.replace(/'/g, "''")}'`).join(', ');
              // Wrap in DO block: CREATE TYPE has no IF NOT EXISTS (pre-PG14)
              w(`DO $$ BEGIN CREATE TYPE "${type.schema}"."${type.name}" AS ENUM (${vals}); EXCEPTION WHEN duplicate_object THEN NULL; END $$;\n`);
            } catch (err) { w(`-- Error exporting enum ${type.schema}.${type.name}: ${err.message}\n`); }
          }
          w('\n');
        }
      } catch (err) { w(`-- Error querying enum types: ${err.message}\n\n`); }

      // Domains
      try {
        const domRes = await conn.client.query(`
          SELECT n.nspname AS schema, t.typname AS name,
            pg_catalog.format_type(t.typbasetype, t.typtypmod) AS base_type,
            (SELECT pg_get_constraintdef(c.oid)
             FROM pg_constraint c WHERE c.contypid = t.oid LIMIT 1) AS check_clause,
            t.typnotnull AS not_null,
            pg_get_expr(t.typdefaultbin, 0) AS default_val
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typtype = 'd'
            AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
          ORDER BY n.nspname, t.typname
        `);
        if (domRes.rows.length) {
          w(`-- Domain Types\n`);
          for (const d of domRes.rows) {
            let ddl = `CREATE DOMAIN "${d.schema}"."${d.name}" AS ${d.base_type}`;
            if (d.not_null) ddl += ` NOT NULL`;
            if (d.default_val) ddl += ` DEFAULT ${d.default_val}`;
            if (d.check_clause) ddl += ` ${d.check_clause}`;
            w(`DO $$ BEGIN ${ddl}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;\n`);
          }
          w('\n');
        }
      } catch (err) { w(`-- Error exporting domain types: ${err.message}\n\n`); }

      // Composite types
      try {
        const compRes = await conn.client.query(`
          SELECT n.nspname AS schema, t.typname AS name, t.typrelid
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          JOIN pg_class c ON c.oid = t.typrelid
          WHERE t.typtype = 'c' AND c.relkind = 'c'
            AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
          ORDER BY n.nspname, t.typname
        `);
        if (compRes.rows.length) {
          w(`-- Composite Types\n`);
          for (const ct of compRes.rows) {
            try {
              const colRes = await conn.client.query(
                `SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) AS atttype
                 FROM pg_attribute a
                 WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
                 ORDER BY a.attnum`, [ct.typrelid]
              );
              const cols = colRes.rows.map(c => `  ${c.attname} ${c.atttype}`).join(',\n');
              w(`DO $$ BEGIN CREATE TYPE "${ct.schema}"."${ct.name}" AS (\n${cols}\n); EXCEPTION WHEN duplicate_object THEN NULL; END $$;\n`);
            } catch (err) { w(`-- Error exporting composite ${ct.schema}.${ct.name}: ${err.message}\n`); }
          }
          w('\n');
        }
      } catch (err) { w(`-- Error exporting composite types: ${err.message}\n\n`); }

      // ── 3. Sequences (pg_class+pg_sequence — no privilege filtering) ──────
      try {
        const seqRes = await conn.client.query(`
          SELECT
            n.nspname      AS schemaname,
            c.relname      AS sequencename,
            s.seqstart     AS start_value,
            s.seqmin       AS minimum_value,
            s.seqmax       AS maximum_value,
            s.seqincrement AS increment_by,
            s.seqcycle     AS cycle
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_sequence s  ON s.seqrelid = c.oid
          WHERE c.relkind = 'S'
            AND n.nspname NOT IN ('pg_catalog','information_schema')
          ORDER BY n.nspname, c.relname
        `);
        if (seqRes.rows.length) {
          w(`-- Sequences\n`);
          for (const s of seqRes.rows) {
            const qn = `"${s.schemaname}"."${s.sequencename}"`;
            w(`CREATE SEQUENCE IF NOT EXISTS ${qn}`
              + ` INCREMENT BY ${s.increment_by}`
              + ` MINVALUE ${s.minimum_value} MAXVALUE ${s.maximum_value}`
              + ` START WITH ${s.start_value}`
              + (s.cycle ? ` CYCLE` : ` NO CYCLE`)
              + `;\n`);
          }
          w('\n');
        }
      } catch (err) { w(`-- Error exporting sequences: ${err.message}\n\n`); }

      // ── 4. Tables ─────────────────────────────────────────────────────────
      const pendingFKs = [];
      const tableStructureCache = new Map(); // fullName → pg_attribute rows

      for (const table of baseTables) {
        current++;
        if (onProgress) onProgress(`Schema ${current}/${total}: ${table.name}`, current, total);
        try {
          const schema    = table.schema || 'public';
          const tableName = table.name;

          // Table OID — needed for pg_attribute, pg_constraint queries
          const oidRes = await conn.client.query(
            `SELECT c.oid FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2`,
            [schema, tableName]
          );
          const tableOid = oidRes.rows[0]?.oid;
          if (!tableOid) { w(`-- Warning: OID not found for ${schema}.${tableName}\n\n`); continue; }

          // Columns — format_type gives exact types: varchar(255), numeric(10,2),
          // integer[], "myschema"."my_type" — no manual reconstruction needed.
          // seq_qualified: correlated subquery (not JOIN) so we get exactly one row
          // per column even when pg_depend has multiple rows for the same attnum.
          const colRes = await conn.client.query(`
            SELECT
              a.attname                                            AS column_name,
              pg_catalog.format_type(a.atttypid, a.atttypmod)    AS data_type,
              a.atttypid                                          AS type_oid,
              a.attnotnull                                        AS not_null,
              pg_get_expr(ad.adbin, a.attrelid)                   AS column_default,
              (SELECT sn.nspname || '.' || sc.relname
               FROM pg_depend dep
               JOIN pg_class sc ON sc.oid = dep.objid AND sc.relkind = 'S'
               JOIN pg_namespace sn ON sn.oid = sc.relnamespace
               WHERE dep.refobjid    = a.attrelid
                 AND dep.refobjsubid = a.attnum
                 AND dep.deptype     = 'a'
               LIMIT 1)                                           AS seq_qualified
            FROM pg_attribute a
            LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
            WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum
          `, [tableOid]);
          tableStructureCache.set(table.fullName, colRes.rows);

          // All constraints via pg_constraint (PK, UNIQUE, CHECK inline; FK deferred)
          const conRes = await conn.client.query(`
            SELECT conname, contype, pg_get_constraintdef(oid) AS def
            FROM pg_constraint
            WHERE conrelid = $1 AND contype IN ('p','u','c','f')
            ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 ELSE 3 END, conname
          `, [tableOid]);

          for (const con of conRes.rows.filter(c => c.contype === 'f')) {
            pendingFKs.push({ srcSchema: schema, srcTable: tableName, name: con.conname, def: con.def });
          }

          const colDefs = colRes.rows.map(c => {
            let def = `  "${c.column_name}" ${c.data_type}`;
            if (c.not_null) def += ' NOT NULL';
            if (c.column_default) {
              let colDefault = c.column_default;
              // Schema-qualify nextval() so it resolves regardless of search_path on target
              if (c.seq_qualified && colDefault.startsWith('nextval(')) {
                const dot = c.seq_qualified.indexOf('.');
                const seqSchema = c.seq_qualified.slice(0, dot);
                const seqName   = c.seq_qualified.slice(dot + 1);
                colDefault = `nextval('"${seqSchema}"."${seqName}"'::regclass)`;
              }
              def += ` DEFAULT ${colDefault}`;
            }
            return def;
          });
          for (const con of conRes.rows.filter(c => c.contype !== 'f')) {
            colDefs.push(`  CONSTRAINT "${con.conname}" ${con.def}`);
          }

          const qn = `"${schema}"."${tableName}"`;
          w(`-- Table: ${qn}\nCREATE TABLE IF NOT EXISTS ${qn} (\n${colDefs.join(',\n')}\n);\n\n`);
        } catch (err) { w(`-- Error creating table ${table.schema}.${table.name}: ${err.message}\n\n`); }
      }

      // ── 5. Indexes (skip PK/UNIQUE — already in CREATE TABLE) ─────────────
      try {
        const idxRes = await conn.client.query(`
          SELECT schemaname, tablename, indexname, indexdef
          FROM pg_indexes
          WHERE schemaname NOT IN ('pg_catalog','information_schema','pg_toast')
            AND indexname NOT IN (
              SELECT conname FROM pg_constraint WHERE contype IN ('p','u')
            )
          ORDER BY schemaname, tablename, indexname
        `);
        if (idxRes.rows.length) {
          w(`-- Indexes\n`);
          for (const idx of idxRes.rows) w(`${idx.indexdef};\n`);
          w('\n');
        }
      } catch (err) { w(`-- Error exporting indexes: ${err.message}\n\n`); }

      // ── 6. Views ──────────────────────────────────────────────────────────
      for (const view of views) {
        try {
          const vSchema = view.schema || 'public';
          const vName   = view.name;
          const vRes = await conn.client.query(
            `SELECT pg_get_viewdef(c.oid, true) AS def
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relname = $1 AND n.nspname = $2`, [vName, vSchema]
          );
          const def = vRes.rows[0]?.def;
          if (def) w(`-- View: "${vSchema}"."${vName}"\nCREATE OR REPLACE VIEW "${vSchema}"."${vName}" AS\n${def.trim()};\n\n`);
        } catch (err) { w(`-- Error exporting view ${view.schema}.${view.name}: ${err.message}\n\n`); }
      }

      // ── 7. Functions & Procedures ─────────────────────────────────────────
      try {
        const fnRes = await conn.client.query(`
          SELECT p.oid, n.nspname AS schema, p.proname AS name
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog','information_schema')
            AND NOT EXISTS (SELECT 1 FROM pg_aggregate WHERE aggfnoid = p.oid)
          ORDER BY n.nspname, p.proname
        `);
        if (fnRes.rows.length) {
          w(`-- Functions & Procedures\n`);
          for (const fn of fnRes.rows) {
            try {
              const defRes = await conn.client.query(
                `SELECT pg_get_functiondef($1) AS def`, [fn.oid]
              );
              const def = defRes.rows[0]?.def?.trim();
              if (def) {
                const safeDef = def.replace(/^CREATE\s+FUNCTION\b/i, 'CREATE OR REPLACE FUNCTION');
                w(`${safeDef};\n\n`);
              }
            } catch (err) { w(`-- Error exporting function ${fn.schema}.${fn.name}: ${err.message}\n`); }
          }
        }
      } catch (err) { w(`-- Error querying functions: ${err.message}\n\n`); }

      // ── 8. Triggers ───────────────────────────────────────────────────────
      try {
        const trgRes = await conn.client.query(`
          SELECT t.oid, t.tgname, n.nspname AS schema, c.relname AS table_name
          FROM pg_trigger t
          JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE NOT t.tgisinternal
            AND n.nspname NOT IN ('pg_catalog','information_schema')
          ORDER BY n.nspname, c.relname, t.tgname
        `);
        if (trgRes.rows.length) {
          w(`-- Triggers\n`);
          for (const trg of trgRes.rows) {
            try {
              const defRes = await conn.client.query(
                `SELECT pg_get_triggerdef($1) AS def`, [trg.oid]
              );
              if (defRes.rows[0]?.def) w(`${defRes.rows[0].def};\n`);
            } catch (err) { w(`-- Error exporting trigger ${trg.tgname}: ${err.message}\n`); }
          }
          w('\n');
        }
      } catch (err) { w(`-- Error querying triggers: ${err.message}\n\n`); }

      // ── 9. Data ───────────────────────────────────────────────────────────
      w(`-- Data\n\n`);
      for (const table of baseTables) {
        try {
          const schema    = table.schema || 'public';
          const tableName = table.name;
          const colInfo   = tableStructureCache.get(table.fullName) || [];

          const { rows } = await this.executeQuery(connectionId, `SELECT * FROM "${schema}"."${tableName}"`);
          if (!rows.length) continue;

          // Type OID map for JSON detection (114=json, 3802=jsonb)
          const colTypeOids = {};
          for (const col of colInfo) colTypeOids[col.column_name] = col.type_oid;

          const dq = (str, cast = '') => {
            let tag = '$x$'; let n = 0;
            while (str.includes(tag)) tag = `$x${++n}$`;
            return `${tag}${str}${tag}${cast}`;
          };

          const serializeVal = (v, colName) => {
            if (v === null || v === undefined) return 'NULL';
            if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
            if (v instanceof Date) return `'${v.toISOString()}'`;
            if (typeof v === 'number') return String(v);
            const oid = colTypeOids[colName];
            if (oid === 114 || oid === 3802) {
              const json = typeof v === 'object' ? JSON.stringify(v) : String(v);
              return dq(json, oid === 3802 ? '::jsonb' : '::json');
            }
            if (Array.isArray(v)) {
              if (!v.length) return "'{}'";
              const els = v.map(el => {
                if (el === null || el === undefined) return 'NULL';
                if (typeof el === 'object') return `"${JSON.stringify(el).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
                return `"${String(el).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
              }).join(',');
              return `'{${els}}'`;
            }
            if (typeof v === 'object') return dq(JSON.stringify(v));
            return `'${String(v).replace(/'/g, "''")}'`;
          };

          const keys = Object.keys(rows[0]);
          const qn = `"${schema}"."${tableName}"`;
          const quotedKeys = keys.map(k => `"${k}"`).join(', ');
          w(`-- Data: ${qn}\n`);
          const batchSize = 100;
          for (let i = 0; i < rows.length; i += batchSize) {
            const vals = rows.slice(i, i + batchSize)
              .map(row => `(${keys.map(k => serializeVal(row[k], k)).join(', ')})`)
              .join(',\n');
            w(`INSERT INTO ${qn} (${quotedKeys}) VALUES\n${vals};\n`);
          }
          w('\n');
        } catch (err) { w(`-- Error exporting data for ${table.schema}.${table.name}: ${err.message}\n\n`); }
      }

      // ── 10. Foreign Keys ──────────────────────────────────────────────────
      if (pendingFKs.length) {
        w(`-- Foreign Key Constraints\n`);
        for (const fk of pendingFKs) {
          w(`ALTER TABLE "${fk.srcSchema}"."${fk.srcTable}" ADD CONSTRAINT "${fk.name}" ${fk.def};\n`);
        }
        w('\n');
      }

      // ── 11. Reset sequence positions ──────────────────────────────────────
      try {
        const ownRes = await conn.client.query(`
          SELECT
            n.nspname  AS seq_schema, s.relname AS seq_name,
            dn.nspname AS tbl_schema, d.relname AS tbl_name,
            a.attname  AS col_name
          FROM pg_class s
          JOIN pg_namespace n   ON n.oid  = s.relnamespace
          JOIN pg_depend dep    ON dep.objid = s.oid AND dep.deptype = 'a'
          JOIN pg_class d       ON d.oid  = dep.refobjid
          JOIN pg_namespace dn  ON dn.oid = d.relnamespace
          JOIN pg_attribute a   ON a.attrelid = d.oid AND a.attnum = dep.refobjsubid
          WHERE s.relkind = 'S'
            AND n.nspname NOT IN ('pg_catalog','information_schema')
          ORDER BY seq_schema, seq_name
        `);
        if (ownRes.rows.length) {
          w(`-- Reset sequence positions\n`);
          for (const r of ownRes.rows) {
            w(`DO $$ BEGIN PERFORM setval('"${r.seq_schema}"."${r.seq_name}"', `
              + `COALESCE((SELECT MAX("${r.col_name}") FROM "${r.tbl_schema}"."${r.tbl_name}"), 1), true); `
              + `EXCEPTION WHEN OTHERS THEN NULL; END $$;\n`);
          }
          w('\n');
        }
      } catch (_) {}

    // ── MySQL SQL export ───────────────────────────────────────────────────────
    } else if (conn.type === 'mysql') {
      w(`SET FOREIGN_KEY_CHECKS = 0;\nSET NAMES utf8mb4;\n\n`);

      for (const table of baseTables) {
        current++;
        if (onProgress) onProgress(`Exporting ${current}/${total}: ${table.name}`, current, total);
        try {
          const dbName    = table.schema || conn.activeDb || conn.config.database;
          const tableName = table.name;

          // SHOW CREATE TABLE gives exact DDL: full types, AUTO_INCREMENT columns,
          // ENUMs, charsets, engine, constraints — more accurate than rebuilding manually
          const [showRows] = await conn.client.query(
            `SHOW CREATE TABLE \`${dbName}\`.\`${tableName}\``
          );
          let createDDL = showRows[0]?.['Create Table'] || '';
          createDDL = createDDL.replace(/\s*AUTO_INCREMENT=\d+/gi, ''); // strip table-level counter
          createDDL = createDDL.replace(/^CREATE TABLE\b/i, 'CREATE TABLE IF NOT EXISTS');
          w(`-- Table: \`${dbName}\`.\`${tableName}\`\n${createDDL};\n\n`);

          // Data
          const { rows } = await this.executeQuery(
            connectionId, `SELECT * FROM \`${dbName}\`.\`${tableName}\``
          );
          if (rows.length) {
            const keys = Object.keys(rows[0]);
            const serializeVal = (v) => {
              if (v === null || v === undefined) return 'NULL';
              if (typeof v === 'boolean') return v ? '1' : '0';
              if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
              if (typeof v === 'number') return String(v);
              if (typeof v === 'object') return `'${JSON.stringify(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
              return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
            };
            const quotedKeys = keys.map(k => `\`${k}\``).join(', ');
            const qn = `\`${dbName}\`.\`${tableName}\``;
            w(`-- Data: ${qn}\n`);
            const batchSize = 100;
            for (let i = 0; i < rows.length; i += batchSize) {
              const vals = rows.slice(i, i + batchSize)
                .map(row => `(${keys.map(k => serializeVal(row[k])).join(', ')})`)
                .join(',\n');
              w(`INSERT INTO ${qn} (${quotedKeys}) VALUES\n${vals};\n`);
            }
            w('\n');
          }
        } catch (err) { w(`-- Error exporting ${table.name}: ${err.message}\n\n`); }
      }

      // Views — strip DEFINER so import doesn't fail if that user doesn't exist
      for (const view of views) {
        try {
          const dbName   = view.schema || conn.activeDb;
          const viewName = view.name;
          const [viewRows] = await conn.client.query(
            `SHOW CREATE VIEW \`${dbName}\`.\`${viewName}\``
          );
          const createView = viewRows[0]?.['Create View'];
          if (createView) {
            const cleanView = createView.replace(
              /^CREATE\s+(ALGORITHM=\w+\s+)?DEFINER=`[^`]*`@`[^`]*`\s+(SQL\s+SECURITY\s+\w+\s+)?VIEW\b/i,
              'CREATE OR REPLACE VIEW'
            );
            w(`-- View: \`${dbName}\`.\`${viewName}\`\n${cleanView};\n\n`);
          }
        } catch (err) { w(`-- Error exporting view ${view.name}: ${err.message}\n\n`); }
      }

      w(`SET FOREIGN_KEY_CHECKS = 1;\n`);
    }
  }
}

module.exports = new DatabaseManager();
