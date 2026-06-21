'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLocalBroker } = require('../../lib/kernel/broker');
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
});
