'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { Database } = require('bun:sqlite');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const sqliteDriver = require('../../lib/kernel/sqlite-driver');
const { buildPrWatchOwnershipMigration } = require('../../lib/kernel/migrations');
const { createBuiltinSQLiteDriver, selectBuiltinSQLiteRuntime } = sqliteDriver;
const owner = require('../../lib/pr-monitor/watch-owner');

function loadTransactionInternals() {
	const filename = require.resolve('../../lib/kernel/sqlite-driver');
	const instrumented = new Module(filename, module);
	instrumented.filename = filename;
	instrumented.paths = Module._nodeModulePaths(path.dirname(filename));
	const source = `${fs.readFileSync(filename, 'utf8')}\nmodule.exports.__transactionInternals = { runWatchOwnerTransaction, runWatchOwnerTransactionOnConnection };\n`;
	instrumented._compile(source, filename);
	return instrumented.exports.__transactionInternals;
}

const transactionInternals = loadTransactionInternals();

const NOW = '2026-08-19T08:00:00.000Z';
const LATER = '2026-08-19T08:00:01.000Z';
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const DRIVER_PATH = path.resolve(__dirname, '../../lib/kernel/sqlite-driver.js');
const OWNER_PATH = path.resolve(__dirname, '../../lib/pr-monitor/watch-owner.js');

function runContender(runtime, databasePath, controllerPid) {
	const source = `
		const { createBuiltinSQLiteDriver } = require(${JSON.stringify(DRIVER_PATH)});
		const owner = require(${JSON.stringify(OWNER_PATH)});
		const driver = createBuiltinSQLiteDriver({ databasePath: process.env.WATCH_OWNER_DB });
		owner.reserveStarting(
			{ repo: 'acme/forge', pr: 77 },
			{ controllerPid: Number(process.env.WATCH_OWNER_PID), startedAt: '${NOW}' },
			{ driver },
		).then(result => { console.log(JSON.stringify(result)); driver.close(); });
	`;
	return new Promise((resolve, reject) => {
		const child = spawn(runtime, ['-e', source], {
			env: { ...process.env, WATCH_OWNER_DB: databasePath, WATCH_OWNER_PID: String(controllerPid), NODE_NO_WARNINGS: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });
		child.on('error', reject);
		child.on('close', code => {
			if (code !== 0) return reject(new Error(`${runtime} contender failed (${code}): ${stderr}`));
			const line = stdout.trim().split(/\r?\n/).at(-1);
			try {
				return resolve(JSON.parse(line));
			} catch (error) {
				return reject(new Error(`${runtime} contender returned invalid JSON: ${stdout}`, { cause: error }));
			}
		});
	});
}

function runImportContender(runtime, databasePath) {
	const source = `
		const { createBuiltinSQLiteDriver } = require(${JSON.stringify(DRIVER_PATH)});
		const owner = require(${JSON.stringify(OWNER_PATH)});
		const driver = createBuiltinSQLiteDriver({ databasePath: process.env.WATCH_OWNER_DB });
		owner.importLegacyStarting(
			{ repo: 'acme/forge', pr: 88 },
			{
				snapshotHash: '${HASH}', legacyEvidenceHash: '${OTHER_HASH}', legacyPid: 288,
				controllerPid: 188, providerEvidence: { state: 'OPEN' }, startedAt: '${NOW}',
			},
			{ driver, isPidAlive: () => false, verifyProviderEvidence: async () => true },
		).then(result => { console.log(JSON.stringify(result)); driver.close(); });
	`;
	return new Promise((resolve, reject) => {
		const child = spawn(runtime, ['-e', source], {
			env: { ...process.env, WATCH_OWNER_DB: databasePath, NODE_NO_WARNINGS: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });
		child.on('error', reject);
		child.on('close', code => {
			if (code !== 0) return reject(new Error(`${runtime} import contender failed (${code}): ${stderr}`));
			try {
				return resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)));
			} catch (error) {
				return reject(new Error(`${runtime} import contender returned invalid JSON: ${stdout}`, { cause: error }));
			}
		});
	});
}

function startKilledHolder(databasePath) {
	const source = `
		const { Database } = require('bun:sqlite');
		const db = new Database(process.env.WATCH_OWNER_DB);
		db.exec(\`BEGIN IMMEDIATE;
			INSERT INTO kernel_pr_watch_owners
			(repo, pr, version, generation, phase, controller_pid, watcher_pid, started_at, updated_at)
			VALUES ('acme/forge', 81, 1, 'uncommitted', 'starting', 5000, NULL, '${NOW}', '${NOW}');\`);
		console.log('READY');
		setInterval(() => {}, 1000);
	`;
	const child = spawn(process.execPath, ['-e', source], {
		env: { ...process.env, WATCH_OWNER_DB: databasePath }, stdio: ['ignore', 'pipe', 'pipe'],
	});
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error('writer holder did not acquire SQLite transaction'));
		}, 5_000);
		child.on('error', error => { clearTimeout(timeout); reject(error); });
		child.stdout.on('data', chunk => {
			if (!String(chunk).includes('READY')) return;
			clearTimeout(timeout);
			resolve(child);
		});
	});
}

