// Shared SQL helpers for the migration engine: identifier/literal quoting,
// dialect objects, a dialect-aware statement splitter and a topological sort.
// Plain CommonJS on purpose (required from ipc-handlers.js, which is compiled to .jsc).

const PG_WIRE = new Set(['postgres', 'cockroachdb', 'greenplum', 'redshift']);
const MYSQL_WIRE = new Set(['mysql', 'mariadb']);

function family(type) {
  const t = String(type || '').toLowerCase();
  if (PG_WIRE.has(t)) return 'postgres';
  if (MYSQL_WIRE.has(t)) return 'mysql';
  return null;
}

function noNul(s) {
  s = String(s);
  if (s.indexOf('\0') !== -1) throw new Error('Identifier or literal contains a NUL byte');
  return s;
}

const pg = {
  id: 'postgres',
  qi: (n) => '"' + noNul(n).replace(/"/g, '""') + '"',
  ql(s) {
    s = noNul(s);
    if (s.indexOf('\\') !== -1) return "E'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
    return "'" + s.replace(/'/g, "''") + "'";
  },
  qn(schema, name) { return pg.qi(schema) + '.' + pg.qi(name); },
};

const my = {
  id: 'mysql',
  qi: (n) => '`' + noNul(n).replace(/`/g, '``') + '`',
  ql(s) { return "'" + noNul(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'"; },
  qn(db, name) { return my.qi(db) + '.' + my.qi(name); },
};

function dialectFor(fam) { return fam === 'mysql' ? my : pg; }

const isIdent = (ch) => !!ch && /[A-Za-z0-9_$\u0080-￿]/.test(ch);

/**
 * Split a SQL script into statements honouring quotes, comments, PG dollar quoting,
 * MySQL DELIMITER and (heuristically) MySQL BEGIN..END routine bodies.
 * Returns [{sql,startLine,endLine}] with a `warnings` array property.
 */
function splitStatements(sql, dialect = 'postgres') {
  const isPg = dialect === 'postgres';
  const out = []; out.warnings = [];
  const n = sql.length;
  let i = 0, line = 1;
  let cur = '', sline = 0, delim = ';';
  let routine = null, depth = 0;

  const countNl = (s) => { let k = 0; for (let j = 0; j < s.length; j++) if (s.charCodeAt(j) === 10) k++; return k; };
  const keep = (s) => {
    if (!sline && /\S/.test(s)) sline = line + countNl(s.slice(0, s.search(/\S/)));
    cur += s; line += countNl(s);
  };
  const drop = (s) => { cur += cur ? ' ' : ''; line += countNl(s); };
  const flush = () => {
    const t = cur.trim();
    if (t) {
      if (isPg && /^\s*copy\b[\s\S]*\bfrom\s+stdin\b/i.test(t)) throw new Error('COPY ... FROM stdin blocks are not supported (line ' + sline + ')');
      out.push({ sql: t, startLine: sline, endLine: line });
    }
    cur = ''; sline = 0; routine = null; depth = 0;
  };
  const unterminated = (what, at) => { throw new Error('Unterminated ' + what + ' starting at line ' + at); };
  const blankSoFar = () => !/\S/.test(cur);

  while (i < n) {
    const ch = sql[i], nx = sql[i + 1];
    // line-start directives
    if (blankSoFar() && (i === 0 || sql[i - 1] === '\n')) {
      if (isPg && ch === '\\') { // psql meta-command
        let e = sql.indexOf('\n', i); if (e < 0) e = n;
        out.warnings.push('Ignored psql meta-command at line ' + line + ': ' + sql.slice(i, e).trim());
        i = e; continue;
      }
      if (!isPg) {
        const m = /^delimiter[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i.exec(sql.slice(i, i + 200));
        if (m) { delim = m[1]; i += m[0].length; line++; continue; }
      }
    }
    // comments
    if (ch === '-' && nx === '-' && (isPg || /\s|^$/.test(sql[i + 2] || ' '))) {
      let e = sql.indexOf('\n', i); if (e < 0) e = n;
      drop(sql.slice(i, e)); i = e; continue;
    }
    if (!isPg && ch === '#') { let e = sql.indexOf('\n', i); if (e < 0) e = n; drop(sql.slice(i, e)); i = e; continue; }
    if (ch === '/' && nx === '*') {
      const at = line;
      if (!isPg && (sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!'))) {
        const e = sql.indexOf('*/', i + 2); if (e < 0) unterminated('comment', at);
        keep(sql.slice(i, e + 2)); i = e + 2; continue;
      }
      let d = 1, j = i + 2;
      while (j < n && d > 0) {
        if (sql[j] === '*' && sql[j + 1] === '/') { d--; j += 2; }
        else if (isPg && sql[j] === '/' && sql[j + 1] === '*') { d++; j += 2; }
        else j++;
      }
      if (d > 0) unterminated('block comment', at);
      drop(sql.slice(i, j)); i = j; continue;
    }
    // quoted strings / identifiers
    if (ch === "'" || ch === '"' || (!isPg && ch === '`')) {
      const at = line;
      const backslash = isPg ? (ch === "'" && /[eE]/.test(sql[i - 1] || '') && !isIdent(sql[i - 2])) : ch !== '`';
      let j = i + 1, closed = false;
      while (j < n) {
        const c = sql[j];
        if (backslash && c === '\\') { j += 2; continue; }
        if (c === ch) { if (sql[j + 1] === ch) { j += 2; continue; } closed = true; j++; break; }
        j++;
      }
      if (!closed) unterminated('quoted string', at);
      keep(sql.slice(i, j)); i = j; continue;
    }
    // dollar quoting
    if (isPg && ch === '$' && !isIdent(sql[i - 1])) {
      const re = /\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y; re.lastIndex = i;
      const m = re.exec(sql);
      if (m) {
        const tag = m[0], at = line;
        const e = sql.indexOf(tag, i + tag.length);
        if (e < 0) unterminated('dollar-quoted string', at);
        keep(sql.slice(i, e + tag.length)); i = e + tag.length; continue;
      }
    }
    // MySQL routine bodies
    if (!isPg && delim === ';' && /[A-Za-z]/.test(ch) && !isIdent(sql[i - 1])) {
      if (routine === null && cur.length > 10) routine = /^\s*create\s+(or\s+replace\s+)?(definer\s*=\s*\S+\s+)?(procedure|function|trigger|event)\b/i.test(cur);
      if (routine) {
        const m = /^[A-Za-z_]+/.exec(sql.slice(i, i + 30)); const w = m[0].toUpperCase();
        if (w === 'BEGIN') depth++;
        else if (w === 'END') { const nxt = /^\s+([A-Za-z]+)/.exec(sql.slice(i + 3, i + 30)); if (!(nxt && /^(IF|LOOP|WHILE|REPEAT|CASE)$/i.test(nxt[1]))) depth--; }
        keep(m[0]); i += m[0].length; continue;
      }
    }
    // statement terminator
    if (sql.startsWith(delim, i) && !(routine && depth > 0)) { flush(); i += delim.length; continue; }
    keep(ch); i++;
  }
  flush();
  return out;
}

/** Kahn topological order. edges: [[before, after], ...]. Returns {order, cycles:[[nodes]]}. */
function topoSort(nodes, edges) {
  const set = new Set(nodes);
  const adj = new Map(nodes.map(n => [n, new Set()]));
  const indeg = new Map(nodes.map(n => [n, 0]));
  for (const [a, b] of edges) {
    if (a === b || !set.has(a) || !set.has(b) || adj.get(a).has(b)) continue;
    adj.get(a).add(b); indeg.set(b, indeg.get(b) + 1);
  }
  const ready = nodes.filter(n => indeg.get(n) === 0).sort();
  const order = [];
  while (ready.length) {
    const n = ready.shift(); order.push(n);
    for (const m of [...adj.get(n)].sort()) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) { ready.push(m); ready.sort(); }
    }
  }
  const cycles = [];
  if (order.length < nodes.length) {
    const done = new Set(order);
    const left = new Set(nodes.filter(n => !done.has(n)));
    // Tarjan SCC over the leftover nodes
    let idx = 0; const st = [], on = new Set(), ix = new Map(), low = new Map();
    const strong = (v) => {
      ix.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v);
      for (const w of adj.get(v)) {
        if (!left.has(w)) continue;
        if (!ix.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
        else if (on.has(w)) low.set(v, Math.min(low.get(v), ix.get(w)));
      }
      if (low.get(v) === ix.get(v)) {
        const comp = []; let w;
        do { w = st.pop(); on.delete(w); comp.push(w); } while (w !== v);
        if (comp.length > 1) cycles.push(comp.sort());
      }
    };
    for (const v of [...left].sort()) if (!ix.has(v)) strong(v);
    for (const v of [...left].sort()) order.push(v); // best effort: append the rest
  }
  return { order, cycles };
}

module.exports = { PG_WIRE, MYSQL_WIRE, family, pg, my, dialectFor, splitStatements, topoSort };
