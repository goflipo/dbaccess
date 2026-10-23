// Public API of the migration engine (see the contract in the project notes).
// Requires nothing from electron, so it also runs under plain ELECTRON_RUN_AS_NODE (tests).
const { introspectAny, buildPlanInternal } = require('./plan');
const { runMigration, cancelMigration } = require('./run');
const { verifyMigration } = require('./verify');

/** Schema model of one connection (tables, columns, types, sequences, constraints, indexes, views). */
async function introspect(dbManager, connId) { return introspectAny(dbManager, connId); }

/** Dry plan: ordered steps, data plan, warnings (blockers refuse a run) and a copyable SQL script. */
async function buildPlan(dbManager, srcId, tgtId, options) { return buildPlanInternal(dbManager, srcId, tgtId, options); }

module.exports = { introspect, buildPlan, runMigration, cancelMigration, verifyMigration };
