// End-to-end tests for the DB-to-DB migration engine (electron/migration/).
//
// Spins up THROWAWAY docker servers (never touches existing containers):
//   postgres:16-alpine on host port 15433   (override: MIG_PG_PORT)
//   mysql:8            on host port 13307   (override: MIG_MYSQL_PORT)
// Containers are named dbaccess-mig-<engine>-<pid> and always removed in finally.
// If a server is already reachable on the port it is used as-is (and NOT removed).
// If docker/server is unavailable the engine's suite is SKIPped.
//
// Run (needs Electron's node ABI like test-row-ops.js):
//   npm run test:migration
//   MIG_ONLY=pg|mysql   run one engine only;   MIG_NO_MYSQL=1  skip mysql
//
// Everything is asserted through the public contract of electron/migration/index.js
// (introspect, buildPlan, runMigration, cancelMigration, verifyMigration).

const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const dbm = require(path.join(ROOT, 'electron', 'database.js'));

let pass = 0, fail = 0, skipped = 0;
let unhandled = 0;
process.on('unhandledRejection', (e) => { unhandled++; console.log('  (unhandledRejection: ' + (e && e.message || e) + ')'); });
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}${extra !== undefined ? ' :: got ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 600) : ''}`); }
}
function skip(name, reason) { skipped++; console.log(`  SKIP - ${name} (${reason})`); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- docker helpers
const started = [];
function docker(args, opts = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', ...opts });
}
function startContainer(name, args) {
  const r = docker(['run', '-d', '--name', name, ...args]);
  if (r.status !== 0) throw new Error(`docker run failed: ${(r.stderr || r.stdout || '').trim()}`);
  started.push(name);
}
function cleanup() {
  while (started.length) {
    const n = started.pop();
    try { docker(['rm', '-f', '-v', n]); console.log(`  (removed container ${n})`); } catch (_) { /* best effort */ }
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ---------------------------------------------------------------- misc helpers
const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const mqi = (s) => '`' + String(s).replace(/`/g, '``') + '`';
const PHASE_ORDER = { types: 0, sequences: 1, tables: 2, columns: 3, data: 4, constraints: 5, indexes: 6, views: 7, 'sequence-sync': 8, drops: 9 };

function baseOpts(o = {}) {
  return {
    tables: null, includeSchema: true, includeData: false, dataMode: 'append',
    allowDrops: false, dropExtraTables: false, dropExtraColumns: false,
    alterTypes: true, createIndexes: true, createConstraints: true, createViews: true, syncSequences: true,
    batchSize: 1000, onError: 'stop', dryRun: false, ...o,
  };
}
const hasBlocker = (plan) => (plan.warnings || []).some(w => w.level === 'blocker');
const blockerText = (plan) => (plan.warnings || []).filter(w => w.level === 'blocker').map(w => w.message).join(' | ');
let runSeq = 0;
async function run(M, src, tgt, options, extra = {}) {
  const runId = `t-${process.pid}-${++runSeq}`;
  const events = [];
  const report = await M.runMigration(dbm, src, tgt, options, {
    runId,
    onProgress: (e) => { events.push(e); if (extra.onEvent) extra.onEvent(e, runId); },
  });
  return { report, events, runId };
}
// plan that may throw (blockers can be signalled either way)
async function tryPlan(M, src, tgt, options) {
  try { return { plan: await M.buildPlan(dbm, src, tgt, options), threw: null }; }
  catch (e) { return { plan: null, threw: e }; }
}
async function tryRun(M, src, tgt, options) {
  try { const r = await run(M, src, tgt, options); return { ...r, threw: null }; }
  catch (e) { return { report: null, events: [], threw: e }; }
}
const findT = (report, name) => (report.tables || []).find(t => t.table === name || String(t.table).endsWith('.' + name) || String(t.table).endsWith('.' + qi(name)));
const dropSteps = (plan) => (plan.steps || []).filter(s => /^\s*DROP\s+(TABLE|COLUMN)/i.test(s.sql) || /^\s*ALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN/i.test(s.sql));
const stepSqlAll = (plan) => (plan.steps || []).map(s => s.sql).join('\n');

async function section(name, fn) {
  console.log(`\n== ${name}`);
  try { await fn(); } catch (e) { fail++; console.log(`  FAIL - section threw :: ${e && e.stack || e}`); }
}

// ======================================================================= POSTGRES
const PG_PORT = parseInt(process.env.MIG_PG_PORT || '15433', 10);
const PG_BASE = { host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'test' };

const PG_SOURCE_SQL = String.raw`
CREATE TYPE mood AS ENUM ('sad','ok','happy');
CREATE TYPE "we'ird" AS ENUM ('it''s','a;b');
CREATE TABLE customers (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  mood mood DEFAULT 'ok',
  "order" int,
  note text,
  created timestamptz DEFAULT now(),
  CONSTRAINT chk_email CHECK (position('@' in email) > 0)
);
CREATE INDEX idx_cust_lower_email ON customers (lower(email));
CREATE TABLE categories (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id int REFERENCES categories(id),
  name varchar(100) NOT NULL
);
CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  total numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  status text,
  tags text[],
  meta jsonb,
  raw json,
  placed timestamp,
  placed_tz timestamptz,
  uid uuid DEFAULT gen_random_uuid(),
  paid boolean DEFAULT false,
  blob bytea,
  bignum bigint
);
CREATE INDEX idx_orders_cust ON orders (customer_id);
CREATE INDEX idx_orders_paid_partial ON orders (placed) WHERE paid;
CREATE TABLE a_t (id int PRIMARY KEY, b_id int);
CREATE TABLE b_t (id int PRIMARY KEY, a_id int REFERENCES a_t(id));
CREATE TABLE log_entries (msg text, n int);
CREATE TABLE big_items (id serial PRIMARY KEY, payload text, n int);
CREATE TABLE items_ident (id int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, v text);
CREATE TABLE gen_t (id serial PRIMARY KEY, a int, b int GENERATED ALWAYS AS (a * 2) STORED);
CREATE TABLE "Weird; Table""x" ("select" int PRIMARY KEY, "Col Name" text, mood "we'ird");
CREATE TABLE "evil"" ; DROP TABLE customers; --" (id int PRIMARY KEY, "col'umn" text);
CREATE SCHEMA "Sales Data";
CREATE TABLE "Sales Data".items (id serial PRIMARY KEY, name text);

INSERT INTO customers (email, mood, "order", note) VALUES
 ('alice@example.com','happy',1,'it''s; "quoted" ünïcödé 日本語 😀'),
 ('bob@example.com','sad',2,'; DROP TABLE customers; --'),
 ('carol@example.com',NULL,NULL,NULL),
 ('dave@example.com','ok',4,E'line1\nline2\ttab\\backslash'),
 ('erin@example.com','ok',5,'');
INSERT INTO categories (parent_id, name) VALUES (NULL,'root');
INSERT INTO categories (parent_id, name) VALUES (1,'child'),(2,'grandchild');
INSERT INTO orders (customer_id,total,status,tags,meta,raw,placed,placed_tz,paid,blob,bignum)
 SELECT 1 + (g % 5), g * 1.25, CASE WHEN g % 3 = 0 THEN NULL ELSE 'st' || g END,
        ARRAY['a','b;c',g::text], jsonb_build_object('k', g, 'arr', ARRAY[1,2,3]), ('{"z":' || g || ',"a":1}')::json,
        timestamp '2024-01-01 10:00:00.123456' + (g || ' hours')::interval,
        timestamptz '2024-03-10 01:30:00.654321+00' + (g || ' days')::interval,
        g % 2 = 0, decode(lpad(to_hex(g), 4, '0'), 'hex') || '\x00ff'::bytea, g::bigint * 1000
 FROM generate_series(1,20) g;
INSERT INTO orders (id, customer_id, total, bignum, placed) VALUES (9007199254740993, 1, 0, 9007199254740993, 'infinity');
SELECT setval('orders_id_seq', 9007199254740993);
INSERT INTO a_t VALUES (1,NULL),(2,NULL);
INSERT INTO b_t VALUES (1,1),(2,2);
UPDATE a_t SET b_id = id;
ALTER TABLE a_t ADD CONSTRAINT a_t_b_fk FOREIGN KEY (b_id) REFERENCES b_t(id);
INSERT INTO log_entries VALUES ('dup',1),('dup',1),('dup',1),('other; x',2);
INSERT INTO big_items (payload, n) SELECT 'row ' || g || '; payload ''q''', g FROM generate_series(1,25000) g;
INSERT INTO items_ident (v) VALUES ('x'),('y');
INSERT INTO gen_t (a) VALUES (1),(2),(3);
INSERT INTO "Weird; Table""x" VALUES (1,'v1','it''s'),(2,'; DROP TABLE customers; --','a;b');
INSERT INTO "evil"" ; DROP TABLE customers; --" VALUES (1,'x''; DROP TABLE customers; --');
INSERT INTO "Sales Data".items (name) VALUES ('s1'),('s2');
CREATE VIEW v_customer_orders AS
  SELECT c.id, c.email, count(o.id) AS n FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.email;
`;

// Partially migrated target: customers lacks columns/enum/unique, orders lacks many
// columns and has total as text plus a target-only column, an extra target-only table.
const PG_PARTIAL_SQL = String.raw`
CREATE TABLE customers (id serial PRIMARY KEY, email text NOT NULL, created timestamptz DEFAULT now());
INSERT INTO customers (id, email) VALUES (1,'stale@example.com'),(99,'targetonly@example.com');
CREATE TABLE orders (id bigserial PRIMARY KEY, customer_id int NOT NULL, total text, legacy_flag int);
CREATE TABLE target_only_tbl (id int);
`;

async function resetPg(admin, setupSql) {
  await admin.query(`DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS "Sales Data" CASCADE; CREATE SCHEMA public;`);
  if (setupSql) await admin.query(setupSql);
}

async function pgFingerprint(client) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL search_path = pg_catalog');
    const sys = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'`;
    const q = {
      cols: `SELECT n.nspname||'.'||c.relname||'.'||a.attname||' '||format_type(a.atttypid,a.atttypmod)||' nn='||a.attnotnull||' id='||a.attidentity::text||' gen='||a.attgenerated::text||' def='||coalesce(pg_get_expr(d.adbin,d.adrelid),'') AS l
             FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
             WHERE c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped AND ${sys}`,
      cons: `SELECT n.nspname||'.'||c.relname||' '||k.conname||' '||pg_get_constraintdef(k.oid) AS l FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE k.contype IN ('p','u','f','c') AND ${sys}`,
      idx: `SELECT pg_get_indexdef(i.indexrelid) AS l FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${sys}`,
      enums: `SELECT n.nspname||'.'||t.typname||' '||(SELECT string_agg(e.enumlabel,',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid) AS l FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typtype='e' AND ${sys}`,
      views: `SELECT n.nspname||'.'||c.relname||' '||pg_get_viewdef(c.oid,true) AS l FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='v' AND ${sys}`,
      seqs: `SELECT n.nspname||'.'||c.relname||' '||s.seqstart||','||s.seqincrement||','||s.seqmax||','||format_type(s.seqtypid,NULL) AS l FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${sys}`,
    };
    const out = {};
    for (const [k, sql] of Object.entries(q)) out[k] = (await client.query(sql)).rows.map(r => r.l).sort();
    return out;
  } finally { await client.query('ROLLBACK'); }
}
function diffFp(a, b) {
  const d = [];
  for (const k of Object.keys(a)) {
    const sa = new Set(a[k]), sb = new Set(b[k] || []);
    for (const l of a[k]) if (!sb.has(l)) d.push(`[${k}] only src: ${l}`);
    for (const l of (b[k] || [])) if (!sa.has(l)) d.push(`[${k}] only tgt: ${l}`);
  }
  return d;
}

async function pgTables(c) {
  const r = await c.query(`SELECT n.nspname s, c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' ORDER BY 1,2`);
  return r.rows.map(x => ({ schema: x.s, table: x.t }));
}
async function pgCols(c, s, t) {
  const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY column_name`, [s, t]);
  return r.rows.map(x => x.column_name);
}
async function pgDigest(c, s, t, cols, where) {
  if (!cols.length) return { n: '0', h: '' };
  const sql = `SELECT count(*)::text n, md5(coalesce(string_agg(x, E'\\n' ORDER BY x),'')) h FROM
    (SELECT ROW(${cols.map(x => qi(x) + '::text').join(',')})::text AS x FROM ${qi(s)}.${qi(t)} ${where || ''}) q`;
  const r = await c.query(sql);
  return r.rows[0];
}
// compare every source table against target (common columns). Returns mismatch list.
async function pgCompareAll(src, tgt, only) {
  const bad = [];
  for (const { schema, table } of await pgTables(src)) {
    if (only && !only.includes(table)) continue;
    const sc = await pgCols(src, schema, table), tc = await pgCols(tgt, schema, table);
    if (!tc.length) { bad.push(`${schema}.${table}: missing in target`); continue; }
    const cols = sc.filter(c => tc.includes(c));
    const a = await pgDigest(src, schema, table, cols), b = await pgDigest(tgt, schema, table, cols);
    if (a.n !== b.n || a.h !== b.h) bad.push(`${schema}.${table}: src ${a.n}/${a.h.slice(0, 6)} tgt ${b.n}/${b.h.slice(0, 6)}`);
  }
  return bad;
}

async function postgresSuite(M) {
  console.log('\n######## POSTGRES ########');
  const { Client } = require('pg');
  const mk = (database) => new Client({ ...PG_BASE, database });
  let admin = mk('postgres');
  let reachable = false;
  try { await admin.connect(); reachable = true; } catch (_) { admin = null; }

  if (!reachable) {
    const name = `dbaccess-mig-pg-${process.pid}`;
    try {
      startContainer(name, ['-e', 'POSTGRES_PASSWORD=test', '-p', `${PG_PORT}:5432`, 'postgres:16-alpine']);
    } catch (e) { skip('postgres suite', e.message); return; }
    console.log(`  started ${name} on ${PG_PORT}`);
    let good = 0;
    for (let i = 0; i < 90 && good < 2; i++) {
      const c = mk('postgres');
      try { await c.connect(); await c.query('SELECT 1'); await c.end(); good++; await sleep(1500); }
      catch (_) { good = 0; try { await c.end(); } catch (__) { } await sleep(1000); }
    }
    if (good < 2) { skip('postgres suite', 'container did not become ready'); return; }
    admin = mk('postgres'); await admin.connect();
  }
  await admin.query('DROP DATABASE IF EXISTS mig_src'); await admin.query('DROP DATABASE IF EXISTS mig_tgt');
  await admin.query('CREATE DATABASE mig_src'); await admin.query('CREATE DATABASE mig_tgt');
  const srcC = mk('mig_src'), tgtC = mk('mig_tgt'); // raw clients for setup + assertions
  await srcC.connect(); await tgtC.connect();
  await srcC.query(PG_SOURCE_SQL);
  const srcTables = await pgTables(srcC);
  const N_TABLES = srcTables.length;
  console.log(`  source has ${N_TABLES} tables`);

  const SRC = 'mig-src', TGT = 'mig-tgt';
  const cfg = (id, database) => ({ id, type: 'postgres', host: PG_BASE.host, port: PG_PORT, database, username: 'postgres', password: 'test', ssl: false });
  await dbm.connect(cfg(SRC, 'mig_src')); await dbm.connect(cfg(TGT, 'mig_tgt'));
  const reset = (sql) => resetPg(tgtC, sql);

  // ---------------------------------------------------------------- introspect
  await section('pg: introspect', async () => {
    const m = await M.introspect(dbm, SRC);
    ok('introspect returns postgres model', m && m.engine === 'postgres', m && m.engine);
    ok('model lists all tables', Array.isArray(m.tables) && m.tables.length === N_TABLES, m.tables && m.tables.length);
    ok('model has enums', (m.types || []).filter(t => t.kind === 'enum').length >= 2);
    const cust = (m.tables || []).find(t => t.name === 'customers');
    ok('customers has PK and unique', cust && cust.primaryKey && cust.primaryKey.columns[0] === 'id' && cust.uniques.length >= 1);
    const cat = (m.tables || []).find(t => t.name === 'categories');
    ok('categories.id is identity ALWAYS', cat && cat.columns.find(c => c.name === 'id').identity === 'a');
    ok('model has the view', (m.views || []).some(v => v.name === 'v_customer_orders'));
  });

  // ---------------------------------------------------------------- plan on empty target
  await section('pg: plan against EMPTY target (schema only)', async () => {
    await reset();
    const plan = await M.buildPlan(dbm, SRC, TGT, baseOpts());
    ok('engine is postgres', plan.engine === 'postgres', plan.engine);
    ok('no blockers', !hasBlocker(plan), blockerText(plan));
    ok(`summary.tablesToCreate == ${N_TABLES}`, plan.summary.tablesToCreate === N_TABLES, plan.summary);
    ok('summary counts enums/sequences/views/indexes/constraints', plan.summary.enumsToCreate >= 2 && plan.summary.sequencesToCreate >= 4 && plan.summary.viewsToCreate === 1 && plan.summary.indexesToCreate >= 3 && plan.summary.constraintsToCreate >= 3, plan.summary);
    ok('every step has the contract fields', plan.steps.every(s => s.id && s.phase in PHASE_ORDER && s.kind && 'object' in s && typeof s.sql === 'string' && typeof s.destructive === 'boolean' && s.description !== undefined));
    ok('step ids unique', new Set(plan.steps.map(s => s.id)).size === plan.steps.length);
    let mono = true; let prev = -1;
    for (const s of plan.steps) { const p = PHASE_ORDER[s.phase]; if (p < prev) mono = false; prev = Math.max(prev, p); }
    ok('steps are ordered by phase (types..tables..constraints..indexes..views..sequence-sync)', mono, plan.steps.map(s => s.phase).join(','));
    const lastTable = Math.max(...plan.steps.map((s, i) => /^\s*CREATE\s+(UNLOGGED\s+)?TABLE/i.test(s.sql) ? i : -1));
    const firstFk = plan.steps.findIndex(s => /FOREIGN KEY/i.test(s.sql));
    ok('foreign keys come after all CREATE TABLE steps', firstFk > lastTable && firstFk >= 0, { lastTable, firstFk });
    const enumIdx = plan.steps.findIndex(s => /CREATE TYPE/i.test(s.sql)), firstTbl = plan.steps.findIndex(s => /CREATE TABLE/i.test(s.sql));
    ok('enum types created before tables', enumIdx >= 0 && enumIdx < firstTbl);
    const sqlAll = stepSqlAll(plan);
    ok('serial default (nextval) preserved in CREATE TABLE', /nextval\(/i.test(sqlAll) && /CREATE SEQUENCE/i.test(sqlAll));
    ok('identity column preserved', /GENERATED ALWAYS AS IDENTITY/i.test(sqlAll) && /GENERATED BY DEFAULT AS IDENTITY/i.test(sqlAll));
    ok('CHECK constraint and partial/expression indexes emitted', /chk_email/.test(sqlAll) && /idx_orders_paid_partial/.test(sqlAll) && /idx_cust_lower_email/.test(sqlAll));
    ok('no DROP statements when allowDrops=false', dropSteps(plan).length === 0 && !plan.steps.some(s => s.destructive));
    ok('no data in schema-only plan steps', !/\bINSERT\s+INTO/i.test(sqlAll));
    ok('plan.script is a non-empty string with CREATE TABLE', typeof plan.script === 'string' && /CREATE TABLE/i.test(plan.script));
    ok('hostile identifiers are quoted/escaped in script', plan.script.includes('"evil"" ; DROP TABLE customers; --"') && plan.script.includes('"Weird; Table""x"'));
    // injection check through the splitter (if exposed) or a line-based fallback
    let stmts = null;
    try { stmts = require(path.join(ROOT, 'electron', 'migration', 'sql.js')).splitStatements(plan.script, 'postgres').map(s => s.sql); } catch (_) { /* optional export */ }
    if (stmts) {
      ok('script splitter never yields a stray "DROP TABLE customers" statement', !stmts.some(s => /^\s*DROP\s+TABLE\s+"?customers/i.test(s)));
      ok('script statement count >= number of steps (BEGIN/COMMIT wrappers allowed)', stmts.length >= plan.steps.length, { stmts: stmts.length, steps: plan.steps.length });
    } else skip('splitter round-trip', 'sql.js splitStatements not exported');
    ok('dataPlan empty when includeData=false', !plan.dataPlan || plan.dataPlan.length === 0, plan.dataPlan && plan.dataPlan.length);
  });

  // ---------------------------------------------------------------- schema-only migration
  await section('pg: schema-only migration into EMPTY target, then idempotent re-plan', async () => {
    await reset();
    const { report, events } = await run(M, SRC, TGT, baseOpts());
    ok('status success', report.status === 'success', { status: report.status, errors: report.errors });
    ok('no step errored', !(report.steps || []).some(s => s.status === 'error'), (report.steps || []).filter(s => s.status === 'error'));
    ok('progress events include phase events', events.some(e => e.type === 'phase'));
    ok('progress events carry runId', events.every(e => e.runId));
    ok('final progress event is done', events.length && events[events.length - 1].type === 'done', events[events.length - 1]);
    const a = await pgFingerprint(srcC), b = await pgFingerprint(tgtC);
    const d = diffFp(a, b);
    ok('target catalog fingerprint (columns/constraints/indexes/enums/view/sequences) equals source', d.length === 0, d.slice(0, 6));
    const cnt = await tgtC.query('SELECT (SELECT count(*) FROM customers) c, (SELECT count(*) FROM big_items) b');
    ok('schema-only copied no rows', Number(cnt.rows[0].c) === 0 && Number(cnt.rows[0].b) === 0, cnt.rows[0]);
    const plan2 = await M.buildPlan(dbm, SRC, TGT, baseOpts());
    ok('second plan has ZERO steps (idempotent)', plan2.steps.length === 0, plan2.steps.map(s => s.description || s.sql).slice(0, 8));
    ok('second plan has no blockers', !hasBlocker(plan2), blockerText(plan2));
    let inserted = true;
    try {
      await tgtC.query(`INSERT INTO customers (email) VALUES ('new@x.com')`);
      await tgtC.query(`INSERT INTO categories (name) VALUES ('n')`);
      await tgtC.query(`INSERT INTO big_items (payload) VALUES ('p')`);
    } catch (e) { inserted = e.message; }
    ok('serial + identity inserts work without explicit ids', inserted === true, inserted);
    const rerun = await run(M, SRC, TGT, baseOpts());
    ok('re-running the same migration succeeds (idempotent run)', rerun.report.status === 'success', rerun.report.errors);
  });

  // ---------------------------------------------------------------- dryRun
  await section('pg: dryRun makes no changes', async () => {
    await reset();
    const { report } = await run(M, SRC, TGT, baseOpts({ dryRun: true, includeData: true }));
    ok('dryRun finishes without failure', report.status === 'success' || report.status === 'partial', { s: report.status, e: report.errors });
    const t = await pgTables(tgtC);
    ok('dryRun left the target empty', t.length === 0, t);
  });

  // ---------------------------------------------------------------- partial target plan / drops
  await section('pg: plan against PARTIAL target; drops are opt-in', async () => {
    await reset(PG_PARTIAL_SQL);
    const plan = await M.buildPlan(dbm, SRC, TGT, baseOpts());
    ok('no blockers', !hasBlocker(plan), blockerText(plan));
    ok(`tablesToCreate == ${N_TABLES - 2}`, plan.summary.tablesToCreate === N_TABLES - 2, plan.summary);
    ok('tablesToAlter >= 2 (customers, orders)', plan.summary.tablesToAlter >= 2, plan.summary);
    ok('columnsToAdd >= 5 (customers: mood/order/note; orders: several)', plan.summary.columnsToAdd >= 5, plan.summary);
    ok('columnsToAlter >= 1 (orders.total text->numeric)', plan.summary.columnsToAlter >= 1, plan.summary);
    ok('tablesToDrop / columnsToDrop are 0 when allowDrops=false', plan.summary.tablesToDrop === 0 && plan.summary.columnsToDrop === 0, plan.summary);
    const sqlAll = stepSqlAll(plan);
    ok('no DROP TABLE/COLUMN emitted', dropSteps(plan).length === 0 && !plan.steps.some(s => s.destructive || s.phase === 'drops'));
    ok('warning reports target-only table', plan.warnings.some(w => /target_only_tbl/.test(w.object + ' ' + w.message)), plan.warnings.map(w => w.message).slice(0, 5));
    ok('warning reports target-only column', plan.warnings.some(w => /legacy_flag/.test(w.object + ' ' + w.message)));
    const alter = plan.steps.find(s => /ALTER\s+COLUMN\s+"?total"?\s+(SET DATA\s+)?TYPE/i.test(s.sql));
    ok('ALTER TYPE emitted with USING cast', alter && /USING/i.test(alter.sql), alter && alter.sql);
    ok('missing enum is created for the added mood column', plan.steps.some(s => /CREATE TYPE.*mood/i.test(s.sql)));
    ok('unique constraint added to existing customers.email', plan.steps.some(s => /customers/.test(s.sql) && /UNIQUE/i.test(s.sql)));

    const plan2 = await M.buildPlan(dbm, SRC, TGT, baseOpts({ allowDrops: true, dropExtraTables: true, dropExtraColumns: true }));
    const drops = dropSteps(plan2);
    ok('allowDrops + dropExtra* emits DROP TABLE and DROP COLUMN', drops.some(s => /DROP TABLE/i.test(s.sql)) && drops.some(s => /DROP COLUMN/i.test(s.sql)), drops.map(s => s.sql));
    ok('drop steps are destructive, phase drops, never CASCADE, and last', drops.every(s => s.destructive && s.phase === 'drops' && !/CASCADE/i.test(s.sql)) && plan2.steps.slice(-drops.length).every(s => s.phase === 'drops'));
    ok('dropExtraTables alone is ignored without allowDrops', dropSteps(await M.buildPlan(dbm, SRC, TGT, baseOpts({ dropExtraTables: true, dropExtraColumns: true }))).length === 0);
  });

  await section('pg: schema migration into PARTIAL target (+drops when opted in)', async () => {
    await reset(PG_PARTIAL_SQL);
    const r1 = await run(M, SRC, TGT, baseOpts());
    ok('status success', r1.report.status === 'success', { s: r1.report.status, e: r1.report.errors, st: (r1.report.steps || []).filter(s => s.status === 'error') });
    const ex = await tgtC.query(`SELECT to_regclass('target_only_tbl') t, (SELECT count(*) FROM information_schema.columns WHERE table_name='orders' AND column_name='legacy_flag') c`);
    ok('target-only table and column survive (no drops by default)', ex.rows[0].t && Number(ex.rows[0].c) === 1, ex.rows[0]);
    const ty = await tgtC.query(`SELECT data_type FROM information_schema.columns WHERE table_name='orders' AND column_name='total'`);
    ok('orders.total converted to numeric', ty.rows[0].data_type === 'numeric', ty.rows[0]);
    const cu = await tgtC.query(`SELECT id, email FROM customers ORDER BY id`);
    ok('existing target rows untouched by schema-only migration', cu.rows.length === 2 && cu.rows[0].email === 'stale@example.com', cu.rows);
    const plan2 = await M.buildPlan(dbm, SRC, TGT, baseOpts());
    ok('re-plan after migration has ZERO steps', plan2.steps.length === 0, plan2.steps.map(s => s.description || s.sql).slice(0, 8));
    const r2 = await run(M, SRC, TGT, baseOpts({ allowDrops: true, dropExtraTables: true, dropExtraColumns: true }));
    ok('drop run succeeds', r2.report.status === 'success', r2.report.errors);
    const ex2 = await tgtC.query(`SELECT to_regclass('target_only_tbl') t, (SELECT count(*) FROM information_schema.columns WHERE table_name='orders' AND column_name='legacy_flag') c`);
    ok('allowDrops removed target-only table and column', ex2.rows[0].t === null && Number(ex2.rows[0].c) === 0, ex2.rows[0]);
  });

  // ---------------------------------------------------------------- full data migration
  await section('pg: FULL migration (schema+data) into EMPTY target', async () => {
    await reset();
    const planOpts = baseOpts({ includeData: true, batchSize: 1000 });
    const plan = await M.buildPlan(dbm, SRC, TGT, planOpts);
    ok('no blockers', !hasBlocker(plan), blockerText(plan));
    const dp = plan.dataPlan || [];
    const pos = (n) => dp.findIndex(d => d.table === n || String(d.table).endsWith('.' + n));
    ok('dataPlan covers every table', dp.length === N_TABLES, dp.length);
    ok('dataPlan is FK-ordered (customers before orders; categories exists)', pos('customers') >= 0 && pos('customers') < pos('orders') && pos('a_t') >= 0 && pos('b_t') >= 0, dp.map(d => d.table));
    ok('cycle a_t <-> b_t is reported as a warning', plan.warnings.some(w => /cycl/i.test(w.message)), plan.warnings.map(w => w.message).slice(0, 6));
    const big = dp.find(d => d.table.endsWith('big_items'));
    ok('dataPlan.sourceRows exact (25000)', big && Number(big.sourceRows) === 25000, big);
    const gen = dp.find(d => d.table.endsWith('gen_t'));
    ok('generated column is skipped for copy', gen && (gen.skippedColumns || []).some(s => s.name === 'b' && /generated/i.test(s.reason)) && !gen.columns.includes('b'), gen);
    ok('rowsEstimate >= 25000', plan.summary.rowsEstimate >= 25000, plan.summary.rowsEstimate);

    const { report, events } = await run(M, SRC, TGT, planOpts);
    ok('status success', report.status === 'success', { s: report.status, e: report.errors });
    const rowsEvts = events.filter(e => e.type === 'rows' && /big_items/.test(e.table || ''));
    ok('rows progress events for big_items (batched)', rowsEvts.length >= 2 && rowsEvts.every(e => e.rowsTotal === undefined || e.rowsTotal >= 0), rowsEvts.length);
    ok('rows progress ends at 25000', rowsEvts.length && rowsEvts[rowsEvts.length - 1].rowsDone === 25000, rowsEvts[rowsEvts.length - 1]);
    const bt = findT(report, 'big_items');
    ok('report.tables big_items rowsCopied 25000', bt && bt.rowsCopied === 25000 && Number(bt.targetRowsAfter) === 25000, bt);
    ok('report.tables has an entry per table', (report.tables || []).length === N_TABLES, (report.tables || []).length);
    const bad = await pgCompareAll(srcC, tgtC);
    ok('every table identical (md5 of ordered row text, incl. bytea/json/arrays/bigint>2^53/infinity/unicode/NULL/dups)', bad.length === 0, bad);
    const d = diffFp(await pgFingerprint(srcC), await pgFingerprint(tgtC));
    ok('catalog fingerprint equals source after full migration', d.length === 0, d.slice(0, 6));
    const dpAfter = await M.buildPlan(dbm, SRC, TGT, planOpts);
    ok('re-plan: zero schema steps', dpAfter.steps.length === 0, dpAfter.steps.map(s => s.description).slice(0, 5));

    // sequences / identity resync
    const tries = [
      [`INSERT INTO customers (email) VALUES ('post@x.com') RETURNING id`, (r) => Number(r.rows[0].id) === 6],
      [`INSERT INTO categories (name) VALUES ('post') RETURNING id`, (r) => Number(r.rows[0].id) === 4],
      [`INSERT INTO items_ident (v) VALUES ('post') RETURNING id`, (r) => Number(r.rows[0].id) === 3],
      [`INSERT INTO big_items (payload) VALUES ('post') RETURNING id`, (r) => Number(r.rows[0].id) === 25001],
      [`INSERT INTO gen_t (a) VALUES (10) RETURNING id, b`, (r) => Number(r.rows[0].id) === 4 && Number(r.rows[0].b) === 20],
      [`INSERT INTO "Sales Data".items (name) VALUES ('post') RETURNING id`, (r) => Number(r.rows[0].id) === 3],
      [`INSERT INTO orders (customer_id) VALUES (1) RETURNING id::text`, (r) => BigInt(r.rows[0].id) === 9007199254740994n],
    ];
    for (const [sql, chk] of tries) {
      let res; try { res = await tgtC.query(sql); } catch (e) { ok(`post-migration insert: ${sql.slice(0, 40)}`, false, e.message); continue; }
      ok(`post-migration insert gets next value: ${sql.slice(12, 40)}`, chk(res), res.rows[0]);
    }
    await tgtC.query(`DELETE FROM customers WHERE id=6; DELETE FROM categories WHERE id=4; DELETE FROM items_ident WHERE id=3; DELETE FROM big_items WHERE id=25001; DELETE FROM gen_t WHERE id=4; DELETE FROM "Sales Data".items WHERE id=3; DELETE FROM orders WHERE id=9007199254740994`);

    // FKs really exist and are enforced; hostile objects intact
    let fkEnforced = false; try { await tgtC.query(`INSERT INTO orders (customer_id) VALUES (424242)`); } catch (e) { fkEnforced = e.code === '23503'; }
    ok('FK constraint is enforced in target', fkEnforced);
    const still = await tgtC.query(`SELECT count(*)::int n FROM customers`);
    ok('injection-style identifiers/values did not drop customers', still.rows[0].n === 5, still.rows[0]);

    // verifyMigration
    const names = srcTables.map(t => `${t.schema}.${t.table}`);
    const v = await M.verifyMigration(dbm, SRC, TGT, names);
    ok('verifyMigration: all tables match', Array.isArray(v) && v.length === N_TABLES && v.every(x => x.status === 'match' && String(x.sourceRows) === String(x.targetRows)), v.filter(x => x.status !== 'match'));
    await tgtC.query(`DELETE FROM big_items WHERE id = 1`);
    const v2 = await M.verifyMigration(dbm, SRC, TGT, names);
    const mm = v2.filter(x => x.status === 'mismatch');
    ok('verifyMigration detects a missing row (only big_items mismatches)', mm.length === 1 && /big_items/.test(mm[0].table) && Number(mm[0].sourceRows) === 25000 && Number(mm[0].targetRows) === 24999, mm);
    const v3 = await M.verifyMigration(dbm, SRC, TGT, ['public.no_such_table']);
    ok('verifyMigration reports error for unknown table', v3.length === 1 && v3[0].status === 'error', v3);
  });

  // ---------------------------------------------------------------- data modes
  await section('pg: dataMode behaviours on PARTIAL target (existing overlapping rows)', async () => {
    const KEYED = srcTables.map(t => `${t.schema}.${t.table}`).filter(n => n !== 'public.log_entries');
    const dm = async (mode, extra = {}) => { await reset(PG_PARTIAL_SQL); return run(M, SRC, TGT, baseOpts({ includeData: true, dataMode: mode, tables: KEYED, ...extra })); };
    const emails = async () => (await tgtC.query(`SELECT id, email FROM customers ORDER BY id`)).rows;

    let r = await dm('insert-missing');
    ok('insert-missing: success', r.report.status === 'success', { s: r.report.status, e: r.report.errors });
    let rows = await emails();
    ok('insert-missing: existing id=1 kept stale, id=99 kept, source rows added (7 rows)', rows.length === 6 && rows.find(x => x.id === 1).email === 'stale@example.com' && rows.some(x => x.id === 99) && rows.some(x => x.id === 5), rows);
    const ct = findT(r.report, 'customers');
    ok('insert-missing: report counts 4 copied, >=1 skipped', ct && ct.rowsCopied === 4 && ct.rowsSkipped >= 1, ct);
    const oc = await tgtC.query('SELECT count(*)::int n FROM orders'); const sc = await srcC.query('SELECT count(*)::int n FROM orders');
    ok('insert-missing: orders fully copied', oc.rows[0].n === sc.rows[0].n, oc.rows[0]);
    let again = await run(M, SRC, TGT, baseOpts({ includeData: true, dataMode: 'insert-missing', tables: KEYED }));
    ok('insert-missing re-run is a no-op success (resumable)', again.report.status === 'success' && (findT(again.report, 'big_items') || {}).rowsCopied === 0, findT(again.report, 'big_items'));

    r = await dm('upsert');
    rows = await emails();
    ok('upsert: success', r.report.status === 'success', { s: r.report.status, e: r.report.errors });
    ok('upsert: id=1 updated from source, id=99 kept', rows.find(x => x.id === 1).email === 'alice@example.com' && rows.some(x => x.id === 99) && rows.length === 6, rows);

    r = await dm('truncate-copy');
    ok('truncate-copy: success', r.report.status === 'success', { s: r.report.status, e: r.report.errors });
    const bad = await pgCompareAll(srcC, tgtC, KEYED.map(n => n.split('.').slice(1).join('.')));
    ok('truncate-copy: target identical to source (id=99 gone)', bad.length === 0, bad);
    await reset(PG_PARTIAL_SQL);
    const pl = await M.buildPlan(dbm, SRC, TGT, baseOpts({ includeData: true, dataMode: 'truncate-copy' }));
    ok('truncate-copy plan warns about deleting existing rows', pl.warnings.some(w => /truncat|delet/i.test(w.message) && w.level !== 'info'), pl.warnings.map(w => w.message).slice(0, 6));
    const cd = (pl.dataPlan || []).find(d => d.table.endsWith('customers'));
    ok('dataPlan shows targetRows=2 for customers', cd && Number(cd.targetRows) === 2 && Number(cd.sourceRows) === 5, cd);

    r = await dm('append', { onError: 'stop' });
    ok('append + onError=stop: not a success, error reported (PK conflict on id=1)', r.report.status !== 'success' && (r.report.errors || []).length > 0, { s: r.report.status, e: r.report.errors });
    ok('append + stop: customers unchanged beyond the original rows', (await emails()).length === 2, await emails());

    r = await dm('append', { onError: 'continue' });
    ok('append + onError=continue: status partial', r.report.status === 'partial', { s: r.report.status, e: r.report.errors });
    rows = await emails();
    ok('append + continue: good rows copied, conflicting row skipped', rows.length === 6 && rows.find(x => x.id === 1).email === 'stale@example.com', rows);
    const ct2 = findT(r.report, 'customers');
    ok('append + continue: rowsSkipped>=1 and error recorded for customers', ct2 && ct2.rowsSkipped >= 1 && ct2.rowsCopied === 4, ct2);
    const o2 = await tgtC.query('SELECT count(*)::int n FROM orders');
    ok('append + continue: other tables completed', o2.rows[0].n === sc.rows[0].n, o2.rows[0]);
  });

  // ---------------------------------------------------------------- cancel
  await section('pg: cancel mid-copy leaves a consistent, resumable state', async () => {
    await reset();
    ok('cancelMigration on unknown runId returns false', M.cancelMigration('nope-' + process.pid) === false);
    let cancelled = false;
    const { report } = await run(M, SRC, TGT, baseOpts({ tables: ['public.big_items'], includeData: true, batchSize: 50 }), {
      onEvent: (e, runId) => { if (!cancelled && e.type === 'rows' && e.rowsDone > 0) { cancelled = true; M.cancelMigration(runId); } },
    });
    if (report.status === 'success') { skip('cancel assertions', 'run finished before cancel took effect'); }
    else {
      ok('status cancelled', report.status === 'cancelled', report.status);
      const n = Number((await tgtC.query('SELECT count(*) n FROM big_items')).rows[0].n);
      // read size ramps up adaptively (10, 40, 160, ... capped at batchSize), each batch is written atomically
      ok('partial rows present, copy stopped early', n > 0 && n < 25000, n);
      await sleep(600);
      const idle = await admin.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname='mig_tgt' AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`);
      ok('no leaked open transactions on target', idle.rows[0].n === 0, idle.rows[0]);
      const r2 = await run(M, SRC, TGT, baseOpts({ tables: ['public.big_items'], includeData: true, dataMode: 'insert-missing', batchSize: 500 }));
      ok('resume with insert-missing succeeds', r2.report.status === 'success', r2.report.errors);
      const bad = await pgCompareAll(srcC, tgtC, ['big_items']);
      ok('after resume big_items identical to source', bad.length === 0, bad);
      let ins = true; try { await tgtC.query(`INSERT INTO big_items (payload) VALUES ('z')`); } catch (e) { ins = e.message; }
      ok('sequence consistent after cancel+resume', ins === true, ins);
    }
  });

  // ---------------------------------------------------------------- selection
  await section('pg: table selection is honoured (options.tables)', async () => {
    await reset();
    const plan = await M.buildPlan(dbm, SRC, TGT, baseOpts({ tables: ['public.orders'] }));
    const sqlAll = stepSqlAll(plan);
    ok('unselected unrelated tables are not in the plan', !/big_items|items_ident|gen_t|categories/.test(sqlAll));
    ok('selected table is created', /CREATE TABLE[^;]*"orders"/i.test(sqlAll));
    const depIncluded = /CREATE TABLE[^;]*"customers"/i.test(sqlAll);
    ok('FK dependency customers is either auto-included or warned about', depIncluded || plan.warnings.some(w => /customers/.test(w.message + w.object)), plan.warnings.map(w => w.message).slice(0, 5));
    const r = await run(M, SRC, TGT, baseOpts({ tables: ['public.orders'], includeData: true }));
    ok('selected migration succeeds', r.report.status === 'success', { s: r.report.status, e: r.report.errors });
    const t = (await pgTables(tgtC)).map(x => x.table);
    ok('only selected (+deps) tables exist in target', t.includes('orders') && !t.includes('big_items') && !t.includes('gen_t'), t);
    const bad = await pgCompareAll(srcC, tgtC, ['orders']);
    ok('orders data identical', bad.length === 0, bad);
  });

  // ---------------------------------------------------------------- blockers
  await section('pg: blockers refuse to run and change nothing', async () => {
    await reset();
    let x = await tryPlan(M, SRC, SRC, baseOpts());
    ok('same source and target connection -> blocker', x.threw || hasBlocker(x.plan), x.plan && x.plan.warnings);
    let rr = await tryRun(M, SRC, SRC, baseOpts({ includeData: true, dataMode: 'truncate-copy' }));
    ok('runMigration refuses same-database migration', rr.threw || (rr.report && rr.report.status === 'failed'), rr.report && rr.report.status);
    const still = await srcC.query('SELECT count(*)::int n FROM customers');
    ok('source untouched by refused self-migration', still.rows[0].n === 5, still.rows[0]);

    x = await tryPlan(M, SRC, TGT, baseOpts({ tables: ['public.does_not_exist'] }));
    ok('selected table missing in source -> blocker', x.threw || hasBlocker(x.plan), x.plan && x.plan.warnings);
    rr = await tryRun(M, SRC, TGT, baseOpts({ tables: ['public.does_not_exist'] }));
    ok('runMigration refuses on that blocker', rr.threw || (rr.report && rr.report.status === 'failed'), rr.report && rr.report.status);
    ok('...and the target stayed empty', (await pgTables(tgtC)).length === 0);

    x = await tryPlan(M, SRC, TGT, baseOpts({ tables: ['public.log_entries'], includeData: true, dataMode: 'insert-missing' }));
    ok('insert-missing on PK-less table -> blocker', x.threw || hasBlocker(x.plan), x.plan && x.plan.warnings);
    x = await tryPlan(M, SRC, TGT, baseOpts({ tables: ['public.log_entries'], includeData: true, dataMode: 'upsert' }));
    ok('upsert on PK-less table -> blocker', x.threw || hasBlocker(x.plan), x.plan && x.plan.warnings);
    x = await tryPlan(M, SRC, TGT, baseOpts({ tables: ['public.log_entries'], includeData: true, dataMode: 'append' }));
    ok('append on PK-less table is allowed', x.plan && !hasBlocker(x.plan), x.threw ? x.threw.message : blockerText(x.plan));
    const ra = await run(M, SRC, TGT, baseOpts({ tables: ['public.log_entries'], includeData: true, dataMode: 'append' }));
    const bad = await pgCompareAll(srcC, tgtC, ['log_entries']);
    ok('PK-less table copied exactly (duplicate rows preserved)', ra.report.status === 'success' && bad.length === 0, { s: ra.report.status, bad });

    await reset(`CREATE TABLE customers (id serial PRIMARY KEY, email text); CREATE TABLE ref_tbl (id int PRIMARY KEY, cust_id int REFERENCES customers(id));
                 INSERT INTO customers (email) VALUES ('keep@me.com');`);
    x = await tryPlan(M, SRC, TGT, baseOpts({ tables: ['public.customers'], includeData: true, dataMode: 'truncate-copy', autoIncludeDeps: false }));
    ok('truncate-copy of a table referenced by an UNSELECTED target table -> blocker', x.threw || hasBlocker(x.plan), x.plan && x.plan.warnings.map(w => w.level + ':' + w.message));
    rr = await tryRun(M, SRC, TGT, baseOpts({ tables: ['public.customers'], includeData: true, dataMode: 'truncate-copy', autoIncludeDeps: false }));
    ok('run refused', rr.threw || (rr.report && rr.report.status === 'failed'), rr.report && rr.report.status);
    const keep = await tgtC.query('SELECT email FROM customers');
    ok('target rows survive the refused truncate-copy', keep.rows.length === 1 && keep.rows[0].email === 'keep@me.com', keep.rows);
  });


  // ---------------------------------------------------------------- regression: review findings (pg)
  await section('pg: FK referencing a standalone UNIQUE INDEX (not a constraint) is ordered after that index', async () => {
    await reset();
    await srcC.query(`CREATE TABLE ux_parent (id serial PRIMARY KEY, code text NOT NULL); CREATE UNIQUE INDEX ux_parent_code_uq ON ux_parent(code);
      CREATE TABLE ux_child (id serial PRIMARY KEY, pcode text REFERENCES ux_parent(code)); INSERT INTO ux_parent(code) VALUES ('a'),('b'); INSERT INTO ux_child(pcode) VALUES ('a'),('b');`);
    try {
      const sel = ['public.ux_parent', 'public.ux_child'];
      const plan = await M.buildPlan(dbm, SRC, TGT, baseOpts({ tables: sel, includeData: true }));
      const iIdx = plan.steps.findIndex(x => x.kind === 'create-index' && /ux_parent_code_uq/.test(x.object));
      const fIdx = plan.steps.findIndex(x => x.kind === 'add-fk' && /ux_child/.test(x.object));
      ok('unique index step exists and precedes the add-fk step', iIdx >= 0 && fIdx >= 0 && iIdx < fIdx, { iIdx, fIdx });
      const r = await run(M, SRC, TGT, baseOpts({ tables: sel, includeData: true }));
      ok('migration succeeds (no 42830)', r.report.status === 'success', { s: r.report.status, e: r.report.errors });
      const fk = await tgtC.query(`SELECT count(*)::int n FROM pg_constraint WHERE conrelid='ux_child'::regclass AND contype='f'`);
      ok('FK exists in target', fk.rows[0].n === 1);
    } finally { await srcC.query('DROP TABLE IF EXISTS ux_child, ux_parent'); }
  });

  await section('pg: step completion events carry a status for every step', async () => {
    await reset();
    const r = await run(M, SRC, TGT, baseOpts({ tables: ['public.categories'] }));
    const done = new Set(r.events.filter(e => e.type === 'step' && e.stepId && e.status).map(e => e.stepId));
    ok('every recorded step has a completion event', r.report.steps.length > 0 && r.report.steps.every(st => done.has(st.id)), { steps: r.report.steps.length, done: done.size });
    ok('completion statuses are ok/error/skipped', r.events.filter(e => e.type === 'step' && e.status).every(e => ['ok', 'error', 'skipped'].includes(e.status)));
  });

  await section('pg: wide rows are bounded by bytes, and a failing second session does not leak the first', async () => {
    await reset();
    await srcC.query(`CREATE TABLE wide_blobs (id int PRIMARY KEY, a bytea, b text); INSERT INTO wide_blobs SELECT g, decode(repeat('ab', 2*1024*1024), 'hex'), repeat('x', 2*1024*1024) FROM generate_series(1, 12) g;`);
    try {
      const r = await run(M, SRC, TGT, baseOpts({ tables: ['public.wide_blobs'], includeData: true, batchSize: 1000 }));
      ok('wide-row copy succeeds with batchSize 1000', r.report.status === 'success', { s: r.report.status, e: r.report.errors });
      const bad = await pgCompareAll(srcC, tgtC, ['wide_blobs']);
      ok('wide rows identical', bad.length === 0, bad);
    } finally { await srcC.query('DROP TABLE IF EXISTS wide_blobs'); }
    // second session fails to open: the first must be released
    const { copyPgAll } = require(path.join(ROOT, 'electron', 'migration', 'copyPg.js'));
    const { getConn } = require(path.join(ROOT, 'electron', 'migration', 'util.js'));
    const real = dbm.connections.get(SRC);
    const fake = { getConnection: (id) => id === 'bad' ? { type: 'postgres', client: { connect: async () => { throw new Error('boom'); } } } : real };
    const busy = () => real.client.totalCount - real.client.idleCount;
    const before = busy();
    let threw = false;
    try { await copyPgAll({ dbManager: fake, srcId: SRC, tgtId: 'bad', plan: {}, opts: baseOpts(), signal: new AbortController().signal, emit() {}, log() {}, getConn, entries: [] }); } catch (e) { threw = /boom/.test(e.message); }
    ok('copyPgAll rejects with the connect error', threw);
    ok('no pool client leaked from the first session', busy() === before, { before, after: busy() });
  });

  await section('pg: no unhandled rejections so far (prefetch is guarded)', async () => { ok('unhandledRejection count is 0', unhandled === 0, unhandled); });

  // ---------------------------------------------------------------- unsupported engine / cross-engine (via sqlite)
  await section('engine support: unsupported engine is rejected with a clear message', async () => {
    let connected = false;
    try { await dbm.connect({ id: 'mig-sqlite', type: 'sqlite', database: ':memory:' }); connected = true; } catch (e) { skip('sqlite rejection', `driver unavailable: ${e.message}`); }
    if (connected) {
      const x = await tryPlan(M, SRC, 'mig-sqlite', baseOpts());
      const msg = x.threw ? x.threw.message : (x.plan.warnings || []).filter(w => w.level === 'blocker').map(w => w.message).join(' ');
      ok('postgres -> sqlite rejected (cross-engine/unsupported)', !!msg && /cross-engine|out of scope|not supported|unsupported/i.test(msg), msg || x.plan.warnings);
      const y = await tryPlan(M, 'mig-sqlite', 'mig-sqlite', baseOpts());
      ok('sqlite source rejected', y.threw || hasBlocker(y.plan));
      try { await dbm.disconnect('mig-sqlite'); } catch (_) { }
    }
  });

  await dbm.disconnect(SRC).catch(() => { }); await dbm.disconnect(TGT).catch(() => { });
  await srcC.end().catch(() => { }); await tgtC.end().catch(() => { });
  await admin.query('DROP DATABASE IF EXISTS mig_src').catch(() => { }); await admin.query('DROP DATABASE IF EXISTS mig_tgt').catch(() => { });
  await admin.end().catch(() => { });
  return { cfg };
}

