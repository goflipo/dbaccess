// runMigration: re-plan from the live catalogs, execute schema steps (per-phase transactions on PostgreSQL),
// copy data, run post-data steps, resynchronise sequences / AUTO_INCREMENT. Progress is streamed via onProgress.

const { buildPlanInternal } = require('./plan');
const { getConn } = require('./util');
const { qi, qn } = require('./sql').pg;
const { copyPgAll, syncSequencesPg } = require('./copyPg');
const { copyMysqlAll, syncAutoIncrementMysql } = require('./copyMysql');

const active = new Map();      // runId -> AbortController
const busyTargets = new Set(); // one active run per target connection

const PG_DUP = new Set(['42710', '42P07', '42701', '42P16', '42P06']);
const MY_DUP = new Set([1060, 1061, 1050, 1826, 1022, 1068, 1007, 1304]);

function cancelMigration(runId) {
  const ac = active.get(runId);
  if (!ac) return false;
  ac.abort();
  return true;
}

async function runMigration(dbManager, srcId, tgtId, options, ctx) {
  const { onProgress, runId: rid } = ctx || {};
  const runId = rid || 'mig-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  const started = Date.now();
  const ac = new AbortController();
  const signal = ac.signal;
  active.set(runId, ac);
  const emit = (e) => { try { if (onProgress) onProgress(Object.assign({ runId }, e)); } catch (err) { /* a broken listener must not break the run */ } };
  const log = (level, message) => emit({ type: 'log', level, message });
  const report = { runId, status: 'success', steps: [], tables: [], errors: [], durationMs: 0 };
  Object.defineProperty(report, '_emit', { value: emit, enumerable: false });   // lets record() announce step completion
  let tgtLocked = false;
  let partial = false, failed = false;
  try {
    emit({ type: 'phase', phase: 'plan', message: 'Reading source and target catalogs' });
    const plan = await buildPlanInternal(dbManager, srcId, tgtId, options);
    const blockers = plan.warnings.filter(w => w.level === 'blocker');
    for (const w of plan.warnings) if (w.level !== 'blocker') log(w.level === 'warn' ? 'warn' : 'info', w.message);
    if (blockers.length) {
      for (const b of blockers) { report.errors.push({ where: 'plan', message: b.message }); emit({ type: 'error', phase: 'plan', message: b.message, level: 'error' }); }
      report.status = 'failed';
      return report;
    }
    if (busyTargets.has(tgtId)) throw new Error('Another migration is already running against this target connection');
    busyTargets.add(tgtId); tgtLocked = true;
    const opts = Object.assign({}, options || {}, plan._ctx.opts);
    const engine = plan.engine;
    const hasData = opts.includeData && plan.dataPlan.length > 0;
    const pre = hasData ? plan.steps.filter(s => s.preData) : plan.steps;
    const post = hasData ? plan.steps.filter(s => !s.preData) : [];

    // ------------------------------------------------------------ schema
    const stepCtx = { report, emit, log, opts, signal, dbManager, tgtId, stop: false, partial: false };
    if (engine === 'postgres') await runPgSchema(stepCtx, pre, post, hasData, async () => { if (hasData && !opts.dryRun) await dataPhase(); });
    else {
      await runMysqlSchema(stepCtx, pre, opts.dryRun);
      if (hasData && !opts.dryRun && !stepCtx.stop && !signal.aborted) await dataPhase();
      if (!stepCtx.stop && !signal.aborted) await runMysqlSchema(stepCtx, post, opts.dryRun);
    }
    if (stepCtx.partial) partial = true;
    if (stepCtx.stop) failed = true;

    async function dataPhase() {
      emit({ type: 'phase', phase: 'data', message: `Copying data for ${plan.dataPlan.length} table(s)` });
      const x = { dbManager, srcId, tgtId, plan, opts, signal, emit, log, getConn, tgtSuper: plan._ctx.tgtSuper, entries: plan.dataPlan };
      const results = engine === 'postgres' ? await copyPgAll(x) : await copyMysqlAll(x);
      report.tables = results;
      const seen = new Set(results.map(r => r.table));
      for (const e of plan.dataPlan) if (!seen.has(e.table)) report.tables.push({ table: e.table, rowsCopied: 0, rowsSkipped: 0, sourceRows: e.sourceRows, targetRowsAfter: null, error: x.cancelled ? 'cancelled before start' : 'not started (earlier failure)' });
      for (const r of results) {
        if (r.error && r.error !== 'cancelled') { report.errors.push({ where: r.table, message: r.error }); partial = true; }
        else if (r.rowsSkipped > 0 && opts.dataMode !== 'insert-missing') partial = true;
      }
      if (x.stopped) failed = true;
      // sequences / AUTO_INCREMENT after data (also after a cancel, for the tables that were reached)
      await resync(results);
    }
    async function resync(results) {
      if (opts.dryRun || !opts.syncSequences) return;
      const conn = getConn(dbManager, tgtId);
      emit({ type: 'phase', phase: 'sequence-sync', message: 'Resynchronising sequences' });
      try {
        if (engine === 'postgres') {
          const c = await conn.client.connect();
          try {
            const copied = new Set(plan.dataPlan.filter(e => results.some(r => r.table === e.table)).map(e => e._src.fullName));
            const entries = hasData ? plan.dataPlan : plan._ctx.selected.map(t => ({ _src: t }));
            await syncSequencesPg({ client: c, srcModel: plan._ctx.src, entries, copied, log, signal: null });
          } finally { c.release(); }
        } else if (hasData) {
          const c = await conn.client.getConnection();
          try { await syncAutoIncrementMysql({ c, tgtDb: conn.activeDb, entries: plan.dataPlan.filter(e => results.some(r => r.table === e.table)), log }); } finally { c.release(); }
        }
      } catch (e) { log('warn', 'Sequence resynchronisation failed: ' + e.message); partial = true; }
    }
    if (!hasData && !signal.aborted && !failed && !opts.dryRun) await resync([]);

    if (signal.aborted) report.status = 'cancelled';
    else if (failed) report.status = 'failed';
    else if (partial) report.status = 'partial';
  } catch (e) {
    if (signal.aborted || (e && e.cancelled)) report.status = 'cancelled';
    else { report.status = 'failed'; report.errors.push({ where: 'run', message: e.message }); emit({ type: 'error', message: e.message, level: 'error' }); }
  } finally {
    if (signal.aborted && report.status !== 'cancelled' && report.status !== 'failed') report.status = 'cancelled';
    if (tgtLocked) busyTargets.delete(tgtId);
    active.delete(runId);
    report.durationMs = Date.now() - started;
    for (const s of report.steps) if (s.status === 'error') report.errors.push({ where: s.id + (s.description ? ' ' + s.description : ''), message: s.error });
    emit({ type: 'done', status: report.status, message: `Migration ${report.status}`, level: report.status === 'success' ? 'info' : 'warn' });
  }
  return report;
}

