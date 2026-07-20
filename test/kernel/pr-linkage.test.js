'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
	buildKernelMigrationPlan,
	buildPrLinkageMigration,
	buildSchemaMigration,
	buildEventExpectedRevisionMigration,
	buildClaimActiveLeaseMigration,
	buildIssueContentFieldsMigration,
	buildMemoryProjectionMigration,
	buildIssueFidelityColumnsMigration,
	buildWorktreeLinkageColumnsMigration,
	buildMemoryFtsMigration,
} = require('../../lib/kernel/migrations');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Migration 009 introduces the `pr` authority table — the reconcile ledger + verdict
// store that links a PR to its issue/worktree/journal (design §3). Like migration 005
// (kernel_memories), the whole table is owned by 009: it is EXCLUDED from the 001 initial
// schema (MIGRATION_ADDED_TABLES) so a fresh DB creates it exactly once and an existing
// DB picks it up through the broker's per-migration ledger.
describe('kernel migration 009 — pr linkage table', () => {
	test('builds a create-table migration for kernel_pr with the reconcile indexes', () => {
		const migration = buildPrLinkageMigration();

		expect(migration.id).toBe('009_kernel_pr_linkage');
		// Idempotent CREATE IF NOT EXISTS so a fresh DB and an existing DB both migrate
		// cleanly through the broker ledger (create-table, no backfill).
		expect(migration.apply[0]).toContain('CREATE TABLE IF NOT EXISTS kernel_pr');
		expect(migration.apply[0]).toContain('id TEXT NOT NULL PRIMARY KEY');
		expect(migration.apply[0]).toContain('git_common_dir TEXT NOT NULL');
		expect(migration.apply[0]).toContain('number INTEGER NOT NULL');
		expect(migration.apply[0]).toContain("state TEXT NOT NULL DEFAULT 'open'");
		// The reconciler's "open PRs in this repo" index + the natural-key uniqueness guard.
		expect(migration.apply).toContain(
			'CREATE INDEX IF NOT EXISTS idx_pr_common_dir_state ON kernel_pr (git_common_dir, state);',
		);
		expect(migration.apply).toContain(
			'CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_common_dir_repo_number ON kernel_pr (git_common_dir, repo, number);',
		);
		// Rollback drops the indexes (reverse order) and the table.
		expect(migration.rollback).toEqual([
			'DROP INDEX IF EXISTS idx_pr_common_dir_repo_number;',
			'DROP INDEX IF EXISTS idx_pr_common_dir_state;',
			'DROP TABLE IF EXISTS kernel_pr;',
		]);
	});

	test('registers 009 last in the default plan and excludes kernel_pr from the 001 schema', () => {
		const plan = buildKernelMigrationPlan();

		expect(plan.migrations.map(migration => migration.id)).toEqual([
			'001_kernel_schema',
			'002_kernel_events_expected_revision',
			'003_kernel_claims_active_lease',
			'004_kernel_issues_content_fields',
			'005_kernel_memories',
			'006_kernel_issue_fidelity_columns',
			'007_kernel_worktrees_linkage_columns',
			'008_kernel_memories_fts',
			'009_kernel_pr_linkage',
		]);
		expect(plan.apply).toContain(
			'CREATE INDEX IF NOT EXISTS idx_pr_common_dir_state ON kernel_pr (git_common_dir, state);',
		);
		// KEEP-IN-SYNC guard: kernel_pr must NOT be created by 001 — it is owned by 009 so a
		// fresh DB creates it exactly once. FAILS until `pr` is added to MIGRATION_ADDED_TABLES.
		// Word-boundary match so this does not false-positive on kernel_priority_events.
		const schemaMigration = plan.migrations.find(migration => migration.id === '001_kernel_schema');
		expect(schemaMigration.apply.some(statement => /\bkernel_pr\b/.test(statement))).toBe(false);
	});
});

