'use strict';

const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migrateCommand = require('../../lib/commands/migrate');
const setupCommand = require('../../lib/commands/setup');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Beads → Kernel transfer is now EXPLICIT-ONLY (a7e1443c): `forge setup` no longer
// silently imports an existing Beads store, and the migrate module exposes no
// implicit auto-migrate seam. The ONLY way to move Beads data into the Kernel is
// to run `forge migrate --from beads` by hand — which must still work, offline,
// reading the committed *.jsonl sidecars directly (no `bd`/Dolt binary).
const NOW = '2026-06-30T00:00:00.000Z';
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

function freshBroker() {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-explicit-migrate-'));
	const dbPath = path.join(tmpDir, 'kernel.sqlite');
	const config = { databasePath: dbPath };
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
	return { tmpDir, dbPath, config, driver, broker };
}

describe('setup/init never auto-migrate Beads — the transfer is explicit-only (a7e1443c)', () => {
	test('setup exposes no autoMigrateBeadsToKernel seam', () => {
		expect(setupCommand.autoMigrateBeadsToKernel).toBeUndefined();
	});

	test('the migrate module exposes no implicit auto-migrate / detection seam', () => {
		expect(migrateCommand.autoMigrateBeadsIfPresent).toBeUndefined();
		expect(migrateCommand.autoMigrateBeadsAtRuntime).toBeUndefined();
		expect(migrateCommand.detectBeadsJsonlSource).toBeUndefined();
	});
});

describe('explicit forge migrate --from beads still works, offline (a7e1443c)', () => {
	test('imports issues + comments + deps into the Kernel from committed jsonl sidecars', async () => {
		const { tmpDir, config, driver, broker } = freshBroker();
		await broker.initialize();

		const result = await migrateCommand.handler([], {
			from: 'beads',
			source: fixtureDir,
			json: true,
		}, tmpDir, { _broker: broker, _now: NOW });

		expect(result.success).toBe(true);
		expect(result.imported.issues.inserted).toBe(2);

		const rows = await driver.queryAll('SELECT id FROM kernel_issues', config);
		expect(rows).toHaveLength(2);
	});
});
