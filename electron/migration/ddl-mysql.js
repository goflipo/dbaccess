// MySQL / MariaDB schema diff + DDL generation. New tables are created from SHOW CREATE TABLE (the
// authority), with FOREIGN KEY lines stripped (re-added as separate steps) and AUTO_INCREMENT counter removed.
// Existing tables are diffed through information_schema-derived column/index definitions.

const { my, topoSort } = require('./sql');
const { norm } = require('./util');
const { qi, ql } = my;

const normType = (t) => String(t || '').toLowerCase().replace(/^((?:tiny|small|medium|big)?int)\(\d+\)/, '$1').replace(/\s+/g, ' ').trim();
const sameCols = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const COLL_MAP = [[/_0900_ai_ci$/, '_general_ci'], [/_0900_as_ci$/, '_general_ci'], [/_0900_as_cs$/, '_bin'], [/_0900_bin$/, '_bin']];

function defaultSql(c, srcMaria) {
  if (c.default == null || c.generated) return null;
  const d = String(c.default);
  if (srcMaria) return d;
  if (c.defaultKind === 'expr') return /^current_timestamp(\(\d*\))?$/i.test(d) ? d : `(${d})`;
  if (/^b'[01]+'$/i.test(d)) return d;
  if (/^current_timestamp(\(\d*\))?$/i.test(d) && /timestamp|datetime/.test(c.dataType)) return d;
  return ql(d);
}

