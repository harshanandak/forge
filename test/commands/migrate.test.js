'use strict';

const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migrateCommand = require('../../lib/commands/migrate');
const { createLocalBroker } = require('../../lib/kernel/broker');
const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
const {
	importBeadsSnapshot,
	loadBeadsSnapshotFromDirectory,
} = require('../../lib/adapters/beads-kernel-compat');

// End-to-end coverage for `forge migrate --from beads`. The command is a thin CLI
// shell over the faithful-import spine: loadBeadsSnapshotFromDirectory →
// importBeadsSnapshot → broker.importIssues (see
// test/kernel/sqlite-driver-import.test.js). Tests drive the committed
// legacy-backup fixtures and an injected, initialized broker so behavior is
// deterministic (DI: _broker + _now mirror forge export's test seams).
const NOW = '2026-06-30T00:00:00.000Z';
const fixtureDir = path.join(__dirname, '..', 'fixtures', 'beads-migrate', 'legacy-backup');

// Expected mapped counts derived from the spine itself (not hard-coded), so the
// assertions track the adapter (e.g. synthetic note comments) without going stale.
const expectedKernel = importBeadsSnapshot(
	loadBeadsSnapshotFromDirectory(fixtureDir),
	{ importedAt: NOW },
).kernel;

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
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-migrate-cmd-'));
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

function emptyDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-migrate-empty-'));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe('forge migrate command contract', () => {
	test('has the registry-required shape', () => {
		expect(migrateCommand.name).toBe('migrate');
		expect(typeof migrateCommand.description).toBe('string');
		expect(typeof migrateCommand.handler).toBe('function');
	});

	// The pre-existing v2 → v3 dry-run PoC contract must survive the beads path.
	test('still refuses the non-dry-run v2→v3 path when --from is absent', async () => {
		const result = await migrateCommand.handler([], {}, process.cwd());
		expect(result.success).toBe(false);
		expect(result.error).toContain('Only forge migrate --dry-run is implemented');
	});

	// A flag supplied without a value must be rejected, not silently swallowed —
	// otherwise `--from beads --source` would auto-detect an unintended source.
	test('rejects --source with no value instead of falling through to auto-detect', async () => {
		const result = await migrateCommand.handler(['--from', 'beads', '--source'], {}, process.cwd());
		expect(result.success).toBe(false);
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain('--source requires a value');
	});
});

describe('forge migrate --from beads — dry run', () => {
	test('reports what WOULD be imported and writes nothing to the kernel', async () => {
		const { broker, driver, config } = freshBroker();
		await broker.initialize();

		const result = await migrateCommand.handler(
			['--from', 'beads', '--source', fixtureDir, '--dry-run'],
			{},
			process.cwd(),
			{ _broker: broker, _now: NOW },
		);

		expect(result.success).toBe(true);
		expect(result.dryRun).toBe(true);
		expect(result.planned).toEqual({
			issues: expectedKernel.issues.length,
			comments: expectedKernel.comments.length,
			dependencies: expectedKernel.dependencies.length,
		});
		expect(result.planned.issues).toBe(2);
		expect(result.planned.dependencies).toBe(1);
		// Gaps surfaced (count + brief).
		expect(result.gaps.count).toBeGreaterThan(0);
		expect(result.output).toContain('nothing written');

		// Nothing was written — the authority table stays empty.
		const issueRows = await driver.queryAll('SELECT id FROM kernel_issues', config);
		expect(issueRows).toHaveLength(0);
	});
});

describe('forge migrate --from beads — real import', () => {
	test('imports the fixtures preserving timestamps/status/created_by + comments + dep', async () => {
		const { broker, driver, config } = freshBroker();
		await broker.initialize();

		const result = await migrateCommand.handler(
			['--from', 'beads', '--source', fixtureDir],
			{},
			process.cwd(),
			{ _broker: broker, _now: NOW },
		);

		expect(result.success).toBe(true);
		expect(result.dryRun).toBe(false);
		expect(result.imported.issues.inserted).toBe(2);
		expect(result.imported.comments.inserted).toBe(expectedKernel.comments.length);
		expect(result.imported.dependencies.inserted).toBe(1);

		const aa1 = await driver.issueOperation('show', ['forge-aa1'], {}, config);
		expect(aa1.data.status).toBe('open');
		expect(aa1.data.created_at).toBe('2026-04-01T09:00:00Z');
		expect(aa1.data.updated_at).toBe('2026-04-01T09:00:00Z');
		expect(aa1.data.created_by).toBe('Harsha Nanda');

		const bb2 = await driver.issueOperation('show', ['forge-bb2'], {}, config);
		expect(bb2.data.status).toBe('in_progress');
		expect(bb2.data.dependencies).toContain('forge-aa1');
	});

	test('a second run is idempotent (0 new)', async () => {
		const { broker } = freshBroker();
		await broker.initialize();

		const args = ['--from', 'beads', '--source', fixtureDir];
		await migrateCommand.handler(args, {}, process.cwd(), { _broker: broker, _now: NOW });
		const second = await migrateCommand.handler(args, {}, process.cwd(), { _broker: broker, _now: NOW });

		expect(second.success).toBe(true);
		expect(second.imported.issues.inserted).toBe(0);
		expect(second.imported.issues.skipped).toBe(2);
		expect(second.imported.dependencies.inserted).toBe(0);
	});
});

describe('forge migrate --from beads — error + output surfaces', () => {
	test('exits non-zero with a clear message when no beads data is found', async () => {
		const result = await migrateCommand.handler(
			['--from', 'beads', '--source', emptyDir()],
			{},
			process.cwd(),
			{ _now: NOW },
		);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/no beads data found/i);
		expect(result.exitCode).toBe(1);
	});

	test('rejects an unsupported migration source', async () => {
		const result = await migrateCommand.handler(
			['--from', 'supabase'],
			{},
			process.cwd(),
			{ _now: NOW },
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/unsupported migration source/i);
	});

	test('--json emits a structured, parseable result', async () => {
		const result = await migrateCommand.handler(
			['--from', 'beads', '--source', fixtureDir, '--dry-run', '--json'],
			{},
			process.cwd(),
			{ _now: NOW },
		);
		expect(result.json).toBe(true);
		const parsed = JSON.parse(result.output);
		expect(parsed.dryRun).toBe(true);
		expect(parsed.from).toBe('beads');
		expect(parsed.planned.issues).toBe(2);
		expect(parsed.gaps.count).toBeGreaterThan(0);
	});
});
