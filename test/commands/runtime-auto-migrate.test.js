'use strict';

const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migrateCommand = require('../../lib/commands/migrate');
const { resolveCommandOpts } = require('../../lib/commands/_resolve-command-opts');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');

// Runtime safety net (fix/upgrade-safety-beads-nudge): the kernel is the DEFAULT
// backend, but onboarding auto-migrate only runs from `forge setup`/`init`. An
// existing repo whose user merely upgrades forge would read an EMPTY kernel on the
// first issue command and their existing Beads issues would appear to vanish. The
// runtime hook imports them ONCE, gated by an IN-DB marker row in the kernel_migrations
// ledger (so the gate shares the DB lifecycle and a DB reset self-heals), idempotently,
// announcing on stderr only so `--json` stdout stays a pure contract.
const NOW = '2026-07-05T00:00:00.000Z';
const MARKER_ID = 'data_import_beads_jsonl';
const fixtureDir = path.join(__dirname, '..', 'fixtures', 'beads-migrate', 'legacy-backup');

const cleanups = [];

afterEach(() => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		try {
			cleanup();
		} catch (_err) {
			/* best-effort temp cleanup */ // NOSONAR S2486
		}
	}
});

// A freshly-created kernel broker + its driver + the DB path the ledger marker lives in.
function freshKernel() {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-migrate-db-'));
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

function projectWithBeadsJsonl() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-migrate-repo-'));
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

// A store with a .beads/ dir but NO jsonl export (Dolt-only or an empty leftover).
function noJsonlProject() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-migrate-nojsonl-'));
	const beadsDir = path.join(root, '.beads');
	fs.mkdirSync(beadsDir, { recursive: true });
	fs.writeFileSync(path.join(beadsDir, 'beads.db'), 'not-jsonl');
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

function bareProject() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-migrate-bare-'));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

// Count the in-DB import marker rows via the driver (kernel_migrations must exist —
// broker.initialize() creates it unconditionally).
async function importMarkerCount(driver, dbPath) {
	const rows = await driver.queryAll(
		`SELECT id FROM kernel_migrations WHERE id = '${MARKER_ID}';`,
		{ databasePath: dbPath },
	);
	return Array.isArray(rows) ? rows.length : 0;
}

describe('autoMigrateBeadsAtRuntime — first-use safety net', () => {
	test('imports a jsonl-backed Beads store, records the in-DB marker, announces', async () => {
		const { broker, dbPath, driver } = freshKernel();
		await broker.initialize();
		const projectRoot = projectWithBeadsJsonl();
		const warnings = [];

		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: dbPath, broker, driver },
			{ now: NOW, warn: (m) => warnings.push(m) },
		);

		expect(outcome.action).toBe('migrated');
		expect(outcome.inserted).toBe(2);
		expect(await importMarkerCount(driver, dbPath)).toBe(1);
		expect(warnings.join('\n')).toMatch(/imported 2/i);
	});

	test('skips (no migrate, no warn) when the in-DB marker already exists', async () => {
		const { broker, dbPath, driver } = freshKernel();
		await broker.initialize();
		const projectRoot = projectWithBeadsJsonl();
		// Pre-seed the marker directly in the ledger.
		await driver.exec(
			`INSERT OR IGNORE INTO kernel_migrations (id, applied_at) VALUES ('${MARKER_ID}', 'earlier');`,
			{ databasePath: dbPath },
		);
		const warnings = [];

		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: dbPath, broker, driver },
			{ now: NOW, warn: (m) => warnings.push(m) },
		);

		expect(outcome.action).toBe('skip');
		expect(outcome.reason).toBe('already-imported');
		expect(warnings).toHaveLength(0);
	});

	test('a second runtime run is a skip (the first recorded the marker)', async () => {
		const { broker, dbPath, driver } = freshKernel();
		await broker.initialize();
		const projectRoot = projectWithBeadsJsonl();

		await migrateCommand.autoMigrateBeadsAtRuntime({ projectRoot, databasePath: dbPath, broker, driver }, { now: NOW });
		const second = await migrateCommand.autoMigrateBeadsAtRuntime({ projectRoot, databasePath: dbPath, broker, driver }, { now: NOW });

		expect(second.action).toBe('skip');
		expect(await importMarkerCount(driver, dbPath)).toBe(1);
	});

	test('a kernel already holding the issues re-imports nothing, still records the marker, no announce', async () => {
		const { broker, dbPath, driver } = freshKernel();
		await broker.initialize();
		const projectRoot = projectWithBeadsJsonl();
		// Pre-import (as `forge setup` would) WITHOUT recording the runtime marker.
		await migrateCommand.autoMigrateBeadsIfPresent(projectRoot, { _broker: broker, _now: NOW });
		const warnings = [];

		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: dbPath, broker, driver },
			{ now: NOW, warn: (m) => warnings.push(m) },
		);

		expect(outcome.action).toBe('migrated');
		expect(outcome.inserted).toBe(0);
		expect(warnings).toHaveLength(0); // nothing new imported → no announcement
		expect(await importMarkerCount(driver, dbPath)).toBe(1);
	});

	test('a failed import records NO marker and nudges (retried next run — success-only)', async () => {
		const { broker, dbPath, driver } = freshKernel();
		await broker.initialize(); // create kernel_migrations so the marker query is valid
		const projectRoot = projectWithBeadsJsonl();
		const throwingBroker = { importIssues: async () => { throw new Error('boom'); } };
		const warnings = [];

		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: dbPath, broker: throwingBroker, driver },
			{ now: NOW, warn: (m) => warnings.push(m) },
		);

		expect(outcome.action).toBe('nudge');
		expect(outcome.reason).toBe('migrate-failed');
		expect(outcome.error).toMatch(/boom/);
		expect(warnings.join('\n')).toMatch(/forge migrate --from beads/);
		// Success-only marker: a failure records nothing, so the next run retries.
		expect(await importMarkerCount(driver, dbPath)).toBe(0);
	});

	test('a store with no jsonl export is skipped SILENTLY (no false nudge, no marker)', async () => {
		// Covers both an empty `.beads/` leftover and an export-less store: neither can
		// be auto-imported, and neither should nudge (the empty-dir false positive that
		// removing the Dolt branch fixed).
		const { broker, dbPath, driver } = freshKernel();
		await broker.initialize();
		const projectRoot = noJsonlProject();
		const warnings = [];

		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: dbPath, broker: null, driver },
			{ now: NOW, warn: (m) => warnings.push(m) },
		);

		expect(outcome.action).toBe('skip');
		expect(outcome.reason).toBe('no-jsonl');
		expect(warnings).toHaveLength(0);
		expect(await importMarkerCount(driver, dbPath)).toBe(0);
	});

	test('no Beads store at all → skip, no marker, no warn', async () => {
		const { broker, dbPath, driver } = freshKernel();
		await broker.initialize();
		const projectRoot = bareProject();
		const warnings = [];

		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: dbPath, broker: null, driver },
			{ now: NOW, warn: (m) => warnings.push(m) },
		);

		expect(outcome.action).toBe('skip');
		expect(outcome.reason).toBe('no-jsonl');
		expect(warnings).toHaveLength(0);
		expect(await importMarkerCount(driver, dbPath)).toBe(0);
	});

	test('never throws — an absent databasePath is swallowed (safety net must not break commands)', async () => {
		const projectRoot = projectWithBeadsJsonl();
		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: undefined, broker: null, driver: null },
			{ now: NOW },
		);
		expect(outcome.action).toBe('skip');
		expect(outcome.reason).toBe('no-db-path');
	});
});

