const { getKernelSchema, validateKernelSchema } = require('./schema');

function assertIdentifier(identifier, label) {
	if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
		throw new Error(`Invalid Kernel SQL ${label}: ${identifier}`);
	}
}

function renderReference(reference) {
	const parts = String(reference || '').split('.');
	if (parts.length !== 2) {
		throw new Error(`Invalid Kernel SQL reference: ${reference}`);
	}
	const [tableName, columnName] = parts;
	assertIdentifier(tableName, 'reference table');
	assertIdentifier(columnName, 'reference column');
	return `REFERENCES kernel_${tableName}(${columnName})`;
}

function renderColumn(field) {
	assertIdentifier(field.name, 'column');
	const parts = [field.name, field.type];
	if (field.notNull) parts.push('NOT NULL');
	if (field.primaryKey) parts.push('PRIMARY KEY');
	if (field.default !== undefined) parts.push(`DEFAULT ${field.default}`);
	if (field.references) parts.push(renderReference(field.references));
	return parts.join(' ');
}

function renderCreateTable(table) {
	assertIdentifier(table.sqlName, 'table');
	const columns = table.fields.map(field => `  ${renderColumn(field)}`).join(',\n');
	return `CREATE TABLE IF NOT EXISTS ${table.sqlName} (\n${columns}\n);`;
}

function renderCreateIndex(table, index) {
	assertIdentifier(index.name, 'index');
	const unique = index.unique ? 'UNIQUE ' : '';
	const columns = index.columns.map(column => {
		assertIdentifier(column, 'index column');
		return column;
	}).join(', ');
	return `CREATE ${unique}INDEX IF NOT EXISTS ${index.name} ON ${table.sqlName} (${columns});`;
}

function renderDropIndex(index) {
	assertIdentifier(index.name, 'index');
	return `DROP INDEX IF EXISTS ${index.name};`;
}

function renderDropTable(table) {
	assertIdentifier(table.sqlName, 'table');
	return `DROP TABLE IF EXISTS ${table.sqlName};`;
}

// Whole tables created by a LATER migration (not by the 001 initial schema). schema.js
// stays the full current schema; the named tables are filtered out of 001 so they are
// created exactly once by their dedicated migration (both on a fresh DB and, via the
// ledger, on an existing DB). KEEP IN SYNC with every new table-creating migration.
//   memories → 005
const MIGRATION_ADDED_TABLES = ['memories'];

function getInitialKernelSchema() {
	const schema = getKernelSchema();
	// Columns added by a later migration MUST be excluded from the initial (001)
	// CREATE TABLE, so a fresh DB doesn't create them before the ALTER … ADD COLUMN
	// migration runs (else "duplicate column name"). schema.js stays the full current
	// schema; this map mirrors which columns each later migration backfills.
	//   events.expected_revision → 002 ; issues.design/notes/assignee → 004 ;
	//   issues.created_by/closed_at/close_reason/metadata → 006
	// KEEP IN SYNC: every new `ALTER TABLE … ADD COLUMN` migration MUST add its
	// column(s) here, or a fresh DB will hit "duplicate column name" on setup.
	const MIGRATION_ADDED_COLUMNS = {
		events: ['expected_revision'],
		issues: ['design', 'notes', 'assignee', 'created_by', 'closed_at', 'close_reason', 'metadata'],
	};
	return {
		...schema,
		tables: schema.tables
			.filter(table => !MIGRATION_ADDED_TABLES.includes(table.name))
			.map(table => {
				const excluded = MIGRATION_ADDED_COLUMNS[table.name];
				if (!excluded) return table;
				return {
					...table,
					fields: table.fields.filter(field => !excluded.includes(field.name)),
				};
			}),
	};
}

function buildSchemaMigration(schema = getInitialKernelSchema()) {
	validateKernelSchema(schema);

	const apply = [];
	for (const table of schema.tables) {
		apply.push(renderCreateTable(table));
		for (const tableIndex of table.indexes) {
			apply.push(renderCreateIndex(table, tableIndex));
		}
	}

	const rollback = [];
	for (const table of [...schema.tables].reverse()) {
		for (const tableIndex of [...table.indexes].reverse()) {
			rollback.push(renderDropIndex(tableIndex));
		}
		rollback.push(renderDropTable(table));
	}

	return {
		id: '001_kernel_schema',
		apply,
		rollback,
	};
}

function buildEventExpectedRevisionMigration() {
	return {
		id: '002_kernel_events_expected_revision',
		apply: ['ALTER TABLE kernel_events ADD COLUMN expected_revision INTEGER NOT NULL DEFAULT 0;'],
		rollback: [
			'CREATE TABLE IF NOT EXISTS kernel_events_002_rollback (\n  id TEXT NOT NULL PRIMARY KEY,\n  entity_type TEXT NOT NULL,\n  entity_id TEXT NOT NULL,\n  event_type TEXT NOT NULL,\n  idempotency_key TEXT NOT NULL,\n  actor TEXT NOT NULL,\n  origin TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);',
			'INSERT INTO kernel_events_002_rollback (id, entity_type, entity_id, event_type, idempotency_key, actor, origin, payload_json, created_at) SELECT id, entity_type, entity_id, event_type, idempotency_key, actor, origin, payload_json, created_at FROM kernel_events;',
			'DROP TABLE kernel_events;',
			'ALTER TABLE kernel_events_002_rollback RENAME TO kernel_events;',
			'CREATE INDEX IF NOT EXISTS idx_kernel_events_entity_created ON kernel_events (entity_type, entity_id, created_at);',
			'CREATE UNIQUE INDEX IF NOT EXISTS idx_kernel_events_idempotency ON kernel_events (idempotency_key);',
		],
	};
}