// ------------------------------------------------------------------------------------------------ PostgreSQL schema
async function runPgSchema(sc, pre, post, hasData, dataFn) {
  const { report, emit, opts, signal, dbManager, tgtId } = sc;
  const conn = getConn(dbManager, tgtId);
  const c = await conn.client.connect();
  let pid = null, inTx = false;
  const onAbort = () => { if (pid) conn.client.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => {}); };
  signal.addEventListener('abort', onAbort);
  try {
    try { pid = (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p; } catch (e) { /* ignore */ }
    try {
      const got = (await c.query("SELECT pg_try_advisory_lock(hashtext('dbaccess-migration')) AS ok")).rows[0].ok;
      if (!got) throw Object.assign(new Error('Another migration is running against this target database (advisory lock busy)'), { fatal: true });
    } catch (e) { if (e.fatal) throw e; }
    try { await c.query('SET statement_timeout = 0'); await c.query('SET idle_in_transaction_session_timeout = 0'); } catch (e) { /* ignore */ }

    const dry = opts.dryRun;
    const all = hasData ? pre.concat(post) : pre;
    const runList = async (list) => {
      // consecutive non-autocommit steps of one phase share a transaction
      let i = 0, lastPhase = null;
      while (i < list.length && !sc.stop && !signal.aborted) {
        const s = list[i];
        if (s.phase !== lastPhase) { lastPhase = s.phase; emit({ type: 'phase', phase: s.phase, message: `Phase: ${s.phase}` }); }
        if (s.autocommit) {
          if (dry) { record(report, s, 'skipped', 'skipped (dry run)', 0); i++; continue; }
          emit({ type: 'step', phase: s.phase, stepId: s.id, message: s.description });
          const t0 = Date.now();
          try { await c.query(s.sql); record(report, s, 'ok', null, Date.now() - t0); }
          catch (e) { if (PG_DUP.has(e.code)) record(report, s, 'skipped', 'already exists', Date.now() - t0); else { handleErr(sc, report, s, e, Date.now() - t0); } }
          i++; continue;
        }
        let j = i; while (j < list.length && list[j].phase === s.phase && !list[j].autocommit) j++;
        await runGroup(list.slice(i, j));
        i = j;
      }
    };
    const runGroup = async (group) => {
      const recs = [];
      await c.query('BEGIN'); inTx = true;
      try { await c.query("SET LOCAL lock_timeout = '15s'"); } catch (e) { /* ignore */ }
      for (const s of group) {
        if (signal.aborted) { recs.push(record(report, s, 'skipped', 'cancelled', 0)); continue; }
        emit({ type: 'step', phase: s.phase, stepId: s.id, message: s.description });
        const t0 = Date.now();
        await c.query('SAVEPOINT mig_s');
        try {
          if (s.checkNulls) {
            const q = `SELECT 1 FROM ${qn(...splitFull(s.checkNulls.table))} WHERE ${qi(s.checkNulls.column)} IS NULL LIMIT 1`;
            if ((await c.query(q)).rowCount) { await c.query('RELEASE SAVEPOINT mig_s'); const rec = record(report, s, 'skipped', `NULL values remain in ${s.checkNulls.table}.${s.checkNulls.column}; column left nullable`, Date.now() - t0); sc.partial = true; emit({ type: 'log', level: 'warn', message: rec.error }); recs.push(rec); continue; }
          }
          await c.query(s.sql);
          await c.query('RELEASE SAVEPOINT mig_s');
          recs.push(record(report, s, 'ok', null, Date.now() - t0));
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT mig_s'); await c.query('RELEASE SAVEPOINT mig_s');
          if (s.fallbackSql && e.code === '23503') {
            try { await c.query('SAVEPOINT mig_s'); await c.query(s.fallbackSql); await c.query('RELEASE SAVEPOINT mig_s'); recs.push(record(report, s, 'ok', null, Date.now() - t0)); emit({ type: 'log', level: 'warn', message: `${s.description}: existing rows violate the constraint, added as NOT VALID` }); sc.partial = true; continue; }
            catch (e2) { await c.query('ROLLBACK TO SAVEPOINT mig_s'); await c.query('RELEASE SAVEPOINT mig_s'); e = e2; }
          }
          if (PG_DUP.has(e.code)) { recs.push(record(report, s, 'skipped', 'already exists', Date.now() - t0)); continue; }
          const rec = handleErr(sc, report, s, e, Date.now() - t0); recs.push(rec);
          if (sc.stop) break;
        }
      }
      if (sc.stop) {
        await c.query('ROLLBACK'); inTx = false;
        for (const r of recs) if (r.status === 'ok') { r.status = 'skipped'; r.error = 'rolled back with its phase after a later failure'; }
        for (const s of group) if (!recs.some(r => r.id === s.id)) record(report, s, 'skipped', 'not executed', 0);
        return;
      }
      await c.query('COMMIT'); inTx = false;
    };
    if (dry) {
      emit({ type: 'log', level: 'info', message: 'Dry run: the schema is executed in one transaction that is rolled back; data is not copied' });
      await c.query('BEGIN'); inTx = true;
      try {
        await runListDry(all);
      } finally { await c.query('ROLLBACK').catch(() => {}); inTx = false; }
      return;
    }
    async function runListDry(list) {
      // one outer transaction: each phase group still uses savepoints; no COMMIT happens
      let i = 0;
      while (i < list.length && !sc.stop) {
        const s = list[i];
        if (s.autocommit) { record(report, s, 'skipped', 'skipped (dry run)', 0); i++; continue; }
        let j = i; while (j < list.length && !list[j].autocommit) j++;
        await runDryGroup(list.slice(i, j));
        i = j;
      }
    }
    async function runDryGroup(group) {
      for (const s of group) {
        if (sc.stop) { record(report, s, 'skipped', 'not executed', 0); continue; }
        emit({ type: 'step', phase: s.phase, stepId: s.id, message: s.description });
        const t0 = Date.now();
        await c.query('SAVEPOINT mig_s');
        try { await c.query(s.sql); await c.query('RELEASE SAVEPOINT mig_s'); record(report, s, 'ok', 'validated (dry run)', Date.now() - t0); }
        catch (e) { await c.query('ROLLBACK TO SAVEPOINT mig_s'); await c.query('RELEASE SAVEPOINT mig_s'); if (PG_DUP.has(e.code)) record(report, s, 'skipped', 'already exists', Date.now() - t0); else handleErr(sc, report, s, e, Date.now() - t0); }
      }
    }

    await runList(pre);
    if (sc.stop || signal.aborted) {
      for (const s of post) record(report, s, 'skipped', 'not executed', 0);
      return;
    }
    // data runs between the pre- and post-data steps, on its own sessions
    if (hasData) await dataFn();
    if (!sc.stop && !signal.aborted) await runList(post);
    else for (const s of post) record(report, s, 'skipped', 'not executed', 0);
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (inTx) { try { await c.query('ROLLBACK'); } catch (e) { /* ignore */ } }
    try { await c.query("SELECT pg_advisory_unlock(hashtext('dbaccess-migration'))"); } catch (e) { /* ignore */ }
    c.release(true);
  }
}

