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
		// Rollback runs migrations in reverse, so 004's last column drop comes first.
		expect(plan.rollback[0]).toBe('ALTER TABLE kernel_issues DROP COLUMN assignee;');
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
		]);
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
