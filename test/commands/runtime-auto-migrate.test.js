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
// first issue command and their `.beads` issues would appear to vanish. The runtime
// hook imports them ONCE (sentinel next to the DB), idempotently, announcing on
// stderr only so `--json` stdout stays a pure contract.
const NOW = '2026-07-05T00:00:00.000Z';
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

// A freshly-initialized kernel broker + the DB path the sentinel is derived from.
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

function doltOnlyProject() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-migrate-dolt-'));
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

function sentinelPathFor(dbPath) {
	return path.join(path.dirname(dbPath), 'beads-import.json');
}

describe('autoMigrateBeadsAtRuntime — first-use safety net', () => {
	test('imports a jsonl-backed Beads store into the kernel, writes the sentinel, announces', async () => {
		const { broker, dbPath } = freshKernel();
		await broker.initialize();
		const projectRoot = projectWithBeadsJsonl();
		const warnings = [];

		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: dbPath, broker },
			{ now: NOW, warn: (m) => warnings.push(m) },
		);

		expect(outcome.action).toBe('migrated');
		expect(outcome.inserted).toBe(2);

		const sentinel = JSON.parse(fs.readFileSync(sentinelPathFor(dbPath), 'utf8'));
		expect(sentinel.inserted).toBe(2);
		expect(sentinel.skipped).toBe(0);
		expect(sentinel.migratedAt).toBe(NOW);
		expect(warnings.join('\n')).toMatch(/imported 2/i);
	});

	test('skips (no migrate, no warn) when the sentinel already exists', async () => {
		const { broker, dbPath } = freshKernel();
		await broker.initialize();
		const projectRoot = projectWithBeadsJsonl();
		fs.writeFileSync(sentinelPathFor(dbPath), JSON.stringify({ migratedAt: 'earlier', inserted: 9 }));
		const warnings = [];

		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: dbPath, broker },
			{ now: NOW, warn: (m) => warnings.push(m) },
		);

		expect(outcome.action).toBe('skip');
		expect(warnings).toHaveLength(0);
		// sentinel untouched
		const sentinel = JSON.parse(fs.readFileSync(sentinelPathFor(dbPath), 'utf8'));
		expect(sentinel.inserted).toBe(9);
	});

	test('a second runtime run is a skip (the first wrote the sentinel)', async () => {
		const { broker, dbPath } = freshKernel();
		await broker.initialize();
		const projectRoot = projectWithBeadsJsonl();

		await migrateCommand.autoMigrateBeadsAtRuntime({ projectRoot, databasePath: dbPath, broker }, { now: NOW });
		const second = await migrateCommand.autoMigrateBeadsAtRuntime({ projectRoot, databasePath: dbPath, broker }, { now: NOW });

		expect(second.action).toBe('skip');
	});

	test('a kernel already holding the beads issues re-imports nothing and does not announce', async () => {
		const { broker, dbPath } = freshKernel();
		await broker.initialize();
		const projectRoot = projectWithBeadsJsonl();
		// Pre-import (as `forge setup` would) WITHOUT writing the runtime sentinel.
		await migrateCommand.autoMigrateBeadsIfPresent(projectRoot, { _broker: broker, _now: NOW });
		const warnings = [];

		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: dbPath, broker },
			{ now: NOW, warn: (m) => warnings.push(m) },
		);

		expect(outcome.action).toBe('migrated');
		expect(outcome.inserted).toBe(0);
		expect(warnings).toHaveLength(0); // nothing new imported → no announcement
		expect(fs.existsSync(sentinelPathFor(dbPath))).toBe(true);
	});

	test('a failed import writes a failure sentinel and nudges once', async () => {
		const { dbPath } = freshKernel();
		const projectRoot = projectWithBeadsJsonl();
		const throwingBroker = { importIssues: async () => { throw new Error('boom'); } };
		const warnings = [];

		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: dbPath, broker: throwingBroker },
			{ now: NOW, warn: (m) => warnings.push(m) },
		);

		expect(outcome.action).toBe('nudge');
		expect(outcome.reason).toBe('migrate-failed');
		const sentinel = JSON.parse(fs.readFileSync(sentinelPathFor(dbPath), 'utf8'));
		expect(sentinel.error).toMatch(/boom/);
		expect(warnings.join('\n')).toMatch(/forge migrate --from beads/);
	});

	test('a store with no jsonl export is skipped SILENTLY (no false nudge, no sentinel)', async () => {
		// Covers both an empty `.beads/` leftover and an export-less store: neither
		// can be auto-imported, and neither should nudge (the empty-dir false positive
		// that removing the Dolt branch fixes).
		const { dbPath } = freshKernel();
		const projectRoot = doltOnlyProject();
		const warnings = [];

		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: dbPath, broker: null },
			{ now: NOW, warn: (m) => warnings.push(m) },
		);

		expect(outcome.action).toBe('skip');
		expect(outcome.reason).toBe('no-jsonl');
		expect(warnings).toHaveLength(0);
		expect(fs.existsSync(sentinelPathFor(dbPath))).toBe(false);
	});

	test('no Beads store at all → skip, no sentinel, no warn', async () => {
		const { dbPath } = freshKernel();
		const projectRoot = bareProject();
		const warnings = [];

		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: dbPath, broker: null },
			{ now: NOW, warn: (m) => warnings.push(m) },
		);

		expect(outcome.action).toBe('skip');
		expect(warnings).toHaveLength(0);
		expect(fs.existsSync(sentinelPathFor(dbPath))).toBe(false);
	});

	test('never throws — a broken fs is swallowed (safety net must not break commands)', async () => {
		const projectRoot = projectWithBeadsJsonl();
		const outcome = await migrateCommand.autoMigrateBeadsAtRuntime(
			{ projectRoot, databasePath: undefined, broker: null },
			{ now: NOW },
		);
		expect(outcome.action).toBe('skip');
	});
});

describe('resolveCommandOpts wires the runtime auto-migrate on the kernel path only', () => {
	function fakeKernelDeps(dbPath) {
		return {
			useKernelBroker: true,
			kernelBroker: { id: 'broker' },
			kernelDriver: {},
			kernelDatabasePath: dbPath,
		};
	}

	test('kernel default path invokes autoMigrateBeadsAtRuntime with the DB path + broker', async () => {
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
		expect(calls[0].projectRoot).toBe('/tmp/x');
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
});