describe('resolveCommandOpts wires the runtime auto-migrate on the kernel path only', () => {
	function fakeKernelDeps(dbPath) {
		return {
			useKernelBroker: true,
			kernelBroker: { id: 'broker' },
			kernelDriver: { id: 'driver' },
			kernelDatabasePath: dbPath,
		};
	}

	test('kernel default path invokes autoMigrateBeadsAtRuntime with the DB path + broker + driver', async () => {
		const calls = [];
		const dbPath = '/tmp/x/forge/kernel.sqlite';
		const { commandOpts } = await resolveCommandOpts('list', [], {
			env: {},
			projectRoot: '/tmp/x',
			buildKernelIssueDeps: async () => fakeKernelDeps(dbPath),
			autoMigrateBeadsAtRuntime: async (params) => { calls.push(params); },
		});

		expect(commandOpts.issueBackend).toBe('kernel');
		expect(calls).toHaveLength(1);
		expect(calls[0].databasePath).toBe(dbPath);
		expect(calls[0].broker).toEqual({ id: 'broker' });
		expect(calls[0].driver).toEqual({ id: 'driver' });
		expect(calls[0].projectRoot).toBe('/tmp/x');
	});

	test('kernel-tool command (export) also invokes the runtime auto-migrate with the driver', async () => {
		const calls = [];
		const dbPath = '/tmp/x/forge/kernel.sqlite';
		await resolveCommandOpts('export', [], {
			env: {},
			projectRoot: '/tmp/x',
			buildKernelIssueDeps: async () => fakeKernelDeps(dbPath),
			autoMigrateBeadsAtRuntime: async (params) => { calls.push(params); },
		});

		expect(calls).toHaveLength(1);
		expect(calls[0].driver).toEqual({ id: 'driver' });
	});

	test('explicit beads backend does NOT invoke the runtime auto-migrate', async () => {
		const calls = [];
		const { commandOpts } = await resolveCommandOpts('list', ['--issue-backend', 'beads'], {
			env: {},
			projectRoot: '/tmp/x',
			buildKernelIssueDeps: async () => fakeKernelDeps('/tmp/x/forge/kernel.sqlite'),
			autoMigrateBeadsAtRuntime: async (params) => { calls.push(params); },
		});

		expect(commandOpts.issueBackend).toBe('beads');
		expect(calls).toHaveLength(0);
	});

	test('a throwing auto-migrate never breaks command-opts resolution', async () => {
		const dbPath = '/tmp/x/forge/kernel.sqlite';
		const { commandOpts } = await resolveCommandOpts('list', [], {
			env: {},
			projectRoot: '/tmp/x',
			buildKernelIssueDeps: async () => fakeKernelDeps(dbPath),
			autoMigrateBeadsAtRuntime: async () => { throw new Error('should be swallowed'); },
		});
		expect(commandOpts.issueBackend).toBe('kernel');
	});

	test('runs the REAL migrate require() path (no injection) without ever throwing', async () => {
		// With no autoMigrateBeadsAtRuntime injected, the shared helper resolves
		// require('./migrate') INSIDE its try — a bare temp dir has no jsonl store, so the
		// real hook is a safe no-op and command-opts resolution still succeeds.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-real-require-'));
		cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
		const dbPath = path.join(tmp, 'kernel.sqlite');
		const { commandOpts } = await resolveCommandOpts('list', [], {
			env: {},
			projectRoot: tmp,
			buildKernelIssueDeps: async () => ({
				useKernelBroker: true,
				kernelBroker: { id: 'broker' },
				kernelDriver: { id: 'driver' },
				kernelDatabasePath: dbPath,
			}),
		});
		expect(commandOpts.issueBackend).toBe('kernel');
	});
});
