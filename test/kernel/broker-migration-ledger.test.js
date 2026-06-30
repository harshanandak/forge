'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker, execMigrationStatement } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const { buildKernelMigrationPlan } = require('../../lib/kernel/migrations');

// The kernel_migrations ledger records applied migration ids so initialize() applies
// each migration AT MOST ONCE — replacing the old "re-run the whole plan every init +
// swallow any duplicate-column error" model. ADD COLUMNs are guarded by a PRAGMA
// precondition (skip if the column already exists), so a pre-ledger DB that already has
// the columns backfills the ledger cleanly without a swallow, and a genuine SQL error
// still propagates.
describe('Kernel broker — migration ledger', () => {
	let tmpDir;
	let driver;
	let config;

	function makeBroker(migrationPlan) {
		return createLocalBroker({
			projectRoot: tmpDir,
			execFileSync: () => path.join(tmpDir, '.git'),
			databasePath: config.databasePath,
			driver,
			...(migrationPlan ? { migrationPlan } : {}),
		});
	}

	async function ledgerIds() {
		const rows = await driver.queryAll('SELECT id FROM kernel_migrations ORDER BY id ASC;', config);
		return rows.map(row => row.id);
	}

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdrv-ledger-'));
		config = { databasePath: path.join(tmpDir, 'kernel.sqlite') };
		driver = createBuiltinSQLiteDriver({});
	});

	afterEach(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('a fresh DB records every plan migration id exactly once', async () => {
		const plan = buildKernelMigrationPlan();
		const result = await makeBroker(plan).initialize();

		const expectedIds = plan.migrations.map(migration => migration.id);
		expect(result.migrationsNewlyApplied).toEqual(expectedIds);
		expect(await ledgerIds()).toEqual([...expectedIds].sort());
		const count = await driver.queryAll('SELECT COUNT(*) AS n FROM kernel_migrations;', config);
		expect(Number(count[0].n)).toBe(expectedIds.length);
	});

	test('initialize() creates the kernel_memories read-model table and a re-run is idempotent', async () => {
		const first = await makeBroker().initialize();
		expect(first.migrationsNewlyApplied).toContain('005_kernel_memories');

		// The read-model table is queryable after the first initialize().
		const empty = await driver.queryAll('SELECT COUNT(*) AS n FROM kernel_memories;', config);
		expect(Number(empty[0].n)).toBe(0);

		// A second initialize() applies nothing new and does not error (idempotent).
		const second = await makeBroker().initialize();
		expect(second.migrationsNewlyApplied).toEqual([]);
		const ids = await ledgerIds();
		expect(ids.filter(id => id === '005_kernel_memories')).toEqual(['005_kernel_memories']);
	});

	test('a second initialize applies nothing (the ledger short-circuits)', async () => {
		await makeBroker().initialize();
		const before = await ledgerIds();

		const second = await makeBroker().initialize();

		expect(second.migrationsNewlyApplied).toEqual([]);
		expect(await ledgerIds()).toEqual(before);
	});

	test('an existing DB whose ledger was lost backfills without a duplicate-column throw', async () => {
		await makeBroker().initialize();
		// Simulate a pre-ledger DB: the columns exist, but the ledger does not.
		await driver.exec('DROP TABLE kernel_migrations;', config);

		const result = await makeBroker().initialize();

		expect(result.success).toBe(true);
		// Guarded ADD COLUMN skipped the already-present columns; the ledger is backfilled.
		const planIds = buildKernelMigrationPlan().migrations.map(migration => migration.id);
		expect(await ledgerIds()).toEqual([...planIds].sort());
	});

	test('migration 006 backfills the beads fidelity columns on a DB created at the prior schema version', async () => {
		const {
			buildSchemaMigration,
			buildEventExpectedRevisionMigration,
			buildClaimActiveLeaseMigration,
			buildIssueContentFieldsMigration,
			buildMemoryProjectionMigration,
		} = require('../../lib/kernel/migrations');
		const fidelityColumns = ['created_by', 'closed_at', 'close_reason', 'metadata'];

		// A DB migrated only through 005 — the schema version BEFORE the fidelity columns.
		const priorPlan = buildKernelMigrationPlan([
			buildSchemaMigration(),
			buildEventExpectedRevisionMigration(),
			buildClaimActiveLeaseMigration(),
			buildIssueContentFieldsMigration(),
			buildMemoryProjectionMigration(),
		]);
		await makeBroker(priorPlan).initialize();

		const before = await driver.queryAll('PRAGMA table_info(kernel_issues);', config);
		const beforeCols = before.map(col => col.name);
		for (const column of fidelityColumns) {
			expect(beforeCols).not.toContain(column);
		}

		// The full plan adds migration 006, which ALTERs the four columns in without error.
		const result = await makeBroker(buildKernelMigrationPlan()).initialize();
		expect(result.success).toBe(true);
		expect(result.migrationsNewlyApplied).toEqual(['006_kernel_issue_fidelity_columns']);

		const after = await driver.queryAll('PRAGMA table_info(kernel_issues);', config);
		const afterCols = after.map(col => col.name);
		for (const column of fidelityColumns) {
			expect(afterCols).toContain(column);
		}
	});

	test('a newly added ADD COLUMN migration applies once on an up-to-date DB', async () => {
		await makeBroker().initialize();

		const newMigration = {
			id: '900_ledger_test_new_column',
			apply: ['ALTER TABLE kernel_issues ADD COLUMN ledger_test_col TEXT;'],
			rollback: ['ALTER TABLE kernel_issues DROP COLUMN ledger_test_col;'],
		};
		const extendedPlan = buildKernelMigrationPlan([
			...buildKernelMigrationPlan().migrations,
			newMigration,
		]);

		const applied = await makeBroker(extendedPlan).initialize();
		expect(applied.migrationsNewlyApplied).toEqual([newMigration.id]);
		const cols = await driver.queryAll('PRAGMA table_info(kernel_issues);', config);
		expect(cols.some(col => col.name === 'ledger_test_col')).toBe(true);

		const reapplied = await makeBroker(extendedPlan).initialize();
		expect(reapplied.migrationsNewlyApplied).toEqual([]);
	});

	test('two brokers initializing the same DB concurrently both succeed with one ledger row per migration', async () => {
		// Integration realism for the concurrent-init path. NOTE: this is SCHEDULING-
		// DEPENDENT — whether the second init lands in the pre-check or the TOCTOU catch
		// is microtask-ordering luck, so it can pass even on unfixed code when scheduling
		// happens to serialize. It asserts only the end state; the DETERMINISTIC guard
		// for the catch path lives in the execMigrationStatement suite below.
		const driver2 = createBuiltinSQLiteDriver({});
		try {
			const a = makeBroker();
			const b = createLocalBroker({
				projectRoot: tmpDir,
				execFileSync: () => path.join(tmpDir, '.git'),
				databasePath: config.databasePath,
				driver: driver2,
			});

			const [resultA, resultB] = await Promise.all([a.initialize(), b.initialize()]);

			expect(resultA.success).toBe(true);
			expect(resultB.success).toBe(true);
			const planIds = buildKernelMigrationPlan().migrations.map(migration => migration.id);
			expect(await ledgerIds()).toEqual([...planIds].sort());
		} finally {
			driver2.close();
		}
	});
});

