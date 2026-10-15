// Shared helpers for the Migration feature (DBComparePanel + MigrationWizard).

const PG_FAMILY = ['postgres', 'cockroachdb', 'greenplum', 'redshift']
const MYSQL_FAMILY = ['mysql', 'mariadb']

export const isMigratable = (type) => PG_FAMILY.includes(type) || MYSQL_FAMILY.includes(type)

export const engineFamily = (type) =>
  PG_FAMILY.includes(type) ? 'postgres' : MYSQL_FAMILY.includes(type) ? 'mysql' : null

// Returns null when the pair can be migrated, otherwise { title, body, tip? }.
export function migrationBlocker(srcConn, tgtConn, srcId, tgtId) {
  if (!srcConn || !tgtConn) return { title: 'Connection not available.', body: 'Both connections must be connected.' }
  if (srcId && srcId === tgtId) return { title: 'Source and target are the same connection.', body: 'Pick two different connections.' }
  if (srcConn.type !== tgtConn.type) {
    return {
      title: 'Cross-engine migration is not supported.',
      body: `You selected ${srcConn.type} → ${tgtConn.type}. This tool migrates between two databases of the same engine (PostgreSQL to PostgreSQL, MySQL to MySQL). Data types, SQL syntax and constraints differ between engines, so converting between them automatically is out of scope.`
        + (MYSQL_FAMILY.includes(srcConn.type) && MYSQL_FAMILY.includes(tgtConn.type) ? ' MySQL and MariaDB differ in some column types.' : ''),
      tip: "Tip: export your data as CSV or use the engine's own dump and restore tools.",
    }
  }
  if (!isMigratable(srcConn.type)) {
    return {
      title: `${srcConn.type} is not supported for migration.`,
      body: 'Migration currently supports PostgreSQL-compatible databases (PostgreSQL, CockroachDB, Greenplum, Redshift) and MySQL/MariaDB. You can still use Compare and Generate SQL Script for schema differences.',
    }
  }
  return null
}

export function formatDuration(ms) {
  if (ms == null || isNaN(ms)) return '-'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// Only name/type/host/database are ever exported - never passwords or full configs.
export const safeConn = (c, id) => ({ id, name: c?.name || null, type: c?.type || null, host: c?.host || null, database: c?.database || null })

export function buildReportJson({ srcId, tgtId, srcConn, tgtConn, options, plan, report, verify }) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: safeConn(srcConn, srcId),
    target: safeConn(tgtConn, tgtId),
    options,
    summary: plan?.summary || null,
    report,
    verification: verify?.rows || null,
  }, null, 2)
}

export function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}
