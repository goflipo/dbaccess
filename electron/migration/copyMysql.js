// MySQL / MariaDB data copy engine. Rows are read as text (dates/decimals/bigints stay strings, binary
// stays Buffer) and written with bulk text-protocol INSERTs inside per-batch transactions.

const { my } = require('./sql');
const { qi, qn } = my;
const { CancelError, TableError } = require('./copyPg');

const RETRY = new Set([1205, 1213]);
const SCHEMA_LEVEL = new Set([1146, 1054, 1049]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BIN = new Set(['BLOB', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'BIT', 'GEOMETRY']);
const typeCast = (field) => {
  if (BIN.has(field.type)) return field.buffer();
  if (field.type === 'JSON') return field.string('utf8');
  return field.string();
};

async function openSession(dbManager, id, getConn, isTarget) {
  const conn = getConn(dbManager, id);
  const c = await conn.client.getConnection();
  const s = { c, pool: conn.client, threadId: null, destroyed: false, maxPacket: 4194304 };
  try { await setupSession(s, isTarget); } catch (e) { try { c.destroy(); } catch (_) { /* ignore */ } s.destroyed = true; throw e; }   // never leak the connection
  return s;
}
async function setupSession(s, isTarget) {
  const c = s.c;
  await c.query("SET SESSION time_zone = '+00:00'");
  try { await c.query('SET NAMES utf8mb4'); } catch (e) { /* ignore */ }
  try { s.threadId = (await c.query('SELECT CONNECTION_ID() AS id'))[0][0].id; } catch (e) { /* ignore */ }
  if (isTarget) {
    try {
      s.maxPacket = Number((await c.query('SELECT @@max_allowed_packet AS p'))[0][0].p) || s.maxPacket;
      const mode = (await c.query('SELECT @@sql_mode AS m'))[0][0].m || '';
      const parts = mode.split(',').filter(x => x && !/^(NO_ZERO_DATE|NO_ZERO_IN_DATE|NO_BACKSLASH_ESCAPES|NO_AUTO_VALUE_ON_ZERO)$/.test(x));
      parts.push('NO_AUTO_VALUE_ON_ZERO');
      await c.query('SET SESSION sql_mode = ?', [parts.join(',')]);
    } catch (e) { /* ignore */ }
    await c.query('SET SESSION foreign_key_checks = 0');
  }
}
function closeSession(s) { if (s && !s.destroyed) { s.destroyed = true; try { s.c.destroy(); } catch (e) { /* ignore */ } } }

const estSize = (row) => { let n = 2; for (const v of row) n += v == null ? 5 : (Buffer.isBuffer(v) ? v.length * 2 + 4 : Buffer.byteLength(String(v)) * 1.2 + 4); return n; };
const kdesc = (entry, cols, row) => { const k = entry.keyColumns || entry.conflictKey; return k ? '(' + k.map(c => `${c}=${row[cols.indexOf(c)] == null ? 'NULL' : String(row[cols.indexOf(c)]).slice(0, 60)}`).join(', ') + ')' : null; };

async function copyMysqlAll(x) {
  const { dbManager, srcId, tgtId, opts, signal, emit, log, getConn, entries } = x;
  const results = [];
  const src = await openSession(dbManager, srcId, getConn, false);
  let tgt;
  try { tgt = await openSession(dbManager, tgtId, getConn, true); } catch (e) { closeSession(src); throw e; }
  const tgtDb = getConn(dbManager, tgtId).activeDb;
  const onAbort = () => { for (const s of [src, tgt]) if (s.threadId) s.pool.query('KILL QUERY ' + Number(s.threadId)).catch(() => {}); };
  signal.addEventListener('abort', onAbort);
  try {
    if (opts.dataMode === 'truncate-copy') {
      for (const e of entries.filter(z => z.existsInTarget).reverse()) {
        const q = qn(tgtDb, e._tgt.name);
        try { await tgt.c.query('TRUNCATE TABLE ' + q); }
        catch (er) { try { await tgt.c.query('DELETE FROM ' + q); } catch (er2) { throw new Error(`Could not empty ${q}: ${er2.message}`); } }
      }
      log('warn', 'Truncated existing target tables before the copy');
    }
    for (const entry of entries) {
      if (signal.aborted) throw new CancelError();
      const r = { table: entry.table, rowsCopied: 0, rowsSkipped: 0, sourceRows: entry.sourceRows, targetRowsAfter: null };
      emit({ type: 'step', phase: 'data', table: entry.table, message: `Copying ${entry.table} (${entry.sourceRows} rows) [${entry.strategy}]`, rowsTotal: entry.sourceRows });
      let failed = false;
      try { await copyTable({ src, tgt, tgtDb, entry, opts, signal, emit, log, r }); }
      catch (e) {
        failed = true;
        if (e.cancelled || signal.aborted) { r.error = 'cancelled'; await finalize(tgt, tgtDb, entry, r); results.push(r); throw new CancelError(); }
        r.error = e.message; if (e.rowsSkipped) r.rowsSkipped = Math.max(r.rowsSkipped, e.rowsSkipped);
        emit({ type: 'error', phase: 'data', table: entry.table, message: e.message, level: 'error' });
      }
      await finalize(tgt, tgtDb, entry, r); results.push(r);
      if (failed && opts.onError === 'stop') { x.stopped = true; break; }
    }
  } catch (e) { if (e.cancelled) x.cancelled = true; else throw e; }
  finally {
    signal.removeEventListener('abort', onAbort);
    try { await tgt.c.query('ROLLBACK'); } catch (e) { /* ignore */ }
    closeSession(src); closeSession(tgt);
  }
  return results;

  async function finalize(t, db, entry, r) {
    try { r.targetRowsAfter = Number((await t.c.query(`SELECT CAST(COUNT(*) AS CHAR) AS n FROM ${qn(db, entry._tgt ? entry._tgt.name : entry._src.name)}`))[0][0].n); } catch (e) { r.targetRowsAfter = null; }
  }
}

async function copyTable({ src, tgt, tgtDb, entry, opts, signal, emit, log, r }) {
  const t = entry._src;
  const srcQ = qn(t.schema, t.name);
  const tName = entry._tgt ? entry._tgt.name : t.name;
  const tgtQ = qn(tgtDb, tName);
  const tcols = new Map((await tgt.c.query('SELECT COLUMN_NAME AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [tgtDb, tName]))[0].map(z => [String(z.n).toLowerCase(), z.n]));
  if (!tcols.size) throw new TableError(`Table ${tgtQ} does not exist in the target`);
  const cols = [], tnames = [];
  for (const c of entry.columns) { const n = tcols.get(c.toLowerCase()); if (n) { cols.push(c); tnames.push(n); } }
  if (cols.length < entry.columns.length) log('warn', `${entry.table}: some columns are missing in the target and are skipped`);
  if (!cols.length) throw new TableError('No columns to copy');
  const sel = cols.map(qi).join(', ');
  const batch = Math.max(1, opts.batchSize);
  // Memory guard: first read is small, then the read size adapts to the observed (estimated) row width.
  const READ_BYTES = 32 * 1024 * 1024;
  let curBatch = Math.min(batch, 10);
  const isKeyset = entry.readMode === 'keyset' && entry.keyColumns && entry.keyColumns.every(k => cols.includes(k));
  const colInfo = (n) => t.columns.find(c => c.name === n) || {};
  const keyCast = (k) => { const ci = colInfo(k); return /int/.test(ci.dataType || '') ? (/unsigned/i.test(ci.type) ? 'CAST(? AS UNSIGNED)' : 'CAST(? AS SIGNED)') : '?'; };
  const keyIdx = isKeyset ? entry.keyColumns.map(k => cols.indexOf(k)) : [];

  // Keyed tables are paged by key. Tables without a deterministic key are STREAMED from one consistent snapshot
  // (never LIMIT/OFFSET paged: tied sort keys and concurrent writes would duplicate or skip rows).
  let iter = null, stream = null, streamDone = false;
  const startStream = async () => {
    try { await src.c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT'); } catch (e) { /* non-transactional engine */ }
    stream = src.c.connection.query({ sql: `SELECT ${sel} FROM ${srcQ}`, rowsAsArray: true, typeCast }).stream({ highWaterMark: 64 });
    iter = stream[Symbol.asyncIterator]();
  };
  const readStream = async (lim) => {
    const out = []; let bytes = 0;
    while (out.length < lim && bytes < READ_BYTES) {
      const n = await iter.next();
      if (n.done) { streamDone = true; break; }
      out.push(n.value); bytes += estSize(n.value);
    }
    return out;
  };
  const stopStream = async () => {
    if (!stream) return;
    const unfinished = !streamDone;
    try { stream.destroy(); } catch (e) { /* ignore */ }
    if (unfinished) {
      // an abandoned result set leaves the connection busy: replace the source session's connection
      try { src.c.destroy(); } catch (e) { /* ignore */ }
      try { src.c = await src.pool.getConnection(); await setupSession(src, false); } catch (e) { /* next table will report the failure */ }
    } else { try { await src.c.query('ROLLBACK'); } catch (e) { /* ignore */ } }
    stream = null; iter = null;
  };

  const read = async (last, lim) => {
    if (!isKeyset) return readStream(lim);
    let where = '', params = [];
    if (isKeyset && last) {
      const ks = entry.keyColumns, ors = [];
      for (let i = 0; i < ks.length; i++) {
        const parts = [];
        for (let j = 0; j < i; j++) { parts.push(`${qi(ks[j])} = ${keyCast(ks[j])}`); params.push(last[j]); }
        parts.push(`${qi(ks[i])} > ${keyCast(ks[i])}`); params.push(last[i]);
        ors.push('(' + parts.join(' AND ') + ')');
      }
      where = ' WHERE ' + ors.join(' OR ');
    }
    const res = await src.c.query({ sql: `SELECT ${sel} FROM ${srcQ}${where} ORDER BY ${entry.keyColumns.map(qi).join(', ')} LIMIT ${lim}`, values: params, rowsAsArray: true, typeCast });
    return res[0];
  };

  const head = `INSERT INTO ${tgtQ} (${tnames.map(qi).join(', ')}) VALUES ?`;
  let suffix = '';
  if (entry.mode === 'insert-missing') { const k = qi(tcols.get(entry.conflictKey[0].toLowerCase()) || entry.conflictKey[0]); suffix = ` ON DUPLICATE KEY UPDATE ${k} = ${k}`; }
  else if (entry.mode === 'upsert') {
    const key = entry.conflictKey, rest = tnames.filter((n, i) => !key.includes(cols[i]));
    const k0 = qi(tcols.get(key[0].toLowerCase()) || key[0]);
    suffix = ` ON DUPLICATE KEY UPDATE ${rest.length ? rest.map(n => `${qi(n)} = VALUES(${qi(n)})`).join(', ') : `${k0} = ${k0}`}`;
  }
  const errSamples = [];
  const rollback = async () => { try { await tgt.c.query('ROLLBACK'); } catch (e) { /* ignore */ } };
  const insertChunk = async (rows) => (await tgt.c.query(head + suffix, [rows]))[0].affectedRows;
  const budget = Math.floor(tgt.maxPacket * 0.8);
  const chunks = (rows) => {
    const out = []; let cur = [], size = 0;
    for (const row of rows) { const s = estSize(row); if (cur.length && (size + s > budget)) { out.push(cur); cur = []; size = 0; } cur.push(row); size += s; }
    if (cur.length) out.push(cur);
    return out;
  };

  async function isolate(rows) {
    let ok = 0, bad = 0; const maxBad = Math.max(20, Math.ceil(rows.length * 0.05));
    await tgt.c.query('START TRANSACTION');
    try {
      for (const row of rows) {
        if (signal.aborted) throw new CancelError();
        try { const n = await insertChunk([row]); ok += entry.mode === 'insert-missing' ? n : 1; }
        catch (e) {
          bad++;
          const kd = kdesc(entry, cols, row); const msg = `${e.message}${kd ? ' at key ' + kd : ''}`;
          if (errSamples.length < 50) { errSamples.push(msg); emit({ type: 'error', phase: 'data', table: entry.table, message: msg, level: 'warn' }); }
          if (opts.onError === 'stop') { await rollback(); throw new TableError(`Row rejected: ${msg}`, 1); }
          if (bad > maxBad) { await tgt.c.query('COMMIT'); r.rowsCopied += ok; r.rowsSkipped += bad; throw new TableError(`Too many rejected rows (${bad}); last: ${msg}`, r.rowsSkipped); }
        }
      }
      await tgt.c.query('COMMIT');
    } catch (e) { if (!(e instanceof TableError && /Too many/.test(e.message))) await rollback(); throw e; }
    return { ok, bad };
  }

  async function writeBatch(rows) {
    for (let attempt = 0; ; attempt++) {
      try {
        let affected = 0;
        await tgt.c.query('START TRANSACTION');
        for (const ch of chunks(rows)) affected += await insertChunk(ch);
        await tgt.c.query('COMMIT');
        if (entry.mode === 'insert-missing') return { inserted: affected, skipped: rows.length - affected };
        return { inserted: rows.length, skipped: 0 };
      } catch (e) {
        await rollback();
        if (signal.aborted) throw new CancelError();
        const no = e.errno;
        if (RETRY.has(no) && attempt < 3) { await sleep([200, 1000, 3000][attempt]); continue; }
        if (SCHEMA_LEVEL.has(no) || no === 2006 || no === 2013 || e.code === 'PROTOCOL_CONNECTION_LOST') throw new TableError(e.message);
        log('warn', `${entry.table}: batch failed (${e.message}); isolating rows one by one`);
        const res = await isolate(rows);
        return { inserted: res.ok, skipped: res.bad };
      }
    }
  }

  let pending = null, done = 0, lastEmit = 0, first = true, last = null;
  try {
    if (!isKeyset) await startStream();
    const readNext = (lastKey) => {
      const lim = curBatch;
      const p = read(lastKey, lim).then(rows => ({ rows, lim }));
      p.catch(() => {});   // a prefetch may reject (cancel, dropped connection) before it is awaited; handled when awaited
      return p;
    };
    pending = readNext(null);
    for (;;) {
      if (signal.aborted) throw new CancelError();
      const { rows, lim } = await pending; pending = null;
      if (!rows.length) break;
      if (isKeyset) last = keyIdx.map(i => rows[rows.length - 1][i]);
      let bytes = 0; for (const row of rows) bytes += estSize(row);
      curBatch = Math.max(1, Math.min(batch, Math.floor(READ_BYTES / Math.max(1, bytes / rows.length)), curBatch * 4));
      pending = (isKeyset ? rows.length < lim : streamDone) ? Promise.resolve({ rows: [], lim }) : readNext(last);
      const w = await writeBatch(rows);
      r.rowsCopied += w.inserted; r.rowsSkipped += w.skipped; done += rows.length;
      const now = Date.now();
      if (first || now - lastEmit >= 250) { first = false; lastEmit = now; emit({ type: 'rows', phase: 'data', table: entry.table, rowsDone: done, rowsTotal: entry.sourceRows }); }
    }
    emit({ type: 'rows', phase: 'data', table: entry.table, rowsDone: done, rowsTotal: Math.max(done, entry.sourceRows) });
  } finally { if (pending) await pending.catch(() => {}); await stopStream(); }
  if (r.rowsSkipped > 0 && entry.mode !== 'insert-missing') r.error = `${r.rowsSkipped} row(s) rejected${errSamples[0] ? ': ' + errSamples[0] : ''}`;
}

/** Re-establish AUTO_INCREMENT counters after the copy (never lowers them). */
async function syncAutoIncrementMysql({ c, tgtDb, entries, log }) {
  for (const e of entries) {
    const col = e._src.columns.find(z => z.autoIncrement && e.columns.includes(z.name));
    if (!col) continue;
    const q = qn(tgtDb, e._tgt ? e._tgt.name : e._src.name);
    try {
      const m = (await c.query(`SELECT CAST(MAX(${qi(col.name)}) AS CHAR) AS m FROM ${q}`))[0][0].m;
      if (m != null && /^\d+$/.test(m)) await c.query(`ALTER TABLE ${q} AUTO_INCREMENT = ${(BigInt(m) + 1n).toString()}`);
    } catch (er) { log('warn', `Could not reset AUTO_INCREMENT of ${e.table}: ${er.message}`); }
  }
}

module.exports = { copyMysqlAll, syncAutoIncrementMysql, openSession, closeSession };