describe('watch owner dedicated SQLite transaction', () => {
	let root;
	let databasePath;
	let driver;

	beforeEach(async () => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-owner-tx-'));
		databasePath = path.join(root, 'forge', 'kernel.sqlite');
		driver = createBuiltinSQLiteDriver({ databasePath });
		await driver.exec(`
			CREATE TABLE kernel_pr_watch_owners (
				repo TEXT NOT NULL, pr INTEGER NOT NULL, version INTEGER NOT NULL,
				generation TEXT NOT NULL, phase TEXT NOT NULL, controller_pid INTEGER,
				watcher_pid INTEGER, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				heartbeat_at TEXT, terminal_receipt_id TEXT, block_reason TEXT,
				legacy_evidence_hash TEXT, PRIMARY KEY (repo, pr)
			);
			CREATE TABLE kernel_pr_watch_migration_gate (
				singleton INTEGER NOT NULL PRIMARY KEY, state TEXT NOT NULL, snapshot_hash TEXT,
				conflict_code TEXT, updated_at TEXT NOT NULL
			);
		`);
	});

	afterEach(() => {
		driver?.close();
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('Bun and Node contenders commit exactly one generation', async () => {
		const runtimes = [process.execPath, 'node', process.execPath, 'node', process.execPath, 'node'];
		const results = await Promise.all(runtimes.map((runtime, index) => runContender(runtime, databasePath, 1_000 + index)));
		expect(results.filter(result => result.ok && result.changed)).toHaveLength(1);
		expect(results.filter(result => !result.changed && !(
			result.ok === false && ['busy', 'authority_unavailable'].includes(result.reason)
		))).toEqual([]);
		const rows = await driver.queryAll('SELECT repo, pr, generation FROM kernel_pr_watch_owners');
		expect(rows).toHaveLength(1);
		expect(rows[0].generation).toBe(results.find(result => result.ok && result.changed).record.generation);
	}, 20_000);

	test('N-process legacy starting import converges on one provenance row', async () => {
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, { driver });
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, { driver });
		const runtimes = [process.execPath, 'node', process.execPath, 'node', process.execPath, 'node'];
		const results = await Promise.all(runtimes.map(runtime => runImportContender(runtime, databasePath)));
		expect(results.filter(result => result.ok && result.changed)).toHaveLength(1);
		expect(results.filter(result =>
			!['imported', 'idempotent', 'stale_evidence', 'authority_unavailable'].includes(result.reason),
		)).toEqual([]);
		const rows = await driver.queryAll(`SELECT repo, pr, generation, phase, controller_pid, legacy_evidence_hash
			FROM kernel_pr_watch_owners WHERE repo = 'acme/forge' AND pr = 88`);
		expect(rows).toEqual([expect.objectContaining({
			repo: 'acme/forge', pr: 88, phase: 'starting', controller_pid: 188,
			legacy_evidence_hash: OTHER_HASH,
		})]);
		expect(new Set(results.map(result => result.record?.generation).filter(Boolean)))
			.toEqual(new Set([rows[0].generation]));
	}, 20_000);

	test('a held writer times out before owner access and leaves the caller connection unchanged', async () => {
		const before = await driver.queryAll('PRAGMA busy_timeout;');
		const blocker = new Database(databasePath);
		blocker.exec('BEGIN IMMEDIATE;');
		const contender = createBuiltinSQLiteDriver({ databasePath, watchOwnerBusyTimeoutMs: 25 });
		const result = await owner.reserveStarting({ repo: 'acme/forge', pr: 78 }, {
			controllerPid: 2_000, startedAt: NOW,
		}, { driver: contender });
		expect(result).toEqual({ ok: false, changed: false, reason: 'authority_unavailable', record: null });
		expect(await owner.readMigrationGate({}, { driver: contender }))
			.toEqual({ ok: false, changed: false, reason: 'authority_unavailable', gate: null });
		blocker.exec('ROLLBACK;');
		blocker.close();
		contender.close();
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners WHERE pr = 78')).toEqual([]);
		expect(await driver.queryAll('PRAGMA busy_timeout;')).toEqual(before);
	});

	test('normalizes a lock encountered during schema preflight as unavailable authority', async () => {
		const blocker = new Database(databasePath);
		const contender = createBuiltinSQLiteDriver({ databasePath, watchOwnerBusyTimeoutMs: 25 });
		let result;
		try {
			blocker.exec('BEGIN EXCLUSIVE;');
			result = await owner.reserveStarting({ repo: 'acme/forge', pr: 85 }, {
				controllerPid: 2_001, startedAt: NOW,
			}, { driver: contender });
		} finally {
			blocker.exec('ROLLBACK;');
			blocker.close();
			contender.close();
		}
		expect(result).toEqual({
			ok: false, changed: false, reason: 'authority_unavailable', record: null,
		});
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners WHERE pr = 85')).toEqual([]);
	});

	test('a killed holder rolls back and the next process acquires', async () => {
		const holder = await startKilledHolder(databasePath);
		const closed = new Promise(resolve => holder.once('close', resolve));
		holder.kill();
		await closed;
		const acquired = await owner.reserveStarting({ repo: 'acme/forge', pr: 81 }, {
			controllerPid: 5_001, startedAt: NOW,
		}, { driver });
		expect(acquired).toMatchObject({ ok: true, changed: true, reason: 'acquired', record: { controllerPid: 5_001 } });
		expect(await driver.queryAll('SELECT generation FROM kernel_pr_watch_owners WHERE pr = 81'))
			.toEqual([{ generation: acquired.record.generation }]);
	}, 10_000);

	test('accepts authority tables created by the PR watch ownership migration', async () => {
		await driver.exec('DROP TABLE kernel_pr_watch_owners; DROP TABLE kernel_pr_watch_migration_gate;');
		const migration = buildPrWatchOwnershipMigration();
		await driver.exec(migration.apply.join('\n'));

		const singleton = (await driver.queryAll('PRAGMA table_info(kernel_pr_watch_migration_gate)'))
			.find(column => column.name === 'singleton');
		expect(singleton).toMatchObject({ type: 'INTEGER', notnull: 1, pk: 1 });
		expect(driver.watchOwnerReserveStarting({
			repo: 'acme/forge', pr: 115, controllerPid: 7_115, now: NOW,
		})).toMatchObject({ ok: true, changed: true, reason: 'acquired' });
	});

	test('refuses a regular canonical database classified as OneDrive even with the general unsafe-FS override', async () => {
		const refusedPath = path.join(root, 'OneDrive', 'forge', 'kernel.sqlite');
		const refused = createBuiltinSQLiteDriver({
			databasePath: refusedPath,
			watchOwnerFilesystemDeps: {
				env: { ...process.env, FORGE_KERNEL_ALLOW_UNSAFE_FS: '1' },
				platform: 'linux', probeMounts: () => 'ext4', readWslInterop: () => false,
				warn: () => {},
			},
		});
		await refused.exec(`
			CREATE TABLE kernel_pr_watch_owners (
				repo TEXT NOT NULL, pr INTEGER NOT NULL, version INTEGER NOT NULL,
				generation TEXT NOT NULL, phase TEXT NOT NULL, controller_pid INTEGER,
				watcher_pid INTEGER, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				heartbeat_at TEXT, terminal_receipt_id TEXT, block_reason TEXT,
				legacy_evidence_hash TEXT, PRIMARY KEY (repo, pr)
			);
			CREATE TABLE kernel_pr_watch_migration_gate (
				singleton INTEGER NOT NULL PRIMARY KEY, state TEXT NOT NULL, snapshot_hash TEXT,
				conflict_code TEXT, updated_at TEXT NOT NULL
			);
		`);
		const result = await owner.reserveStarting({ repo: 'acme/forge', pr: 82 }, {
			controllerPid: 6_000, startedAt: NOW,
		}, { driver: refused });
		expect(result).toEqual({ ok: false, changed: false, reason: 'authority_unavailable', record: null });
		expect(await refused.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
		expect(await owner.readMigrationGate({}, { driver: refused }))
			.toEqual({ ok: false, changed: false, reason: 'authority_unavailable', gate: null });
		expect(await refused.queryAll('SELECT * FROM kernel_pr_watch_migration_gate')).toEqual([]);
		refused.close();
	});

	test('refuses a canonical junction whose real database is on OneDrive without mutation', async () => {
		const targetDirectory = path.join(root, 'OneDrive', 'forge');
		const targetPath = path.join(targetDirectory, 'kernel.sqlite');
		const target = createBuiltinSQLiteDriver({ databasePath: targetPath });
		await target.exec(`
			CREATE TABLE kernel_pr_watch_owners (
				repo TEXT NOT NULL, pr INTEGER NOT NULL, version INTEGER NOT NULL,
				generation TEXT NOT NULL, phase TEXT NOT NULL, controller_pid INTEGER,
				watcher_pid INTEGER, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				heartbeat_at TEXT, terminal_receipt_id TEXT, block_reason TEXT,
				legacy_evidence_hash TEXT, PRIMARY KEY (repo, pr)
			);
			CREATE TABLE kernel_pr_watch_migration_gate (
				singleton INTEGER NOT NULL PRIMARY KEY, state TEXT NOT NULL, snapshot_hash TEXT,
				conflict_code TEXT, updated_at TEXT NOT NULL
			);
		`);
		target.close();
		const safeRoot = path.join(root, 'safe');
		fs.mkdirSync(safeRoot, { recursive: true });
		const linkedForge = path.join(safeRoot, 'forge');
		fs.symlinkSync(targetDirectory, linkedForge, process.platform === 'win32' ? 'junction' : 'dir');
		const linkedPath = path.join(linkedForge, 'kernel.sqlite');
		const linked = createBuiltinSQLiteDriver({
			databasePath: linkedPath,
			watchOwnerFilesystemDeps: {
				env: { ...process.env, FORGE_KERNEL_ALLOW_UNSAFE_FS: '' },
				platform: 'linux', probeMounts: () => 'ext4', readWslInterop: () => false,
				warn: () => {},
			},
		});
		const filesBefore = fs.readdirSync(targetDirectory).sort();
		const result = await owner.reserveStarting({ repo: 'acme/forge', pr: 83 }, {
			controllerPid: 6_001, startedAt: NOW,
		}, { driver: linked });
		expect(result).toEqual({ ok: false, changed: false, reason: 'authority_unavailable', record: null });
		const verify = createBuiltinSQLiteDriver({ databasePath: targetPath });
		expect(await verify.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
		verify.close();
		expect(fs.readdirSync(targetDirectory).sort()).toEqual(filesBefore);
		linked.close();
	});

	test('refuses a lexical forge junction whose real database parent is noncanonical', async () => {
		const targetDirectory = path.join(root, 'safe-target');
		const targetPath = path.join(targetDirectory, 'kernel.sqlite');
		const target = createBuiltinSQLiteDriver({ databasePath: targetPath });
		await target.exec(`
			CREATE TABLE kernel_pr_watch_owners (
				repo TEXT NOT NULL, pr INTEGER NOT NULL, version INTEGER NOT NULL,
				generation TEXT NOT NULL, phase TEXT NOT NULL, controller_pid INTEGER,
				watcher_pid INTEGER, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				heartbeat_at TEXT, terminal_receipt_id TEXT, block_reason TEXT,
				legacy_evidence_hash TEXT, PRIMARY KEY (repo, pr)
			);
			CREATE TABLE kernel_pr_watch_migration_gate (
				singleton INTEGER NOT NULL PRIMARY KEY, state TEXT NOT NULL, snapshot_hash TEXT,
				conflict_code TEXT, updated_at TEXT NOT NULL
			);
		`);
		target.close();
		const aliasRoot = path.join(root, 'alias');
		fs.mkdirSync(aliasRoot, { recursive: true });
		const linkedForge = path.join(aliasRoot, 'forge');
		fs.symlinkSync(targetDirectory, linkedForge, process.platform === 'win32' ? 'junction' : 'dir');
		const linked = createBuiltinSQLiteDriver({ databasePath: path.join(linkedForge, 'kernel.sqlite') });
		expect(() => linked.watchOwnerRead({ repo: 'acme/forge', pr: 84 }))
			.toThrow('Watcher authority database resolves outside the canonical forge/kernel.sqlite location');
		expect(await owner.reserveStarting({ repo: 'acme/forge', pr: 84 }, {
			controllerPid: 6_002, startedAt: NOW,
		}, { driver: linked })).toEqual({
			ok: false, changed: false, reason: 'authority_unavailable', record: null,
		});
		const verify = createBuiltinSQLiteDriver({ databasePath: targetPath });
		expect(await verify.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
		verify.close();
		linked.close();
	});

	test('reports a realpath resolution failure without classifying it as an unsafe filesystem', () => {
		const realpathSync = fs.realpathSync;
		fs.realpathSync = () => { throw new Error('synthetic realpath failure'); };
		try {
			expect(() => driver.watchOwnerRead({ repo: 'acme/forge', pr: 84 }))
				.toThrow('Watcher authority database path cannot be resolved');
		} finally {
			fs.realpathSync = realpathSync;
		}
	});

	test('fails closed when the authority file vanishes after validation and is not recreated', async () => {
		driver.close();
		const originalRealpathSync = fs.realpathSync;
		let vanished = false;
		fs.realpathSync = target => {
			const realPath = originalRealpathSync(target);
			if (!vanished && path.resolve(target) === path.resolve(databasePath)) {
				fs.unlinkSync(databasePath);
				vanished = true;
			}
			return realPath;
		};
		const reopened = createBuiltinSQLiteDriver({ databasePath });
		try {
			expect(await owner.reserveStarting({ repo: 'acme/forge', pr: 86 }, {
				controllerPid: 6_003, startedAt: NOW,
			}, { driver: reopened })).toEqual({
				ok: false, changed: false, reason: 'authority_unavailable', record: null,
			});
		} finally {
			fs.realpathSync = originalRealpathSync;
			reopened.close();
		}
		expect(vanished).toBe(true);
		expect(fs.existsSync(databasePath)).toBe(false);
	});

	test('does not expose a callback, batch, clear, or raw transaction escape hatch', async () => {
		expect(sqliteDriver.__test).toBeUndefined();
		expect(sqliteDriver.runWatchOwnerTransaction).toBeUndefined();
		expect(sqliteDriver.runWatchOwnerTransactionOnConnection).toBeUndefined();
		expect(driver.watchOwnerTransaction).toBeUndefined();
		expect(driver.watchOwnerBatch).toBeUndefined();
		expect(driver.watchOwnerImport).toBeUndefined();
		expect(owner.clear).toBeUndefined();
		expect(owner.transition).toBeUndefined();
		expect(await owner.reserveStarting({ repo: 'acme/forge', pr: 80 }, {
			controllerPid: 4_000, startedAt: NOW,
		}, { driver: { watchOwnerReserveStarting: async () => ({ ok: true }) } }))
			.toEqual({ ok: false, changed: false, reason: 'invalid_operation', record: null });
	});

	test('rejects coerced numeric inputs through the narrow driver API before SQLite', async () => {
		for (const [index, coerced] of [true, '1'].entries()) {
			expect(driver.watchOwnerReserveStarting({
				repo: 'acme/forge', pr: coerced, controllerPid: 7_000, now: NOW,
			})).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
			expect(driver.watchOwnerReserveStarting({
				repo: 'acme/forge', pr: 90 + index, controllerPid: coerced, now: NOW,
			})).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
			const start = driver.watchOwnerReserveStarting({
				repo: 'acme/forge', pr: 100 + index, controllerPid: 7_001, now: NOW,
			});
			expect(driver.watchOwnerBindRunning({
				repo: 'acme/forge', pr: 100 + index, generation: start.row.generation,
				controllerPid: 7_001, watcherPid: coerced, now: NOW,
			})).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
		}
		expect(await driver.queryAll('SELECT pr, phase FROM kernel_pr_watch_owners ORDER BY pr')).toEqual([
			{ pr: 100, phase: 'starting' },
			{ pr: 101, phase: 'starting' },
		]);
	});

	test('rejects malformed reserve identity and timestamp before SQLite', async () => {
		const malformedRepo = driver.watchOwnerReserveStarting({
			repo: 'Not Canonical/Forge', pr: 102, controllerPid: 7_002, now: NOW,
		});
		const malformedNow = driver.watchOwnerReserveStarting({
			repo: 'acme/forge', pr: 103, controllerPid: 7_003, now: 'not-a-timestamp',
		});

		expect(await driver.queryAll('SELECT repo, pr FROM kernel_pr_watch_owners WHERE pr IN (102, 103)')).toEqual([]);
		expect(malformedRepo).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
		expect(malformedNow).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
	});

	test('fails closed for throwing enumeration and accessor-backed owner inputs', async () => {
		const throwingEnumeration = new Proxy({
			repo: 'acme/forge', pr: 105, controllerPid: 7_005, now: NOW,
		}, {
			ownKeys() {
				throw new Error('enumeration must not escape');
			},
		});
		const throwingGetter = {};
		Object.defineProperties(throwingGetter, {
			repo: {
				enumerable: true,
				get() {
					throw new Error('getter must not escape');
				},
			},
			pr: { value: 106, enumerable: true },
			controllerPid: { value: 7_006, enumerable: true },
			now: { value: NOW, enumerable: true },
		});

		let enumerationResult;
		let getterResult;
		let readResult;
		expect(() => {
			readResult = driver.watchOwnerRead(throwingGetter);
		}).not.toThrow();
		expect(() => {
			enumerationResult = driver.watchOwnerReserveStarting(throwingEnumeration);
		}).not.toThrow();
		expect(() => {
			getterResult = driver.watchOwnerReserveStarting(throwingGetter);
		}).not.toThrow();

		expect(enumerationResult).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
		expect(getterResult).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
		expect(readResult).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
		expect(await driver.queryAll('SELECT repo, pr FROM kernel_pr_watch_owners WHERE pr IN (105, 106)')).toEqual([]);
	});

	test('does not release a running owner directly', async () => {
		const starting = driver.watchOwnerReserveStarting({
			repo: 'acme/forge', pr: 104, controllerPid: 7_004, now: NOW,
		});
		const running = driver.watchOwnerBindRunning({
			repo: 'acme/forge', pr: 104, generation: starting.row.generation,
			controllerPid: 7_004, watcherPid: 8_004, now: LATER,
		});

		const released = driver.watchOwnerReleaseNonterminal({
			repo: 'acme/forge', pr: 104, generation: running.row.generation, watcherPid: 8_004,
		});

		expect(released).toMatchObject({ ok: false, changed: false, reason: 'phase_mismatch' });
		expect(driver.watchOwnerRead({ repo: 'acme/forge', pr: 104 }))
			.toMatchObject({ ok: true, row: { phase: 'running', watcher_pid: 8_004 } });
	});

	test.each([
		'watchOwnerReserveReopened',
		'watchOwnerRecordTerminal',
		'watchOwnerCompleteTerminal',
		'watchOwnerAbortStarting',
		'watchOwnerRecoverDeadStarting',
		'watchOwnerRecoverDeadWatcher',
		'watchOwnerMarkLegacyBlocked',
		'watchOwnerRecheckLegacyBlocked',
		'watchOwnerImportLegacyStarting',
		'watchOwnerImportLegacyComplete',
	])('%s rejects evidence-bound direct mutation without an expected snapshot', method => {
		const input = {
			repo: 'acme/forge', pr: 111, now: NOW, generation: 'generation-111',
			controllerPid: 7_111, expectedControllerPid: 7_111, watcherPid: 8_111,
			expectedReceiptId: 'receipt-111', terminalReceiptId: 'receipt-111',
			snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH,
			blockReason: 'legacy_lossy', action: 'complete',
		};

		expect(driver[method](input)).toEqual({
			ok: false, changed: false, reason: 'invalid_input', row: null,
		});
		expect(driver[method]({ ...input, expectedSnapshot: undefined })).toEqual({
			ok: false, changed: false, reason: 'invalid_input', row: null,
		});
	});

	test.each([
		['omitted', input => {
			const { action: _action, ...withoutAction } = input;
			return withoutAction;
		}],
		['undefined', input => ({ ...input, action: undefined })],
		['null', input => ({ ...input, action: null })],
		['invalid string', input => ({ ...input, action: 'retry' })],
		['invalid number', input => ({ ...input, action: 1 })],
		['invalid object', input => ({ ...input, action: {} })],
	])('recheckLegacyBlocked rejects %s before opening SQLite', (_label, buildInput) => {
		const blocker = new Database(databasePath);
		const isolatedDriver = createBuiltinSQLiteDriver({ databasePath, watchOwnerBusyTimeoutMs: 25 });
		const input = buildInput({
			repo: 'acme/forge', pr: 113, now: NOW, generation: 'generation-113',
			watcherPid: null, terminalReceiptId: null, legacyEvidenceHash: OTHER_HASH,
			expectedSnapshot: null,
		});
		const beforeRows = driver.queryAll('SELECT * FROM kernel_pr_watch_owners');

		let result;
		try {
			blocker.exec('BEGIN EXCLUSIVE;');
			result = isolatedDriver.watchOwnerRecheckLegacyBlocked(input);
		} finally {
			blocker.exec('ROLLBACK;');
			blocker.close();
			isolatedDriver.close();
		}

		expect(result).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
		expect(driver.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual(beforeRows);
	});

	test('copies an evidence snapshot before acquiring the writer transaction', () => {
		const initial = driver.watchOwnerReserveStarting({
			repo: 'acme/forge', pr: 112, controllerPid: 7_112, now: NOW,
		});
		const snapshot = driver.watchOwnerRead({ repo: 'acme/forge', pr: 112 }).row;
		let nestedOutcome;
		let nestedError;
		const expectedSnapshot = new Proxy(snapshot, {
			get(target, property, receiver) {
				if (property === 'repo' && nestedOutcome === undefined && nestedError === undefined) {
					try {
						nestedOutcome = driver.watchOwnerReserveStarting(
								{ repo: 'acme/forge', pr: 113, controllerPid: 7_113, now: NOW },
								{ watchOwnerBusyTimeoutMs: 25 },
							);
					} catch (error) {
						nestedError = error;
					}
				}
				return Reflect.get(target, property, receiver);
			},
		});

		const result = driver.watchOwnerAbortStarting({
			repo: 'acme/forge', pr: 112, generation: initial.row.generation,
			controllerPid: initial.row.controller_pid,
			expectedSnapshot,
		}, { watchOwnerBusyTimeoutMs: 25 });

		expect(result).toMatchObject({ ok: true, changed: true, reason: 'aborted' });
		expect(nestedError).toBeUndefined();
		expect(nestedOutcome).toMatchObject({ ok: true, changed: true, reason: 'acquired' });
	});

	test.each([
		['bindRunning', 'watchOwnerBindRunning', 114, 115],
		['heartbeat', 'watchOwnerHeartbeat', 116, 117],
		['requestStop', 'watchOwnerRequestStop', 118, 119],
	])('copies an optional %s snapshot before acquiring the writer transaction', (
		_label, method, pr, nestedPr,
	) => {
		const controllerPid = 7_000 + pr;
		const watcherPid = 8_000 + pr;
		const started = driver.watchOwnerReserveStarting({
			repo: 'acme/forge', pr, controllerPid, now: NOW,
		});
		let current = started.row;
		if (method !== 'watchOwnerBindRunning') {
			current = driver.watchOwnerBindRunning({
				repo: 'acme/forge', pr, generation: current.generation,
				controllerPid, watcherPid, now: LATER,
			}).row;
		}
		const snapshot = driver.watchOwnerRead({ repo: 'acme/forge', pr }).row;
		let nestedOutcome;
		let nestedError;
		const expectedSnapshot = new Proxy(snapshot, {
			get(target, property, receiver) {
				if (property === 'repo' && nestedOutcome === undefined && nestedError === undefined) {
					try {
						nestedOutcome = driver.watchOwnerReserveStarting(
							{ repo: 'acme/forge', pr: nestedPr, controllerPid: 7_000 + nestedPr, now: NOW },
							{ watchOwnerBusyTimeoutMs: 25 },
						);
					} catch (error) {
						nestedError = error;
					}
				}
				return Reflect.get(target, property, receiver);
			},
		});
		const input = method === 'watchOwnerBindRunning'
			? {
				repo: 'acme/forge', pr, generation: current.generation,
				controllerPid, watcherPid, now: LATER, expectedSnapshot,
			}
			: {
				repo: 'acme/forge', pr, generation: current.generation,
				watcherPid, now: '2026-08-19T08:00:02.000Z', expectedSnapshot,
			};

		const result = driver[method](input, { watchOwnerBusyTimeoutMs: 25 });

		expect(result).toMatchObject({
			ok: true, changed: true,
			reason: method === 'watchOwnerBindRunning'
				? 'bound'
				: (method === 'watchOwnerHeartbeat' ? 'heartbeat' : 'stop_requested'),
		});
		expect(nestedError).toBeUndefined();
		expect(nestedOutcome).toMatchObject({ ok: true, changed: true, reason: 'acquired' });
	});

	test('copies migration gate inputs before acquiring the writer transaction', () => {
		expect(driver.watchGatePublishQuarantine({ now: NOW })).toMatchObject({ ok: true, changed: true });
		const reads = { now: 0, snapshotHash: 0, conflictCode: 0 };
		const input = {
			get now() { reads.now += 1; return reads.now === 1 ? LATER : 'not-a-timestamp'; },
			get snapshotHash() { reads.snapshotHash += 1; return reads.snapshotHash === 1 ? HASH : OTHER_HASH; },
			get conflictCode() { reads.conflictCode += 1; return reads.conflictCode === 1 ? 'legacy_owner_conflict' : 'legacy_snapshot_changed'; },
		};

		const result = driver.watchGatePublishConflict(input);

		expect(reads).toEqual({ now: 1, snapshotHash: 1, conflictCode: 1 });
		expect(result).toMatchObject({ ok: true, changed: true, gate: {
			state: 'conflict', snapshot_hash: HASH, conflict_code: 'legacy_owner_conflict', updated_at: LATER,
		} });
	});

	test('uses one prepared identity for evidence checks and deletion', async () => {
		const starting = driver.watchOwnerReserveStarting({
			repo: 'acme/forge', pr: 116, controllerPid: 7_116, now: NOW,
		});
		let repoReads = 0;
		const input = {
			get repo() { repoReads += 1; return repoReads < 3 ? 'acme/forge' : 'acme/other'; },
			pr: 116,
			generation: starting.row.generation,
			controllerPid: 7_116,
			expectedSnapshot: starting.row,
		};

		expect(driver.watchOwnerAbortStarting(input)).toMatchObject({
			ok: true, changed: true, reason: 'aborted',
		});
		expect(await driver.queryAll('SELECT repo, pr FROM kernel_pr_watch_owners WHERE pr = 116')).toEqual([]);
	});

	test('uses one prepared snapshot hash for legacy gate checks', async () => {
		driver.watchGatePublishQuarantine({ now: NOW });
		driver.watchGateBindSnapshot({ snapshotHash: HASH, now: NOW });
		let hashReads = 0;
		const input = {
			repo: 'acme/forge', pr: 117, now: NOW, controllerPid: 7_117,
			get snapshotHash() { hashReads += 1; return hashReads < 4 ? HASH : OTHER_HASH; },
			legacyEvidenceHash: OTHER_HASH,
			expectedSnapshot: null,
		};

		expect(driver.watchOwnerImportLegacyStarting(input)).toMatchObject({
			ok: true, changed: true, reason: 'imported',
		});
		expect(await driver.queryAll('SELECT repo, pr FROM kernel_pr_watch_owners WHERE pr = 117'))
			.toEqual([{ repo: 'acme/forge', pr: 117 }]);
	});

	test('fails closed for incomplete or prerelease same-name authority tables', async () => {
		const ownerSchema = ({ includeEvidence = true, extra = '', primaryKey = 'PRIMARY KEY (repo, pr)' } = {}) => {
			const columns = [
				'repo TEXT NOT NULL', 'pr INTEGER NOT NULL', 'version INTEGER NOT NULL',
				'generation TEXT NOT NULL', 'phase TEXT NOT NULL', 'controller_pid INTEGER',
				'watcher_pid INTEGER', 'started_at TEXT NOT NULL', 'updated_at TEXT NOT NULL',
				'heartbeat_at TEXT', 'terminal_receipt_id TEXT', 'block_reason TEXT',
			];
			if (includeEvidence) columns.push('legacy_evidence_hash TEXT');
			if (extra) columns.push(extra);
			columns.push(primaryKey);
			return `CREATE TABLE kernel_pr_watch_owners (${columns.join(', ')});`;
		};
		const gateSchema = ({ includeConflict = true, extra = '' } = {}) => {
			const columns = [
				'singleton INTEGER NOT NULL PRIMARY KEY', 'state TEXT NOT NULL', 'snapshot_hash TEXT',
			];
			if (includeConflict) columns.push('conflict_code TEXT');
			columns.push('updated_at TEXT NOT NULL');
			if (extra) columns.push(extra);
			return `CREATE TABLE kernel_pr_watch_migration_gate (${columns.join(', ')});`;
		};
		const validOwner = ownerSchema();
		const validGate = gateSchema();
		const cases = [
			['owner missing column', ownerSchema({ includeEvidence: false }), validGate],
			['owner prerelease column', ownerSchema({ extra: 'pre_release_marker TEXT' }), validGate],
			['owner non-composite primary key', ownerSchema({ primaryKey: 'PRIMARY KEY (repo)' }), validGate],
			['gate missing column', validOwner, gateSchema({ includeConflict: false })],
			['gate prerelease column', validOwner, gateSchema({ extra: 'pre_release_marker TEXT' })],
		];

		for (const [label, ownerDdl, gateDdl] of cases) {
			await driver.exec('DROP TABLE kernel_pr_watch_owners; DROP TABLE kernel_pr_watch_migration_gate;');
			await driver.exec(`${ownerDdl}${gateDdl}`);
			let directError;
			try {
				driver.watchOwnerRead({ repo: 'acme/forge', pr: 114 });
			} catch (error) {
				directError = error;
			}
			expect(directError?.code, label).toBe('AUTHORITY_UNAVAILABLE');
			expect(await owner.reserveStarting({ repo: 'acme/forge', pr: 114 }, {
				controllerPid: 7_114, startedAt: NOW,
			}, { driver }), label).toEqual({
				ok: false, changed: false, reason: 'authority_unavailable', record: null,
			});
		}
	});

	test.each([
		['owner', 'kernel_pr_watch_owners'],
		['gate', 'kernel_pr_watch_migration_gate'],
		['uppercase owner', 'KERNEL_PR_WATCH_OWNERS'],
		['uppercase gate', 'KERNEL_PR_WATCH_MIGRATION_GATE'],
	])('fails closed for an unexpected trigger on the %s authority table', async (_label, tableName) => {
		await driver.exec(`CREATE TRIGGER unexpected_watch_authority_trigger
			BEFORE INSERT ON ${tableName}
			BEGIN SELECT RAISE(ABORT, 'unexpected authority trigger'); END;`);
		let directError;
		try {
			driver.watchOwnerRead({ repo: 'acme/forge', pr: 118 });
		} catch (error) {
			directError = error;
		}

		expect(directError?.code).toBe('AUTHORITY_UNAVAILABLE');
		expect(await owner.reserveStarting({ repo: 'acme/forge', pr: 118 }, {
			controllerPid: 7_118, startedAt: NOW,
		}, { driver })).toEqual({
			ok: false, changed: false, reason: 'authority_unavailable', record: null,
		});
	});

	test('rejects updated-at regression for every timestamped owner phase mutation', async () => {
		driver.watchGatePublishQuarantine({ now: NOW });
		driver.watchGateBindSnapshot({ snapshotHash: HASH, now: NOW });
		const cases = [
			{ method: 'watchOwnerReserveReopened', phase: 'complete', input: state => ({
				generation: state.generation, controllerPid: state.controllerPid,
				expectedReceiptId: state.receipt, expectedSnapshot: state.row,
			}) },
			{ method: 'watchOwnerBindRunning', phase: 'starting', input: state => ({
				generation: state.generation, controllerPid: state.controllerPid, watcherPid: state.watcherPid,
			}) },
			{ method: 'watchOwnerHeartbeat', phase: 'running', input: state => ({
				generation: state.generation, watcherPid: state.watcherPid,
			}) },
			{ method: 'watchOwnerRequestStop', phase: 'running', input: state => ({
				generation: state.generation, watcherPid: state.watcherPid,
			}) },
			{ method: 'watchOwnerRecordTerminal', phase: 'running', input: state => ({
				generation: state.generation, watcherPid: state.watcherPid,
				terminalReceiptId: `next-${state.receipt}`, expectedSnapshot: state.row,
			}) },
			{ method: 'watchOwnerCompleteTerminal', phase: 'terminal_pending', input: state => ({
				generation: state.generation, watcherPid: state.watcherPid,
				terminalReceiptId: state.receipt, expectedSnapshot: state.row,
			}) },
			{ method: 'watchOwnerRecoverDeadStarting', phase: 'starting', input: state => ({
				generation: state.generation, expectedControllerPid: state.controllerPid,
				controllerPid: state.controllerPid + 100, expectedSnapshot: state.row,
			}) },
			{ method: 'watchOwnerRecoverDeadWatcher', phase: 'running', input: state => ({
				generation: state.generation, watcherPid: state.watcherPid,
				controllerPid: state.controllerPid, expectedSnapshot: state.row,
			}) },
			{ method: 'watchOwnerMarkLegacyBlocked', phase: 'blocked', input: state => ({
				snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH, blockReason: 'legacy_lossy',
				watcherPid: null, terminalReceiptId: state.receipt, expectedSnapshot: state.row,
			}) },
			{ method: 'watchOwnerRecheckLegacyBlocked', phase: 'blocked', input: state => ({
				generation: state.generation, action: 'complete', legacyEvidenceHash: OTHER_HASH,
				watcherPid: null, terminalReceiptId: state.receipt, expectedSnapshot: state.row,
			}) },
			{ method: 'watchOwnerImportLegacyStarting', phase: 'starting', input: state => ({
				snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH, controllerPid: state.controllerPid,
				expectedSnapshot: state.row,
			}) },
			{ method: 'watchOwnerImportLegacyComplete', phase: 'complete', input: state => ({
				snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH, terminalReceiptId: state.receipt,
				expectedSnapshot: state.row,
			}) },
		];
		const states = new Map();
		for (const [index, entry] of cases.entries()) {
			const pr = 140 + index;
			const generation = `generation-${pr}`;
			const controllerPid = 8_000 + index;
			const watcherPid = 9_000 + index;
			const receipt = `receipt-${pr}`;
			const starting = entry.phase === 'starting';
			const active = ['running', 'stop_requested', 'terminal_pending'].includes(entry.phase);
			const terminal = ['terminal_pending', 'complete'].includes(entry.phase);
			const blocked = entry.phase === 'blocked';
			await driver.exec(`INSERT INTO kernel_pr_watch_owners
				(repo, pr, version, generation, phase, controller_pid, watcher_pid, started_at, updated_at,
				 heartbeat_at, terminal_receipt_id, block_reason, legacy_evidence_hash)
				VALUES ('acme/forge', ${pr}, 1, '${generation}', '${entry.phase}',
				 ${starting ? controllerPid : 'NULL'}, ${active ? watcherPid : 'NULL'}, '${NOW}',
				 '${LATER}',
				 ${active ? `'${LATER}'` : 'NULL'}, ${terminal || blocked ? `'${receipt}'` : 'NULL'},
				 ${blocked ? "'legacy_lossy'" : 'NULL'}, ${blocked || entry.method.includes('ImportLegacy') ? `'${OTHER_HASH}'` : 'NULL'})`);
			const [row] = await driver.queryAll(`SELECT * FROM kernel_pr_watch_owners WHERE pr = ${pr}`);
			const state = { pr, generation, controllerPid, watcherPid, receipt, row };
			states.set(entry.method, state);
			const result = driver[entry.method]({ repo: 'acme/forge', pr, now: NOW, ...entry.input(state) });
			expect(result, entry.method).toMatchObject({ ok: false, changed: false, reason: 'stale_evidence' });
			expect(await driver.queryAll(`SELECT * FROM kernel_pr_watch_owners WHERE pr = ${pr}`), entry.method)
				.toEqual([row]);
		}

		const starting = states.get('watchOwnerBindRunning');
		const running = states.get('watchOwnerRequestStop');
		expect(driver.watchOwnerAbortStarting({
			repo: 'acme/forge', pr: starting.pr, generation: starting.generation,
			controllerPid: starting.controllerPid, expectedSnapshot: starting.row,
		})).toMatchObject({ ok: true, changed: true, reason: 'aborted' });
		expect(driver.watchOwnerReleaseNonterminal({
			repo: 'acme/forge', pr: running.pr, generation: running.generation,
			watcherPid: running.watcherPid,
		})).toMatchObject({ ok: false, changed: false, reason: 'phase_mismatch' });
		expect(driver.watchOwnerRequestStop({
			repo: 'acme/forge', pr: running.pr, generation: running.generation,
			watcherPid: running.watcherPid, now: LATER,
		})).toMatchObject({ ok: true, changed: true, reason: 'stop_requested' });
		expect(driver.watchOwnerReleaseNonterminal({
			repo: 'acme/forge', pr: running.pr, generation: running.generation,
			watcherPid: running.watcherPid,
		})).toMatchObject({ ok: true, changed: true, reason: 'released' });
		const liveBlocked = driver.watchOwnerMarkLegacyBlocked({
			repo: 'acme/forge', pr: 199, now: LATER, snapshotHash: HASH,
			legacyEvidenceHash: OTHER_HASH, blockReason: 'legacy_live_pid', watcherPid: 9_199,
			terminalReceiptId: null, expectedSnapshot: null,
		});
		expect(driver.watchOwnerRecheckLegacyBlocked({
			repo: 'acme/forge', pr: 199, generation: liveBlocked.row.generation, now: NOW,
			action: 'release', legacyEvidenceHash: OTHER_HASH, watcherPid: 9_199,
			terminalReceiptId: null, expectedSnapshot: liveBlocked.row,
		})).toMatchObject({ ok: true, changed: true, reason: 'released' });
	});

	test.each([
		['array', ['acme/forge']],
		['boxed string', new String('acme/forge')],
		['buffer', Buffer.from('acme/forge')],
	])('rejects a %s repository identity before SQLite', async (_label, repo) => {
		const result = driver.watchOwnerReserveStarting({ repo, pr: 105, controllerPid: 7_006, now: NOW });

		expect(await driver.queryAll('SELECT repo, pr FROM kernel_pr_watch_owners WHERE pr = 105')).toEqual([]);
		expect(result).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
	});

	test('rejects a malformed quarantine timestamp before SQLite', async () => {
		const result = driver.watchGatePublishQuarantine({ now: 'not-a-timestamp' });

		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_migration_gate')).toEqual([]);
		expect(result).toEqual({ ok: false, changed: false, reason: 'invalid_input', gate: null });
	});

	test.each([
		['publish quarantine', () => driver.watchGatePublishQuarantine({ now: LATER }),
			() => driver.watchGatePublishQuarantine({ now: NOW })],
		['bind snapshot', () => driver.watchGatePublishQuarantine({ now: LATER }),
			() => driver.watchGateBindSnapshot({ snapshotHash: HASH, now: NOW })],
		['publish conflict', () => driver.watchGatePublishQuarantine({ now: LATER }),
			() => driver.watchGatePublishConflict({ snapshotHash: HASH, conflictCode: 'legacy_owner_conflict', now: NOW })],
		['retry conflict', () => {
			driver.watchGatePublishQuarantine({ now: NOW });
			return driver.watchGatePublishConflict({ snapshotHash: HASH, conflictCode: 'legacy_owner_conflict', now: LATER });
		}, () => driver.watchGateRetryConflict({
			expectedSnapshotHash: HASH, expectedConflictCode: 'legacy_owner_conflict',
			replacementSnapshotHash: OTHER_HASH, now: NOW,
		})],
		['complete migration', () => {
			driver.watchGatePublishQuarantine({ now: NOW });
			return driver.watchGateBindSnapshot({ snapshotHash: HASH, now: LATER });
		}, () => driver.watchGateCompleteMigration({ snapshotHash: HASH, now: NOW })],
	])('rejects a stale timestamp for %s without changing the migration gate', async (_label, arrange, act) => {
		expect(arrange()).toMatchObject({ ok: true, changed: true });
		const [before] = await driver.queryAll('SELECT * FROM kernel_pr_watch_migration_gate');

		expect(act()).toEqual({ ok: false, changed: false, reason: 'stale_evidence', gate: before });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_migration_gate')).toEqual([before]);
	});

	test.each([
		[113, LATER, LATER, NOW],
		[114, NOW, NOW, LATER],
	])('rejects owner row %d whose heartbeat is outside its persisted lifetime', async (pr, startedAt, updatedAt, heartbeatAt) => {
		await driver.exec(`INSERT INTO kernel_pr_watch_owners
			(repo, pr, version, generation, phase, controller_pid, watcher_pid, started_at, updated_at,
			 heartbeat_at, terminal_receipt_id, block_reason, legacy_evidence_hash)
			VALUES ('acme/forge', ${pr}, 1, 'generation-${pr}', 'running', NULL, ${pr},
			 '${startedAt}', '${updatedAt}', '${heartbeatAt}', NULL, NULL, NULL)`);

		expect(driver.watchOwnerRead({ repo: 'acme/forge', pr }))
			.toMatchObject({ ok: false, changed: false, reason: 'corrupt' });
	});

	test('rejects a malformed bind snapshot before SQLite', async () => {
		expect(driver.watchGatePublishQuarantine({ now: NOW })).toMatchObject({
			ok: true, changed: true, reason: 'quarantined',
		});
		const result = driver.watchGateBindSnapshot({ snapshotHash: 'not-a-hash', now: NOW });

		expect(await driver.queryAll('SELECT state, snapshot_hash FROM kernel_pr_watch_migration_gate')).toEqual([
			{ state: 'quarantined', snapshot_hash: null },
		]);
		expect(result).toEqual({ ok: false, changed: false, reason: 'invalid_input', gate: null });
	});

	test.each([
		['array', [HASH]],
		['boxed string', new String(HASH)],
		['buffer', Buffer.from(HASH)],
	])('rejects a %s migration snapshot before SQLite', async (_label, snapshotHash) => {
		expect(driver.watchGatePublishQuarantine({ now: NOW })).toMatchObject({
			ok: true, changed: true, reason: 'quarantined',
		});
		const result = driver.watchGateBindSnapshot({ snapshotHash, now: NOW });

		expect(await driver.queryAll('SELECT state, snapshot_hash FROM kernel_pr_watch_migration_gate')).toEqual([
			{ state: 'quarantined', snapshot_hash: null },
		]);
		expect(result).toEqual({ ok: false, changed: false, reason: 'invalid_input', gate: null });
	});

	test.each([
		['array', value => [value]],
		['boxed string', value => new String(value)],
		['buffer', value => Buffer.from(value)],
	])('rejects %s values for every persisted textual mutation field', async (_label, wrap) => {
		const ownerTime = driver.watchOwnerReserveStarting({
			repo: 'acme/forge', pr: 106, controllerPid: 7_007, now: wrap(NOW),
		});
		const gateTime = driver.watchGatePublishQuarantine({ now: wrap(NOW) });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_migration_gate')).toEqual([]);
		expect(ownerTime).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
		expect(gateTime).toEqual({ ok: false, changed: false, reason: 'invalid_input', gate: null });

		expect(driver.watchGatePublishQuarantine({ now: NOW })).toMatchObject({ ok: true, changed: true });
		expect(driver.watchGateBindSnapshot({ snapshotHash: HASH, now: NOW })).toMatchObject({ ok: true, changed: true });
		const legacyHash = driver.watchOwnerImportLegacyStarting({
			repo: 'acme/forge', pr: 107, now: NOW, snapshotHash: HASH,
			legacyEvidenceHash: wrap(OTHER_HASH), controllerPid: 7_008, expectedSnapshot: null,
		});
		const receipt = driver.watchOwnerImportLegacyComplete({
			repo: 'acme/forge', pr: 108, now: NOW, snapshotHash: HASH,
			legacyEvidenceHash: OTHER_HASH, terminalReceiptId: wrap('receipt-108'), expectedSnapshot: null,
		});
		const blockReason = driver.watchOwnerMarkLegacyBlocked({
			repo: 'acme/forge', pr: 109, now: NOW, snapshotHash: HASH,
			legacyEvidenceHash: OTHER_HASH, blockReason: wrap('legacy_lossy'),
			watcherPid: null, terminalReceiptId: null, expectedSnapshot: null,
		});

		for (const result of [legacyHash, receipt, blockReason]) {
			expect(result).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
		}
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
	});

	test.each([
		['snapshot hash', { snapshotHash: 'bad', legacyEvidenceHash: OTHER_HASH }],
		['legacy evidence hash', { snapshotHash: HASH, legacyEvidenceHash: 'bad' }],
	])('rejects a malformed primitive %s before opening missing authority', (_label, hashes) => {
		const missingPath = path.join(root, `missing-${_label.replaceAll(' ', '-')}`, 'forge', 'kernel.sqlite');
		const missingDriver = createBuiltinSQLiteDriver({ databasePath: missingPath });
		const result = missingDriver.watchOwnerImportLegacyStarting({
			repo: 'acme/forge', pr: 110, now: NOW, controllerPid: 7_009,
			expectedSnapshot: null, ...hashes,
		});

		expect(result).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
		expect(fs.existsSync(missingPath)).toBe(false);
		missingDriver.close();
	});

	test('rejects malformed identity and time at every direct owner mutation entry point', async () => {
		const methods = [
			'watchOwnerReserveStarting', 'watchOwnerReserveReopened', 'watchOwnerBindRunning',
			'watchOwnerHeartbeat', 'watchOwnerRequestStop', 'watchOwnerRecordTerminal',
			'watchOwnerCompleteTerminal', 'watchOwnerAbortStarting', 'watchOwnerReleaseNonterminal',
			'watchOwnerRecoverDeadStarting', 'watchOwnerRecoverDeadWatcher', 'watchOwnerMarkLegacyBlocked',
			'watchOwnerRecheckLegacyBlocked', 'watchOwnerImportLegacyStarting', 'watchOwnerImportLegacyComplete',
		];
		const input = {
			repo: 'acme/forge', pr: 104, now: NOW, generation: 'generation-104',
			controllerPid: 7_004, expectedControllerPid: 7_004, watcherPid: 7_005,
			terminalReceiptId: 'receipt-104', expectedReceiptId: 'receipt-104',
			snapshotHash: HASH, legacyEvidenceHash: OTHER_HASH, blockReason: 'legacy_lossy',
			action: 'release', expectedSnapshot: null,
		};

		for (const method of methods) {
			expect(driver[method]({ ...input, repo: 'Not Canonical/Forge' })).toEqual({
				ok: false, changed: false, reason: 'invalid_input', row: null,
			});
		}
		for (const method of methods.filter(method => ![
			'watchOwnerAbortStarting', 'watchOwnerReleaseNonterminal',
		].includes(method))) {
			expect(driver[method]({ ...input, now: 'not-a-timestamp' })).toEqual({
				ok: false, changed: false, reason: 'invalid_input', row: null,
			});
		}
		expect(driver.watchOwnerRead({ repo: 'Not Canonical/Forge', pr: 104 })).toEqual({
			ok: false, changed: false, reason: 'invalid_input', row: null,
		});
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
	});

	test('requires a generation before every fenced direct owner mutation', async () => {
		const input = {
			repo: 'acme/forge', pr: 112, now: NOW, controllerPid: 7_012,
			expectedControllerPid: 7_012, watcherPid: 7_013, terminalReceiptId: 'receipt-112',
			expectedReceiptId: 'receipt-112', legacyEvidenceHash: OTHER_HASH,
			action: 'release', expectedSnapshot: null,
		};
		for (const method of [
			'watchOwnerReserveReopened', 'watchOwnerBindRunning', 'watchOwnerHeartbeat',
			'watchOwnerRequestStop', 'watchOwnerRecordTerminal', 'watchOwnerCompleteTerminal',
			'watchOwnerAbortStarting', 'watchOwnerReleaseNonterminal', 'watchOwnerRecoverDeadStarting',
			'watchOwnerRecoverDeadWatcher', 'watchOwnerRecheckLegacyBlocked',
		]) {
			expect(driver[method](input), method).toEqual({
				ok: false, changed: false, reason: 'invalid_input', row: null,
			});
		}
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
	});

	test('rejects malformed time and snapshot at every direct gate mutation entry point', async () => {
		const gateInput = { snapshotHash: HASH, conflictCode: 'legacy_owner_conflict', now: NOW };
		for (const method of [
			'watchGatePublishQuarantine', 'watchGateBindSnapshot',
			'watchGatePublishConflict', 'watchGateRetryConflict', 'watchGateCompleteMigration',
		]) {
			expect(driver[method]({ ...gateInput, now: 'not-a-timestamp' })).toEqual({
				ok: false, changed: false, reason: 'invalid_input', gate: null,
			});
		}
		for (const method of [
			'watchGateBindSnapshot', 'watchGatePublishConflict', 'watchGateCompleteMigration',
		]) {
			expect(driver[method]({ ...gateInput, snapshotHash: 'not-a-hash' })).toEqual({
				ok: false, changed: false, reason: 'invalid_input', gate: null,
			});
		}
		expect(driver.watchGateRetryConflict({
			expectedSnapshotHash: 'not-a-hash', expectedConflictCode: 'legacy_owner_conflict',
			replacementSnapshotHash: OTHER_HASH, now: NOW,
		})).toEqual({ ok: false, changed: false, reason: 'invalid_input', gate: null });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_migration_gate')).toEqual([]);
	});

	test('validates constructed legacy rows before insert', async () => {
		await owner.publishMigrationQuarantine({ updatedAt: NOW }, { driver });
		await owner.bindMigrationSnapshot({ snapshotHash: HASH, updatedAt: NOW }, { driver });
		expect(driver.watchOwnerMarkLegacyBlocked({
			repo: 'acme/forge', pr: 96, now: NOW, snapshotHash: HASH,
			legacyEvidenceHash: 'bad', blockReason: 'legacy_lossy', watcherPid: null,
			terminalReceiptId: null, expectedSnapshot: null,
		})).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
		expect(driver.watchOwnerImportLegacyComplete({
			repo: 'acme/forge', pr: 97, now: NOW, snapshotHash: HASH,
			legacyEvidenceHash: 'bad', terminalReceiptId: 'receipt-97', expectedSnapshot: null,
		})).toEqual({ ok: false, changed: false, reason: 'invalid_input', row: null });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners WHERE pr IN (96, 97)')).toEqual([]);
	});

	test('replays legacy imports independently of the current time and rejects evidence mismatches', async () => {
		driver.watchGatePublishQuarantine({ now: NOW });
		driver.watchGateBindSnapshot({ snapshotHash: HASH, now: NOW });
		const input = {
			repo: 'acme/forge', pr: 111, now: NOW, snapshotHash: HASH,
			legacyEvidenceHash: OTHER_HASH, blockReason: 'legacy_receipt_unverified',
			watcherPid: null, terminalReceiptId: 'receipt-111', expectedSnapshot: null,
		};
		const inserted = driver.watchOwnerMarkLegacyBlocked(input);
		const replayed = driver.watchOwnerMarkLegacyBlocked({ ...input, now: LATER, expectedSnapshot: inserted.row });
		const mismatched = driver.watchOwnerMarkLegacyBlocked({
			...input, now: LATER, terminalReceiptId: 'receipt-other', expectedSnapshot: inserted.row,
		});
		const startingInput = {
			repo: 'acme/forge', pr: 112, now: NOW, snapshotHash: HASH,
			legacyEvidenceHash: OTHER_HASH, controllerPid: 7_112, expectedSnapshot: null,
		};
		const starting = driver.watchOwnerImportLegacyStarting(startingInput);
		const startingReplay = driver.watchOwnerImportLegacyStarting({
			...startingInput, now: LATER, expectedSnapshot: starting.row,
		});
		const startingMismatch = driver.watchOwnerImportLegacyStarting({
			...startingInput, now: LATER, controllerPid: 8_112, expectedSnapshot: starting.row,
		});

		expect(inserted).toMatchObject({ ok: true, changed: true, reason: 'blocked' });
		expect(replayed).toEqual({ ok: true, changed: false, reason: 'idempotent', row: inserted.row });
		expect(mismatched).toEqual({ ok: false, changed: false, reason: 'owner_conflict', row: inserted.row });
		expect(starting).toMatchObject({ ok: true, changed: true, reason: 'imported' });
		expect(startingReplay).toEqual({ ok: true, changed: false, reason: 'idempotent', row: starting.row });
		expect(startingMismatch).toEqual({ ok: false, changed: false, reason: 'owner_conflict', row: starting.row });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners WHERE pr IN (111, 112) ORDER BY pr'))
			.toEqual([inserted.row, starting.row]);
	});

	test.each([
		'legacy_conflict',
		'legacy_unreadable',
		'legacy_lossy',
		'legacy_receipt_unverified',
	])('direct mutation cannot release a %s blocked row without new evidence', async blockReason => {
		driver.watchGatePublishQuarantine({ now: NOW });
		driver.watchGateBindSnapshot({ snapshotHash: HASH, now: NOW });
		const inserted = driver.watchOwnerMarkLegacyBlocked({
			repo: 'acme/forge', pr: 119, now: NOW, snapshotHash: HASH,
			legacyEvidenceHash: OTHER_HASH, blockReason, watcherPid: null,
			terminalReceiptId: blockReason === 'legacy_receipt_unverified' ? 'receipt-119' : null,
			expectedSnapshot: null,
		});

		const result = driver.watchOwnerRecheckLegacyBlocked({
			repo: 'acme/forge', pr: 119, generation: inserted.row.generation, now: LATER,
			action: 'release', legacyEvidenceHash: OTHER_HASH, watcherPid: null,
			terminalReceiptId: null, expectedSnapshot: inserted.row,
		});

		expect(result).toMatchObject({ ok: false, changed: false, reason: 'invalid_transition' });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners WHERE pr = 119')).toEqual([inserted.row]);
	});

	test('rolls back a failed mutation and closes the poisoned dedicated connection', async () => {
		await driver.exec(`
			DROP TABLE kernel_pr_watch_owners;
			CREATE TABLE kernel_pr_watch_owners (
				repo TEXT NOT NULL, pr INTEGER NOT NULL, version INTEGER NOT NULL,
				generation TEXT NOT NULL, phase TEXT NOT NULL,
				controller_pid INTEGER CHECK (controller_pid < 0), watcher_pid INTEGER,
				started_at TEXT NOT NULL, updated_at TEXT NOT NULL, heartbeat_at TEXT,
				terminal_receipt_id TEXT, block_reason TEXT, legacy_evidence_hash TEXT,
				PRIMARY KEY (repo, pr)
			);
		`);
		const failed = await owner.reserveStarting({ repo: 'acme/forge', pr: 79 }, {
			controllerPid: 3_000, startedAt: NOW,
		}, { driver });
		expect(failed).toEqual({ ok: false, changed: false, reason: 'store_error', record: null });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
	});

	test('rejects same-connection transaction re-entry', () => {
		const runtime = selectBuiltinSQLiteRuntime();
		const database = new Database(databasePath);
		expect(() => transactionInternals.runWatchOwnerTransactionOnConnection(
			runtime,
			database,
			{},
			(_connection, reenter) => reenter(() => ({ ok: true })),
		)).toThrow(/re-entry/i);
		database.close();
	});

	test('validates the authority schema while holding the writer lock', () => {
		const runtime = selectBuiltinSQLiteRuntime();
		const database = new Database(databasePath);
		const attacker = new Database(databasePath);
		attacker.exec('PRAGMA busy_timeout=0;');
		const query = database.query.bind(database);
		let injectionError;
		database.query = sql => {
			const statement = query(sql);
			if (!String(sql).includes("SELECT tbl_name AS tbl_name, sql FROM sqlite_master WHERE type = 'trigger'")) return statement;
			return {
				all(...args) {
					const rows = statement.all(...args);
					try {
						attacker.exec(`CREATE TRIGGER raced_watch_authority_trigger
							BEFORE INSERT ON kernel_pr_watch_owners
							BEGIN SELECT RAISE(ABORT, 'raced authority trigger'); END;`);
					} catch (error) {
						injectionError = error;
					}
					return rows;
				},
			};
		};

		const result = transactionInternals.runWatchOwnerTransactionOnConnection(
			runtime, database, {}, () => ({ ok: true }),
		);
		database.query = query;

		expect(result).toEqual({ ok: true });
		expect(String(injectionError?.message || '')).toMatch(/locked|busy/i);
		expect(database.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").all()).toEqual([]);
		attacker.close();
		database.close();
	});

	test('rejects declared async and returned thenable transaction callbacks', () => {
		const runtime = selectBuiltinSQLiteRuntime();
		const database = new Database(databasePath);
		expect(() => transactionInternals.runWatchOwnerTransactionOnConnection(
			runtime, database, {}, async () => ({ ok: true }),
		)).toThrow(/synchronous/i);
		expect(() => transactionInternals.runWatchOwnerTransactionOnConnection(
			runtime, database, {}, () => ({ then() {} }),
		)).toThrow(/thenable/i);
		database.close();
	});

	test('restores the exact busy timeout after the internal transaction', () => {
		const runtime = selectBuiltinSQLiteRuntime();
		const database = new Database(databasePath);
		database.exec('PRAGMA busy_timeout=4321;');
		let inside;
		transactionInternals.runWatchOwnerTransactionOnConnection(runtime, database, {
			watchOwnerBusyTimeoutMs: 17,
		}, connection => {
			inside = connection.query('PRAGMA busy_timeout;').get().timeout;
			return { ok: true };
		});
		expect(inside).toBe(17);
		expect(database.query('PRAGMA busy_timeout;').get().timeout).toBe(4_321);
		database.close();
	});

	test('observably closes the poisoned owned connection after callback failure', () => {
		let closes = 0;
		class ObservedDatabase {
			constructor(...args) {
				this.inner = new Database(...args);
			}
			exec(...args) { return this.inner.exec(...args); }
			query(...args) { return this.inner.query(...args); }
			close() { closes += 1; return this.inner.close(); }
		}
		const runtime = {
			...selectBuiltinSQLiteRuntime(),
			module: { Database: ObservedDatabase },
		};
		expect(() => transactionInternals.runWatchOwnerTransaction(
			runtime,
			databasePath,
			{},
			() => { throw new Error('poison'); },
		)).toThrow('poison');
		expect(closes).toBe(1);
	});

	test('returns the committed result when busy-timeout restoration fails', () => {
		let closes = 0;
		let restorationAttempts = 0;
		let committed = false;
		class RestoreFailureDatabase {
			constructor(...args) {
				this.inner = new Database(...args);
			}
			exec(sql) {
				if (committed && /^PRAGMA busy_timeout=/i.test(sql) && restorationAttempts++ === 0) {
					throw new Error('synthetic timeout restoration failure');
				}
				const result = this.inner.exec(sql);
				if (sql === 'COMMIT;') committed = true;
				return result;
			}
			query(...args) { return this.inner.query(...args); }
			close() { closes += 1; return this.inner.close(); }
		}
		const runtime = {
			...selectBuiltinSQLiteRuntime(),
			module: { Database: RestoreFailureDatabase },
		};
		const result = transactionInternals.runWatchOwnerTransaction(
			runtime,
			databasePath,
			{ watchOwnerBusyTimeoutMs: 17 },
			() => ({ ok: true, changed: true }),
		);
		expect(result).toEqual({ ok: true, changed: true });
		expect(restorationAttempts).toBe(1);
		expect(closes).toBe(1);
	});
	test('rejects inbound foreign-key cascades referencing watcher authority rows', async () => {
		await driver.exec(`
			CREATE TABLE kernel_pr_watch_owner_extras (
				extra TEXT NOT NULL PRIMARY KEY,
				repo TEXT NOT NULL,
				pr INTEGER NOT NULL,
				FOREIGN KEY (repo, pr) REFERENCES kernel_pr_watch_owners (repo, pr) ON DELETE CASCADE
			);
		`);
		const result = await owner.reserveStarting({ repo: 'acme/forge', pr: 116 }, {
			controllerPid: 7_116, startedAt: NOW,
		}, { driver });
		expect(result).toEqual({ ok: false, changed: false, reason: 'authority_unavailable', record: null });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
	});

	test('rejects inbound foreign-key cascades declared with different identifier casing', async () => {
		await driver.exec(`
			CREATE TABLE watcher_refs_kernel (
				extra TEXT NOT NULL PRIMARY KEY,
				repo TEXT NOT NULL,
				pr INTEGER NOT NULL,
				FOREIGN KEY (repo, pr) REFERENCES KERNEL_PR_WATCH_OWNERS (repo, pr) ON DELETE CASCADE
			);
		`);
		const result = await owner.reserveStarting({ repo: 'acme/forge', pr: 117 }, {
			controllerPid: 7_117, startedAt: NOW,
		}, { driver });
		expect(result).toEqual({ ok: false, changed: false, reason: 'authority_unavailable', record: null });
	});

	test('rejects outbound foreign keys declared on the authority tables themselves', async () => {
		await driver.exec('DROP TABLE kernel_pr_watch_owners;');
		await driver.exec(`
			CREATE TABLE kernel_pr_watch_parent (
				id TEXT NOT NULL PRIMARY KEY
			);
			CREATE TABLE kernel_pr_watch_owners (
				repo TEXT NOT NULL REFERENCES kernel_pr_watch_parent (id) ON DELETE CASCADE,
				pr INTEGER NOT NULL,
				version INTEGER NOT NULL,
				generation TEXT NOT NULL,
				phase TEXT NOT NULL,
				controller_pid INTEGER,
				watcher_pid INTEGER,
				started_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				heartbeat_at TEXT,
				terminal_receipt_id TEXT,
				block_reason TEXT,
				legacy_evidence_hash TEXT,
				PRIMARY KEY (repo, pr)
			);
		`);
		const result = await owner.reserveStarting({ repo: 'acme/forge', pr: 118 }, {
			controllerPid: 7_118, startedAt: NOW,
		}, { driver });
		expect(result).toEqual({ ok: false, changed: false, reason: 'authority_unavailable', record: null });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
	});

	test('rejects extra uniqueness constraints on the authority tables', async () => {
		await driver.exec('DROP TABLE kernel_pr_watch_owners;');
		await driver.exec(`
			CREATE TABLE kernel_pr_watch_owners (
				repo TEXT NOT NULL,
				pr INTEGER NOT NULL,
				version INTEGER NOT NULL,
				generation TEXT NOT NULL,
				phase TEXT NOT NULL,
				controller_pid INTEGER,
				watcher_pid INTEGER,
				started_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				heartbeat_at TEXT,
				terminal_receipt_id TEXT,
				block_reason TEXT,
				legacy_evidence_hash TEXT,
				PRIMARY KEY (repo, pr),
				UNIQUE (repo) ON CONFLICT REPLACE
			);
		`);
		const result = await owner.reserveStarting({ repo: 'acme/forge', pr: 119 }, {
			controllerPid: 7_119, startedAt: NOW,
		}, { driver });
		expect(result).toEqual({ ok: false, changed: false, reason: 'authority_unavailable', record: null });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
	});

	test('rejects cross-table triggers that write into authority tables', async () => {
		await driver.exec(`
			CREATE TABLE kernel_pr_watch_owner_events (
				event TEXT NOT NULL PRIMARY KEY
			);
			CREATE TRIGGER purge_owners_on_event
			AFTER INSERT ON kernel_pr_watch_owner_events
			BEGIN
				DELETE FROM kernel_pr_watch_owners;
			END;
		`);
		const result = await owner.reserveStarting({ repo: 'acme/forge', pr: 120 }, {
			controllerPid: 7_120, startedAt: NOW,
		}, { driver });
		expect(result).toEqual({ ok: false, changed: false, reason: 'authority_unavailable', record: null });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
	});

	test('rejects cross-table triggers that reference authority tables via quoted identifiers', async () => {
		await driver.exec(`
			CREATE TABLE kernel_pr_watch_owner_events (
				event TEXT NOT NULL PRIMARY KEY
			);
			CREATE TRIGGER purge_owners_quoted_on_event
			AFTER INSERT ON kernel_pr_watch_owner_events
			BEGIN
				DELETE FROM "kernel_pr_watch_owners";
			END;
		`);
		const result = await owner.reserveStarting({ repo: 'acme/forge', pr: 121 }, {
			controllerPid: 7_121, startedAt: NOW,
		}, { driver });
		expect(result).toEqual({ ok: false, changed: false, reason: 'authority_unavailable', record: null });
		expect(await driver.queryAll('SELECT * FROM kernel_pr_watch_owners')).toEqual([]);
	});
});