describe('kernel migration 009 — broker application', () => {
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

	function prTableShape() {
		return driver.queryAll('PRAGMA table_info(kernel_pr);', config)
			.then(rows => rows.map(row => ({
				name: row.name,
				type: row.type,
				notnull: Number(row.notnull),
				dflt_value: row.dflt_value,
				pk: Number(row.pk),
			})));
	}

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpr-009-'));
		config = { databasePath: path.join(tmpDir, 'kernel.sqlite') };
		driver = createBuiltinSQLiteDriver({});
	});

	afterEach(() => {
		if (driver) driver.close();
		if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('KEEP-IN-SYNC parity: a fresh DB and a migrated (pre-009) DB end with an identical kernel_pr shape', async () => {
		// The prior-schema plan (everything through 008) is exactly the default plan BEFORE
		// 009 was appended. Because 009 owns the table, a genuine pre-009 DB has no kernel_pr.
		const priorPlan = buildKernelMigrationPlan([
			buildSchemaMigration(),
			buildEventExpectedRevisionMigration(),
			buildClaimActiveLeaseMigration(),
			buildIssueContentFieldsMigration(),
			buildMemoryProjectionMigration(),
			buildIssueFidelityColumnsMigration(),
			buildWorktreeLinkageColumnsMigration(),
			buildMemoryFtsMigration(),
		]);
		await makeBroker(priorPlan).initialize();

		// FAILS until MIGRATION_ADDED_TABLES excludes `pr` from 001: otherwise 001 would
		// create kernel_pr on the pre-009 DB and this shape would be non-empty.
		const migratedBefore = await prTableShape();
		expect(migratedBefore).toEqual([]);

		// Upgrading with the full plan applies 009 and creates the table.
		const upgrade = await makeBroker(buildKernelMigrationPlan()).initialize();
		expect(upgrade.migrationsNewlyApplied).toEqual(['009_kernel_pr_linkage']);
		const migratedShape = await prTableShape();

		// A brand-new DB built straight from the full plan.
		const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpr-009-fresh-'));
		const freshConfig = { databasePath: path.join(freshDir, 'kernel.sqlite') };
		const freshDriver = createBuiltinSQLiteDriver({});
		try {
			await createLocalBroker({
				projectRoot: freshDir,
				execFileSync: () => path.join(freshDir, '.git'),
				databasePath: freshConfig.databasePath,
				driver: freshDriver,
			}).initialize();
			const freshShape = (await freshDriver.queryAll('PRAGMA table_info(kernel_pr);', freshConfig)).map(row => ({
				name: row.name,
				type: row.type,
				notnull: Number(row.notnull),
				dflt_value: row.dflt_value,
				pk: Number(row.pk),
			}));

			expect(freshShape.length).toBeGreaterThan(0);
			expect(migratedShape).toEqual(freshShape);
		} finally {
			freshDriver.close();
			fs.rmSync(freshDir, { recursive: true, force: true });
		}
	});

	test('the ledger records 009 exactly once and a re-run initialize() is a no-op', async () => {
		const first = await makeBroker().initialize();
		expect(first.migrationsNewlyApplied).toContain('009_kernel_pr_linkage');

		const second = await makeBroker().initialize();
		expect(second.migrationsNewlyApplied).toEqual([]);

		const ledger = await driver.queryAll(
			"SELECT id FROM kernel_migrations WHERE id = '009_kernel_pr_linkage';",
			config,
		);
		expect(ledger.map(row => row.id)).toEqual(['009_kernel_pr_linkage']);
	});

	test('listOpenPrs returns only state=open rows for the given git_common_dir', async () => {
		await makeBroker().initialize();

		const rows = [
			['a#1', '/repo-a/.git', 'owner/a', 1, 'open'],
			['a#2', '/repo-a/.git', 'owner/a', 2, 'merged'],
			['a#3', '/repo-a/.git', 'owner/a', 3, 'open'],
			['b#1', '/repo-b/.git', 'owner/b', 1, 'open'],
		];
		for (const [id, gitCommonDir, repo, number, state] of rows) {
			await driver.exec(
				`INSERT INTO kernel_pr (id, git_common_dir, repo, number, state, registered_at) `
				+ `VALUES ('${id}', '${gitCommonDir}', '${repo}', ${number}, '${state}', '2026-07-20T00:00:00.000Z');`,
				config,
			);
		}

		const open = await makeBroker().listOpenPrs('/repo-a/.git');

		expect(open.map(row => row.id).sort()).toEqual(['a#1', 'a#3']);
		expect(open.every(row => row.state === 'open')).toBe(true);
		expect(open.every(row => row.git_common_dir === '/repo-a/.git')).toBe(true);
	});
});