// Deterministic guards for the ADD COLUMN TOCTOU catch path. These drive
// execMigrationStatement with a fake driver so the exact "another writer added the
// column between our pre-check and our exec" interleaving is forced every run (no
// reliance on scheduling). The first FAILS on the pre-fix code (which had no catch).
describe('Kernel broker — execMigrationStatement ADD COLUMN race (TOCTOU)', () => {
	const ADD_COLUMN = 'ALTER TABLE kernel_issues ADD COLUMN design TEXT;';

	test('skips (does not throw) when a concurrent writer adds the column between pre-check and exec', async () => {
		// Pre-check sees the column MISSING; exec then loses the race and throws
		// duplicate-column; the catch re-verifies and now sees it PRESENT → skip.
		let pragmaCalls = 0;
		const driver = {
			async queryAll(statement) {
				if (/PRAGMA table_info/i.test(statement)) {
					pragmaCalls += 1;
					return pragmaCalls === 1 ? [] : [{ name: 'design' }];
				}
				return [];
			},
			async exec() {
				throw new Error('SQLITE_ERROR: duplicate column name: design');
			},
		};

		const result = await execMigrationStatement(driver, ADD_COLUMN, {});

		expect(result).toEqual({ skipped: true, reason: 'column-added-concurrently' });
		expect(pragmaCalls).toBe(2); // pre-check + post-failure re-verify
	});

	test('rethrows when exec fails and the column is still absent (no blanket swallow)', async () => {
		// A non-duplicate failure with the column never appearing must propagate.
		const driver = {
			async queryAll() {
				return []; // column never present
			},
			async exec() {
				throw new Error('SQLITE_ERROR: disk I/O error');
			},
		};

		await expect(execMigrationStatement(driver, ADD_COLUMN, {}))
			.rejects.toThrow(/disk I\/O error/);
	});

	test('surfaces the original exec error when the post-failure re-check itself throws', async () => {
		let pragmaCalls = 0;
		const driver = {
			async queryAll(statement) {
				if (/PRAGMA table_info/i.test(statement)) {
					pragmaCalls += 1;
					if (pragmaCalls === 1) return []; // pre-check: missing
					throw new Error('re-check boom'); // post-failure re-verify blows up
				}
				return [];
			},
			async exec() {
				throw new Error('original exec failure');
			},
		};

		await expect(execMigrationStatement(driver, ADD_COLUMN, {}))
			.rejects.toThrow(/original exec failure/);
	});
});
