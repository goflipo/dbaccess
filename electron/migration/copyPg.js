// PostgreSQL data copy engine. Values travel as the server's raw text representation (no JS type
// conversion), so bigint/numeric/timestamp/bytea/arrays/json round-trip exactly. Writes use
// parameterised multi-row INSERTs with explicit casts to the TARGET column types.

const { pg } = require('./sql');
const { qi, qn } = pg;

class CancelError extends Error { constructor() { super('Migration cancelled'); this.cancelled = true; } }
class TableError extends Error { constructor(m, rowsSkipped) { super(m); this.rowsSkipped = rowsSkipped || 0; } }

const RAW = { getTypeParser: () => (v) => v };
const RETRY = new Set(['55P03', '40P01', '40001']);
const SCHEMA_LEVEL = new Set(['42P01', '42703', '42883', '42704', '42P10']);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function openSession(dbManager, id, getConn) {
  const conn = getConn(dbManager, id);
  const client = await conn.client.connect();
  const s = { client, conn, pid: null, destroyed: false };
  // (setup below swallows its own errors, so the client cannot leak here)
  for (const q of ["SET TimeZone = 'UTC'", "SET DateStyle = 'ISO, MDY'", "SET IntervalStyle = 'iso_8601'", "SET bytea_output = 'hex'", 'SET extra_float_digits = 3', "SET client_encoding = 'UTF8'", 'SET statement_timeout = 0', 'SET idle_in_transaction_session_timeout = 0']) {
    try { await client.query(q); } catch (e) { /* not supported on every PG-wire engine */ }
  }
  try { s.pid = (await client.query('SELECT pg_backend_pid() AS p')).rows[0].p; } catch (e) { /* ignore */ }
  return s;
}
function closeSession(s) { if (s && !s.destroyed) { s.destroyed = true; try { s.client.release(true); } catch (e) { /* ignore */ } } }

const kdesc = (entry, cols, row) => {
  const k = entry.keyColumns || entry.conflictKey;
  if (!k) return null;
  return '(' + k.map(c => { const i = cols.indexOf(c); const v = i >= 0 ? row[i] : undefined; return `${c}=${v == null ? 'NULL' : String(v).slice(0, 60)}`; }).join(', ') + ')';
};

