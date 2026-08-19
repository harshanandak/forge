const { describe, expect, test } = require('bun:test');
const { Database } = require('bun:sqlite');

const {
	buildKernelMigrationPlan,
	buildPrWatchOwnershipMigration,
	buildSchemaMigration,
} = require('../../lib/kernel/migrations');

const PR_WATCH_ROLLBACK_SQL = "INSERT INTO kernel_pr_watch_migration_gate (singleton, state, snapshot_hash, conflict_code, updated_at) VALUES (1, 'quarantined', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(singleton) DO UPDATE SET state = 'quarantined', conflict_code = NULL, updated_at = excluded.updated_at;";
const {
	field,
	getKernelSchema,
	table,
	validateKernelSchema,
} = require('../../lib/kernel/schema');

function schemaWithPrimaryKey(primaryKey, fields = [
	field('repo', 'TEXT', { notNull: true }),
	field('pr', 'INTEGER', { notNull: true }),
]) {
	return {
		version: 1,
		tables: [table('watch_owner_fixture', 'authority', fields, [], { primaryKey })],
	};
}

describe('kernel table-level primary keys', () => {
	test('renders an ordered composite primary key', () => {
		const schema = {
			version: 1,
			tables: [table('watch_owner_fixture', 'authority', [
				field('repo', 'TEXT', { notNull: true }),
				field('pr', 'INTEGER', { notNull: true }),
				field('phase', 'TEXT', { notNull: true }),
			], [], { primaryKey: ['repo', 'pr'] })],
		};

		expect(buildSchemaMigration(schema).apply).toEqual([
			'CREATE TABLE IF NOT EXISTS kernel_watch_owner_fixture (\n'
			+ '  repo TEXT NOT NULL,\n'
			+ '  pr INTEGER NOT NULL,\n'
			+ '  phase TEXT NOT NULL,\n'
			+ '  PRIMARY KEY (repo, pr)\n'
			+ ');',
		]);
	});

	test.each([
		['empty', [], undefined, 'expected a non-empty column array'],
		['unknown', ['repo', 'missing'], undefined, 'Unknown table primary key column'],
		['duplicate', ['repo', 'repo'], undefined, 'Duplicate table primary key column'],
		['nullable', ['repo', 'pr'], [
			field('repo', 'TEXT', { notNull: true }),
			field('pr', 'INTEGER'),
		], 'Nullable table primary key column'],
		['mixed field/table', ['repo', 'pr'], [
			field('repo', 'TEXT', { primaryKey: true }),
			field('pr', 'INTEGER', { notNull: true }),
		], 'Mixed field and table primary keys'],
	])('rejects a %s table primary key', (_label, primaryKey, fields, message) => {
		expect(() => validateKernelSchema(schemaWithPrimaryKey(primaryKey, fields)))
			.toThrow(message);
	});
});

