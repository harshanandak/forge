'use strict';

const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migrateCommand = require('../../lib/commands/migrate');
const setupCommand = require('../../lib/commands/setup');
const initCommand = require('../../lib/commands/init');
const { resolveCommandOpts } = require('../../lib/commands/_resolve-command-opts');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// `forge migrate` is the SOLE Beads → Kernel invocation path (a7e1443c): it is
// only ever run explicitly. NO default path — no per-command runtime hook, no
// setup, no init — may trigger a migration. These tests pin that contract: the
// implicit auto-migrate hooks are GONE from every module, and a kernel command
// run in a repo that STILL has a committed .beads/ jsonl store imports nothing.
const fixtureDir = path.join(__dirname, '..', 'fixtures', 'beads-migrate', 'legacy-backup');

const cleanups = [];
afterEach(() => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		try {
			cleanup();
		} catch (_err) {
			/* intentional: best-effort temp cleanup */ // NOSONAR S2486
		}
	}
});

// A temp repo that carries a real, committed .beads/ jsonl store plus a fresh,
// initialized Kernel broker + driver (the every-command path's kernel deps).
function repoWithBeadsStore() {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-no-automigrate-'));
	const beadsDir = path.join(tmpDir, '.beads');
	fs.mkdirSync(beadsDir, { recursive: true });
	for (const file of fs.readdirSync(fixtureDir)) {
		fs.copyFileSync(path.join(fixtureDir, file), path.join(beadsDir, file));
	}
	const dbPath = path.join(tmpDir, 'kernel.sqlite');
	const driver = createBuiltinSQLiteDriver({});
	const broker = createLocalBroker({
		projectRoot: tmpDir,
		execFileSync: () => path.join(tmpDir, '.git'),
		databasePath: dbPath,
		driver,
	});
	cleanups.push(() => {
		driver.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
	return { tmpDir, dbPath, driver, broker };
}

describe('forge migrate is the sole Beads → Kernel path — no implicit migration (a7e1443c)', () => {
	test('the implicit auto-migrate hooks no longer exist on any module', () => {
		expect(migrateCommand.autoMigrateBeadsAtRuntime).toBeUndefined();
		expect(migrateCommand.autoMigrateBeadsIfPresent).toBeUndefined();
		expect(migrateCommand.detectBeadsJsonlSource).toBeUndefined();
		expect(setupCommand.autoMigrateBeadsToKernel).toBeUndefined();
		// init exposes no auto-migrate seam either.
		expect(initCommand.autoMigrateBeads).toBeUndefined();
	});

	test('a kernel command in a repo with a .beads/ store imports NOTHING', async () => {
		const { tmpDir, dbPath, driver, broker } = repoWithBeadsStore();
		await broker.initialize();
		const config = { databasePath: dbPath };

		// Drive the every-command kernel path exactly as dispatch does. Before the
		// implicit hook was removed this silently imported the fixture's 2 issues.
		await resolveCommandOpts('show', [], {
			projectRoot: tmpDir,
			databasePath: dbPath,
			buildKernelIssueDeps: async () => ({
				issueBackend: 'kernel',
				kernelBroker: broker,
				kernelDriver: driver,
				kernelDatabasePath: dbPath,
			}),
		});

		const rows = await driver.queryAll('SELECT id FROM kernel_issues', config);
		expect(rows).toHaveLength(0);
	});

	test('the kernel-tool (export) path also imports NOTHING', async () => {
		const { tmpDir, dbPath, driver, broker } = repoWithBeadsStore();
		await broker.initialize();
		const config = { databasePath: dbPath };

		await resolveCommandOpts('export', [], {
			projectRoot: tmpDir,
			databasePath: dbPath,
			buildKernelIssueDeps: async () => ({
				issueBackend: 'kernel',
				kernelBroker: broker,
				kernelDriver: driver,
				kernelDatabasePath: dbPath,
			}),
		});

		const rows = await driver.queryAll('SELECT id FROM kernel_issues', config);
		expect(rows).toHaveLength(0);
	});
});
