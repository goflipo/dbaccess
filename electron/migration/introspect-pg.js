// PostgreSQL catalog introspection -> common schema model.
// Runs on ONE dedicated client inside a REPEATABLE READ READ ONLY snapshot with
// search_path = pg_catalog so format_type / pg_get_expr / pg_get_constraintdef
// qualify every non-catalog name (no dependence on the target's search_path).

const NSP = `n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'`;
const extOwned = (cls, alias) => `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='${cls}'::regclass AND d.objid=${alias}.oid AND d.deptype='e')`;

const arr = (v) => (Array.isArray(v) ? v : []);

async function introspectPg(c) {
  const info = (await c.query(`SELECT version() AS version, current_database() AS db, current_setting('server_version_num')::int AS v, current_schema() AS cs, current_user AS usr`)).rows[0];
  const v = info.v;
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await c.query('SET LOCAL search_path = pg_catalog');
    await c.query('SET LOCAL statement_timeout = 0');
    if (v < 100000) throw new Error('PostgreSQL ' + info.version.split(' ')[1] + ' is too old (migration needs PostgreSQL 10+)');
    const q = async (text, params) => (await c.query(text, params)).rows;

    const model = {
      engine: 'postgres', version: info.version, versionNum: v, serverVersion: String(info.version).split(' ')[1] || '',
      database: info.db, currentSchema: info.cs, currentUser: info.usr,
      schemas: [], extensions: [], types: [], sequences: [], tables: [], views: [], functions: [], warnings: [],
    };

    model.schemas = (await q(`SELECT nspname FROM pg_namespace n WHERE ${NSP} AND ${extOwned('pg_namespace', 'n')} ORDER BY 1`)).map(r => r.nspname);
    model.extensions = (await q(`SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname<>'plpgsql' ORDER BY 1`));

    // --- relations ---
    const rels = await q(`
      SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind, c.relpersistence, c.relispartition,
             c.relrowsecurity, c.relforcerowsecurity, c.reltuples::bigint AS est_rows,
             pg_get_partkeydef(c.oid) AS partkey,
             CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END AS partbound,
             obj_description(c.oid,'pg_class') AS comment, c.reloptions, pg_get_userbyid(c.relowner) AS owner,
             CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid, true) END AS viewdef
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','f','v','m') AND ${NSP} AND ${extOwned('pg_class', 'c')}
      ORDER BY n.nspname, c.relname`);
    const tableRels = rels.filter(r => 'rpf'.includes(r.relkind));
    const viewRels = rels.filter(r => 'vm'.includes(r.relkind));
    const tOids = tableRels.map(r => r.oid);
    const idxOids = rels.filter(r => 'rpm'.includes(r.relkind)).map(r => r.oid);

    const inh = tOids.length ? await q(`
      SELECT i.inhrelid, i.inhparent, pn.nspname AS pschema, pc.relname AS pname, i.inhseqno, cc.relispartition
      FROM pg_inherits i JOIN pg_class pc ON pc.oid=i.inhparent JOIN pg_namespace pn ON pn.oid=pc.relnamespace
      JOIN pg_class cc ON cc.oid=i.inhrelid WHERE i.inhrelid = ANY($1::oid[]) OR i.inhparent = ANY($1::oid[]) ORDER BY i.inhrelid, i.inhseqno`, [tOids]) : [];

    const cols = tOids.length ? await q(`
      SELECT a.attrelid AS reloid, a.attnum, a.attname,
             pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
             a.atttypid, t.typname, tn.nspname AS type_schema, t.typtype, t.typcategory,
             CASE WHEN t.typcategory='A' THEN t.typelem ELSE t.oid END AS base_oid,
             (t.typtype IN ('e','d','c','r','m') OR COALESCE(et.typtype IN ('e','d','c','r','m'), false)) AS user_type,
             (t.typcategory='A') AS is_array,
             a.attnotnull,
             ${v >= 100000 ? 'a.attidentity::text' : "''::text"} AS attidentity,
             ${v >= 120000 ? 'a.attgenerated::text' : "''::text"} AS attgenerated,
             pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
             CASE WHEN a.attcollation<>t.typcollation THEN (SELECT json_build_object('schema', cn.nspname, 'name', co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid=co.collnamespace WHERE co.oid=a.attcollation) END AS collation,
             col_description(a.attrelid,a.attnum) AS comment
      FROM pg_attribute a
      JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace tn ON tn.oid=t.typnamespace
      LEFT JOIN pg_type et ON et.oid=t.typelem AND t.typcategory='A'
      LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
      WHERE a.attrelid = ANY($1::oid[]) AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY a.attrelid, a.attnum`, [tOids]) : [];

    // sequences referenced by column defaults (robust: via pg_depend, not by parsing text)
    const defSeq = tOids.length ? await q(`
      SELECT ad.adrelid AS reloid, ad.adnum, sn.nspname AS seq_schema, sc.relname AS seq_name
      FROM pg_attrdef ad
      JOIN pg_depend d ON d.classid='pg_attrdef'::regclass AND d.objid=ad.oid AND d.refclassid='pg_class'::regclass
      JOIN pg_class sc ON sc.oid=d.refobjid AND sc.relkind='S' JOIN pg_namespace sn ON sn.oid=sc.relnamespace
      WHERE ad.adrelid = ANY($1::oid[])`, [tOids]) : [];

    const seqs = await q(`
      SELECT c.oid, n.nspname AS schema, c.relname AS name, format_type(s.seqtypid,NULL) AS data_type,
             s.seqstart::text AS start, s.seqincrement::text AS incr, s.seqmin::text AS min, s.seqmax::text AS max,
             s.seqcache::text AS cache, s.seqcycle AS cycle, ps.last_value::text AS last_value,
             d.refobjid AS owner_oid, d.refobjsubid AS owner_attnum, d.deptype
      FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_sequences ps ON ps.schemaname=n.nspname AND ps.sequencename=c.relname
      LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
      WHERE ${NSP} AND ${extOwned('pg_class', 'c')} ORDER BY n.nspname, c.relname`);

    const cons = tOids.length ? await q(`
      SELECT con.oid, con.conrelid, con.conname, con.contype, con.condeferrable, con.condeferred, con.convalidated, con.connoinherit,
             con.conkey, con.confrelid, rn.nspname AS ref_schema, rc.relname AS ref_table, con.confkey,
             con.confupdtype::text AS confupdtype, con.confdeltype::text AS confdeltype, con.confmatchtype::text AS confmatchtype,
             pg_get_constraintdef(con.oid, true) AS def, con.conindid, con.conislocal
      FROM pg_constraint con
      LEFT JOIN pg_class rc ON rc.oid=con.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rc.relnamespace
      WHERE con.conrelid = ANY($1::oid[]) AND con.contype IN ('p','u','f','c','x')
      ORDER BY con.conrelid, con.contype, con.conname`, [tOids]) : [];

    const idxs = idxOids.length ? await q(`
      SELECT i.indrelid, i.indexrelid, ic.relname AS name, pg_get_indexdef(i.indexrelid) AS def, i.indisunique, i.indisprimary, i.indisvalid,
             i.indisexclusion, am.amname AS method, (i.indpred IS NOT NULL) AS partial, (i.indexprs IS NOT NULL) AS has_expr,
             ic.relispartition AS attached, i.indkey::int2[] AS indkey, i.indnkeyatts,
             EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid=i.indexrelid AND k.contype IN ('p','u','x')) AS constraint_backed,
             obj_description(i.indexrelid,'pg_class') AS comment
      FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam
      WHERE i.indrelid = ANY($1::oid[]) AND NOT i.indisprimary
      ORDER BY i.indrelid, ic.relname`, [idxOids]) : [];

    const trig = tOids.length ? await q(`SELECT tgrelid, tgname, pg_get_triggerdef(oid,true) AS def, tgenabled::text AS enabled FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = ANY($1::oid[])`, [tOids]) : [];
    let policies = [];
    try { policies = await q(`SELECT schemaname, tablename, policyname FROM pg_policies`); } catch (e) { /* ignore */ }

    // --- types ---
    const typeRef = (alias) => `CASE WHEN ${alias}.typcategory='A' THEN ${alias}.typelem ELSE ${alias}.oid END`;
    const enums = await q(`SELECT t.oid, n.nspname AS schema, t.typname AS name,
        (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid) AS labels
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE t.typtype='e' AND ${NSP} AND ${extOwned('pg_type', 't')} ORDER BY 2,3`);
    const domains = await q(`SELECT t.oid, n.nspname AS schema, t.typname AS name, format_type(t.typbasetype,t.typtypmod) AS base,
        ${typeRef('bt')} AS ref_oid, t.typnotnull AS not_null, pg_get_expr(t.typdefaultbin, 0) AS "default",
        (SELECT json_agg(json_build_object('name',c.conname,'def',pg_get_constraintdef(c.oid,true)) ORDER BY c.conname) FROM pg_constraint c WHERE c.contypid=t.oid) AS checks
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_type bt ON bt.oid=t.typbasetype
      WHERE t.typtype='d' AND ${NSP} AND ${extOwned('pg_type', 't')} ORDER BY 2,3`);
    const comps = await q(`SELECT t.oid, n.nspname AS schema, t.typname AS name,
        (SELECT json_agg(json_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'ref',${typeRef('at')}) ORDER BY a.attnum)
           FROM pg_attribute a JOIN pg_type at ON at.oid=a.atttypid WHERE a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped) AS attrs
      FROM pg_type t JOIN pg_class c ON c.oid=t.typrelid AND c.relkind='c' JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE t.typtype='c' AND ${NSP} AND ${extOwned('pg_type', 't')} ORDER BY 2,3`);
    const ranges = await q(`SELECT t.oid, n.nspname AS schema, t.typname AS name, format_type(r.rngsubtype,NULL) AS subtype, ${typeRef('st')} AS ref_oid
      FROM pg_range r JOIN pg_type t ON t.oid=r.rngtypid JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_type st ON st.oid=r.rngsubtype
      WHERE ${NSP} AND ${extOwned('pg_type', 't')} ORDER BY 2,3`);
    for (const e of enums) model.types.push({ oid: e.oid, schema: e.schema, name: e.name, kind: 'enum', labels: arr(e.labels), refs: [] });
    for (const d of domains) model.types.push({ oid: d.oid, schema: d.schema, name: d.name, kind: 'domain', baseType: d.base, notNull: d.not_null, default: d.default, checks: arr(d.checks), refs: [d.ref_oid] });
    for (const t of comps) model.types.push({ oid: t.oid, schema: t.schema, name: t.name, kind: 'composite', attrs: arr(t.attrs), refs: arr(t.attrs).map(a => a.ref) });
    for (const r of ranges) model.types.push({ oid: r.oid, schema: r.schema, name: r.name, kind: 'range', subtype: r.subtype, refs: [r.ref_oid] });

    // --- views ---
    let viewDeps = [];
    let viewCols = [];
    if (viewRels.length) {
      viewDeps = await q(`SELECT DISTINCT dv.oid AS view_oid, dt.oid AS dep_oid FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid
        JOIN pg_class dv ON dv.oid=r.ev_class JOIN pg_class dt ON dt.oid=d.refobjid
        WHERE d.classid='pg_rewrite'::regclass AND d.refclassid='pg_class'::regclass AND dt.oid<>dv.oid AND dv.relkind IN ('v','m')`);
      viewCols = await q(`SELECT attrelid, array_agg(attname::text ORDER BY attnum) AS names FROM pg_attribute WHERE attrelid = ANY($1::oid[]) AND attnum>0 AND NOT attisdropped GROUP BY attrelid`, [viewRels.map(r => r.oid)]);
    }
    const oidToFull = new Map(rels.map(r => [r.oid, r.schema + '.' + r.name]));
    for (const r of viewRels) {
      model.views.push({
        oid: r.oid, schema: r.schema, name: r.name, fullName: r.schema + '.' + r.name, kind: r.relkind === 'm' ? 'matview' : 'view',
        definition: String(r.viewdef || '').replace(/;\s*$/, ''), options: arr(r.reloptions), comment: r.comment, owner: r.owner,
        columns: (viewCols.find(x => x.attrelid === r.oid) || {}).names || [],
        deps: viewDeps.filter(d => d.view_oid === r.oid).map(d => oidToFull.get(d.dep_oid)).filter(Boolean),
        indexes: [],
      });
    }

    // functions (report only)
    try {
      model.functions = (await q(`SELECT n.nspname AS schema, p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, ${v >= 110000 ? 'p.prokind::text' : "'f'"} AS kind
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE ${NSP} AND ${v >= 110000 ? "p.prokind IN ('f','p')" : 'true'} AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype IN ('e','i')) ORDER BY 1,2`));
    } catch (e) { model.warnings.push('Could not list functions: ' + e.message); }

    // --- assemble tables ---
    const attName = new Map(cols.map(r => [r.reloid + ':' + r.attnum, r.attname]));
    const nm = (oid, nums) => arr(nums).map(k => attName.get(oid + ':' + k));
    const byOid = new Map();
    for (const r of tableRels) {
      const t = {
        oid: r.oid, schema: r.schema, name: r.name, fullName: r.schema + '.' + r.name,
        kind: r.relkind === 'p' ? 'partitioned' : r.relkind === 'f' ? 'foreign' : r.relispartition ? 'partition' : 'table',
        unlogged: r.relpersistence === 'u', partitionKey: r.partkey || null, partitionOf: null, inherits: [], hasInheritChildren: false,
        comment: r.comment, estRows: Number(r.est_rows), owner: r.owner, options: {},
        columns: [], primaryKey: null, uniques: [], foreignKeys: [], checks: [], exclusions: [], indexes: [], triggers: [], rules: [],
        rls: { enabled: r.relrowsecurity, forced: r.relforcerowsecurity, policies: policies.filter(p => p.schemaname === r.schema && p.tablename === r.name).map(p => ({ name: p.policyname })) },
      };
      if (r.relispartition) t.partitionOf = { parent: null, bound: r.partbound };
      byOid.set(r.oid, t); model.tables.push(t);
    }
    for (const i of inh) {
      const child = byOid.get(i.inhrelid);
      const parent = byOid.get(i.inhparent);
      if (child) {
        const pf = i.pschema + '.' + i.pname;
        if (child.partitionOf && !child.partitionOf.parent) child.partitionOf.parent = pf;
        else if (!child.partitionOf) child.inherits.push(pf);
      }
      if (parent && !i.relispartition && parent.kind === 'table') parent.hasInheritChildren = true;
    }
    const seqByFull = new Map();
    const seqRows = seqs.map(s => {
      const o = {
        oid: s.oid, schema: s.schema, name: s.name, fullName: s.schema + '.' + s.name, dataType: s.data_type, start: s.start, increment: s.incr,
        min: s.min, max: s.max, cache: s.cache, cycle: s.cycle, lastValue: s.last_value, isCalled: s.last_value != null,
        ownedBy: null, identityOwned: s.deptype === 'i', ownerOid: s.owner_oid, ownerAttnum: s.owner_attnum,
      };
      seqByFull.set(o.fullName, o);
      return o;
    });
    for (const s of seqRows) {
      if (s.ownerOid && byOid.has(s.ownerOid)) {
        const ot = byOid.get(s.ownerOid);
        s.ownedBy = { schema: ot.schema, table: ot.name, column: attName.get(s.ownerOid + ':' + s.ownerAttnum) || null };
      }
      delete s.ownerOid; delete s.ownerAttnum;
    }
    // never-called sequences may just be unreadable via pg_sequences: leave isCalled=false
    model.sequences = seqRows;

    const colByKey = new Map();
    for (const r of cols) {
      const t = byOid.get(r.reloid); if (!t) continue;
      const col = {
        name: r.attname, pos: r.attnum, type: r.type, typeSchema: r.type_schema, typeOid: r.atttypid, baseTypeOid: r.base_oid,
        isArray: r.is_array, userType: r.user_type, notNull: r.attnotnull,
        default: r.default_expr, defaultKind: 'none', defaultSeq: null,
        identity: r.attidentity === 'a' || r.attidentity === 'd' ? r.attidentity : null, identitySeq: null,
        generated: r.attgenerated === 's' ? { expr: r.default_expr, stored: true } : null,
        collation: r.collation, comment: r.comment,
      };
      if (col.identity || col.generated) col.default = null;
      if (col.default != null) col.defaultKind = /^nextval\(/i.test(col.default) ? 'sequence' : /^[-+]?[\d.]+$|^'[^']*'(::[\w\s"\.\[\]()]+)?$/.test(col.default) ? 'literal' : 'expr';
      t.columns.push(col); colByKey.set(r.reloid + ':' + r.attnum, col);
    }
    for (const r of defSeq) {
      const col = colByKey.get(r.reloid + ':' + r.adnum);
      if (col && !col.identity) col.defaultSeq = { schema: r.seq_schema, name: r.seq_name };
    }
    // identity sequence parameters
    for (const s of model.sequences) {
      if (!s.identityOwned || !s.ownedBy) continue;
      const t = model.tables.find(x => x.schema === s.ownedBy.schema && x.name === s.ownedBy.table);
      const col = t && t.columns.find(x => x.name === s.ownedBy.column);
      if (col) col.identitySeq = { start: s.start, incr: s.increment, min: s.min, max: s.max, cache: s.cache, cycle: s.cycle, name: s.name, lastValue: s.lastValue, isCalled: s.isCalled };
    }

    const ACT = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
    for (const r of cons) {
      const t = byOid.get(r.conrelid); if (!t) continue;
      if (!r.conislocal && t.kind === 'partition') continue; // inherited from the partitioned parent
      const columns = nm(r.conrelid, r.conkey);
      if (r.contype === 'p') t.primaryKey = { name: r.conname, columns, def: r.def };
      else if (r.contype === 'u') t.uniques.push({ name: r.conname, columns, def: r.def, deferrable: r.condeferrable, initDeferred: r.condeferred, nullsNotDistinct: /NULLS NOT DISTINCT/.test(r.def) });
      else if (r.contype === 'f') t.foreignKeys.push({
        name: r.conname, columns, refSchema: r.ref_schema, refTable: r.ref_table, refColumns: nm(r.confrelid, r.confkey),
        onDelete: ACT[r.confdeltype], onUpdate: ACT[r.confupdtype], match: r.confmatchtype === 'f' ? 'FULL' : 'SIMPLE',
        deferrable: r.condeferrable, initDeferred: r.condeferred, validated: r.convalidated, def: r.def,
      });
      else if (r.contype === 'c') t.checks.push({ name: r.conname, expr: r.def, validated: r.convalidated, noInherit: r.connoinherit });
      else if (r.contype === 'x') t.exclusions.push({ name: r.conname, def: r.def });
    }
    const viewByOid = new Map(model.views.map(x => [x.oid, x]));
    for (const r of idxs) {
      const keys = arr(r.indkey).slice(0, Number(r.indnkeyatts) || undefined);
      const ix = {
        name: r.name, def: r.def, unique: r.indisunique, primary: r.indisprimary, method: r.method,
        columns: keys.filter(k => k > 0).map(k => attName.get(r.indrelid + ':' + k)).filter(Boolean),
        expressions: r.has_expr, partial: r.partial, constraintBacked: r.constraint_backed, valid: r.indisvalid, attached: r.attached, comment: r.comment,
      };
      if (byOid.has(r.indrelid)) byOid.get(r.indrelid).indexes.push(ix);
      else if (viewByOid.has(r.indrelid)) viewByOid.get(r.indrelid).indexes.push(ix);
    }
    for (const r of trig) { const t = byOid.get(r.tgrelid); if (t) t.triggers.push({ name: r.tgname, def: r.def, enabled: r.enabled !== 'D' }); }

    model.tableList = model.tables.map(t => ({ fullName: t.fullName, schema: t.schema, name: t.name, kind: t.kind, columns: t.columns.length, estRows: t.estRows }));
    await c.query('COMMIT');
    return model;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}

module.exports = { introspectPg };