async function planMysql(ctx) {
  const { src, tgt, opts, warn, F, sum, selected } = ctx;
  const tgtDb = ctx.tgtDb, srcDb = src.database;
  const T = (name) => my.qn(tgtDb, name);
  const fold = src.lctn === 1 || tgt.lctn === 1 || tgt.lctn === 2;
  const key = (n) => (fold ? String(n).toLowerCase() : n);
  const tgtTables = new Map(tgt.tables.map(t => [key(t.name), t]));
  const tgtViews = new Map(tgt.views.map(x => [key(x.name), x]));
  const selNames = new Set(selected.map(t => key(t.name)));
  const created = new Set();
  const altered = new Set();
  const maria = tgt.isMaria;

  warn('info', 'engine', 'MySQL/MariaDB DDL is not transactional (implicit commit): a failure leaves earlier steps applied. Steps are written to be re-runnable.');
  if (src.isMaria !== tgt.isMaria) warn('warn', 'engine', `Source is ${src.isMaria ? 'MariaDB' : 'MySQL'} and target is ${tgt.isMaria ? 'MariaDB' : 'MySQL'}: syntax and collation differences may cause errors`);
  if (src.lctn !== tgt.lctn) warn('warn', 'lower_case_table_names', `lower_case_table_names differs (source ${src.lctn}, target ${tgt.lctn}); table names are matched case-insensitively`);

  const engines = new Set((await ctx.tgtQuery("SELECT ENGINE AS e FROM information_schema.ENGINES WHERE SUPPORT IN ('YES','DEFAULT')").catch(() => [])).map(r => String(r.e).toUpperCase()));
  const colls = new Set((await ctx.tgtQuery('SELECT COLLATION_NAME AS c FROM information_schema.COLLATIONS').catch(() => [])).map(r => r.c));
  const mapColl = (c) => {
    if (!c || !colls.size || colls.has(c)) return c;
    for (const [re, rep] of COLL_MAP) if (re.test(c)) { const m = c.replace(re, rep); if (colls.has(m)) return m; }
    return c;
  };
  const collWarned = new Set();
  const fixColl = (s, obj) => s.replace(/\b(utf8mb4|utf8mb3|utf8|latin1|ascii)_[A-Za-z0-9_]+\b/g, (m) => {
    const r = mapColl(m);
    if (r !== m) { if (!collWarned.has(m)) { collWarned.add(m); warn('warn', obj, `Collation ${m} does not exist on the target; mapped to ${r}`); } }
    else if (colls.size && !colls.has(m) && !collWarned.has(m)) { collWarned.add(m); warn('warn', obj, `Collation ${m} does not exist on the target server and has no known mapping`); }
    return r;
  });

  function colDef(c, o = {}) {
    let s = qi(c.name) + ' ' + c.type;
    if (c.charset && /char|text|enum|set/.test(c.dataType)) s += ` CHARACTER SET ${c.charset} COLLATE ${mapColl(c.collation)}`;
    if (c.generated) {
      s += ` GENERATED ALWAYS AS (${c.generated.expr}) ${c.generated.stored ? 'STORED' : 'VIRTUAL'}`;
      if (c.notNull && !o.nullable) s += ' NOT NULL';
    } else {
      s += c.notNull && !o.nullable ? ' NOT NULL' : ' NULL';
      const d = defaultSql(c, src.isMaria);
      if (d != null) s += ' DEFAULT ' + d;
      if (c.autoIncrement && !o.noAuto) s += ' AUTO_INCREMENT';
      if (c.onUpdate) s += ' ON UPDATE ' + c.onUpdate;
    }
    if (c.comment) s += ' COMMENT ' + ql(c.comment);
    return s;
  }
  const idxParts = (ix) => '(' + ix.parts.map(p => (p.expr ? `(${p.expr})` : qi(p.name) + (p.sub ? `(${p.sub})` : '')) + (p.desc ? ' DESC' : '')).join(', ') + ')';
  const idxSig = (ix) => `${ix.unique ? 'U' : 'N'}|${ix.method}|${ix.parts.map(p => `${p.name || ''}:${p.sub || ''}:${p.desc ? 'D' : ''}:${p.expr || ''}`).join(',')}`;

  function transformCreate(t) {
    let sql = t.createSql;
    if (!sql) return null;
    sql = sql.replace(/\r\n/g, '\n');
    const lines = sql.split('\n');
    lines[0] = lines[0].replace(/^CREATE TABLE (?:IF NOT EXISTS )?`(?:[^`]|``)*`/, 'CREATE TABLE IF NOT EXISTS ' + T(t.name));
    let endIdx = -1;
    for (let i = lines.length - 1; i > 0; i--) if (/^\)/.test(lines[i])) { endIdx = i; break; }
    if (endIdx < 0) return null;
    const keep = [];
    for (let i = 0; i < lines.length; i++) if (!(i > 0 && i < endIdx && /^\s*CONSTRAINT `(?:[^`]|``)*` FOREIGN KEY/.test(lines[i]))) keep.push(lines[i]);
    const e2 = keep.findIndex((l, i) => i > 0 && /^\)/.test(l));
    if (e2 > 1) keep[e2 - 1] = keep[e2 - 1].replace(/,\s*$/, '');
    keep[e2] = keep[e2].replace(/\s*AUTO_INCREMENT=\d+/, '');
    const em = /ENGINE=(\w+)/i.exec(keep[e2]);
    if (em && engines.size && !engines.has(em[1].toUpperCase())) { keep[e2] = keep[e2].replace(/\s*ENGINE=\w+/i, ''); warn('warn', t.fullName, `Storage engine ${em[1]} is not available on the target; the server default engine is used`); }
    else if (em && !/^innodb$/i.test(em[1])) warn('warn', t.fullName, `Table uses the ${em[1]} engine, which is not transactional: data batches cannot be rolled back`);
    return fixColl(keep.join('\n'), t.fullName);
  }

  // ---------------------------------------------------------------- tables
  const toCreate = selected.filter(t => !tgtTables.has(key(t.name)));
  for (const t of toCreate.sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = transformCreate(t);
    if (!sql) { warn('blocker', t.fullName, `Could not read SHOW CREATE TABLE for ${t.fullName}`); continue; }
    F.add('tables', 'create-table', t.fullName, sql, `Create table ${t.fullName}`);
    created.add(t.fullName); sum.tablesToCreate++;
    sum.constraintsToCreate += (t.primaryKey ? 1 : 0) + t.indexes.filter(i => i.unique).length + t.checks.length;
    sum.indexesToCreate += t.indexes.filter(i => !i.unique).length;
    for (const c of t.columns) if (c.virtual) warn('info', `${t.fullName}.${c.name}`, `Virtual column ${c.name} is recreated but not copied`);
  }

  // ---------------------------------------------------------------- existing tables
  for (const t of selected) {
    const x = tgtTables.get(key(t.name));
    if (!x) continue;
    const Q = T(x.name);
    const changed = () => altered.add(t.fullName);
    const xCols = new Map(x.columns.map(c => [key(c.name), c]));
    let rows = null;
    const hasRows = async () => (rows === null ? (rows = await ctx.tgtHasRows(t)) : rows);
    for (const c of t.columns) {
      const e = xCols.get(key(c.name));
      if (!e) {
        changed(); sum.columnsToAdd++;
        let nullable = false;
        if (c.notNull && c.default == null && !c.autoIncrement && !c.generated && await hasRows()) {
          nullable = true;
          const willFill = opts.includeData && (opts.dataMode === 'truncate-copy' || opts.dataMode === 'upsert');
          const follow = `ALTER TABLE ${Q} MODIFY COLUMN ${colDef(c)}`;
          if (willFill) F.add('constraints', 'set-not-null', t.fullName, follow, `Set ${t.fullName}.${c.name} NOT NULL after the data copy`, { checkNulls: { table: t.fullName, column: c.name } });
          else warn('warn', `${t.fullName}.${c.name}`, `Column ${c.name} is NOT NULL in the source but ${t.fullName} already has rows and no default: added as NULLABLE. Backfill it, then run: ${follow}`);
        }
        F.add('columns', 'add-column', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} ADD COLUMN ${maria ? 'IF NOT EXISTS ' : ''}${colDef(c, { nullable })}`, `Add column ${c.name} to ${t.fullName}`);
        continue;
      }
      if (c.generated || e.generated) {
        if (!!c.generated !== !!e.generated || (c.generated && norm(c.generated.expr) !== norm(e.generated.expr))) warn('warn', `${t.fullName}.${c.name}`, `Generated-column definition of ${t.fullName}.${c.name} differs; left unchanged`);
        continue;
      }
      const diffs = [];
      if (normType(c.type) !== normType(e.type)) diffs.push('type');
      if (c.notNull !== e.notNull) diffs.push('nullability');
      if (norm(defaultSql(c, src.isMaria)) !== norm(defaultSql(e, tgt.isMaria))) diffs.push('default');
      if ((c.onUpdate || '') !== (e.onUpdate || '')) diffs.push('on update');
      if (c.charset && e.charset && (mapColl(c.collation) !== e.collation)) diffs.push('collation');
      const autoDiff = c.autoIncrement !== e.autoIncrement;
      if (autoDiff) diffs.push('auto_increment');
      if (!diffs.length) continue;
      if (diffs.includes('type') && !opts.alterTypes) { warn('warn', `${t.fullName}.${c.name}`, `Type differs (${e.type} vs ${c.type}); alterTypes is off`); continue; }
      if (diffs.includes('type') && /char|text|blob|enum|set|decimal|int|bit/.test(c.dataType + e.dataType) && await hasRows()) {
        const nar = /^(var)?char\((\d+)\)/i.exec(c.type), old = /^(var)?char\((\d+)\)/i.exec(e.type);
        if (nar && old && Number(nar[2]) < Number(old[2])) {
          try {
            const r = await ctx.tgtQuery(`SELECT 1 AS x FROM ${Q} WHERE CHAR_LENGTH(${qi(c.name)}) > ${Number(nar[2])} LIMIT 1`, null, 5000);
            if (r.length) { warn('blocker', `${t.fullName}.${c.name}`, `Cannot narrow ${t.fullName}.${c.name} to ${c.type}: longer values exist`); continue; }
          } catch (er) { /* unverifiable */ }
        }
        warn('warn', `${t.fullName}.${c.name}`, `Column type change ${e.type} -> ${c.type} on a populated table may truncate or fail (depends on sql_mode)`);
      }
      const later = c.autoIncrement && !e.autoIncrement;
      F.add(later ? 'constraints' : 'columns', 'modify-column', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} MODIFY COLUMN ${colDef(c)}`, `Modify column ${t.fullName}.${c.name} (${diffs.join(', ')})`, later ? { preData: true, rank: 5 } : {}); // AUTO_INCREMENT needs the key, so it runs after add-pk/add-unique
      sum.columnsToAlter++; changed();
    }
    const srcNames = new Set(t.columns.map(c => key(c.name)));
    for (const e of x.columns) if (!srcNames.has(key(e.name))) {
      if (opts.allowDrops && opts.dropExtraColumns) { F.add('drops', 'drop-column', `${t.fullName}.${e.name}`, `ALTER TABLE ${Q} DROP COLUMN ${qi(e.name)}`, `Drop column ${t.fullName}.${e.name} (not in source)`, { destructive: true }); sum.columnsToDrop++; changed(); }
      else warn('warn', `${t.fullName}.${e.name}`, `Column ${e.name} exists only in the target table ${t.fullName}; it is not touched${opts.allowDrops ? '' : ' (drops are disabled)'}`);
    }
    if (opts.createConstraints) {
      if (t.primaryKey) {
        if (!x.primaryKey) { F.add('constraints', 'add-pk', t.fullName, `ALTER TABLE ${Q} ADD PRIMARY KEY (${t.primaryKey.columns.map(qi).join(', ')})`, `Add primary key on ${t.fullName}`, { preData: true }); sum.constraintsToCreate++; changed(); }
        else if (!sameCols(t.primaryKey.columns, x.primaryKey.columns)) warn('warn', t.fullName, `Primary key of ${t.fullName} differs; not altered`);
      }
      for (const k of t.checks) {
        if (x.checks.some(y => y.name === k.name || norm(y.expr) === norm(k.expr))) continue;
        F.add('constraints', 'add-check', t.fullName, `ALTER TABLE ${Q} ADD CONSTRAINT ${qi(k.name)} CHECK (${k.expr})`, `Add check constraint ${k.name} on ${t.fullName}`, { preData: true }); sum.constraintsToCreate++; changed();
      }
    }
    for (const ix of t.indexes) {
      const m = x.indexes.find(y => y.name === ix.name) || x.indexes.find(y => idxSig(y) === idxSig(ix));
      if (m) { if (m.name === ix.name && idxSig(m) !== idxSig(ix)) warn('warn', `${t.fullName}.${ix.name}`, `Index ${ix.name} on ${t.fullName} differs; not altered`); continue; }
      if (ix.unique) {
        if (!opts.createConstraints) continue;
        F.add('constraints', 'add-unique', t.fullName, `ALTER TABLE ${Q} ADD UNIQUE KEY ${qi(ix.name)} ${idxParts(ix)}`, `Add unique key ${ix.name} on ${t.fullName}`, { preData: true }); sum.constraintsToCreate++; changed();
      } else if (opts.createIndexes) {
        F.add('indexes', 'create-index', `${t.fullName}.${ix.name}`, `CREATE ${ix.fulltext ? 'FULLTEXT ' : ix.spatial ? 'SPATIAL ' : ''}INDEX ${maria ? 'IF NOT EXISTS ' : ''}${qi(ix.name)} ON ${Q} ${idxParts(ix)}`, `Create index ${ix.name} on ${t.fullName}`); sum.indexesToCreate++; changed();
      }
    }
  }

  // ---------------------------------------------------------------- foreign keys
  if (opts.createConstraints) {
    for (const t of selected) {
      const x = tgtTables.get(key(t.name));
      for (const fk of t.foreignKeys) {
        if (fk.refSchema !== srcDb) { warn('warn', `${t.fullName}.${fk.name}`, `Foreign key ${fk.name} references another schema (${fk.refSchema}); skipped`); continue; }
        if (!selNames.has(key(fk.refTable)) && !tgtTables.has(key(fk.refTable))) { warn('warn', `${t.fullName}.${fk.name}`, `Foreign key ${fk.name} on ${t.fullName} references ${fk.refTable}, which is neither selected nor present in the target; skipped`); continue; }
        if (x && x.foreignKeys.some(y => y.name === fk.name || (sameCols(y.columns, fk.columns) && key(y.refTable) === key(fk.refTable) && sameCols(y.refColumns, fk.refColumns) && y.onDelete === fk.onDelete && y.onUpdate === fk.onUpdate))) continue;
        const sql = `ALTER TABLE ${T(t.name)} ADD CONSTRAINT ${qi(fk.name)} FOREIGN KEY (${fk.columns.map(qi).join(', ')}) REFERENCES ${T(fk.refTable)} (${fk.refColumns.map(qi).join(', ')}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`;
        F.add('constraints', 'add-fk', t.fullName, sql, `Add foreign key ${fk.name} on ${t.fullName} -> ${fk.refTable}`);
        sum.constraintsToCreate++; if (x) altered.add(t.fullName);
      }
    }
  }

  // ---------------------------------------------------------------- views
  if (opts.createViews) {
    const strip = (d) => String(d || '').replace(/^CREATE\s+(?:OR REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*(?:`(?:[^`]|``)*`@`(?:[^`]|``)*`|\S+)\s+)?(?:SQL SECURITY\s+\w+\s+)?VIEW\s+(?:`(?:[^`]|``)*`\.)?`(?:[^`]|``)*`/i, 'CREATE VIEW');
    const body = (d, db) => norm(strip(d).split('`' + db + '`.').join('')).toLowerCase();
    // Views are only created when everything they read (tables or other views) will exist in the target.
    // SHOW CREATE VIEW omits the schema for same-schema objects, so scan every backquoted identifier: a token counts as a table/view reference when it names a source table/view and is not a column (preceded by '.' unless the qualifier is the source schema)
    const objNames = new Set([...src.tables, ...src.views].map(o => key(o.name)));
    const refsOf = (v) => { const out = new Set(); const re = /`((?:[^`]|``)+)`/g; const def = String(v.definition); let m, prev = null, prevEnd = -1; while ((m = re.exec(def))) { const name = m[1].replace(/``/g, '`'); const dotBefore = prevEnd >= 0 && def.slice(prevEnd, m.index) === '.'; if ((!dotBefore || prev === srcDb) && objNames.has(key(name))) out.add(key(name)); prev = name; prevEnd = m.index + m[0].length; } return out; };
    let vs = src.views.filter(v => v.definition);
    if (opts.tables) {
      let again = true;
      while (again) {
        again = false;
        const viewNames = new Set(vs.map(v => key(v.name)));
        const next = [];
        for (const v of vs) {
          const missing = [...refsOf(v)].filter(r => r !== key(v.name) && !(selNames.has(r) || tgtTables.has(r) || tgtViews.has(r) || viewNames.has(r)));
          if (missing.length) { warn('warn', v.fullName, `View ${v.fullName} reads object(s) that are neither selected nor present in the target (${missing.join(', ')}); skipped`); again = true; } else next.push(v);
        }
        vs = next;
      }
    }
    const names = vs.map(v => v.name);
    const edges = [];
    for (const v of vs) for (const o of vs) if (o !== v && String(v.definition).includes('`' + o.name + '`')) edges.push([o.name, v.name]);
    const { order } = topoSort(names, edges);
    for (const n of order) {
      const v = vs.find(z => z.name === n);
      const ex = tgtViews.get(key(v.name));
      let sql = String(v.definition).replace(/^CREATE\s+(?:OR REPLACE\s+)?(?:ALGORITHM\s*=\s*\w+\s+)?(?:DEFINER\s*=\s*(?:`(?:[^`]|``)*`@`(?:[^`]|``)*`|\S+)\s+)?(?:SQL SECURITY\s+\w+\s+)?VIEW\s+(?:`(?:[^`]|``)*`\.)?`(?:[^`]|``)*`/i, 'CREATE OR REPLACE VIEW ' + T(v.name));
      if (srcDb !== tgtDb) sql = sql.split('`' + srcDb + '`.').join('`' + tgtDb + '`.');
      sql = fixColl(sql, v.fullName);
      if (!ex) { F.add('views', 'create-view', v.fullName, sql, `Create view ${v.fullName}`); sum.viewsToCreate++; }
      else if (body(ex.definition, tgtDb) !== body(v.definition, srcDb)) { F.add('views', 'replace-view', v.fullName, sql, `Replace definition of view ${v.fullName}`); sum.viewsToCreate++; warn('warn', v.fullName, `View ${v.fullName} differs from the source and is replaced`); }
    }
  }

  // ---------------------------------------------------------------- extras
  if (!opts.tables) {
    for (const x of tgt.tables) if (!src.tables.some(t => key(t.name) === key(x.name))) {
      if (opts.allowDrops && opts.dropExtraTables) { F.add('drops', 'drop-table', x.fullName, `DROP TABLE IF EXISTS ${T(x.name)}`, `Drop table ${x.name} (not in source)`, { destructive: true }); sum.tablesToDrop++; }
      else { warn('warn', x.fullName, `Table ${x.name} exists only in the target; it is not touched${opts.allowDrops ? '' : ' (drops are disabled)'}`); if (!opts.allowDrops) ctx.skippedDrops.push(`DROP TABLE IF EXISTS ${T(x.name)}`); }
    }
  }
  if (src.triggers && src.triggers.length) warn('warn', 'triggers', `${src.triggers.length} trigger(s) in the source are NOT migrated`);
  if (src.functions && src.functions.length) warn('warn', 'routines', `${src.functions.length} stored routine(s) in the source are NOT migrated`);
  warn('info', 'scope', 'Users, GRANTs, events and DEFINER settings are not migrated; views are created with the connecting user as definer');
  sum.tablesToAlter = [...altered].filter(n => !created.has(n)).length;
  return { created };
}

module.exports = { planMysql, normType };
