// buildPlan: introspect both sides, select tables, diff, order, warn, render script, plan the data copy.
// Never trusts anything from the UI except the options; the catalogs are read fresh every time.

const { family, pg, my, topoSort } = require('./sql');
const { normalizeOptions, getConn, withClient, sameDatabase, stepFactory, renderScript } = require('./util');
const { introspectPg } = require('./introspect-pg');
const { introspectMysql } = require('./introspect-mysql');
const { planPg } = require('./ddl-pg');
const { planMysql } = require('./ddl-mysql');

async function introspectAny(dbManager, id) {
  const conn = getConn(dbManager, id);
  const fam = family(conn.type);
  if (fam === 'postgres') return withClient(dbManager, id, async (c) => { try { return await introspectPg(c); } finally { /* SET LOCAL only: nothing to reset */ } });
  if (fam === 'mysql') return withClient(dbManager, id, (c) => introspectMysql(c, conn.activeDb));
  throw new Error('Unsupported engine: ' + conn.type + '. Only PostgreSQL-wire and MySQL/MariaDB databases can be migrated.');
}

/** Run a read query on a connection. timeoutMs uses a dedicated client so the timeout cannot leak. */
async function qrows(dbManager, id, sql, params, timeoutMs) {
  const conn = getConn(dbManager, id);
  if (family(conn.type) === 'postgres') {
    if (!timeoutMs) return (await conn.client.query(sql, params || undefined)).rows;
    return withClient(dbManager, id, async (c) => {
      await c.query('BEGIN');
      try { await c.query(`SET LOCAL statement_timeout = ${Number(timeoutMs) | 0}`); return (await c.query(sql, params || undefined)).rows; }
      finally { await c.query('ROLLBACK').catch(() => {}); }
    });
  }
  if (!timeoutMs) return (await conn.client.query(sql, params || undefined))[0];
  return withClient(dbManager, id, async (c) => {
    try { await c.query(`SET SESSION max_execution_time = ${Number(timeoutMs) | 0}`); } catch (e) { try { await c.query(`SET SESSION max_statement_time = ${Number(timeoutMs) / 1000}`); } catch (e2) { /* ignore */ } }
    try { return (await c.query(sql, params || undefined))[0]; }
    finally { try { await c.query('SET SESSION max_execution_time = 0'); } catch (e) { try { await c.query('SET SESSION max_statement_time = 0'); } catch (e2) { /* ignore */ } } }
  });
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

const zeroSummary = () => ({ tablesToCreate: 0, tablesToAlter: 0, columnsToAdd: 0, columnsToAlter: 0, columnsToDrop: 0, indexesToCreate: 0, constraintsToCreate: 0, enumsToCreate: 0, sequencesToCreate: 0, viewsToCreate: 0, tablesToDrop: 0, rowsEstimate: 0 });

async function buildPlanInternal(dbManager, srcId, tgtId, options) {
  const opts = normalizeOptions(options);
  const warnings = [];
  const warn = (level, object, message) => warnings.push({ level, object: object || '', message });
  const sum = zeroSummary();
  const skippedDrops = [];
  const mk = (engine, extra) => {
    const plan = Object.assign({ engine, summary: sum, steps: [], dataPlan: [], warnings, script: '' }, extra || {});
    return plan;
  };
  const sc = getConn(dbManager, srcId), tc = getConn(dbManager, tgtId);
  const sfam = family(sc.type), tfam = family(tc.type);
  if (!sfam || !tfam) {
    const bad = !sfam ? sc.type : tc.type;
    warn('blocker', 'engine', `Unsupported engine "${bad}": migration is not supported for it. Only PostgreSQL-wire (PostgreSQL) and MySQL/MariaDB databases are supported. Cross-engine migration is out of scope.`);
    return mk(sfam || tfam || null);
  }
  if (sfam !== tfam) {
    warn('blocker', 'engine', `Cross-engine migration is out of scope: source is ${sc.type} and target is ${tc.type}. Pick two databases of the same engine family.`);
    return mk(sfam);
  }
  if (sameDatabase(sc, tc, srcId, tgtId)) {
    warn('blocker', 'connection', 'Source and target are the same database; choose two different databases.');
    return mk(sfam);
  }
  const engine = sfam;
  if (!['postgres', 'mysql', 'mariadb'].includes(sc.type) || !['postgres', 'mysql', 'mariadb'].includes(tc.type)) warn('warn', 'engine', `${sc.type} -> ${tc.type}: best-effort, untested engine (catalog differences may cause failures)`);

  const [src, tgt] = await Promise.all([introspectAny(dbManager, srcId), introspectAny(dbManager, tgtId)]);
  if (engine === 'postgres') for (const m of [src, tgt]) if (/CockroachDB|Redshift|Greenplum/i.test(m.version)) { warn('warn', 'engine', 'Best-effort, untested engine: ' + String(m.version).slice(0, 60)); break; }
  for (const w of [...(src.warnings || []), ...(tgt.warnings || [])]) warn('warn', 'introspection', w);
  if (engine === 'postgres' && tgt.versionNum < src.versionNum - 10000 * 0) {
    if (tgt.versionNum < 120000 && src.tables.some(t => t.columns.some(c => c.generated))) warn('blocker', 'version', 'Target PostgreSQL is older than 12 and the source uses generated columns');
    if (tgt.versionNum < 100000) warn('blocker', 'version', 'Target PostgreSQL is older than 10');
  }

  // ---------------------------------------------------------------- selection
  const mysqlMode = engine === 'mysql';
  const nameOf = (t) => (mysqlMode ? t.name : t.fullName);
  let selected = [];
  const byFull = new Map(src.tables.map(t => [t.fullName, t]));
  if (opts.tables) {
    const seen = new Set();
    for (const raw of opts.tables) {
      let t = byFull.get(raw);
      if (!t && mysqlMode) { const nm = String(raw).includes('.') ? String(raw).slice(String(raw).indexOf('.') + 1) : raw; t = src.tables.find(x => x.name === nm || (src.lctn && x.name.toLowerCase() === nm.toLowerCase())); }
      if (!t) { warn('blocker', raw, `Selected table ${raw} does not exist in the source database`); continue; }
      if (!seen.has(t.fullName)) { seen.add(t.fullName); selected.push(t); }
    }
  } else selected = src.tables.slice();
  const foreign = selected.filter(t => t.kind === 'foreign');
  for (const t of foreign) warn('warn', t.fullName, `Foreign table ${t.fullName} needs a foreign server and is skipped`);
  selected = selected.filter(t => t.kind !== 'foreign');
  const selSet = new Set(selected.map(t => t.fullName));
  const refFull = (t, fk) => (mysqlMode ? src.database + '.' + fk.refTable : fk.refSchema + '.' + fk.refTable);
  for (let changed = true; changed;) {
    changed = false;
    for (const t of selected.slice()) {
      const deps = [];
      if (t.partitionOf && t.partitionOf.parent) deps.push([t.partitionOf.parent, 'is a partition of', true]);
      for (const p of t.inherits || []) deps.push([p, 'inherits from', true]);
      for (const fk of t.foreignKeys) deps.push([refFull(t, fk), 'references', false]);
      for (const c of src.tables) if (c.partitionOf && c.partitionOf.parent === t.fullName) deps.push([c.fullName, 'is the partitioned parent of', true]);
      for (const [d, verb, force] of deps) {
        const dt = byFull.get(d);
        if (!dt || selSet.has(d) || dt.kind === 'foreign') continue;
        if (force || opts.autoIncludeDeps) { selected.push(dt); selSet.add(d); changed = true; warn('info', d, `Added ${d} to the selection because ${t.fullName} ${verb} it`.replace(/because (S+) is the partitioned parent of it/, 'because it is a partition of $1')); }
      }
    }
  }
  selected.sort((a, b) => (a.fullName < b.fullName ? -1 : 1));
  if (!selected.length && !warnings.some(w => w.level === 'blocker')) warn('info', 'selection', 'No tables selected');

  // ---------------------------------------------------------------- target privileges / state probes
  const ctx = {
    src, tgt, opts, warn, F: stepFactory(), sum, selected, tgtDb: tc.activeDb, skippedDrops,
    tgtQuery: (sql, params, ms) => qrows(dbManager, tgtId, sql, params, ms),
    tgtHasRows: async (t) => {
      const q = mysqlMode ? my.qn(tc.activeDb, t.name) : pg.qn(t.schema, t.name);
      try { return (await qrows(dbManager, tgtId, `SELECT EXISTS (SELECT 1 FROM ${q}) AS x`, null))[0].x == true; } catch (e) { return true; }
    },
  };
  if (engine === 'postgres') {
    try {
      const p = (await ctx.tgtQuery(`SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create, pg_is_in_recovery() AS rec, current_setting('default_transaction_read_only') AS ro,
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) AS su`))[0];
      ctx.tgtSuper = p.su;
      if (p.rec) warn('blocker', 'target', 'The target is a read-only replica (pg_is_in_recovery)');
      if (p.ro === 'on') warn('blocker', 'target', 'The target session has default_transaction_read_only = on');
      ctx.tgtCanCreateDb = p.can_create;
    } catch (e) { warn('warn', 'target', 'Could not verify target privileges: ' + e.message); }
  }

  // ---------------------------------------------------------------- schema diff
  let created = new Set();
  if (opts.includeSchema && !warnings.some(w => w.level === 'blocker' && /does not exist in the source/.test(w.message))) {
    const r = engine === 'postgres' ? await planPg(ctx) : await planMysql(ctx);
    created = r.created;
    if (engine === 'postgres' && ctx.F.steps.some(s => /^create-/.test(s.kind)) && r.neededSchemas) {
      try {
        const ex = [...r.neededSchemas].filter(s => tgt.schemas.includes(s));
        const missing = [...r.neededSchemas].filter(s => !tgt.schemas.includes(s));
        if (missing.length && ctx.tgtCanCreateDb === false) warn('blocker', 'target', `The target user lacks CREATE privilege on the database (needed to create schema ${missing.join(', ')})`);
        if (ex.length) for (const x of await ctx.tgtQuery(`SELECT s, has_schema_privilege(current_user, s, 'CREATE') AS ok FROM unnest($1::text[]) s`, [ex])) if (!x.ok) warn('blocker', x.s, `The target user lacks CREATE privilege on schema ${x.s}`);
      } catch (e) { /* ignore */ }
    }
  } else if (!opts.includeSchema) {
    for (const t of selected) if (!(mysqlMode ? tgt.tables.some(x => x.name.toLowerCase() === t.name.toLowerCase()) : tgt.tables.some(x => x.fullName === t.fullName))) warn('blocker', t.fullName, `Table ${t.fullName} does not exist in the target and schema migration is disabled`);
  }
  if (mysqlMode && !ctx.opts.dryRun) { /* nothing */ }

  // ---------------------------------------------------------------- data plan
  let dataPlan = [];
  const explicit = new Set(opts.tables ? selected.filter(t => opts.tables.includes(t.fullName) || opts.tables.includes(t.name)).map(t => t.fullName) : []);
  if (opts.includeData) dataPlan = await buildDataPlan({ explicit, dbManager, srcId, tgtId, engine, src, tgt, opts, selected, warn, sum, tc, ctx, created });

  const plan = mk(engine);
  plan.steps = ctx.F.finish().map(s => { const o = Object.assign({}, s); return o; });
  plan.dataPlan = dataPlan;
  plan.skippedDrops = skippedDrops;
  const lbl = (c) => `${c.type} ${(c.config && c.config.host) || ''}:${(c.config && c.config.port) || ''}/${c.activeDb || ''}`;
  plan.script = renderScript(plan, { srcLabel: lbl(sc), tgtLabel: lbl(tc) });
  delete plan.skippedDrops;
  if (engine === 'postgres') warn('info', 'plan', 'Script generated from the live catalogs; run it only against the intended target');
  Object.defineProperty(plan, '_ctx', { value: { src, tgt, selected, created, opts, tgtSuper: ctx.tgtSuper }, enumerable: false });
  return plan;
}

async function buildDataPlan(a) {
  const { dbManager, srcId, tgtId, engine, src, tgt, opts, selected, warn, sum, tc, created } = a;
  const my_ = engine === 'mysql';
  const key = (n) => (my_ ? String(n).toLowerCase() : n);
  const tgtBy = new Map(tgt.tables.map(t => [my_ ? key(t.name) : t.fullName, t]));
  const entries = [];
  for (const t of selected) {
    if (t.partitionOf && t.partitionOf.parent) continue; // rows are routed through the partitioned parent
    const x = tgtBy.get(my_ ? key(t.name) : t.fullName);
    const columns = [], skippedColumns = [];
    const xCols = new Map(((x && x.columns) || []).map(c => [key(c.name), c]));
    for (const c of t.columns) {
      const e = xCols.get(key(c.name));
      if (c.generated) skippedColumns.push({ name: c.name, reason: 'generated column' });
      else if (c.virtual) skippedColumns.push({ name: c.name, reason: 'virtual column' });
      else if (e && e.generated) skippedColumns.push({ name: c.name, reason: 'generated column in target' });
      else columns.push(c.name);
    }
    if (x) for (const e of x.columns) if (!t.columns.some(c => key(c.name) === key(e.name)) && e.notNull && e.default == null && !e.identity && !e.generated && !e.autoIncrement) warn('warn', `${t.fullName}.${e.name}`, `Target column ${e.name} of ${t.fullName} is NOT NULL without a default and does not exist in the source; inserts will fail`);
    let keyCols = null, readMode = my_ ? 'offset' : 'cursor';
    if (t.primaryKey && t.primaryKey.columns.every(c => columns.includes(c))) { keyCols = t.primaryKey.columns; readMode = 'keyset'; }
    else if (!my_) {
      const u = t.uniques.find(u => u.columns.length && u.columns.every(c => columns.includes(c) && (t.columns.find(z => z.name === c) || {}).notNull));
      if (u) { keyCols = u.columns; readMode = 'keyset'; }
    } else {
      const u = t.indexes.find(i => i.unique && !i.expressions && i.parts.every(p => !p.sub && columns.includes(p.name) && (t.columns.find(z => z.name === p.name) || {}).notNull));
      if (u) { keyCols = u.columns; readMode = 'keyset'; }
    }
    if (keyCols) { // json/xml/point etc. cannot be ordered
      const bad = keyCols.some(k => /^(json|xml|point|box|line|lseg|path|polygon|circle)$/i.test(((t.columns.find(z => z.name === k) || {}).type || '').replace(/\(.*/, '')) || /^(json|blob|text|geometry)/i.test((t.columns.find(z => z.name === k) || {}).dataType || '') && my_);
      if (bad) { keyCols = null; readMode = my_ ? 'offset' : 'cursor'; }
    }
    let conflictKey = t.primaryKey ? t.primaryKey.columns : (!my_ && t.uniques[0] ? t.uniques[0].columns : (my_ ? ((t.indexes.find(i => i.unique && !i.expressions) || {}).columns || null) : null));
    let keyless = false;
    if ((opts.dataMode === 'insert-missing' || opts.dataMode === 'upsert') && (!conflictKey || !conflictKey.every(c => columns.includes(c)))) {
      conflictKey = null;
      // explicitly selected table: refuse. Implicitly selected ("all tables"): fall back after the row counts are known.
      if (a.explicit.has(t.fullName)) warn('blocker', t.fullName, `Data mode "${opts.dataMode}" needs a primary key or unique constraint, but ${t.fullName} has none (use "append" or "truncate-copy")`);
      else keyless = true;
    }
    if (!columns.length) { warn('warn', t.fullName, `No copyable columns for ${t.fullName}; skipped`); continue; }
    if (a.engine === 'postgres' && /redshift/i.test(src.version) && (opts.dataMode === 'insert-missing' || opts.dataMode === 'upsert')) warn('blocker', t.fullName, 'ON CONFLICT data modes are not supported on Redshift');
    entries.push({
      table: t.fullName, mode: opts.dataMode, sourceRows: 0, targetRows: 0, columns, skippedColumns,
      readMode, keyColumns: keyCols, conflictKey, identityAlways: !my_ && t.columns.some(c => c.identity === 'a' && columns.includes(c.name)),
      onlyParent: !!t.hasInheritChildren, partitioned: t.kind === 'partitioned', existsInTarget: !!x, keyless, estimated: false, cycleGroup: null, strategy: '',
      _src: t, _tgt: x || null,
    });
  }
  // counts
  const sq = (t) => (my_ ? my.qn(src.database, t.name) : pg.qn(t.schema, t.name));
  await pool(entries, 4, async (e) => {
    try { e.sourceRows = Number((await qrows(dbManager, srcId, `SELECT ${my_ ? 'CAST(COUNT(*) AS CHAR)' : 'count(*)::text'} AS n FROM ${e.onlyParent ? 'ONLY ' : ''}${sq(e._src)}`, null, 30000))[0].n); }
    catch (err) { e.sourceRows = Math.max(0, Number(e._src.estRows) || 0); e.estimated = true; warn('warn', e.table, `Exact row count of ${e.table} timed out or failed; using the catalog estimate (${e.sourceRows})`); }
    if (e._tgt) {
      const tq = my_ ? my.qn(tc.activeDb, e._tgt.name) : pg.qn(e._tgt.schema, e._tgt.name);
      try { e.targetRows = Number((await qrows(dbManager, tgtId, `SELECT ${my_ ? 'CAST(COUNT(*) AS CHAR)' : 'count(*)::text'} AS n FROM ${e.onlyParent ? 'ONLY ' : ''}${tq}`, null, 30000))[0].n); }
      catch (err) { e.targetRows = Math.max(0, Number(e._tgt.estRows) || 0); }
    }
  });
  // keyless tables under insert-missing/upsert (implicit selection): copy only into an EMPTY target table (append), else skip
  for (const e of entries.slice()) {
    if (!e.keyless) continue;
    if (e.targetRows === 0) { e.mode = 'append'; warn('info', e.table, `${e.table} has no primary/unique key; its rows are copied with "append" because the target table is empty`); }
    else { entries.splice(entries.indexOf(e), 1); warn('warn', e.table, `${e.table} has no primary/unique key and the target table already has ${e.targetRows} row(s): its data is NOT copied (it would create duplicates). Select it explicitly with mode "append" or "truncate-copy" to copy it`); }
  }
  // FK order (parents first)
  const names = entries.map(e => e.table);
  const edges = [];
  for (const e of entries) for (const fk of e._src.foreignKeys) { const p = my_ ? src.database + '.' + fk.refTable : fk.refSchema + '.' + fk.refTable; if (p !== e.table && names.includes(p)) edges.push([p, e.table]); }
  const { order, cycles } = topoSort(names, edges);
  for (const cyc of cycles) {
    for (const n of cyc) entries.find(e => e.table === n).cycleGroup = cyc.join(',');
    warn('warn', cyc.join(', '), `Cyclic foreign-key dependency between ${cyc.join(', ')}: rows are loaded in best-effort order. New foreign keys are added after the data copy; existing target foreign keys need a superuser (replication role) or deferrable constraints.`);
  }
  const selfRef = entries.filter(e => e._src.foreignKeys.some(fk => (my_ ? src.database + '.' + fk.refTable : fk.refSchema + '.' + fk.refTable) === e.table));
  for (const e of selfRef) if (e._tgt && e._tgt.foreignKeys.length) warn('info', e.table, `${e.table} has a self-referencing foreign key; rows are loaded in key order`);
  entries.sort((x, y) => order.indexOf(x.table) - order.indexOf(y.table));

  for (const e of entries) {
    e.strategy = `${e.readMode} read, ${e.mode}${e.cycleGroup ? ', cyclic FK group' : ''}`;
    if (e.sourceRows > 5000000) warn('warn', e.table, `${e.table} has ${e.sourceRows} rows; plan a maintenance window and consider a larger batch size`);
    if (e.mode === 'truncate-copy' && e.targetRows > 0) warn('warn', e.table, `truncate-copy will DELETE the ${e.targetRows} existing row(s) of ${e.table} in the target before copying`);
    sum.rowsEstimate += e.sourceRows;
  }
  if (opts.dataMode === 'truncate-copy' && !my_) {
    const selTgt = new Set(entries.filter(e => e._tgt).map(e => e._tgt.fullName));
    for (const x of tgt.tables) {
      if (selTgt.has(x.fullName)) continue;
      for (const fk of x.foreignKeys) if (selTgt.has(fk.refSchema + '.' + fk.refTable)) { warn('blocker', x.fullName, `truncate-copy cannot truncate ${fk.refSchema}.${fk.refTable}: it is referenced by the foreign key ${fk.name} of ${x.fullName}, which is not part of the selection (select it too)`); }
    }
  }
  if (my_) {
    for (const e of entries) if (e._tgt && e._tgt.options && e._tgt.options.engine && !/innodb/i.test(e._tgt.options.engine)) warn('warn', e.table, `Target table uses the ${e._tgt.options.engine} engine: data batches are not transactional`);
  }
  if (!my_) {
    const rlsT = entries.filter(e => e._src.rls && e._src.rls.enabled);
    if (rlsT.length) {
      try {
        const r = (await qrows(dbManager, srcId, `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) AS bypass, current_user AS u`))[0];
        for (const e of rlsT) if (!r.bypass && e._src.owner !== r.u) warn('blocker', e.table, `Row level security is enabled on ${e.table} and the source user can neither bypass it nor owns the table: the copy would silently miss rows`);
      } catch (err) { /* ignore */ }
    }
  }
  return entries.map((e) => { const { _src, _tgt, ...o } = e; Object.defineProperty(o, '_src', { value: _src }); Object.defineProperty(o, '_tgt', { value: _tgt }); return o; });
}

module.exports = { buildPlanInternal, introspectAny, qrows, pool };