// ========================================================================= MYSQL
const MY_PORT = parseInt(process.env.MIG_MYSQL_PORT || '13307', 10);

const MYSQL_SOURCE_SQL = [
  `CREATE TABLE customers (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(100) NOT NULL, note TEXT, created DATETIME DEFAULT CURRENT_TIMESTAMP, flags TINYINT UNSIGNED NOT NULL DEFAULT 0, UNIQUE KEY uq_email (email)) ENGINE=InnoDB`,
  `CREATE TABLE categories (id INT AUTO_INCREMENT PRIMARY KEY, parent_id INT NULL, name VARCHAR(50) NOT NULL, CONSTRAINT fk_cat_parent FOREIGN KEY (parent_id) REFERENCES categories(id)) ENGINE=InnoDB`,
  `CREATE TABLE orders (id BIGINT AUTO_INCREMENT PRIMARY KEY, customer_id INT NOT NULL, total DECIMAL(12,2) NOT NULL DEFAULT 0, status ENUM('new','paid','it''s') DEFAULT 'new', meta JSON, blob_col BLOB, big BIGINT UNSIGNED,
     KEY idx_cust (customer_id), CONSTRAINT fk_ord_cust FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE, CONSTRAINT chk_total CHECK (total >= 0)) ENGINE=InnoDB`,
  `CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, payload VARCHAR(100)) ENGINE=InnoDB`,
  `CREATE TABLE nopk (a INT, b VARCHAR(10)) ENGINE=InnoDB`,
  'CREATE TABLE `we``ird; name` (`select` INT PRIMARY KEY, `col name` TEXT) ENGINE=InnoDB',
  `INSERT INTO customers (email, note, flags) VALUES ('alice@example.com','it''s; "quoted" ünïcödé 日本語 😀',1),('bob@example.com','; DROP TABLE customers; --',2),('carol@example.com',NULL,3),('dave@example.com','back\\\\slash\nnewline',4)`,
  `INSERT INTO categories (parent_id, name) VALUES (NULL,'root')`,
  `INSERT INTO categories (parent_id, name) VALUES (1,'child'),(2,'grandchild')`,
  `INSERT INTO orders (customer_id,total,status,meta,blob_col,big) VALUES (1,10.50,'new','{"a":[1,2,{"b":null}]}',UNHEX('00FF10'),18446744073709551615),(2,0,'it''s',NULL,NULL,0),(3,99999999.99,'paid','[]',UNHEX('DEADBEEF'),1)`,
  `SET SESSION cte_max_recursion_depth=20000`,
  `INSERT INTO items (payload) WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<12000) SELECT CONCAT('row ',n,'; x''y') FROM s`,
  `INSERT INTO nopk VALUES (1,'dup'),(1,'dup'),(NULL,'n')`,
  'INSERT INTO `we``ird; name` VALUES (1,\'a;b\'),(2,NULL)',
  `CREATE VIEW v_orders AS SELECT c.id, c.email, COUNT(o.id) AS n FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.email`,
];
const MYSQL_PARTIAL_SQL = [
  `CREATE TABLE customers (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(100) NOT NULL) ENGINE=InnoDB`,
  `INSERT INTO customers (id, email) VALUES (1,'stale@example.com'),(99,'targetonly@example.com')`,
  `CREATE TABLE target_only_tbl (id INT) ENGINE=InnoDB`,
];