function splitFull(full) { const i = full.indexOf('.'); return [full.slice(0, i), full.slice(i + 1)]; }

function record(report, s, status, error, ms) {
  const rec = { id: s.id, status, ms, description: s.description, phase: s.phase };
  if (error) rec.error = error;
  report.steps.push(rec);
  if (typeof report._emit === 'function') report._emit({ type: 'step', phase: s.phase, stepId: s.id, status });   // completion event (no message: the start event already logged it)
  return rec;
}

function handleErr(sc, report, s, e, ms) {
  const msg = (e.code ? `[${e.code}] ` : e.errno ? `[${e.errno}] ` : '') + e.message;
  if (s.optional) { const rec = record(report, s, 'skipped', msg, ms); sc.emit({ type: 'log', level: 'warn', message: `${s.description} failed (optional): ${e.message}` }); return rec; }
  const rec = record(report, s, 'error', msg, ms);
  sc.emit({ type: 'error', phase: s.phase, stepId: s.id, message: `${s.description}: ${msg}`, level: 'error' });
  if (sc.opts.onError === 'stop') sc.stop = true; else sc.partial = true;
  return rec;
}

// ------------------------------------------------------------------------------------------------ MySQL schema
async function runMysqlSchema(sc, steps, dry) {
  const { report, emit, signal, dbManager, tgtId } = sc;
  if (!steps.length) return;
  const conn = getConn(dbManager, tgtId);
  const c = await conn.client.getConnection();
  let tid = null;
  const onAbort = () => { if (tid) conn.client.query('KILL QUERY ' + Number(tid)).catch(() => {}); };
  signal.addEventListener('abort', onAbort);
  try {
    try { tid = (await c.query('SELECT CONNECTION_ID() AS id'))[0][0].id; } catch (e) { /* ignore */ }
    let lastPhase = null;
    for (const s of steps) {
      if (sc.stop || signal.aborted) { record(report, s, 'skipped', signal.aborted ? 'cancelled' : 'not executed', 0); continue; }
      if (s.phase !== lastPhase) { lastPhase = s.phase; emit({ type: 'phase', phase: s.phase, message: `Phase: ${s.phase}` }); }
      if (dry) { record(report, s, 'skipped', 'skipped (dry run: MySQL DDL cannot be rolled back)', 0); continue; }
      emit({ type: 'step', phase: s.phase, stepId: s.id, message: s.description });
      const t0 = Date.now();
      try {
        if (s.checkNulls) {
          const [rows] = await c.query(`SELECT 1 AS x FROM \`${String(s.checkNulls.table).replace(/^[^.]*\./, '').replace(/`/g, '``')}\` WHERE \`${s.checkNulls.column.replace(/`/g, '``')}\` IS NULL LIMIT 1`).catch(() => [[]]);
          if (rows.length) { const rec = record(report, s, 'skipped', `NULL values remain in ${s.checkNulls.table}.${s.checkNulls.column}; column left nullable`, Date.now() - t0); sc.partial = true; emit({ type: 'log', level: 'warn', message: rec.error }); continue; }
        }
        await c.query(s.sql);
        record(report, s, 'ok', null, Date.now() - t0);
      } catch (e) {
        if (MY_DUP.has(e.errno)) record(report, s, 'skipped', 'already exists', Date.now() - t0);
        else handleErr(sc, report, s, e, Date.now() - t0);
      }
    }
  } finally { signal.removeEventListener('abort', onAbort); c.release(); }
}

module.exports = { runMigration, cancelMigration };