function buildClaimActiveLeaseMigration() {
	// DB-enforced claim-lease invariant (task 9.5.10): at most one active claim
	// per issue. A partial UNIQUE index is the only guarantee that survives
	// multi-process races — a pre-read check cannot, because two writers can both
	// read zero active claims before either commits. renderCreateIndex() has no
	// partial-WHERE support, so this is a hand-written apply string (like 002).
	return {
		id: '003_kernel_claims_active_lease',
		apply: [
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_kernel_claims_active_lease ON kernel_claims (issue_id) WHERE state = 'active';",
		],
		rollback: [
			'DROP INDEX IF EXISTS idx_kernel_claims_active_lease;',
		],
	};
}

// KAP-10 (acceptance/design/notes) + KAP-11 (assignee): three additive content
// columns on kernel_issues. acceptance_criteria/estimate already exist; these add
// the remaining authored fields plus a persistent assignee (distinct from the
// transient kernel_claims lease). Plain ADD COLUMNs — the 001 initial schema omits
// these columns (getInitialKernelSchema/MIGRATION_ADDED_COLUMNS) and the broker's
// per-migration ledger + guarded ADD COLUMN apply them exactly once.
function buildIssueContentFieldsMigration() {
	return {
		id: '004_kernel_issues_content_fields',
		apply: [
			'ALTER TABLE kernel_issues ADD COLUMN design TEXT;',
			'ALTER TABLE kernel_issues ADD COLUMN notes TEXT;',
			'ALTER TABLE kernel_issues ADD COLUMN assignee TEXT;',
		],
		rollback: [
			'ALTER TABLE kernel_issues DROP COLUMN assignee;',
			'ALTER TABLE kernel_issues DROP COLUMN notes;',
			'ALTER TABLE kernel_issues DROP COLUMN design;',
		],
	};
}

// 005: the project-memory read-model table (kernel_memories). Rendered from the
// schema.js table definition so the DDL never drifts from the registry. Excluded from
// the 001 initial schema (MIGRATION_ADDED_TABLES), so a fresh DB creates it exactly
// once here and an existing DB picks it up through the broker's per-migration ledger.
// CREATE … IF NOT EXISTS keeps a re-run idempotent.
function buildMemoryProjectionMigration() {
	const memories = getKernelSchema().tables.find(table => table.name === 'memories');
	if (!memories) {
		throw new Error('Kernel schema is missing the memories read-model table');
	}
	return {
		id: '005_kernel_memories',
		apply: [
			renderCreateTable(memories),
			...memories.indexes.map(memoryIndex => renderCreateIndex(memories, memoryIndex)),
		],
		rollback: [
			...[...memories.indexes].reverse().map(memoryIndex => renderDropIndex(memoryIndex)),
			renderDropTable(memories),
		],
	};
}

// 006: full-fidelity beads import. Four additive ADD COLUMNs on kernel_issues so no
// beads issue data is dropped — the author (created_by), the close timestamp
// (closed_at) and raw close reason (close_reason, distinct from the mapped terminal
// status), plus a verbatim JSON metadata blob (metadata). Plain ADD COLUMNs — the 001
// initial schema omits these columns (getInitialKernelSchema/MIGRATION_ADDED_COLUMNS)
// and the broker's per-migration ledger + guarded ADD COLUMN apply them exactly once.
function buildIssueFidelityColumnsMigration() {
	return {
		id: '006_kernel_issue_fidelity_columns',
		apply: [
			'ALTER TABLE kernel_issues ADD COLUMN created_by TEXT;',
			'ALTER TABLE kernel_issues ADD COLUMN closed_at TEXT;',
			'ALTER TABLE kernel_issues ADD COLUMN close_reason TEXT;',
			'ALTER TABLE kernel_issues ADD COLUMN metadata TEXT;',
		],
		rollback: [
			'ALTER TABLE kernel_issues DROP COLUMN metadata;',
			'ALTER TABLE kernel_issues DROP COLUMN close_reason;',
			'ALTER TABLE kernel_issues DROP COLUMN closed_at;',
			'ALTER TABLE kernel_issues DROP COLUMN created_by;',
		],
	};
}

function validateKernelMigrations(migrations) {
	const ids = new Set();
	for (const migration of migrations) {
		if (!migration || !migration.id) {
			throw new Error('Kernel migration is missing an id');
		}
		if (ids.has(migration.id)) {
			throw new Error(`Duplicate Kernel migration id: ${migration.id}`);
		}
		ids.add(migration.id);
		if (!Array.isArray(migration.apply) || migration.apply.length === 0) {
			throw new Error(`Kernel migration ${migration.id} has no apply statements`);
		}
		if (!Array.isArray(migration.rollback) || migration.rollback.length === 0) {
			throw new Error(`Kernel migration ${migration.id} has no rollback statements`);
		}
	}

	return true;
}

function buildKernelMigrationPlan(migrations = [
	buildSchemaMigration(),
	buildEventExpectedRevisionMigration(),
	buildClaimActiveLeaseMigration(),
	buildIssueContentFieldsMigration(),
	buildMemoryProjectionMigration(),
	buildIssueFidelityColumnsMigration(),
]) {
	validateKernelMigrations(migrations);

	return {
		migrations,
		apply: migrations.flatMap(migration => migration.apply),
		rollback: [...migrations].reverse().flatMap(migration => migration.rollback),
	};
}

module.exports = {
	buildClaimActiveLeaseMigration,
	buildEventExpectedRevisionMigration,
	buildIssueContentFieldsMigration,
	buildIssueFidelityColumnsMigration,
	buildKernelMigrationPlan,
	buildMemoryProjectionMigration,
	buildSchemaMigration,
	validateKernelMigrations,
};
