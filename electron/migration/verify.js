// verifyMigration: exact row counts on both sides (plus a FK orphan / sequence sanity check could be added later).
const { family, pg, my } = require('./sql');
const { getConn } = require('./util');

async function countRows(conn, fam, schema, table) {
  if (fam === 'postgres') return String((await conn.client.query(`SELECT count(*)::text AS n FROM ${pg.qn(schema, table)}`)).rows[0].n);
  return String((await conn.client.query(`SELECT CAST(COUNT(*) AS CHAR) AS n FROM ${my.qn(schema, table)}`))[0][0].n);
}

async function verifyMigration(dbManager, srcId, tgtId, tables) {
  const sc = getConn(dbManager, srcId), tc = getConn(dbManager, tgtId);
  const sf = family(sc.type), tf = family(tc.type);
  if (!sf || !tf || sf !== tf) throw new Error('Cross-engine migration is out of scope: verification needs two databases of the same engine family (PostgreSQL or MySQL/MariaDB)');
  const out = [];
  for (const name of tables || []) {
    const i = String(name).indexOf('.');
    const schema = i < 0 ? (sf === 'mysql' ? sc.activeDb : 'public') : name.slice(0, i), table = i < 0 ? name : name.slice(i + 1);
    const row = { table: name, sourceRows: null, targetRows: null, status: 'error' };
    try {
      row.sourceRows = Number(await countRows(sc, sf, schema, table));
      row.targetRows = Number(await countRows(tc, tf, sf === 'mysql' ? tc.activeDb : schema, table));
      row.status = row.sourceRows === row.targetRows ? 'match' : 'mismatch';
    } catch (e) { row.status = 'error'; row.error = e.message; }
    out.push(row);
  }
  return out;
}
module.exports = { verifyMigration };