/** Copy every table of plan.dataPlan. Returns {tables:[...], cancelled}. */
async function copyPgAll(x) {
  const { dbManager, srcId, tgtId, plan, opts, signal, emit, log, getConn, tgtSuper, entries } = x;
  const results = [];
  const src = await openSession(dbManager, srcId, getConn);
  let tgt;
  try { tgt = await openSession(dbManager, tgtId, getConn); } catch (e) { closeSession(src); throw e; }   // never leak the first session
  const cancelPool = getConn(dbManager, tgtId).client;
  const onAbort = () => {
    for (const [s, p] of [[src, getConn(dbManager, srcId).client], [tgt, cancelPool]]) if (s.pid) p.query('SELECT pg_cancel_backend($1)', [s.pid]).catch(() => {});
  };
  signal.addEventListener('abort', onAbort);
  let replica = false;
  const engineType = getConn(dbManager, tgtId).type;
  try {
    if (tgtSuper !== false) {
      try { await tgt.client.query('SET session_replication_role = replica'); replica = true; log('info', 'Foreign-key checks and triggers are suspended on the target session (replication role)'); }
      catch (e) { log('info', 'Not allowed to use session_replication_role (needs superuser): relying on table order and deferrable constraints'); }
    }
    if (opts.dataMode === 'truncate-copy') {
      const list = entries.filter(e => e.existsInTarget);
      if (list.length) {
        const sql = 'TRUNCATE TABLE ' + list.map(e => (e.onlyParent ? 'ONLY ' : '') + qn(e._src.schema, e._src.name)).join(', ');
        log('warn', `Truncating ${list.length} target table(s) before the copy`);
        try { await tgt.client.query('BEGIN'); await tgt.client.query(sql); await tgt.client.query('COMMIT'); }
        catch (e) { try { await tgt.client.query('ROLLBACK'); } catch (_) { /* ignore */ } throw new Error('TRUNCATE failed: ' + e.message); }
      }
    }
    for (const entry of entries) {
      if (signal.aborted) throw new CancelError();
      const r = { table: entry.table, rowsCopied: 0, rowsSkipped: 0, sourceRows: entry.sourceRows, targetRowsAfter: null };
      emit({ type: 'step', phase: 'data', table: entry.table, message: `Copying ${entry.table} (${entry.sourceRows} rows) [${entry.strategy}]`, rowsTotal: entry.sourceRows });
      try {
        await copyTable({ src, tgt, entry, opts, signal, emit, log, replica, engineType, r });
      } catch (e) {
        if (e.cancelled || signal.aborted) { r.error = 'cancelled'; results.push(await finalize(tgt, entry, r)); throw Object.assign(new CancelError(), { results }); }
        r.error = e.message; if (e.rowsSkipped) r.rowsSkipped = Math.max(r.rowsSkipped, e.rowsSkipped);
        emit({ type: 'error', phase: 'data', table: entry.table, message: e.message, level: 'error' });
        results.push(await finalize(tgt, entry, r));
        if (opts.onError === 'stop') { x.stopped = true; break; }
        continue;
      }
      results.push(await finalize(tgt, entry, r));
    }
  } catch (e) {
    if (e.cancelled) { x.cancelled = true; if (e.results) { /* already collected */ } }
    else throw e;
  } finally {
    signal.removeEventListener('abort', onAbort);
    try { await tgt.client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    try { await src.client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    closeSession(src); closeSession(tgt);   // destroyed (not pooled): session settings never leak
  }
  return results;

  async function finalize(t, entry, r) {
    try {
      const q = qn(entry._src.schema, entry._src.name);
      r.targetRowsAfter = Number((await t.client.query(`SELECT count(*)::text AS n FROM ${entry.onlyParent ? 'ONLY ' : ''}${q}`)).rows[0].n);
    } catch (e) { r.targetRowsAfter = null; try { await t.client.query('ROLLBACK'); } catch (_) { /* ignore */ } }
    return r;
  }
}

async function copyTable({ src, tgt, entry, opts, signal, emit, log, replica, engineType, r }) {
  const t = entry._src;
  const srcQ = qn(t.schema, t.name), tgtQ = qn(t.schema, t.name);
  const only = entry.onlyParent ? 'ONLY ' : '';
  const tcols = new Map((await tgt.client.query(`SELECT a.attname AS n, format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`, [tgtQ])).rows.map(z => [z.n, z.t]));
  const cols = entry.columns.filter(c => tcols.has(c));
  const missing = entry.columns.filter(c => !tcols.has(c));
  if (missing.length) log('warn', `${entry.table}: columns missing in the target are skipped: ${missing.join(', ')}`);
  if (!cols.length) throw new TableError('No columns to copy');
  const sel = cols.map(qi).join(', ');
  const batch = Math.max(1, opts.batchSize);
  // Memory guard: rows travel as text, so budget by bytes as well as by row count. The first read is small and the
  // read size then adapts to the observed row width (wide bytea/text rows shrink it, narrow rows grow it up to batchSize).
  const READ_BYTES = 32 * 1024 * 1024, STMT_BYTES = 16 * 1024 * 1024;
  let curBatch = Math.min(batch, 10);
  const rowBytes = (row) => { let n = 8; for (const v of row) n += v == null ? 1 : (typeof v === 'string' ? v.length : 16); return n; };
  const perStmt = Math.max(1, Math.min(batch, Math.floor(60000 / cols.length)));
  const isKeyset = entry.readMode === 'keyset' && entry.keyColumns && entry.keyColumns.every(k => cols.includes(k));
  let ktypes = {};
  if (isKeyset) ktypes = Object.fromEntries((await src.client.query(`SELECT a.attname AS n, format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`, [srcQ])).rows.map(z => [z.n, z.t]));
  const keyIdx = isKeyset ? entry.keyColumns.map(k => cols.indexOf(k)) : [];

  // ---- reader
  let cursor = false;
  const readKeyset = async (last, lim) => {
    let where = '', params = [];
    if (last) { where = ` WHERE (${entry.keyColumns.map(qi).join(', ')}) > (${entry.keyColumns.map((k, i) => `$${i + 1}::${ktypes[k]}`).join(', ')})`; params = last; }
    const res = await src.client.query({ text: `SELECT ${sel} FROM ${only}${srcQ}${where} ORDER BY ${entry.keyColumns.map(qi).join(', ')} LIMIT ${lim}`, values: params, rowMode: 'array', types: RAW });
    return res.rows;
  };
  const readCursor = async (lim) => (await src.client.query({ text: `FETCH ${lim} FROM mig_c`, rowMode: 'array', types: RAW })).rows;

  // ---- writer
  const mode = entry.mode;
  let suffix = '';
  if (mode === 'insert-missing') suffix = ' ON CONFLICT DO NOTHING';
  else if (mode === 'upsert') {
    const key = entry.conflictKey, rest = cols.filter(c => !key.includes(c));
    suffix = rest.length ? ` ON CONFLICT (${key.map(qi).join(', ')}) DO UPDATE SET ${rest.map(c => `${qi(c)} = EXCLUDED.${qi(c)}`).join(', ')}` : ` ON CONFLICT (${key.map(qi).join(', ')}) DO NOTHING`;
  }
  const override = entry.identityAlways && !/cockroach|redshift/i.test(engineType) ? ' OVERRIDING SYSTEM VALUE' : '';
  const head = `INSERT INTO ${tgtQ} (${sel})${override} VALUES `;
  const cache = new Map();
  const stmt = (n) => {
    let s = cache.get(n);
    if (!s) {
      let k = 1; const rows = [];
      for (let i = 0; i < n; i++) rows.push('(' + cols.map(c => `$${k++}::${tcols.get(c)}`).join(', ') + ')');
      s = head + rows.join(', ') + suffix; cache.set(n, s);
    }
    return s;
  };
  const run = async (rows) => { const vals = []; for (const row of rows) for (const v of row) vals.push(v); return tgt.client.query({ text: stmt(rows.length), values: vals }); };
  const rollback = async () => { try { await tgt.client.query('ROLLBACK'); } catch (e) { /* ignore */ } };
  const errSamples = [];

  async function isolate(rows, firstErr) {
    let bad = 0, ok = 0;
    const maxBad = Math.max(20, Math.ceil(rows.length * 0.05));
    await tgt.client.query('BEGIN');
    try {
      if (!replica) await tgt.client.query('SET CONSTRAINTS ALL DEFERRED');
      for (const row of rows) {
        if (signal.aborted) throw new CancelError();
        await tgt.client.query('SAVEPOINT mig_r');
        try { const res = await run([row]); ok += res.rowCount; await tgt.client.query('RELEASE SAVEPOINT mig_r'); }
        catch (e) {
          await tgt.client.query('ROLLBACK TO SAVEPOINT mig_r');
          bad++;
          const kd = kdesc(entry, cols, row);
          const msg = `${e.message}${kd ? ' at key ' + kd : ''}`;
          if (errSamples.length < 50) { errSamples.push(msg); emit({ type: 'error', phase: 'data', table: entry.table, message: msg, level: 'warn' }); }
          if (opts.onError === 'stop') { await rollback(); throw new TableError(`Row rejected: ${msg}`, 1); }
          if (bad > maxBad) { await tgt.client.query('COMMIT'); r.rowsCopied += ok; r.rowsSkipped += bad; throw new TableError(`Too many rejected rows (${bad}); last: ${msg}`, r.rowsSkipped); }
        }
      }
      await tgt.client.query('COMMIT');
    } catch (e) { if (!(e instanceof TableError && /Too many/.test(e.message))) await rollback(); throw e; }
    return { ok, bad };
  }

  // split a batch into statements bounded by parameter count AND bytes (PG caps a message at 1GB)
  const stmtChunks = (rows) => {
    const out = []; let cur = [], size = 0;
    for (const row of rows) { const s = rowBytes(row); if (cur.length && (cur.length >= perStmt || size + s > STMT_BYTES)) { out.push(cur); cur = []; size = 0; } cur.push(row); size += s; }
    if (cur.length) out.push(cur);
    return out;
  };

  async function writeBatch(rows) {
    for (let attempt = 0; ; attempt++) {
      try {
        let inserted = 0;
        await tgt.client.query('BEGIN');
        if (!replica) await tgt.client.query('SET CONSTRAINTS ALL DEFERRED');
        for (const ch of stmtChunks(rows)) inserted += (await run(ch)).rowCount;
        await tgt.client.query('COMMIT');
        return { inserted, skipped: mode === 'insert-missing' ? rows.length - inserted : 0 };
      } catch (e) {
        await rollback();
        if (signal.aborted) throw new CancelError();
        if (RETRY.has(e.code) && attempt < 3) { log('warn', `${entry.table}: ${e.message}; retrying (${attempt + 1}/3)`); await sleep([200, 1000, 3000][attempt]); continue; }
        if (SCHEMA_LEVEL.has(e.code) || /^08|^57P0[1-3]/.test(e.code || '') || e.code === 'ECONNRESET') throw new TableError(e.message);
        log('warn', `${entry.table}: batch failed (${e.message}); isolating rows one by one`);
        const res = await isolate(rows, e);
        return { inserted: res.ok, skipped: res.bad };
      }
    }
  }

  // ---- loop with depth-1 prefetch
  let pending = null, done = 0, lastEmit = 0, first = true;
  try {
    if (!isKeyset) {
      cursor = true;
      await src.client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await src.client.query(`DECLARE mig_c NO SCROLL CURSOR FOR SELECT ${sel} FROM ${only}${srcQ}`);
    }
    let last = null;
    const readNext = () => {
      const lim = curBatch;
      const p = (isKeyset ? readKeyset(last, lim) : readCursor(lim)).then(rows => ({ rows, lim }));
      p.catch(() => {});   // the prefetch may reject (cancel, dropped connection) before it is awaited; it is awaited/handled later
      return p;
    };
    pending = readNext();
    for (;;) {
      if (signal.aborted) throw new CancelError();
      const { rows, lim } = await pending; pending = null;
      if (!rows.length) break;
      if (isKeyset) last = keyIdx.map(i => rows[rows.length - 1][i]);
      let bytes = 0; for (const row of rows) bytes += rowBytes(row);
      const avg = Math.max(1, bytes / rows.length);
      curBatch = Math.max(1, Math.min(batch, Math.floor(READ_BYTES / avg), curBatch * 4));
      pending = rows.length < lim ? Promise.resolve({ rows: [], lim }) : readNext();
      let w;
      try { w = await writeBatch(rows); } catch (e) { throw e; }
      r.rowsCopied += w.inserted; r.rowsSkipped += w.skipped;
      done += rows.length;
      const now = Date.now();
      if (first || now - lastEmit >= 250) { first = false; lastEmit = now; emit({ type: 'rows', phase: 'data', table: entry.table, rowsDone: done, rowsTotal: entry.sourceRows }); }
    }
    emit({ type: 'rows', phase: 'data', table: entry.table, rowsDone: done, rowsTotal: Math.max(done, entry.sourceRows) });
  } finally {
    if (pending) await pending.catch(() => {});
    if (cursor) { try { await src.client.query('CLOSE mig_c'); } catch (e) { /* ignore */ } try { await src.client.query('ROLLBACK'); } catch (e) { /* ignore */ } }
  }
  if (r.rowsSkipped > 0 && mode !== 'insert-missing') r.error = `${r.rowsSkipped} row(s) rejected${errSamples[0] ? ': ' + errSamples[0] : ''}`;
}

// ---------------------------------------------------------------- sequences
async function syncSequencesPg({ client, srcModel, entries, copied, log, signal }) {
  const names = entries.map(e => e._src.fullName);
  if (!names.length) return;
  const rows = (await client.query(`
    SELECT sn.nspname AS seq_schema, sc.relname AS seq_name, tn.nspname AS t_schema, tc.relname AS t_name, a.attname AS col,
           s.seqmin::text AS min, s.seqmax::text AS max, s.seqincrement::text AS incr
    FROM pg_class tc JOIN pg_namespace tn ON tn.oid = tc.relnamespace
    JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN (SELECT ad.adrelid AS rel, ad.adnum AS num, d.refobjid AS seq FROM pg_attrdef ad JOIN pg_depend d ON d.classid = 'pg_attrdef'::regclass AND d.objid = ad.oid AND d.refclassid = 'pg_class'::regclass
          UNION SELECT d.refobjid, d.refobjsubid, d.objid FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'i') l ON l.rel = tc.oid AND l.num = a.attnum
    JOIN pg_class sc ON sc.oid = l.seq AND sc.relkind = 'S' JOIN pg_namespace sn ON sn.oid = sc.relnamespace JOIN pg_sequence s ON s.seqrelid = sc.oid
    WHERE tn.nspname || '.' || tc.relname = ANY($1::text[])`, [names])).rows;
  const srcSeq = new Map((srcModel.sequences || []).map(s => [s.fullName, s]));
  const emptyMemo = new Map();
  for (const r of rows) {
    if (signal && signal.aborted) return;
    const tfull = r.t_schema + '.' + r.t_name, sfull = r.seq_schema + '.' + r.seq_name;
    try {
      if (BigInt(r.incr) < 0n) { log('info', `Sequence ${sfull} has a negative increment; not resynchronised`); continue; }
      let cand = null;
      const isCopied = copied.has(tfull);
      const tq = qn(r.t_schema, r.t_name);
      if (isCopied) {
        const m = (await client.query(`SELECT max(${qi(r.col)})::text AS m FROM ${tq}`)).rows[0].m;
        if (m != null && /^-?\d+$/.test(m)) cand = BigInt(m);
      }
      let empty = false;
      if (!isCopied) { if (!emptyMemo.has(tfull)) emptyMemo.set(tfull, !(await client.query(`SELECT EXISTS (SELECT 1 FROM ${tq}) AS x`)).rows[0].x); empty = emptyMemo.get(tfull); }
      const ss = srcSeq.get(sfull);
      if (ss && ss.lastValue != null && (isCopied || empty)) { const sl = BigInt(ss.lastValue); if (cand == null || sl > cand) cand = sl; }
      if (cand == null) continue;
      const min = BigInt(r.min), max = BigInt(r.max);
      if (cand < min) cand = min; if (cand > max) cand = max;
      const sq = qn(r.seq_schema, r.seq_name);
      const cur = (await client.query(`SELECT last_value::text AS v, is_called AS c FROM ${sq}`)).rows[0];
      if (cur.c && BigInt(cur.v) >= cand) continue;
      await client.query('SELECT setval($1::regclass, $2::bigint, true)', [sq, cand.toString()]);
    } catch (e) { log('warn', `Could not resynchronise sequence ${sfull}: ${e.message}`); try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ } }
  }
}

module.exports = { copyPgAll, syncSequencesPg, openSession, closeSession, CancelError, TableError };