async function mysqlSuite(M) {
  console.log('\n######## MYSQL ########');
  const my = require('mysql2/promise');
  const conn = async (database) => my.createConnection({ host: '127.0.0.1', port: MY_PORT, user: 'root', password: 'test', database, charset: 'utf8mb4', multipleStatements: false });
  let admin = null;
  try { admin = await conn(undefined); } catch (_) { admin = null; }
  if (!admin) {
    const name = `dbaccess-mig-mysql-${process.pid}`;
    try { startContainer(name, ['-e', 'MYSQL_ROOT_PASSWORD=test', '-p', `${MY_PORT}:3306`, 'mysql:8', '--max_allowed_packet=1048576']); }
    catch (e) { skip('mysql suite', e.message); return; }
    console.log(`  started ${name} on ${MY_PORT} (waiting for init...)`);
    let good = 0;
    for (let i = 0; i < 120 && good < 2; i++) {
      try { const c = await conn(undefined); await c.query('SELECT 1'); await c.end(); good++; await sleep(2500); } catch (_) { good = 0; await sleep(1500); }
    }
    if (good < 2) { skip('mysql suite', 'container did not become ready'); return; }
    admin = await conn(undefined);
  }
  await admin.query('DROP DATABASE IF EXISTS msrc'); await admin.query('DROP DATABASE IF EXISTS mtgt');
  await admin.query('CREATE DATABASE msrc CHARACTER SET utf8mb4'); await admin.query('CREATE DATABASE mtgt CHARACTER SET utf8mb4');
  const srcC = await conn('msrc'), tgtC = await conn('mtgt');
  for (const s of MYSQL_SOURCE_SQL) await srcC.query(s);
  const tablesOf = async (c, db) => (await c.query(`SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' ORDER BY 1`, [db]))[0].map(r => r.t);
  const srcTables = await tablesOf(srcC, 'msrc');
  const resetMy = async (stmts) => {
    await tgtC.query('SET FOREIGN_KEY_CHECKS=0');
    const [objs] = await tgtC.query(`SELECT TABLE_NAME t, TABLE_TYPE ty FROM information_schema.TABLES WHERE TABLE_SCHEMA='mtgt'`);
    for (const o of objs) await tgtC.query(`DROP ${o.ty === 'VIEW' ? 'VIEW' : 'TABLE'} ${mqi(o.t)}`);
    await tgtC.query('SET FOREIGN_KEY_CHECKS=1');
    for (const s of stmts || []) await tgtC.query(s);
  };
  const digest = async (c, db, t) => {
    const [cols] = await c.query(`SELECT COLUMN_NAME n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND GENERATION_EXPRESSION='' ORDER BY ORDINAL_POSITION`, [db, t]);
    return cols.map(x => x.n);
  };
  const hash = async (c, db, t, cols) => {
    const expr = cols.map(x => `IFNULL(CAST(${mqi(x)} AS CHAR),'<N>')`).join(',');
    const [r] = await c.query(`SELECT COUNT(*) n, BIT_XOR(CAST(CONV(SUBSTRING(MD5(CONCAT_WS('|',${expr})),1,16),16,10) AS UNSIGNED)) h FROM ${mqi(db)}.${mqi(t)}`);
    return `${r[0].n}/${String(r[0].h)}`;
  };
  const compareAll = async (only) => {
    const bad = [];
    for (const t of srcTables) {
      if (only && !only.includes(t)) continue;
      const sc = await digest(srcC, 'msrc', t), tc = await digest(tgtC, 'mtgt', t);
      if (!tc.length) { bad.push(`${t}: missing`); continue; }
      const cols = sc.filter(c => tc.includes(c));
      const a = await hash(srcC, 'msrc', t, cols), b = await hash(tgtC, 'mtgt', t, cols);
      if (a !== b) bad.push(`${t}: src ${a} tgt ${b}`);
    }
    return bad;
  };

  const SRC = 'mig-msrc', TGT = 'mig-mtgt';
  const cfg = (id, database) => ({ id, type: 'mysql', host: '127.0.0.1', port: MY_PORT, database, username: 'root', password: 'test', ssl: false });
  try { await dbm.connect(cfg(SRC, 'msrc')); await dbm.connect(cfg(TGT, 'mtgt')); }
  catch (e) { skip('mysql suite', `dbManager.connect failed: ${e.message}`); await admin.end(); return; }

  await section('mysql: plan + schema-only migration into EMPTY target', async () => {
    await resetMy();
    const m = await M.introspect(dbm, SRC);
    ok('introspect returns mysql model with all tables', m.engine === 'mysql' && m.tables.length === srcTables.length, { e: m.engine, n: m.tables && m.tables.length });
    const plan = await M.buildPlan(dbm, SRC, TGT, baseOpts());
    ok('engine mysql, no blockers', plan.engine === 'mysql' && !hasBlocker(plan), blockerText(plan));
    ok(`tablesToCreate == ${srcTables.length}`, plan.summary.tablesToCreate === srcTables.length, plan.summary);
    const sqlAll = stepSqlAll(plan);
    ok('tables are created in the TARGET database (qualified)', /`mtgt`\.`customers`/.test(sqlAll) && !/`msrc`/.test(sqlAll.replace(/--.*$/gm, '')), sqlAll.slice(0, 300));
    ok('AUTO_INCREMENT preserved on id columns, FKs created after tables', /AUTO_INCREMENT/i.test(sqlAll) && plan.steps.findIndex(s => /FOREIGN KEY/i.test(s.sql)) > Math.max(...plan.steps.map((s, i) => /CREATE TABLE/i.test(s.sql) ? i : -1)));
    ok('view created for target db', plan.summary.viewsToCreate === 1 && /v_orders/.test(sqlAll));
    ok('no DROP when allowDrops=false', dropSteps(plan).length === 0);
    ok('warns that MySQL DDL is not transactional', plan.warnings.some(w => /transactional|implicit commit/i.test(w.message)), plan.warnings.map(w => w.message).slice(0, 5));
    const { report } = await run(M, SRC, TGT, baseOpts());
    ok('status success', report.status === 'success', { s: report.status, e: report.errors });
    const plan2 = await M.buildPlan(dbm, SRC, TGT, baseOpts());
    ok('second plan has ZERO steps (idempotent)', plan2.steps.length === 0, plan2.steps.map(s => s.description || s.sql).slice(0, 6));
  });

  await section('mysql: FULL migration (schema+data) into EMPTY target', async () => {
    await resetMy();
    const opts = baseOpts({ includeData: true, batchSize: 1000 });
    const plan = await M.buildPlan(dbm, SRC, TGT, opts);
    const dp = plan.dataPlan || [];
    const pos = (n) => dp.findIndex(d => d.table === n || String(d.table).endsWith('.' + n) || String(d.table).endsWith('.' + mqi(n)));
    ok('dataPlan FK-ordered (customers before orders)', pos('customers') >= 0 && pos('customers') < pos('orders'), dp.map(d => d.table));
    const { report, events } = await run(M, SRC, TGT, opts);
    ok('status success', report.status === 'success', { s: report.status, e: report.errors });
    ok('rows progress events for items', events.some(e => e.type === 'rows' && /items/.test(e.table || '')));
    const it = findT(report, 'items');
    ok('items 12000 rows copied', it && it.rowsCopied === 12000, it);
    const bad = await compareAll();
    ok('every table identical (BIT_XOR/MD5 digest: DECIMAL, JSON, BLOB, ENUM, BIGINT UNSIGNED max, emoji, NULLs, dup rows)', bad.length === 0, bad);
    let ins = true, ids = null;
    try {
      ids = [(await tgtC.query(`INSERT INTO customers (email) VALUES ('post@x.com')`))[0].insertId, (await tgtC.query(`INSERT INTO items (payload) VALUES ('p')`))[0].insertId, (await tgtC.query(`INSERT INTO categories (name) VALUES ('p')`))[0].insertId];
    } catch (e) { ins = e.message; }
    ok('AUTO_INCREMENT resynced (next ids 5, 12001, 4)', ins === true && ids[0] === 5 && ids[1] === 12001 && ids[2] === 4, ins === true ? ids : ins);
    for (const q of ['DELETE FROM customers WHERE id=5', 'DELETE FROM items WHERE id=12001', 'DELETE FROM categories WHERE id=4']) await tgtC.query(q).catch(() => { });
    const v = await M.verifyMigration(dbm, SRC, TGT, srcTables.map(t => `msrc.${t}`));
    ok('verifyMigration: all match', v.length === srcTables.length && v.every(x => x.status === 'match'), v.filter(x => x.status !== 'match'));
    const x = await tryPlan(M, SRC, TGT, baseOpts({ tables: ['msrc.nopk'], includeData: true, dataMode: 'upsert' }));
    ok('upsert on PK-less table -> blocker', x.threw || hasBlocker(x.plan));
  });

  await section('mysql: PARTIAL target (missing tables/columns, extra table, overlapping rows)', async () => {
    await resetMy(MYSQL_PARTIAL_SQL);
    const KEYED = srcTables.filter(t => t !== 'nopk').map(t => `msrc.${t}`);
    const plan = await M.buildPlan(dbm, SRC, TGT, baseOpts({ includeData: true, dataMode: 'insert-missing', tables: KEYED }));
    ok('no blockers', !hasBlocker(plan), blockerText(plan));
    ok(`tablesToCreate == ${srcTables.length - 2}`, plan.summary.tablesToCreate === KEYED.length - 1, plan.summary);
    ok('columnsToAdd >= 3 on customers', plan.summary.columnsToAdd >= 3, plan.summary);
    ok('no drops emitted; target-only table warned', dropSteps(plan).length === 0 && (await M.buildPlan(dbm, SRC, TGT, baseOpts())).warnings.some(w => /target_only_tbl/.test(w.object + w.message)));
    const { report } = await run(M, SRC, TGT, baseOpts({ includeData: true, dataMode: 'insert-missing', tables: KEYED }));
    ok('status success', report.status === 'success', { s: report.status, e: report.errors });
    const [rows] = await tgtC.query('SELECT id, email, flags FROM customers ORDER BY id');
    ok('insert-missing keeps stale id=1 and id=99, adds the rest', rows.length === 5 && rows[0].email === 'stale@example.com' && rows.some(r => r.id === 99), rows);
    const bad = await compareAll(['items', 'orders', 'categories']);
    ok('other tables identical', bad.length === 0, bad);
    const plan2 = await M.buildPlan(dbm, SRC, TGT, baseOpts({ tables: KEYED }));
    ok('re-plan after migration has ZERO steps', plan2.steps.length === 0, plan2.steps.map(s => s.description || s.sql).slice(0, 6));
    await resetMy(MYSQL_PARTIAL_SQL);
    await run(M, SRC, TGT, baseOpts({ includeData: true, dataMode: 'upsert', tables: KEYED }));
    const [r2] = await tgtC.query('SELECT email FROM customers WHERE id=1');
    ok('upsert overwrites id=1 from source', r2[0].email === 'alice@example.com', r2);
    await resetMy(MYSQL_PARTIAL_SQL);
    const rc = await run(M, SRC, TGT, baseOpts({ includeData: true, dataMode: 'append', onError: 'continue', tables: KEYED }));
    ok('append + continue: partial status, conflicting row skipped', rc.report.status === 'partial' && (findT(rc.report, 'customers') || {}).rowsSkipped >= 1, { s: rc.report.status, c: findT(rc.report, 'customers') });
  });

  // ---------------------------------------------------------------- regression: review findings (mysql)
  await section('mysql: views whose base tables are not selected are not planned', async () => {
    await resetMy();
    await srcC.query('CREATE TABLE mx_a (id INT PRIMARY KEY)'); await srcC.query('CREATE TABLE mx_b (id INT PRIMARY KEY)');
    await srcC.query('CREATE VIEW mx_vb AS SELECT id FROM mx_b'); await srcC.query('CREATE VIEW mx_va AS SELECT id FROM mx_a');
    try {
      const plan = await M.buildPlan(dbm, SRC, TGT, baseOpts({ tables: ['msrc.mx_a'] }));
      const sql = stepSqlAll(plan);
      ok('view over the unselected table is skipped', !/mx_vb/.test(sql), sql);
      ok('view over the selected table is kept', /mx_va/.test(sql));
      ok('a warning explains the skipped view', plan.warnings.some(w => /mx_vb/.test(w.object + w.message)));
      const r = await run(M, SRC, TGT, baseOpts({ tables: ['msrc.mx_a'], includeData: true }));
      ok('run succeeds', r.report.status === 'success', { s: r.report.status, e: r.report.errors });
    } finally { await srcC.query('DROP VIEW IF EXISTS mx_va, mx_vb'); await srcC.query('DROP TABLE IF EXISTS mx_a, mx_b'); }
  });

  await section('mysql: AUTO_INCREMENT is applied after the primary key on an existing keyless column', async () => {
    await resetMy(['CREATE TABLE mx_c (id INT NOT NULL)', 'INSERT INTO mx_c VALUES (1),(2)']);
    await srcC.query('CREATE TABLE mx_c (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY)');
    try {
      const plan = await M.buildPlan(dbm, SRC, TGT, baseOpts({ tables: ['msrc.mx_c'] }));
      const pk = plan.steps.findIndex(x => x.kind === 'add-pk'), mod = plan.steps.findIndex(x => x.kind === 'modify-column' && /AUTO_INCREMENT/i.test(x.sql));
      ok('add-pk precedes the AUTO_INCREMENT modify', pk >= 0 && mod >= 0 && pk < mod, { pk, mod });
      const r = await run(M, SRC, TGT, baseOpts({ tables: ['msrc.mx_c'] }));
      ok('run succeeds (no ER_WRONG_AUTO_KEY)', r.report.status === 'success', { s: r.report.status, e: r.report.errors });
      const [c] = await tgtC.query(`SELECT EXTRA e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='mtgt' AND TABLE_NAME='mx_c' AND COLUMN_NAME='id'`);
      ok('target column is auto_increment', /auto_increment/.test(c[0].e), c);
    } finally { await srcC.query('DROP TABLE IF EXISTS mx_c'); }
  });

  await section('mysql: keyless table with long tied TEXT is streamed (no OFFSET paging), nothing lost or duplicated', async () => {
    await resetMy();
    await srcC.query('CREATE TABLE mx_nopk (t TEXT, n INT)');
    await srcC.query('SET SESSION cte_max_recursion_depth = 100000');
    await srcC.query("INSERT INTO mx_nopk SELECT CONCAT(REPEAT('x', 3000), q.n), q.n FROM (WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n < 3000) SELECT n FROM s) q");
    try {
      const plan = await M.buildPlan(dbm, SRC, TGT, baseOpts({ tables: ['msrc.mx_nopk'], includeData: true }));
      ok('table is planned for copy', (plan.dataPlan || []).length === 1);
      const r = await run(M, SRC, TGT, baseOpts({ tables: ['msrc.mx_nopk'], includeData: true, batchSize: 100 }));
      ok('copy succeeds', r.report.status === 'success', { s: r.report.status, e: r.report.errors });
      const t = findT(r.report, 'mx_nopk');
      ok('rowsCopied equals source rows', t && t.rowsCopied === 3000 && t.targetRowsAfter === 3000, t);
      const bad = await compareAll(['mx_nopk']);
      ok('content identical (no duplicates/skips)', bad.length === 0, bad);
    } finally { await srcC.query('DROP TABLE IF EXISTS mx_nopk'); }
  });

  await section('mysql: no unhandled rejections', async () => { ok('unhandledRejection count is 0', unhandled === 0, unhandled); });

  await section('mysql: cross-engine is rejected (postgres -> mysql)', async () => {
    const pgSrc = 'mig-xpg';
    let pgOk = true;
    try { await dbm.connect({ id: pgSrc, type: 'postgres', host: '127.0.0.1', port: PG_PORT, database: 'postgres', username: 'postgres', password: 'test', ssl: false }); } catch (_) { pgOk = false; }
    if (!pgOk) { skip('cross-engine rejection', 'postgres not reachable (pg suite not run)'); return; }
    const x = await tryPlan(M, pgSrc, TGT, baseOpts());
    const msg = x.threw ? x.threw.message : (x.plan.warnings || []).filter(w => w.level === 'blocker').map(w => w.message).join(' ');
    ok('blocker mentions cross-engine / out of scope', /cross-engine|out of scope/i.test(msg), msg);
    const rr = await tryRun(M, pgSrc, TGT, baseOpts());
    ok('run refused', rr.threw || (rr.report && rr.report.status === 'failed'));
    try { await dbm.disconnect(pgSrc); } catch (_) { }
  });

  await dbm.disconnect(SRC).catch(() => { }); await dbm.disconnect(TGT).catch(() => { });
  await srcC.end().catch(() => { }); await tgtC.end().catch(() => { });
  await admin.query('DROP DATABASE IF EXISTS msrc').catch(() => { }); await admin.query('DROP DATABASE IF EXISTS mtgt').catch(() => { });
  await admin.end().catch(() => { });
}

// ========================================================================= main
async function main() {
  const idx = path.join(ROOT, 'electron', 'migration', 'index.js');
  if (!fs.existsSync(idx)) { console.error('FATAL: electron/migration/index.js not found'); process.exit(2); }
  const M = require(idx);
  for (const fn of ['introspect', 'buildPlan', 'runMigration', 'cancelMigration', 'verifyMigration']) {
    if (typeof M[fn] !== 'function') { console.error(`FATAL: electron/migration/index.js does not export ${fn}()`); process.exit(2); }
  }
  const only = process.env.MIG_ONLY;
  try {
    if (!only || only === 'pg') await postgresSuite(M);
    if ((!only || only === 'mysql') && !process.env.MIG_NO_MYSQL) await mysqlSuite(M);
  } finally {
    cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); cleanup(); process.exit(1); });