describe('PR watch ownership schema', () => {
	test('defines one composite-key owner row and a lifecycle-free singleton migration gate', () => {
		const schema = getKernelSchema();
		const owners = schema.tables.find(candidate => candidate.name === 'pr_watch_owners');
		const gate = schema.tables.find(candidate => candidate.name === 'pr_watch_migration_gate');

		expect(owners.primaryKey).toEqual(['repo', 'pr']);
		expect(owners.fields.map(candidate => candidate.name)).toEqual([
			'repo',
			'pr',
			'version',
			'generation',
			'phase',
			'controller_pid',
			'watcher_pid',
			'started_at',
			'updated_at',
			'heartbeat_at',
			'terminal_receipt_id',
			'block_reason',
			'legacy_evidence_hash',
		]);
		expect(gate.fields.map(candidate => candidate.name)).toEqual([
			'singleton',
			'state',
			'snapshot_hash',
			'conflict_code',
			'updated_at',
		]);
		expect(gate.fields.find(candidate => candidate.name === 'singleton')).toMatchObject({
			primaryKey: true,
			notNull: true,
		});
		expect(gate.fields.map(candidate => candidate.name)).not.toEqual(expect.arrayContaining([
			'repo',
			'pr',
			'generation',
			'controller_pid',
			'watcher_pid',
			'phase',
			'terminal_receipt_id',
		]));
	});

	test('uses identical owner DDL for the current schema and additive migration', () => {
		const ownerTables = getKernelSchema().tables.filter(candidate => (
			candidate.name === 'pr_watch_owners'
			|| candidate.name === 'pr_watch_migration_gate'
		));
		const migration = buildPrWatchOwnershipMigration();

		expect(migration.id).toBe('012_kernel_pr_watch_ownership');
		expect(migration.apply).toEqual(buildSchemaMigration({ version: 1, tables: ownerTables }).apply);
		expect(migration.apply[0]).toContain('PRIMARY KEY (repo, pr)');
		expect(migration.apply[1]).toContain('CHECK (singleton = 1)');
	});

	test('retains authority and fails the migration gate closed on rollback', () => {
		expect(buildPrWatchOwnershipMigration().rollback).toEqual([
			PR_WATCH_ROLLBACK_SQL,
		]);
	});

	test.each([
		['absent', null, null],
		['quarantined-unbound', { state: 'quarantined', snapshotHash: null, conflictCode: null }, null],
		['quarantined-bound', { state: 'quarantined', snapshotHash: 'a'.repeat(64), conflictCode: null }, 'a'.repeat(64)],
		['conflict', { state: 'conflict', snapshotHash: 'b'.repeat(64), conflictCode: 'legacy_owner_conflict' }, 'b'.repeat(64)],
		['complete', { state: 'complete', snapshotHash: 'c'.repeat(64), conflictCode: null }, 'c'.repeat(64)],
	])('rollback leaves a valid fail-closed gate from %s state', (_label, initial, expectedHash) => {
		const database = new Database(':memory:');
		try {
			for (const statement of buildPrWatchOwnershipMigration().apply) database.exec(statement);
			if (initial) {
				database.query(`INSERT INTO kernel_pr_watch_migration_gate
					(singleton, state, snapshot_hash, conflict_code, updated_at) VALUES (1, ?, ?, ?, ?)`)
					.run(initial.state, initial.snapshotHash, initial.conflictCode, '2026-08-19T00:00:00.000Z');
			}

			database.exec(buildPrWatchOwnershipMigration().rollback[0]);
			const row = database.query('SELECT * FROM kernel_pr_watch_migration_gate WHERE singleton = 1').get();
			expect(row).toMatchObject({
				singleton: 1,
				state: 'quarantined',
				snapshot_hash: expectedHash,
				conflict_code: null,
			});
			expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		} finally {
			database.close();
		}
	});

	test('enforces composite owner identity and singleton gate in SQLite', () => {
		const database = new Database(':memory:');
		try {
			for (const statement of buildPrWatchOwnershipMigration().apply) {
				database.exec(statement);
			}
			const primaryKey = database.query('PRAGMA table_info(kernel_pr_watch_owners)').all()
				.filter(column => column.pk > 0)
				.map(column => ({ name: column.name, order: column.pk }));

			expect(primaryKey).toEqual([
				{ name: 'repo', order: 1 },
				{ name: 'pr', order: 2 },
			]);
			expect(() => database.exec(
				"INSERT INTO kernel_pr_watch_migration_gate (singleton, state, updated_at) VALUES (2, 'quarantined', '2026-08-19T00:00:00.000Z');",
			)).toThrow();
		} finally {
			database.close();
		}
	});

	test('keeps owner tables out of the initial migration and adds migration 012 once', () => {
		const plan = buildKernelMigrationPlan();
		const initialSql = plan.migrations[0].apply.join('\n');

		expect(initialSql).not.toContain('kernel_pr_watch_owners');
		expect(initialSql).not.toContain('kernel_pr_watch_migration_gate');
		expect(plan.migrations.filter(candidate => candidate.id === '012_kernel_pr_watch_ownership'))
			.toHaveLength(1);
	});
});
