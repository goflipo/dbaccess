// Regression test for row edit/delete correctness across DB engines.
//
// Exercises electron/database.js#executeQuery directly with the exact
// "BEGIN; ...; COMMIT;" SQL shape src/components/ResultsGrid.jsx sends for
// row edits and deletes, and checks that reported rowCount/rows reflect what
// actually happened (single delete, zero-match delete, multi-statement
// cascade delete, mixed UPDATE+INSERT edit-save, semicolon-in-value safety,
// atomic rollback on error).
//
// sqlite and libsql run with no setup required. postgres and mysql are
// skipped automatically unless a server is reachable at the env vars below
// (spin one up with e.g.:
//   docker run --rm -d -e POSTGRES_PASSWORD=test -e POSTGRES_DB=testdb -p 15432:5432 postgres:16-alpine
//   docker run --rm -d -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=testdb -p 13306:3306 mysql:8
// ).
//
// sqlite needs better-sqlite3's native binding built against Electron's Node
// ABI, so run this via Electron's node runtime, not plain `node`:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-row-ops.js

const path = require('path');
const db = require(path.join(__dirname, '..', 'electron', 'database.js'));

let pass = 0, fail = 0, skipped = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  PASS - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}${extra !== undefined ? ' :: got ' + JSON.stringify(extra) : ''}`); }
}
function skip(name, reason) { skipped++; console.log(`  SKIP - ${name} (${reason})`); }

// Shared checks against any connection that speaks SQL this way.
async function runSuite(connId, quoteCol, idColumnDdl) {
  const q = quoteCol ? (c) => `"${c}"` : (c) => c;

  await db.executeQuery(connId, `DROP TABLE IF EXISTS users`);
  await db.executeQuery(connId, `CREATE TABLE users (${idColumnDdl}, name VARCHAR(50), age INT)`);
  await db.executeQuery(connId, `INSERT INTO users (name, age) VALUES ('alice',30),('bob',25),('carol',40)`);

  const del = await db.executeQuery(connId, `BEGIN;\nDELETE FROM users WHERE ${q('name')} = 'bob';\nCOMMIT;`);
  ok('single-row delete reports rowCount 1', del.rowCount === 1, del.rowCount);

  const check = await db.executeQuery(connId, `SELECT count(*) AS c FROM users`);
  ok('deleted row is actually gone (2 remain)', Number(check.rows[0].c) === 2, check.rows[0]);

  const del0 = await db.executeQuery(connId, `BEGIN;\nDELETE FROM users WHERE ${q('name')} = 'nobody';\nCOMMIT;`);
  ok('zero-match delete reports rowCount 0 (no false success)', del0.rowCount === 0, del0.rowCount);

  const edit = await db.executeQuery(connId, `BEGIN;\nUPDATE users SET ${q('age')} = 31 WHERE ${q('name')} = 'alice';\nINSERT INTO users (${q('name')}, ${q('age')}) VALUES ('frank', 22);\nCOMMIT;`);
  ok('edit-save (UPDATE+INSERT) reports rowCount 2', edit.rowCount === 2, edit.rowCount);

  const check2 = await db.executeQuery(connId, `SELECT age FROM users WHERE name = 'alice'`);
  ok('UPDATE actually applied', Number(check2.rows[0].age) === 31, check2.rows[0]);

  const sel = await db.executeQuery(connId, `SELECT * FROM users ORDER BY name`);
  ok('plain single-statement SELECT unaffected', sel.rowCount === sel.rows.length && sel.rows.length > 0, { rowCount: sel.rowCount, rows: sel.rows.length });

  await db.executeQuery(connId, `DROP TABLE users`);
}

async function testPostgres() {
  console.log('\npostgres:');
  const id = 'test-pg';
  try {
    await db.connect({ id, type: 'postgres', host: process.env.PGHOST || '127.0.0.1', port: process.env.PGPORT || 15432, database: 'testdb', username: 'postgres', password: 'test', ssl: false });
  } catch (e) { skip('postgres suite', `no server reachable (${e.message})`); return; }
  await runSuite(id, true, 'id serial primary key');

  await db.executeQuery(id, `DROP TABLE IF EXISTS t1; DROP TABLE IF EXISTS t2;`);
  await db.executeQuery(id, `CREATE TABLE t1 (id int); CREATE TABLE t2 (id int); INSERT INTO t1 VALUES (1),(2); INSERT INTO t2 VALUES (10),(20)`);
  const cascade = await db.executeQuery(id, `BEGIN;\nDELETE FROM t1 WHERE id = 1 RETURNING id;\nDELETE FROM t2 WHERE id = 10;\nCOMMIT;`);
  ok('cascade-style multi-DELETE sums rowCount across statements', cascade.rowCount === 2, cascade.rowCount);
  ok('mixed RETURNING+plain delete surfaces the RETURNING rows', cascade.rows.length === 1 && cascade.rows[0].id === 1, cascade.rows);
  await db.executeQuery(id, `DROP TABLE t1; DROP TABLE t2;`);

  await db.disconnect(id);
}

async function testMysql() {
  console.log('\nmysql:');
  const id = 'test-mysql';
  try {
    await db.connect({ id, type: 'mysql', host: process.env.MYSQL_HOST || '127.0.0.1', port: process.env.MYSQL_PORT || 13306, database: 'testdb', username: 'root', password: 'test', ssl: false });
  } catch (e) { skip('mysql suite', `no server reachable (${e.message})`); return; }
  await runSuite(id, false, 'id INT PRIMARY KEY AUTO_INCREMENT');
  await db.disconnect(id);
}

async function testSqlite() {
  console.log('\nsqlite:');
  const id = 'test-sqlite';
  try {
    await db.connect({ id, type: 'sqlite', database: ':memory:' });
  } catch (e) { skip('sqlite suite', `driver unavailable — run via Electron's node runtime: ${e.message}`); return; }
  await runSuite(id, true, 'id INTEGER PRIMARY KEY');

  await db.executeQuery(id, `CREATE TABLE t (name TEXT)`);
  const semi = await db.executeQuery(id, `BEGIN;\nINSERT INTO t (name) VALUES ('a;b');\nCOMMIT;`);
  ok('semicolon inside a quoted value does not confuse statement splitting', semi.rowCount === 1, semi.rowCount);

  let threw = false;
  await db.executeQuery(id, `INSERT INTO t (name) VALUES ('keep-me')`);
  try {
    await db.executeQuery(id, `BEGIN;\nDELETE FROM t WHERE name = 'keep-me';\nINSERT INTO nonexistent_table (x) VALUES (1);\nCOMMIT;`);
  } catch (e) { threw = true; }
  ok('a failing statement throws', threw);
  const stillThere = await db.executeQuery(id, `SELECT count(*) AS c FROM t WHERE name = 'keep-me'`);
  ok('...and the whole script rolled back atomically', stillThere.rows[0].c === 1, stillThere.rows[0]);

  await db.disconnect(id);
}

async function testLibsql() {
  console.log('\nlibsql:');
  const id = 'test-libsql';
  await db.connect({ id, type: 'libsql', database: '' });
  await runSuite(id, true, 'id INTEGER PRIMARY KEY');
  await db.disconnect(id);
}

async function main() {
  await testPostgres();
  await testMysql();
  await testSqlite();
  await testLibsql();

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
