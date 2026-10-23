// PostgreSQL schema diff + DDL generation (source model vs target model -> ordered steps).
// All SQL text is produced from catalog data through qi/ql; plain statements only (one per step).

const { pg, topoSort } = require('./sql');
const { norm } = require('./util');
const { qi, ql, qn } = pg;

const num = (v) => { const s = String(v); if (!/^-?\d+$/.test(s)) throw new Error('Unexpected numeric value from catalog: ' + s); return s; };
const seqOpts = (s) => `START WITH ${num(s.start)} INCREMENT BY ${num(s.incr != null ? s.incr : s.increment)} MINVALUE ${num(s.min)} MAXVALUE ${num(s.max)} CACHE ${num(s.cache)} ${s.cycle ? '' : 'NO '}CYCLE`;
const idxHead = (d) => String(d).replace(/^CREATE (UNIQUE )?INDEX (CONCURRENTLY )?/, 'CREATE $1INDEX IF NOT EXISTS ').replace(/ ON ONLY /, ' ON ');
const idxShape = (d) => String(d).replace(/^CREATE (UNIQUE )?INDEX (?:"(?:[^"]|"")*"|\S+) ON( ONLY)?/, 'CREATE $1INDEX ON').replace(/\s+/g, ' ');
const sameCols = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- type-change classification --------------------------------------------------------------
function fam(t) {
  t = String(t);
  if (/\[\]$/.test(t)) return 'array';
  const b = t.replace(/\(.*?\)/, '');
  if (/^(smallint|integer|bigint)$/.test(b)) return 'int';
  if (/^numeric$/.test(b)) return 'numeric';
  if (/^(real|double precision)$/.test(b)) return 'float';
  if (/^(text|character varying|character|"char"|name|citext|public\.citext)$/.test(b)) return 'text';
  if (b === 'boolean') return 'bool';
  if (/^timestamp without time zone$/.test(b)) return 'ts';
  if (/^timestamp with time zone$/.test(b)) return 'tstz';
  if (b === 'date') return 'date';
  if (/^time( with(out)? time zone)?$/.test(b)) return 'time';
  if (b === 'interval') return 'interval';
  if (b === 'uuid') return 'uuid';
  if (b === 'json') return 'json';
  if (b === 'jsonb') return 'jsonb';
  if (b === 'bytea') return 'bytea';
  if (/[."]/.test(b)) return 'user';
  return 'other';
}
const INT_RANGE = { smallint: [-32768n, 32767n], integer: [-2147483648n, 2147483647n], bigint: [-9223372036854775808n, 9223372036854775807n] };

/** How to change a column from tgtType (old) to srcType (new). */
function classifyTypeChange(srcT, tgtT, colSql) {
  const fs = fam(srcT), ft = fam(tgtT);
  const r = { using: `${colSql}::${srcT}`, risk: 'ok', msg: null, checks: [] };
  const bad = (m) => { r.risk = 'blocker'; r.msg = m; return r; };
  const warn = (m) => { if (r.risk === 'ok') { r.risk = 'warn'; r.msg = m; } return r; };
  if (fs === 'array' || ft === 'array') {
    if (fs !== ft) return bad(`no safe cast between array type ${tgtT} and scalar type ${srcT}`);
    return warn('array element cast may fail at runtime');
  }
  if (fs === 'user' || ft === 'user') {
    r.using = `${colSql}::text::${srcT}`;
    if (fs === 'user' && ft !== 'text' && ft !== 'user') return bad(`no cast from ${tgtT} to ${srcT}`);
    if (fs !== 'user' && fs !== 'text') return bad(`no cast from ${tgtT} to ${srcT}`);
    if (fs !== 'user') r.using = `${colSql}::text`;
    return warn('conversion involving a user-defined type may fail for values that do not map');
  }
  const lenS = /\((\d+)\)/.exec(srcT), lenT = /\((\d+)\)/.exec(tgtT);
  if (fs === 'text' && ft === 'text') {
    if (lenS && (!lenT || Number(lenS[1]) < Number(lenT[1]))) { r.checks.push({ sql: (t) => `SELECT 1 FROM ${t} WHERE length(${colSql}) > ${num(lenS[1])} LIMIT 1`, msg: `rows longer than ${lenS[1]} characters exist` }); warn(`narrowing to ${srcT} fails if longer values exist`); }
    return r;
  }
  if (fs === 'int' && ft === 'int') {
    const sb = INT_RANGE[srcT.replace(/\(.*/, '')], tb = INT_RANGE[tgtT.replace(/\(.*/, '')];
    if (sb && tb && sb[1] < tb[1]) { r.checks.push({ sql: (t) => `SELECT 1 FROM ${t} WHERE ${colSql} > ${sb[1]} OR ${colSql} < ${sb[0]} LIMIT 1`, msg: `values outside the range of ${srcT} exist` }); warn(`narrowing ${tgtT} -> ${srcT}`); }
    return r;
  }
  if (fs === 'numeric' && (ft === 'numeric' || ft === 'int' || ft === 'float')) {
    const m = /\((\d+),\s*(\d+)\)/.exec(srcT);
    if (m) { const lim = `1${'0'.repeat(Math.max(0, Number(m[1]) - Number(m[2])))}`; r.checks.push({ sql: (t) => `SELECT 1 FROM ${t} WHERE abs(${colSql}) >= ${lim}::numeric LIMIT 1`, msg: `values exceed numeric(${m[1]},${m[2]}) precision` }); warn('numeric precision/scale change may round or overflow values'); }
    return r;
  }
  if (fs === 'text' && ft !== 'text') { r.using = `${colSql}::text`; return r; }
  if (['int', 'numeric', 'float', 'bool', 'date', 'ts', 'tstz', 'time', 'interval', 'uuid', 'json', 'jsonb'].includes(ft) && fs === 'text') {
    r.checks.push({ sql: (t) => `SELECT 1 FROM ${t} WHERE ${colSql} IS NOT NULL AND NOT pg_input_is_valid(${colSql}::text, ${ql(srcT)}) LIMIT 1`, msg: `values that cannot be cast to ${srcT} exist`, minVersion: 160000 });
    return warn(`text -> ${srcT} cast may fail at runtime`);
  }
  if (ft === 'ts' && fs === 'tstz') { r.using = `${colSql} AT TIME ZONE 'UTC'`; return r; }
  if (ft === 'tstz' && fs === 'ts') { r.using = `${colSql} AT TIME ZONE 'UTC'`; return r; }
  if ((ft === 'ts' || ft === 'tstz') && fs === 'date') return warn('time part is truncated');
  if ((ft === 'json' && fs === 'jsonb') || (ft === 'jsonb' && fs === 'json')) { r.risk = 'info'; r.msg = 'json <-> jsonb conversion (key order / duplicate keys may change)'; return r; }
  if (ft === 'bool' && fs === 'int') { r.using = `${colSql}::int::${srcT}`; return r; }
  if (ft === 'int' && fs === 'bool') { r.using = `${colSql} <> 0`; return warn('integer -> boolean: non-zero becomes true'); }
  if (ft === 'bytea' && fs === 'text') { r.using = `convert_from(${colSql}, 'UTF8')`; return warn('bytea -> text assumes UTF8 content'); }
  if (fs === 'bytea' && ft === 'text') { r.using = `convert_to(${colSql}, 'UTF8')`; return r; }
  if (ft === 'float' && fs === 'int') return warn('floating-point values are rounded');
  if (fs === 'bool') return warn('conversion to boolean may fail');
  if (['bytea', 'uuid', 'json', 'jsonb'].includes(ft) || ['bytea', 'uuid', 'json', 'jsonb'].includes(fs)) {
    if (fs !== ft) return bad(`no cast from ${tgtT} to ${srcT}`);
  }
  if (fs !== ft) warn(`cast from ${tgtT} to ${srcT} may fail at runtime`);
  return r;
}

// ---- main ------------------------------------------------------------------------------------
async function planPg(ctx) {
  const { src, tgt, opts, warn, F, sum, tgtKey } = ctx;
  const { selected } = ctx;
  const v = tgt.versionNum;
  const tgtTables = new Map(tgt.tables.map(t => [t.fullName, t]));
  const tgtSeqs = new Map(tgt.sequences.map(s => [s.fullName, s]));
  const tgtTypes = new Map(tgt.types.map(t => [t.schema + '.' + t.name, t]));
  const tgtViews = new Map(tgt.views.map(x => [x.fullName, x]));
  const selSet = new Set(selected.map(t => t.fullName));
  const created = new Set();          // source fullNames of tables created in this run
  const preDataKinds = new Set();
  const tablesAltered = new Set();
  const addPreInfo = [];

  // ------------------------------------------------------------ schemas needed
  const neededSchemas = new Set(selected.map(t => t.schema));
  // ------------------------------------------------------------ types (closure over selected columns)
  const typeByOid = new Map(src.types.map(t => [String(t.oid), t]));
  const need = new Set();
  const walk = (oid) => {
    const key = String(oid); if (need.has(key) || !typeByOid.has(key)) return;
    need.add(key); for (const r of typeByOid.get(key).refs || []) walk(r);
  };
  for (const t of selected) for (const c of t.columns) if (c.userType) walk(c.baseTypeOid);
  const typeList = src.types.filter(t => need.has(String(t.oid)));
  const { order: typeOrder } = topoSort(typeList.map(t => String(t.oid)), typeList.flatMap(t => (t.refs || []).map(r => [String(r), String(t.oid)])));
  const missingSchemaTypes = new Set();
  for (const key of typeOrder) {
    const t = typeByOid.get(key); const full = t.schema + '.' + t.name;
    neededSchemas.add(t.schema);
    const ex = tgtTypes.get(full);
    if (!ex) {
      let sql;
      if (t.kind === 'enum') sql = `CREATE TYPE ${qn(t.schema, t.name)} AS ENUM (${t.labels.map(ql).join(', ')})`;
      else if (t.kind === 'domain') sql = `CREATE DOMAIN ${qn(t.schema, t.name)} AS ${t.baseType}${t.default != null ? ' DEFAULT ' + t.default : ''}${t.notNull ? ' NOT NULL' : ''}${(t.checks || []).map(c => ` CONSTRAINT ${qi(c.name)} ${c.def}`).join('')}`;
      else if (t.kind === 'composite') sql = `CREATE TYPE ${qn(t.schema, t.name)} AS (${t.attrs.map(a => qi(a.name) + ' ' + a.type).join(', ')})`;
      else sql = `CREATE TYPE ${qn(t.schema, t.name)} AS RANGE (SUBTYPE = ${t.subtype})`;
      F.add('types', 'create-type', full, sql, `Create ${t.kind} type ${full}`);
      sum.enumsToCreate++; missingSchemaTypes.add(full);
    } else if (t.kind === 'enum' && ex.kind === 'enum') {
      const have = new Set(ex.labels);
      t.labels.forEach((l, i) => {
        if (have.has(l)) return;
        const pos = i > 0 ? ` AFTER ${ql(t.labels[i - 1])}` : (t.labels[1] ? ` BEFORE ${ql(t.labels[1])}` : '');
        F.add('types', 'add-enum-value', full, `ALTER TYPE ${qn(t.schema, t.name)} ADD VALUE IF NOT EXISTS ${ql(l)}${pos}`, `Add label ${l} to enum ${full}`, { autocommit: true });
      });
      const extra = ex.labels.filter(l => !t.labels.includes(l));
      if (extra.length) warn('warn', full, `Enum ${full} has labels only in the target (${extra.join(', ')}); PostgreSQL cannot drop enum values`);
    } else if (ex.kind !== t.kind) warn('warn', full, `Type ${full} exists in the target as a ${ex.kind} but is a ${t.kind} in the source`);
    else if (t.kind === 'domain' && (norm(ex.baseType) !== norm(t.baseType))) warn('warn', full, `Domain ${full} differs from the source (base type ${ex.baseType} vs ${t.baseType}); not altered`);
  }

  // ------------------------------------------------------------ sequences used by selected tables
  const seqList = new Map();
  const addSeq = (s) => { if (s && !s.identityOwned && !seqList.has(s.fullName)) seqList.set(s.fullName, s); };
  const srcSeqs = new Map(src.sequences.map(s => [s.fullName, s]));
  for (const t of selected) {
    for (const c of t.columns) if (c.defaultSeq) addSeq(srcSeqs.get(c.defaultSeq.schema + '.' + c.defaultSeq.name));
  }
  for (const s of src.sequences) if (s.ownedBy && !s.identityOwned && selSet.has(s.ownedBy.schema + '.' + s.ownedBy.table)) addSeq(s);
  for (const s of seqList.values()) {
    neededSchemas.add(s.schema);
    if (tgtSeqs.has(s.fullName)) continue;
    F.add('sequences', 'create-sequence', s.fullName, `CREATE SEQUENCE IF NOT EXISTS ${qn(s.schema, s.name)} AS ${s.dataType} ${seqOpts(s)}`, `Create sequence ${s.fullName}`);
    sum.sequencesToCreate++;
  }

  // ------------------------------------------------------------ extensions
  const tgtExt = new Set(tgt.extensions.map(e => e.name));
  const missingExt = src.extensions.filter(e => !tgtExt.has(e.name));
  if (missingExt.length) {
    const avail = new Set((await ctx.tgtQuery('SELECT name FROM pg_available_extensions WHERE name = ANY($1::text[])', [missingExt.map(e => e.name)])).map(r => r.name));
    for (const e of missingExt) {
      const used = selected.some(t => t.columns.some(c => (c.typeSchema && c.typeSchema !== 'pg_catalog' && c.type.includes(e.name)) || (c.default && c.default.includes(e.name.replace(/-/g, '_')))))
        || selected.some(t => t.columns.some(c => c.default && /uuid_generate_v/.test(c.default)) && e.name === 'uuid-ossp');
      if (!avail.has(e.name)) { warn(used ? 'blocker' : 'warn', e.name, `Extension ${e.name} (used in the source) is not available on the target server${used ? ' and objects selected for migration depend on it' : ''}`); continue; }
      neededSchemas.add(e.schema);
      F.add('types', 'create-extension', e.name, `CREATE EXTENSION IF NOT EXISTS ${qi(e.name)} WITH SCHEMA ${qi(e.schema)}`, `Create extension ${e.name}`, { optional: true, first: 2 });
    }
  }

  // ------------------------------------------------------------ schemas
  for (const s of neededSchemas) if (!tgt.schemas.includes(s)) F.add('types', 'create-schema', s, `CREATE SCHEMA IF NOT EXISTS ${qi(s)}`, `Create schema ${s}`, { first: 1 });
  // (schema steps are inserted before types by ordering below)

  // ------------------------------------------------------------ types available on target for builtin/extension columns
  const probe = [...new Set(selected.flatMap(t => t.columns.filter(c => !c.userType && c.typeSchema !== 'pg_catalog').map(c => c.type)))];
  if (probe.length) {
    const rows = await ctx.tgtQuery('SELECT t, to_regtype(t) IS NOT NULL AS ok FROM unnest($1::text[]) AS t', [probe]);
    const willExt = missingExt.length > 0;
    for (const r of rows) if (!r.ok) warn(willExt ? 'warn' : 'blocker', r.t, `Column type ${r.t} is not available on the target server${willExt ? ' (an extension is being created; verify it provides this type)' : ''}`);
  }

  // ------------------------------------------------------------ tables
  const srcFnSet = new Set(src.functions.map(f => f.schema + '.' + f.name));
  const tgtFnSet = new Set(tgt.functions.map(f => f.schema + '.' + f.name));
  const deferredDefault = (c) => {
    if (!c.default) return false;
    const m = [...String(c.default).matchAll(/\b([a-z_][\w$]*)\.([a-z_][\w$]*)\s*\(/gi)];
    return m.some(x => srcFnSet.has(x[1] + '.' + x[2]) && !tgtFnSet.has(x[1] + '.' + x[2]));
  };
  const colDef = (t, c, o = {}) => {
    let s = qi(c.name) + ' ' + c.type;
    if (c.collation) s += ' COLLATE ' + qn(c.collation.schema, c.collation.name);
    if (c.generated) s += ` GENERATED ALWAYS AS (${c.generated.expr}) STORED`;
    else if (c.identity) {
      const sq = c.identitySeq;
      let inner = '';
      if (sq) { const std = `${t.name}_${c.name}_seq`; inner = ` (${sq.name !== std ? `SEQUENCE NAME ${qn(t.schema, sq.name)} ` : ''}${seqOpts(sq)})`; }
      s += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY${inner}`;
    } else if (c.default != null && !o.noDefault) s += ' DEFAULT ' + c.default;
    if (c.notNull && !o.nullable) s += ' NOT NULL';
    return s;
  };
  const conLine = (name, def) => `CONSTRAINT ${qi(name)} ${def}`;

  // creation order: partition parents / inheritance parents first
  const toCreate = selected.filter(t => !tgtTables.has(t.fullName));
  const cNames = toCreate.map(t => t.fullName);
  const { order: cOrder } = topoSort(cNames, toCreate.flatMap(t => [t.partitionOf && t.partitionOf.parent, ...(t.inherits || [])].filter(Boolean).map(p => [p, t.fullName])));
  const byFull = new Map(selected.map(t => [t.fullName, t]));
  const postSteps = [];

  for (const fn of cOrder) {
    const t = byFull.get(fn);
    created.add(fn); sum.tablesToCreate++;
    const isChild = t.partitionOf && t.partitionOf.parent;
    const parts = [];
    let sql;
    const deferred = [];
    if (isChild) {
      const [ps, ...pn] = t.partitionOf.parent.split('.');
      sql = `CREATE TABLE IF NOT EXISTS ${qn(t.schema, t.name)} PARTITION OF ${qn(ps, pn.join('.'))} ${t.partitionOf.bound}`;
      if (t.partitionKey) sql += ` PARTITION BY ${t.partitionKey}`;
    } else {
      for (const c of t.columns) {
        const d = deferredDefault(c);
        if (d) deferred.push(c);
        parts.push(colDef(t, c, { noDefault: d }));
      }
      if (t.primaryKey) parts.push(conLine(t.primaryKey.name, t.primaryKey.def));
      if (opts.createConstraints) {
        for (const u of t.uniques) parts.push(conLine(u.name, u.def));
        for (const k of t.checks) if (k.validated !== false) parts.push(conLine(k.name, k.expr));
        for (const x of t.exclusions) parts.push(conLine(x.name, x.def));
      }
      sql = `CREATE ${t.unlogged ? 'UNLOGGED ' : ''}TABLE IF NOT EXISTS ${qn(t.schema, t.name)} (\n  ${parts.join(',\n  ')}\n)`;
      if (t.partitionKey) sql += ` PARTITION BY ${t.partitionKey}`;
      if (t.inherits && t.inherits.length) {
        sql += ` INHERITS (${t.inherits.map(p => { const [ps, ...pn] = p.split('.'); return qn(ps, pn.join('.')); }).join(', ')})`;
        warn('warn', t.fullName, `Table ${t.fullName} uses classic inheritance; its rows are copied with SELECT ... FROM ONLY`);
      }
    }
    F.add('tables', 'create-table', t.fullName, sql, `Create table ${t.fullName}`);
    if (!isChild) for (const c of deferred) {
      F.add('constraints', 'set-default', t.fullName, `ALTER TABLE ${qn(t.schema, t.name)} ALTER COLUMN ${qi(c.name)} SET DEFAULT ${c.default}`, `Set default of ${t.fullName}.${c.name} (references a function that is created later)`);
      warn('warn', `${t.fullName}.${c.name}`, `Default of ${t.fullName}.${c.name} references a function missing in the target (functions are not migrated); the default is applied last and may fail`);
    }
    if (!isChild && opts.createConstraints) {
      for (const k of t.checks) if (k.validated === false) F.add('constraints', 'add-check', t.fullName, `ALTER TABLE ${qn(t.schema, t.name)} ADD CONSTRAINT ${qi(k.name)} ${k.expr}`, `Add NOT VALID check ${k.name} on ${t.fullName}`);
    }
    if (t.comment) F.add('constraints', 'comment', t.fullName, `COMMENT ON TABLE ${qn(t.schema, t.name)} IS ${ql(t.comment)}`, `Comment on table ${t.fullName}`);
    for (const c of t.columns) if (c.comment && !isChild) F.add('constraints', 'comment', t.fullName, `COMMENT ON COLUMN ${qn(t.schema, t.name)}.${qi(c.name)} IS ${ql(c.comment)}`, `Comment on column ${t.fullName}.${c.name}`);
    sum.constraintsToCreate += (t.primaryKey ? 1 : 0) + (opts.createConstraints ? t.uniques.length + t.checks.length + t.exclusions.length : 0);
  }

  // existing tables: column / constraint diff
  for (const t of selected) {
    const x = tgtTables.get(t.fullName);
    if (!x) continue;
    const Q = qn(t.schema, t.name);
    const changed = () => tablesAltered.add(t.fullName);
    if (t.partitionOf && t.partitionOf.parent) continue; // inherited definition
    const xCols = new Map(x.columns.map(c => [c.name, c]));
    let rows = null;
    const hasRows = async () => (rows === null ? (rows = await ctx.tgtHasRows(t)) : rows);
    for (const c of t.columns) {
      const e = xCols.get(c.name);
      if (!e) {
        changed(); sum.columnsToAdd++;
        let nullable = false;
        if (c.notNull && c.default == null && !c.identity && !c.generated && await hasRows()) {
          nullable = true;
          const willFill = opts.includeData && (opts.dataMode === 'truncate-copy' || opts.dataMode === 'upsert');
          const follow = `ALTER TABLE ${Q} ALTER COLUMN ${qi(c.name)} SET NOT NULL`;
          if (willFill) F.add('constraints', 'set-not-null', t.fullName, follow, `Set ${t.fullName}.${c.name} NOT NULL after the data copy`, { checkNulls: { table: t.fullName, column: c.name } });
          else warn('warn', `${t.fullName}.${c.name}`, `Column ${c.name} is NOT NULL in the source but ${t.fullName} already has rows and no default: added as NULLABLE. Backfill it, then run: ${follow}`);
          if (!willFill) addPreInfo.push([t.fullName, c.name, follow]);
        }
        const d = deferredDefault(c);
        const s = F.add('columns', 'add-column', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} ADD COLUMN IF NOT EXISTS ${colDef(t, c, { nullable, noDefault: d })}`, `Add column ${c.name} to ${t.fullName}`);
        if (nullable && !(opts.includeData && (opts.dataMode === 'truncate-copy' || opts.dataMode === 'upsert'))) s.commentedFollowUp = `ALTER TABLE ${Q} ALTER COLUMN ${qi(c.name)} SET NOT NULL;  (after backfilling)`;
        if (d) F.add('constraints', 'set-default', t.fullName, `ALTER TABLE ${Q} ALTER COLUMN ${qi(c.name)} SET DEFAULT ${c.default}`, `Set default of ${t.fullName}.${c.name}`);
        if (c.comment) F.add('constraints', 'comment', t.fullName, `COMMENT ON COLUMN ${Q}.${qi(c.name)} IS ${ql(c.comment)}`, `Comment on column ${t.fullName}.${c.name}`);
        continue;
      }
      // ---- existing column: compare
      const cq = qi(c.name);
      const typeDiff = norm(c.type) !== norm(e.type);
      const collDiff = JSON.stringify(c.collation || null) !== JSON.stringify(e.collation || null);
      const idChange = (c.identity || null) !== (e.identity || null);
      let didSomething = false;
      if (c.generated || e.generated) {
        if (!!c.generated !== !!e.generated || (c.generated && norm(c.generated.expr) !== norm(e.generated.expr))) warn('warn', `${t.fullName}.${c.name}`, `Generated-column definition of ${t.fullName}.${c.name} differs; PostgreSQL cannot alter it safely, left unchanged`);
        continue;
      }
      if (idChange) {
        didSomething = true;
        if (!c.identity) F.add('columns', 'drop-identity', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} ALTER COLUMN ${cq} DROP IDENTITY IF EXISTS`, `Drop identity from ${t.fullName}.${c.name}`);
        else if (!e.identity) {
          if (e.default != null) F.add('columns', 'drop-default', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} ALTER COLUMN ${cq} DROP DEFAULT`, `Drop default of ${t.fullName}.${c.name} (becomes identity)`);
          if (!e.notNull) F.add('columns', 'set-not-null', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} ALTER COLUMN ${cq} SET NOT NULL`, `Identity requires NOT NULL on ${t.fullName}.${c.name}`);
          const inner = c.identitySeq ? ` (${seqOpts(c.identitySeq)})` : '';
          F.add('columns', 'add-identity', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} ALTER COLUMN ${cq} ADD GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY${inner}`, `Make ${t.fullName}.${c.name} an identity column`);
        } else F.add('columns', 'set-identity', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} ALTER COLUMN ${cq} SET GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'}`, `Change identity mode of ${t.fullName}.${c.name}`);
        sum.columnsToAlter++;
      }
      if ((typeDiff || collDiff) && opts.alterTypes) {
        const cls = typeDiff ? classifyTypeChange(c.type, e.type, cq) : { using: `${cq}::${c.type}`, risk: 'ok', checks: [] };
        if (cls.risk === 'blocker') warn('blocker', `${t.fullName}.${c.name}`, `Cannot change ${t.fullName}.${c.name} from ${e.type} to ${c.type}: ${cls.msg}`);
        else {
          let blocked = false;
          if (cls.checks.length && await hasRows()) {
            for (const ch of cls.checks) {
              if (ch.minVersion && v < ch.minVersion) continue;
              try {
                const r = await ctx.tgtQuery(ch.sql(Q), null, 5000);
                if (r.length) { warn('blocker', `${t.fullName}.${c.name}`, `Cannot change ${t.fullName}.${c.name} from ${e.type} to ${c.type}: ${ch.msg}`); blocked = true; }
              } catch (err) { warn('warn', `${t.fullName}.${c.name}`, `Could not pre-verify the type change of ${t.fullName}.${c.name} (${err.message})`); }
            }
          }
          if (!blocked) {
            const hasDef = e.default != null;
            const parts = [];
            if (hasDef) parts.push(`ALTER COLUMN ${cq} DROP DEFAULT`);
            parts.push(`ALTER COLUMN ${cq} TYPE ${c.type}${c.collation ? ' COLLATE ' + qn(c.collation.schema, c.collation.name) : ''} USING ${cls.using}`);
            if (c.default != null && !c.identity) parts.push(`ALTER COLUMN ${cq} SET DEFAULT ${c.default}`);
            const s = F.add('columns', 'alter-type', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} ${parts.join(', ')}`, `Change type of ${t.fullName}.${c.name}: ${e.type} -> ${c.type}`, { destructive: false });
            if (cls.risk !== 'ok') warn(cls.risk === 'info' ? 'info' : 'warn', `${t.fullName}.${c.name}`, `Type change ${e.type} -> ${c.type}: ${cls.msg}`);
            if (cls.risk === 'warn') s.risky = true;
            didSomething = true; sum.columnsToAlter++;
            e.default = c.default; // defaults are handled by the statement above
          }
        }
      } else if (typeDiff && !opts.alterTypes) warn('warn', `${t.fullName}.${c.name}`, `Type differs (${e.type} vs ${c.type}); alterTypes is off`);
      if (!c.identity && !e.identity && norm(c.default) !== norm(e.default)) {
        didSomething = true; sum.columnsToAlter++;
        if (c.default == null) F.add('columns', 'drop-default', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} ALTER COLUMN ${cq} DROP DEFAULT`, `Drop default of ${t.fullName}.${c.name}`);
        else F.add('columns', 'set-default', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} ALTER COLUMN ${cq} SET DEFAULT ${c.default}`, `Set default of ${t.fullName}.${c.name}`);
      }
      if (c.notNull !== e.notNull && !(c.identity || e.identity)) {
        didSomething = true; sum.columnsToAlter++;
        if (c.notNull) F.add('constraints', 'set-not-null', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} ALTER COLUMN ${cq} SET NOT NULL`, `Set ${t.fullName}.${c.name} NOT NULL`, { checkNulls: { table: t.fullName, column: c.name } });
        else F.add('columns', 'drop-not-null', `${t.fullName}.${c.name}`, `ALTER TABLE ${Q} ALTER COLUMN ${cq} DROP NOT NULL`, `Drop NOT NULL of ${t.fullName}.${c.name}`);
      }
      if (didSomething) changed();
    }
    const srcColNames = new Set(t.columns.map(c => c.name));
    for (const e of x.columns) if (!srcColNames.has(e.name)) {
      if (opts.allowDrops && opts.dropExtraColumns) {
        F.add('drops', 'drop-column', `${t.fullName}.${e.name}`, `ALTER TABLE ${Q} DROP COLUMN IF EXISTS ${qi(e.name)}`, `Drop column ${t.fullName}.${e.name} (not in source)`, { destructive: true });
        sum.columnsToDrop++; changed();
      } else warn('warn', `${t.fullName}.${e.name}`, `Column ${e.name} exists only in the target table ${t.fullName}; it is not touched${opts.allowDrops ? '' : ' (drops are disabled)'}`);
    }

    // constraints on existing tables
    if (opts.createConstraints) {
      if (t.primaryKey) {
        if (!x.primaryKey) { F.add('constraints', 'add-pk', t.fullName, `ALTER TABLE ${Q} ADD CONSTRAINT ${qi(t.primaryKey.name)} ${t.primaryKey.def}`, `Add primary key on ${t.fullName}`, { preData: true }); sum.constraintsToCreate++; changed(); }
        else if (!sameCols(t.primaryKey.columns, x.primaryKey.columns)) warn('warn', t.fullName, `Primary key of ${t.fullName} differs (${x.primaryKey.columns.join(',')} vs ${t.primaryKey.columns.join(',')}); not altered`);
      }
      for (const u of t.uniques) {
        const m = x.uniques.find(y => y.name === u.name) || x.uniques.find(y => sameCols(y.columns, u.columns) && !!y.nullsNotDistinct === !!u.nullsNotDistinct);
        if (m) { if (m.name === u.name && !sameCols(m.columns, u.columns)) warn('warn', `${t.fullName}.${u.name}`, `Unique constraint ${u.name} differs on ${t.fullName}; not altered`); continue; }
        if (x.primaryKey && sameCols(x.primaryKey.columns, u.columns)) continue;
        F.add('constraints', 'add-unique', t.fullName, `ALTER TABLE ${Q} ADD CONSTRAINT ${qi(u.name)} ${u.def}`, `Add unique constraint ${u.name} on ${t.fullName}`, { preData: true }); sum.constraintsToCreate++; changed();
      }
      for (const k of t.checks) {
        const m = x.checks.find(y => y.name === k.name);
        if (m) { if (norm(m.expr) !== norm(k.expr)) warn('warn', `${t.fullName}.${k.name}`, `Check constraint ${k.name} on ${t.fullName} differs; not altered`); continue; }
        if (x.checks.some(y => norm(y.expr) === norm(k.expr))) continue;
        F.add('constraints', 'add-check', t.fullName, `ALTER TABLE ${Q} ADD CONSTRAINT ${qi(k.name)} ${k.expr}`, `Add check constraint ${k.name} on ${t.fullName}`, { preData: true }); sum.constraintsToCreate++; changed();
      }
      for (const k of t.exclusions) if (!x.exclusions.some(y => y.name === k.name)) { F.add('constraints', 'add-exclusion', t.fullName, `ALTER TABLE ${Q} ADD CONSTRAINT ${qi(k.name)} ${k.def}`, `Add exclusion constraint ${k.name} on ${t.fullName}`, { preData: true }); sum.constraintsToCreate++; changed(); }
    }
  }

  // foreign keys (always after all tables; after data when data is copied)
  if (opts.createConstraints) {
    for (const t of selected) {
      const x = tgtTables.get(t.fullName);
      if (t.partitionOf && t.partitionOf.parent) continue;
      for (const fk of t.foreignKeys) {
        const refFull = fk.refSchema + '.' + fk.refTable;
        if (!selSet.has(refFull) && !tgtTables.has(refFull)) { warn('warn', `${t.fullName}.${fk.name}`, `Foreign key ${fk.name} on ${t.fullName} references ${refFull}, which is neither selected nor present in the target; the constraint is skipped`); continue; }
        if (x) {
          const m = x.foreignKeys.find(y => y.name === fk.name || (sameCols(y.columns, fk.columns) && y.refSchema === fk.refSchema && y.refTable === fk.refTable && sameCols(y.refColumns, fk.refColumns) && y.onDelete === fk.onDelete && y.onUpdate === fk.onUpdate));
          if (m) continue;
        }
        const sql = `ALTER TABLE ${qn(t.schema, t.name)} ADD CONSTRAINT ${qi(fk.name)} ${fk.def}`;
        F.add('constraints', 'add-fk', t.fullName, sql, `Add foreign key ${fk.name} on ${t.fullName} -> ${refFull}`, /NOT VALID/.test(fk.def) ? {} : { fallbackSql: sql + ' NOT VALID' });
        sum.constraintsToCreate++; if (x) tablesAltered.add(t.fullName);
      }
      if (x) for (const fk of x.foreignKeys) if (!t.foreignKeys.some(y => y.name === fk.name)) {/* extra FK in target: left alone */}
    }
  }

  // indexes
  if (opts.createIndexes) {
    for (const t of selected) {
      if (t.partitionOf && t.partitionOf.parent) continue;
      const x = tgtTables.get(t.fullName);
      for (const ix of t.indexes) {
        if (ix.constraintBacked || ix.attached) continue;
        if (!ix.valid) { warn('warn', `${t.fullName}.${ix.name}`, `Index ${ix.name} is INVALID in the source and is skipped`); continue; }
        if (x) {
          const m = x.indexes.find(y => y.name === ix.name);
          if (m) { if (idxShape(m.def) !== idxShape(ix.def)) warn('warn', `${t.fullName}.${ix.name}`, `Index ${ix.name} on ${t.fullName} differs from the source; not altered`); continue; }
          if (x.indexes.some(y => idxShape(y.def) === idxShape(ix.def))) continue;
        }
        F.add('indexes', 'create-index', `${t.fullName}.${ix.name}`, idxHead(ix.def), `Create index ${ix.name} on ${t.fullName}`, /^s*CREATE UNIQUE INDEX/i.test(ix.def) && !/WHERE/i.test(ix.def) ? { rank: 5 } : {}); // unique indexes must exist before FKs that reference them
        sum.indexesToCreate++; if (x) tablesAltered.add(t.fullName);
        if (ix.comment) F.add('indexes', 'comment', ix.name, `COMMENT ON INDEX ${qn(t.schema, ix.name)} IS ${ql(ix.comment)}`, `Comment on index ${ix.name}`);
      }
    }
  }

  // views
  if (opts.createViews) {
    const avail = new Set([...tgtTables.keys(), ...tgtViews.keys(), ...selSet]);
    const viewsSel = src.views.filter(vw => {
      const depTables = vw.deps.filter(d => !src.views.some(o => o.fullName === d));
      if (opts.tables) return depTables.length > 0 && depTables.every(d => selSet.has(d));
      return true;
    });
    const vNames = viewsSel.map(vw => vw.fullName);
    const { order: vOrder } = topoSort(vNames, viewsSel.flatMap(vw => vw.deps.map(d => [d, vw.fullName])));
    const vBy = new Map(viewsSel.map(vw => [vw.fullName, vw]));
    const skipped = new Set();
    for (const name of vOrder) {
      const vw = vBy.get(name);
      const missing = vw.deps.filter(d => !(avail.has(d) || (vBy.has(d) && !skipped.has(d))));
      if (missing.length || vw.deps.some(d => skipped.has(d))) { skipped.add(name); warn('warn', name, `View ${name} depends on unselected or missing object(s) (${missing.join(', ') || 'a skipped view'}) and is skipped`); continue; }
      neededSchemas.add(vw.schema);
      const ex = tgtViews.get(name);
      const Qv = qn(vw.schema, vw.name);
      if (vw.kind === 'matview') {
        if (!ex) {
          F.add('views', 'create-matview', name, `CREATE MATERIALIZED VIEW IF NOT EXISTS ${Qv} AS ${vw.definition} WITH ${vw.populated === false ? 'NO ' : ''}DATA`, `Create materialized view ${name}`); sum.viewsToCreate++;
          for (const ix of vw.indexes) if (ix.valid && !ix.constraintBacked) { F.add('views', 'create-index', `${name}.${ix.name}`, idxHead(ix.def), `Create index ${ix.name} on materialized view ${name}`); sum.indexesToCreate++; }
        } else if (norm(ex.definition) !== norm(vw.definition)) warn('warn', name, `Materialized view ${name} differs from the source; not altered (drop it manually to recreate)`);
        continue;
      }
      if (!ex) {
        F.add('views', 'create-view', name, `CREATE OR REPLACE VIEW ${Qv} AS ${vw.definition}`, `Create view ${name}`); sum.viewsToCreate++;
        for (const o of vw.options || []) if (/^[a-z_]+=[A-Za-z0-9_.]+$/.test(o)) F.add('views', 'view-options', name, `ALTER VIEW ${Qv} SET (${o})`, `Set ${o} on view ${name}`);
      } else if (norm(ex.definition) !== norm(vw.definition)) {
        F.add('views', 'replace-view', name, `CREATE OR REPLACE VIEW ${Qv} AS ${vw.definition}`, `Replace definition of view ${name}`); sum.viewsToCreate++;
        warn('warn', name, `View ${name} differs from the source and is replaced (fails if the column list is incompatible)`);
      }
      if (vw.comment && !ex) F.add('views', 'comment', name, `COMMENT ON VIEW ${Qv} IS ${ql(vw.comment)}`, `Comment on view ${name}`);
    }
  }

  // sequence ownership (needs the tables to exist)
  for (const s of seqList.values()) {
    if (!s.ownedBy || !s.ownedBy.column) continue;
    if (!selSet.has(s.ownedBy.schema + '.' + s.ownedBy.table)) continue;
    const ex = tgtSeqs.get(s.fullName);
    if (ex && ex.ownedBy && ex.ownedBy.schema === s.ownedBy.schema && ex.ownedBy.table === s.ownedBy.table && ex.ownedBy.column === s.ownedBy.column) continue;
    F.add('sequence-sync', 'owned-by', s.fullName, `ALTER SEQUENCE ${qn(s.schema, s.name)} OWNED BY ${qn(s.ownedBy.schema, s.ownedBy.table)}.${qi(s.ownedBy.column)}`, `Attach sequence ${s.fullName} to ${s.ownedBy.table}.${s.ownedBy.column}`);
  }

  // target-only tables
  if (!opts.tables) {
    for (const x of tgt.tables) if (!src.tables.some(t => t.fullName === x.fullName)) {
      if (opts.allowDrops && opts.dropExtraTables && x.kind !== 'partition') {
        F.add('drops', 'drop-table', x.fullName, `DROP TABLE IF EXISTS ${qn(x.schema, x.name)}`, `Drop table ${x.fullName} (not in source)`, { destructive: true }); sum.tablesToDrop++;
      } else {
        warn('warn', x.fullName, `Table ${x.fullName} exists only in the target; it is not touched${opts.allowDrops ? '' : ' (drops are disabled)'}`);
        if (!opts.allowDrops) ctx.skippedDrops.push(`DROP TABLE IF EXISTS ${qn(x.schema, x.name)}`);
      }
    }
  }
  sum.tablesToAlter = [...tablesAltered].filter(n => !created.has(n)).length;

  // report-only objects
  const trig = selected.reduce((n, t) => n + t.triggers.length, 0);
  if (trig) warn('warn', 'triggers', `${trig} trigger(s) on selected tables are NOT migrated: ${selected.filter(t => t.triggers.length).map(t => t.name).join(', ')}`);
  if (src.functions.length) warn('warn', 'functions', `${src.functions.length} user function(s)/procedure(s) exist in the source and are NOT migrated (defaults/checks/triggers that use them will fail)`);
  const rls = selected.filter(t => t.rls && t.rls.enabled);
  if (rls.length) warn('warn', 'row level security', `Row level security is enabled on ${rls.map(t => t.name).join(', ')}; policies are NOT migrated`);
  for (const t of selected) for (const nm of [t.name, ...t.columns.map(c => c.name)]) if (Buffer.byteLength(nm) > 63) warn('warn', t.fullName, `Identifier "${nm.slice(0, 20)}..." is longer than 63 bytes and will be truncated by PostgreSQL`);
  warn('info', 'scope', 'Ownership, GRANTs, row level security policies, publications and tablespaces are not migrated');
  warn('info', 'scope', 'Indexes are created with CREATE INDEX (not CONCURRENTLY) after the data copy; on large tables this locks writes while the index builds');

  return { created, neededSchemas };
}

module.exports = { planPg, classifyTypeChange, fam };
