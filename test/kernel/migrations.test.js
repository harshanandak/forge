const { describe, expect, test } = require('bun:test');

const {
	buildKernelMigrationPlan,
	buildSchemaMigration,
	validateKernelMigrations,
} = require('../../lib/kernel/migrations');
const { getKernelSchema } = require('../../lib/kernel/schema');

describe('kernel migration plans', () => {
	test('generates deterministic apply and rollback SQL for the schema', () => {
		const plan = buildKernelMigrationPlan();
		const secondPlan = buildKernelMigrationPlan();

		expect(plan.apply).toEqual(secondPlan.apply);
		expect(plan.rollback).toEqual(secondPlan.rollback);
		expect(plan.apply[0]).toContain('CREATE TABLE IF NOT EXISTS kernel_issues');
		expect(plan.apply[0]).toContain('id TEXT NOT NULL PRIMARY KEY');
		expect(plan.apply).toContain('CREATE INDEX IF NOT EXISTS idx_kernel_issues_status_priority ON kernel_issues (status, priority_rank);');
		expect(plan.apply).toContain('CREATE TABLE IF NOT EXISTS kernel_dependencies (\n  id TEXT NOT NULL PRIMARY KEY,\n  issue_id TEXT NOT NULL REFERENCES kernel_issues(id),\n  blocks_issue_id TEXT NOT NULL REFERENCES kernel_issues(id),\n  dependency_type TEXT NOT NULL DEFAULT \'blocks\',\n  created_at TEXT NOT NULL\n);');
		expect(plan.apply).toContain('CREATE TABLE IF NOT EXISTS kernel_events (\n  id TEXT NOT NULL PRIMARY KEY,\n  entity_type TEXT NOT NULL,\n  entity_id TEXT NOT NULL,\n  event_type TEXT NOT NULL,\n  idempotency_key TEXT NOT NULL,\n  actor TEXT NOT NULL,\n  origin TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);');
		expect(plan.apply).toContain('ALTER TABLE kernel_events ADD COLUMN expected_revision INTEGER NOT NULL DEFAULT 0;');
		expect(plan.apply).toContain('CREATE TABLE IF NOT EXISTS kernel_outbox (\n  id TEXT NOT NULL PRIMARY KEY,\n  event_id TEXT NOT NULL REFERENCES kernel_events(id),\n  target TEXT NOT NULL,\n  status TEXT NOT NULL DEFAULT \'pending\',\n  attempts INTEGER NOT NULL DEFAULT 0,\n  next_attempt_at TEXT,\n  created_at TEXT NOT NULL\n);');
		// Rollback runs migrations in reverse, so 007 (the latest migration) rolls back
		// first: its last-added linkage column (work_folder) drops before everything else.
		expect(plan.rollback[0]).toBe('ALTER TABLE kernel_worktrees DROP COLUMN work_folder;');
		expect(plan.rollback).toContain('DROP INDEX IF EXISTS idx_kernel_memories_source_agent;');
		expect(plan.rollback).toContain('DROP TABLE IF EXISTS kernel_memories;');
		expect(plan.rollback).toContain('ALTER TABLE kernel_issues DROP COLUMN assignee;');
		expect(plan.rollback).toContain('DROP INDEX IF EXISTS idx_kernel_claims_active_lease;');
		expect(plan.rollback).toContain('CREATE TABLE IF NOT EXISTS kernel_events_002_rollback (\n  id TEXT NOT NULL PRIMARY KEY,\n  entity_type TEXT NOT NULL,\n  entity_id TEXT NOT NULL,\n  event_type TEXT NOT NULL,\n  idempotency_key TEXT NOT NULL,\n  actor TEXT NOT NULL,\n  origin TEXT NOT NULL,\n  payload_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);');
		expect(plan.rollback).toContain('INSERT INTO kernel_events_002_rollback (id, entity_type, entity_id, event_type, idempotency_key, actor, origin, payload_json, created_at) SELECT id, entity_type, entity_id, event_type, idempotency_key, actor, origin, payload_json, created_at FROM kernel_events;');
		expect(plan.rollback).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_kernel_events_idempotency ON kernel_events (idempotency_key);');
		expect(plan.rollback.at(-1)).toBe('DROP TABLE IF EXISTS kernel_issues;');
		expect(plan.migrations.map(migration => migration.id)).toEqual([
			'001_kernel_schema',
			'002_kernel_events_expected_revision',
			'003_kernel_claims_active_lease',
			'004_kernel_issues_content_fields',
			'005_kernel_memories',
			'006_kernel_issue_fidelity_columns',
			'007_kernel_worktrees_linkage_columns',
		]);
	});

	test('migration 005 creates the kernel_memories read-model table and drops it on rollback', () => {
		const { buildMemoryProjectionMigration } = require('../../lib/kernel/migrations');
		const migration = buildMemoryProjectionMigration();

		expect(migration.id).toBe('005_kernel_memories');
		// Idempotent CREATE IF NOT EXISTS so a fresh DB and an existing DB both migrate
		// cleanly through the broker ledger.
		expect(migration.apply[0]).toContain('CREATE TABLE IF NOT EXISTS kernel_memories');
		expect(migration.apply[0]).toContain('key TEXT NOT NULL PRIMARY KEY');
		expect(migration.apply).toContain(
			'CREATE INDEX IF NOT EXISTS idx_kernel_memories_source_agent ON kernel_memories (source_agent);',
		);
		expect(migration.rollback).toEqual([
			'DROP INDEX IF EXISTS idx_kernel_memories_source_agent;',
			'DROP TABLE IF EXISTS kernel_memories;',
		]);

		// Registered in the default plan so the broker's initialize() creates it.
		const plan = buildKernelMigrationPlan();
		expect(plan.apply).toContain(
			'CREATE INDEX IF NOT EXISTS idx_kernel_memories_source_agent ON kernel_memories (source_agent);',
		);
	});

	test('the initial (001) schema migration excludes kernel_memories (created by 005)', () => {
		const plan = buildKernelMigrationPlan();
		const schemaMigration = plan.migrations.find(migration => migration.id === '001_kernel_schema');
		// kernel_memories must NOT be created by 001 — it is owned by migration 005 so a
		// fresh DB creates it exactly once and an existing DB picks it up via the ledger.
		expect(schemaMigration.apply.some(statement => statement.includes('kernel_memories'))).toBe(false);
	});

	test('KAP-10/11: migration 004 adds design/notes/assignee content fields and drops them on rollback', () => {
		const { buildIssueContentFieldsMigration } = require('../../lib/kernel/migrations');
		const migration = buildIssueContentFieldsMigration();

		expect(migration.id).toBe('004_kernel_issues_content_fields');
		// The three additive content columns (KAP-10: design/notes; KAP-11: assignee).
		expect(migration.apply).toEqual([
			'ALTER TABLE kernel_issues ADD COLUMN design TEXT;',
			'ALTER TABLE kernel_issues ADD COLUMN notes TEXT;',
			'ALTER TABLE kernel_issues ADD COLUMN assignee TEXT;',
		]);
		// Rollback drops them in reverse so dependent ordering is symmetric.
		expect(migration.rollback).toEqual([
			'ALTER TABLE kernel_issues DROP COLUMN assignee;',
			'ALTER TABLE kernel_issues DROP COLUMN notes;',
			'ALTER TABLE kernel_issues DROP COLUMN design;',
		]);

		// Registered in the default plan so fresh and existing DBs both migrate.
		const plan = buildKernelMigrationPlan();
		expect(plan.apply).toContain('ALTER TABLE kernel_issues ADD COLUMN design TEXT;');
		expect(plan.apply).toContain('ALTER TABLE kernel_issues ADD COLUMN notes TEXT;');
		expect(plan.apply).toContain('ALTER TABLE kernel_issues ADD COLUMN assignee TEXT;');
		expect(plan.rollback).toContain('ALTER TABLE kernel_issues DROP COLUMN assignee;');
	});

	test('beads fidelity: migration 006 adds created_by/closed_at/close_reason/metadata and drops them on rollback', () => {
		const { buildIssueFidelityColumnsMigration } = require('../../lib/kernel/migrations');
		const migration = buildIssueFidelityColumnsMigration();

		expect(migration.id).toBe('006_kernel_issue_fidelity_columns');
		// The four additive full-fidelity beads-import columns, in declaration order.
		expect(migration.apply).toEqual([
			'ALTER TABLE kernel_issues ADD COLUMN created_by TEXT;',
			'ALTER TABLE kernel_issues ADD COLUMN closed_at TEXT;',
			'ALTER TABLE kernel_issues ADD COLUMN close_reason TEXT;',
			'ALTER TABLE kernel_issues ADD COLUMN metadata TEXT;',
		]);
		// Rollback drops them in reverse so dependent ordering is symmetric.
		expect(migration.rollback).toEqual([
			'ALTER TABLE kernel_issues DROP COLUMN metadata;',
			'ALTER TABLE kernel_issues DROP COLUMN close_reason;',
			'ALTER TABLE kernel_issues DROP COLUMN closed_at;',
			'ALTER TABLE kernel_issues DROP COLUMN created_by;',
		]);

		// Registered in the default plan so fresh and existing DBs both migrate.
		const plan = buildKernelMigrationPlan();
		expect(plan.apply).toContain('ALTER TABLE kernel_issues ADD COLUMN created_by TEXT;');
		expect(plan.apply).toContain('ALTER TABLE kernel_issues ADD COLUMN closed_at TEXT;');
		expect(plan.apply).toContain('ALTER TABLE kernel_issues ADD COLUMN close_reason TEXT;');
		expect(plan.apply).toContain('ALTER TABLE kernel_issues ADD COLUMN metadata TEXT;');
		expect(plan.rollback).toContain('ALTER TABLE kernel_issues DROP COLUMN metadata;');

		// The initial (001) schema must EXCLUDE the four columns — they are owned by 006,
		// so a fresh DB does not create them before the ALTER … ADD COLUMN runs.
		const schemaMigration = plan.migrations.find(entry => entry.id === '001_kernel_schema');
		const createIssues = schemaMigration.apply.find(statement => statement.includes('CREATE TABLE IF NOT EXISTS kernel_issues'));
		for (const column of ['created_by', 'closed_at', 'close_reason', 'metadata']) {
			expect(createIssues.includes(`${column} TEXT`)).toBe(false);
		}
	});

	test('enforces a single active claim lease per issue via a partial unique index (9.5.10)', () => {
		const { buildClaimActiveLeaseMigration } = require('../../lib/kernel/migrations');
		const migration = buildClaimActiveLeaseMigration();

		expect(migration.id).toBe('003_kernel_claims_active_lease');
		// The hard DB-level invariant: at most one row with state='active' per issue_id.
		// renderCreateIndex has no partial-WHERE support, so this must be a raw apply string.
		expect(migration.apply).toContain(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_kernel_claims_active_lease ON kernel_claims (issue_id) WHERE state = 'active';",
		);
		expect(migration.rollback).toContain('DROP INDEX IF EXISTS idx_kernel_claims_active_lease;');

		const plan = buildKernelMigrationPlan();
		expect(plan.apply).toContain(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_kernel_claims_active_lease ON kernel_claims (issue_id) WHERE state = 'active';",
		);
		expect(plan.rollback).toContain('DROP INDEX IF EXISTS idx_kernel_claims_active_lease;');
	});

	test('rejects duplicate migration IDs', () => {
		const migration = {
			id: '001_kernel_schema',
			apply: ['SELECT 1;'],
			rollback: ['SELECT 0;'],
		};

		expect(() => validateKernelMigrations([migration, migration])).toThrow('Duplicate Kernel migration id');
	});

	test('orders multiple migrations forward and rolls them back in reverse migration order', () => {
		const migrations = [
			{
				id: '001_kernel_schema',
				apply: ['APPLY 1A;', 'APPLY 1B;'],
				rollback: ['ROLLBACK 1B;', 'ROLLBACK 1A;'],
			},
			{
				id: '002_kernel_projection_status',
				apply: ['APPLY 2;'],
				rollback: ['ROLLBACK 2;'],
			},
		];

		const plan = buildKernelMigrationPlan(migrations);

		expect(plan.apply).toEqual(['APPLY 1A;', 'APPLY 1B;', 'APPLY 2;']);
		expect(plan.rollback).toEqual(['ROLLBACK 2;', 'ROLLBACK 1B;', 'ROLLBACK 1A;']);
	});

	test('rejects malformed references and index columns before rendering SQL', () => {
		const schema = getKernelSchema();
		const badReferenceTable = {
			...schema.tables[0],
			fields: [
				...schema.tables[0].fields,
				{
					name: 'bad_reference_id',
					type: 'TEXT',
					notNull: true,
					authority: 'forge',
					storageClass: 'authority',
					references: 'issues.id.extra',
				},
			],
		};
		const badIndexTable = {
			...schema.tables[0],
			indexes: [{
				name: 'idx_kernel_bad_column',
				columns: ['status, priority_rank'],
				unique: false,
			}],
		};

		expect(() => buildSchemaMigration({ tables: [badReferenceTable] })).toThrow('Invalid Kernel SQL reference');
		expect(() => buildSchemaMigration({ tables: [badIndexTable] })).toThrow('Invalid Kernel SQL index column');
	});
});
