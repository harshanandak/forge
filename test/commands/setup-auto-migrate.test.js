'use strict';

const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migrateCommand = require('../../lib/commands/migrate');
const setupCommand = require('../../lib/commands/setup');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Gap 1 coverage: installing Forge onto a repo that already has a Beads store
// must auto-import the issues/comments/deps into the Kernel — without the user
// ever running `forge migrate` by hand, and without requiring the `bd` binary
// (the migrater reads the committed *.jsonl sidecars directly). The auto-migrate
// spine is idempotent, so it is safe to run on every setup.
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
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-auto-migrate-kernel-'));
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

// A project whose .beads/ holds jsonl sidecars (the split-layout the migrater
// already understands) — copied from the committed legacy-backup fixture.
function projectWithBeadsJsonl() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-auto-migrate-repo-'));
	const beadsDir = path.join(root, '.beads');
	fs.mkdirSync(beadsDir, { recursive: true });
	for (const entry of fs.readdirSync(fixtureDir)) {
		if (entry.endsWith('.jsonl')) {
			fs.copyFileSync(path.join(fixtureDir, entry), path.join(beadsDir, entry));
		}
	}
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

function bareProject() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-auto-migrate-bare-'));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

describe('beads → kernel jsonl detection (bd-free)', () => {
	test('detects a .beads/ directory that holds *.jsonl sidecars', () => {
		const root = projectWithBeadsJsonl();
		expect(migrateCommand.detectBeadsJsonlSource(root)).toBe(path.join(root, '.beads'));
	});

	test('returns null when there is no .beads/ store', () => {
		expect(migrateCommand.detectBeadsJsonlSource(bareProject())).toBeNull();
	});

	test('returns null for a Dolt-only .beads/ (no jsonl) so setup never shells out to bd', () => {
		const root = bareProject();
		const beadsDir = path.join(root, '.beads');
		fs.mkdirSync(beadsDir, { recursive: true });
		fs.writeFileSync(path.join(beadsDir, 'beads.db'), 'not-jsonl');
		expect(migrateCommand.detectBeadsJsonlSource(root)).toBeNull();
	});
});

describe('autoMigrateBeadsIfPresent', () => {
	test('imports a jsonl-backed Beads store into the Kernel', async () => {
		const { broker, driver, config } = freshBroker();
		await broker.initialize();
		const root = projectWithBeadsJsonl();

		const outcome = await migrateCommand.autoMigrateBeadsIfPresent(root, { _broker: broker, _now: NOW });

		expect(outcome.migrated).toBe(true);
		expect(outcome.result.imported.issues.inserted).toBe(2);

		const aa1 = await driver.issueOperation('show', ['forge-aa1'], {}, config);
		expect(aa1.data.status).toBe('open');
		const bb2 = await driver.issueOperation('show', ['forge-bb2'], {}, config);
		expect(bb2.data.dependencies).toContain('forge-aa1');
	});

	test('is a no-op when the repo has no Beads store', async () => {
		const outcome = await migrateCommand.autoMigrateBeadsIfPresent(bareProject(), { _now: NOW });
		expect(outcome.migrated).toBe(false);
		expect(outcome.reason).toBe('no-beads-jsonl');
	});

	test('a second run is idempotent (nothing re-imported)', async () => {
		const { broker } = freshBroker();
		await broker.initialize();
		const root = projectWithBeadsJsonl();

		await migrateCommand.autoMigrateBeadsIfPresent(root, { _broker: broker, _now: NOW });
		const second = await migrateCommand.autoMigrateBeadsIfPresent(root, { _broker: broker, _now: NOW });

		expect(second.migrated).toBe(true);
		expect(second.result.imported.issues.inserted).toBe(0);
		expect(second.result.imported.issues.skipped).toBe(2);
	});
});

describe('forge setup auto-populates the Kernel from an existing Beads store', () => {
	test('setup.autoMigrateBeadsToKernel drives the migrate spine into the Kernel', async () => {
		const { broker, driver, config } = freshBroker();
		await broker.initialize();
		const root = projectWithBeadsJsonl();

		const saved = setupCommand._getState();
		setupCommand._setState({ projectRoot: root });
		try {
			const outcome = await setupCommand.autoMigrateBeadsToKernel({ _broker: broker, _now: NOW });
			expect(outcome.migrated).toBe(true);
		} finally {
			setupCommand._setState({ projectRoot: saved.projectRoot });
		}

		const aa1 = await driver.issueOperation('show', ['forge-aa1'], {}, config);
		expect(aa1.data.created_by).toBe('Harsha Nanda');
	});
});
