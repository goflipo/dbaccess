// MySQL / MariaDB introspection -> common schema model. All queries are parameterised.
// `c` is a dedicated mysql2/promise connection; `db` is the database the pool is bound to.
const { my } = require('./sql');

const grp = (rows, key) => { const m = new Map(); for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };

async function introspectMysql(c, db) {
  const q = async (sql, params) => (await c.query(sql, params))[0];
  if (!db) throw new Error('No database selected on this MySQL connection');
  const info = (await q(`SELECT VERSION() AS v, @@sql_mode AS sql_mode, @@lower_case_table_names AS lctn, @@character_set_database AS cs, @@collation_database AS coll, @@max_allowed_packet AS pkt`))[0];
  const isMaria = /mariadb/i.test(info.v);
  const model = {
    engine: 'mysql', version: info.v, serverVersion: String(info.v).split('-')[0], isMaria, versionNum: 0,
    database: db, activeDb: db, sqlMode: info.sql_mode, lctn: Number(info.lctn), charset: info.cs, collation: info.coll, maxPacket: Number(info.pkt),
    schemas: [db], extensions: [], types: [], sequences: [], tables: [], views: [], functions: [], triggers: [], warnings: [],
  };
  const vm = /^(\d+)\.(\d+)\.(\d+)/.exec(model.serverVersion);
  if (vm) model.versionNum = Number(vm[1]) * 10000 + Number(vm[2]) * 100 + Number(vm[3]);

  const tables = await q(`SELECT TABLE_NAME, TABLE_TYPE, ENGINE, ROW_FORMAT, TABLE_ROWS, AUTO_INCREMENT, TABLE_COLLATION, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME`, [db]);
  const cols = await q(`SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_KEY, CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_COMMENT, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db]);
  let hasExpr = false;
  try { hasExpr = (await q(`SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='information_schema' AND TABLE_NAME='STATISTICS' AND COLUMN_NAME='EXPRESSION'`)).length > 0; } catch (e) { /* ignore */ }
  const stats = await q(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, COLLATION, INDEX_TYPE, ${hasExpr ? 'EXPRESSION' : 'NULL AS EXPRESSION'} FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, [db]);
  const fks = await q(`SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
    FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME AND r.TABLE_NAME=k.TABLE_NAME
    WHERE k.TABLE_SCHEMA=? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [db]);
  let checks = [];
  try {
    checks = isMaria
      ? await q(`SELECT TABLE_NAME, CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=?`, [db])
      : await q(`SELECT tc.TABLE_NAME, cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS cc JOIN information_schema.TABLE_CONSTRAINTS tc
          ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME AND tc.CONSTRAINT_TYPE='CHECK' WHERE cc.CONSTRAINT_SCHEMA=?`, [db]);
  } catch (e) { /* pre-8.0.16: no check constraints */ }

  const colsBy = grp(cols, 'TABLE_NAME'), statsBy = grp(stats, 'TABLE_NAME'), fksBy = grp(fks, 'TABLE_NAME'), chkBy = grp(checks, 'TABLE_NAME');
  const base = tables.filter(t => t.TABLE_TYPE === 'BASE TABLE');

  // SHOW CREATE TABLE is the authority for CREATE TABLE of missing tables (a few at a time)
  const createSql = new Map();
  for (let i = 0; i < base.length; i += 8) {
    await Promise.all(base.slice(i, i + 8).map(async (t) => {
      try {
        const r = await q('SHOW CREATE TABLE ' + my.qi(db) + '.' + my.qi(t.TABLE_NAME));
        createSql.set(t.TABLE_NAME, r[0]['Create Table']);
      } catch (e) { model.warnings.push('SHOW CREATE TABLE failed for ' + t.TABLE_NAME + ': ' + e.message); }
    }));
  }

  for (const t of base) {
    const tbl = {
      schema: db, name: t.TABLE_NAME, fullName: db + '.' + t.TABLE_NAME, kind: 'table', unlogged: false, partitionKey: null, partitionOf: null, inherits: [],
      comment: t.TABLE_COMMENT || null, estRows: Number(t.TABLE_ROWS) || 0,
      options: { engine: t.ENGINE, rowFormat: t.ROW_FORMAT, collation: t.TABLE_COLLATION, autoIncrement: t.AUTO_INCREMENT, comment: t.TABLE_COMMENT },
      createSql: createSql.get(t.TABLE_NAME) || null,
      columns: [], primaryKey: null, uniques: [], foreignKeys: [], checks: [], exclusions: [], indexes: [], triggers: [], rules: [], rls: { enabled: false, policies: [] },
    };
    for (const r of colsBy.get(t.TABLE_NAME) || []) {
      const extra = String(r.EXTRA || '');
      const gen = /(VIRTUAL|STORED|PERSISTENT) GENERATED/i.exec(extra);
      const col = {
        name: r.COLUMN_NAME, pos: r.ORDINAL_POSITION, type: r.COLUMN_TYPE, dataType: String(r.DATA_TYPE).toLowerCase(), notNull: r.IS_NULLABLE === 'NO',
        default: r.COLUMN_DEFAULT, defaultKind: r.COLUMN_DEFAULT == null ? 'none' : /DEFAULT_GENERATED/i.test(extra) ? 'expr' : 'literal',
        extra, autoIncrement: /auto_increment/i.test(extra), onUpdate: (/on update (\S+(?:\(\d*\))?)/i.exec(extra) || [])[1] || null,
        virtual: !!gen && /VIRTUAL/i.test(gen[1]), invisible: /INVISIBLE/i.test(extra),
        generated: gen && r.GENERATION_EXPRESSION ? { expr: r.GENERATION_EXPRESSION, stored: !/VIRTUAL/i.test(gen[1]) } : null,
        charset: r.CHARACTER_SET_NAME, collation: r.COLLATION_NAME, comment: r.COLUMN_COMMENT || null,
      };
      // MariaDB reports the literal 'NULL' for "DEFAULT NULL" on nullable columns
      if (isMaria && col.default === 'NULL' && !col.notNull) { col.default = null; col.defaultKind = 'none'; }
      tbl.columns.push(col);
    }
    const byIdx = grp(statsBy.get(t.TABLE_NAME) || [], 'INDEX_NAME');
    for (const [name, rows] of byIdx) {
      rows.sort((a, b) => a.SEQ_IN_INDEX - b.SEQ_IN_INDEX);
      const parts = rows.map(r => ({ name: r.COLUMN_NAME, sub: r.SUB_PART == null ? null : Number(r.SUB_PART), desc: r.COLLATION === 'D', expr: r.EXPRESSION || null }));
      const type = rows[0].INDEX_TYPE;
      if (name === 'PRIMARY') { tbl.primaryKey = { name, columns: parts.map(p => p.name) }; continue; }
      tbl.indexes.push({ name, columns: parts.map(p => p.name), parts, unique: Number(rows[0].NON_UNIQUE) === 0, method: type, fulltext: type === 'FULLTEXT', spatial: type === 'SPATIAL', expressions: parts.some(p => p.expr), constraintBacked: false, valid: true });
    }
    for (const [name, rows] of grp(fksBy.get(t.TABLE_NAME) || [], 'CONSTRAINT_NAME')) {
      tbl.foreignKeys.push({
        name, columns: rows.map(r => r.COLUMN_NAME), refSchema: rows[0].REFERENCED_TABLE_SCHEMA, refTable: rows[0].REFERENCED_TABLE_NAME,
        refColumns: rows.map(r => r.REFERENCED_COLUMN_NAME), onDelete: rows[0].DELETE_RULE, onUpdate: rows[0].UPDATE_RULE,
      });
    }
    for (const r of chkBy.get(t.TABLE_NAME) || []) tbl.checks.push({ name: r.CONSTRAINT_NAME, expr: r.CHECK_CLAUSE });
    model.tables.push(tbl);
  }

  for (const t of tables.filter(x => x.TABLE_TYPE !== 'BASE TABLE')) {
    if (t.TABLE_TYPE !== 'VIEW') continue;
    let def = null;
    try { def = (await q('SHOW CREATE VIEW ' + my.qi(db) + '.' + my.qi(t.TABLE_NAME)))[0]['Create View']; } catch (e) { model.warnings.push('SHOW CREATE VIEW failed for ' + t.TABLE_NAME + ': ' + e.message); }
    model.views.push({ schema: db, name: t.TABLE_NAME, fullName: db + '.' + t.TABLE_NAME, kind: 'view', definition: def, deps: [], columns: [], indexes: [] });
  }

  try { model.triggers = await q('SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=?', [db]); } catch (e) { /* ignore */ }
  try { model.functions = (await q('SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS kind FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=?', [db])).map(r => ({ schema: db, name: r.name, kind: r.kind })); } catch (e) { /* ignore */ }
  model.tableList = model.tables.map(t => ({ fullName: t.fullName, schema: t.schema, name: t.name, kind: t.kind, columns: t.columns.length, estRows: t.estRows }));
  return model;
}

module.exports = { introspectMysql };
