const { afterEach, describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDirs = [];

function makeTempDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-kernel-sqlite-'));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
	}
});

describe('Kernel SQLite runtime driver selection', () => {
	test('selects the first builtin SQLite runtime without native package dependencies', () => {
		const { selectBuiltinSQLiteRuntime } = require('../../lib/kernel/sqlite-driver');
		const calls = [];

		const selected = selectBuiltinSQLiteRuntime({
			requireModule(name) {
				calls.push(name);
				if (name === 'bun:sqlite') {
					return {
						Database: function Database() {},
					};
				}
				throw new Error(`unexpected module ${name}`);
			},
		});

		expect(selected).toMatchObject({
			id: 'bun:sqlite',
			databaseClassName: 'Database',
			nativeCompileDependency: false,
			experimental: false,
		});
		expect(calls).toEqual(['bun:sqlite']);
	});

	test('falls back to node:sqlite when bun:sqlite is not available', () => {
		const { selectBuiltinSQLiteRuntime } = require('../../lib/kernel/sqlite-driver');
		const selected = selectBuiltinSQLiteRuntime({
			requireModule(name) {
				if (name === 'node:sqlite') {
					return {
						DatabaseSync: function DatabaseSync() {},
						backup: async () => {},
					};
				}
				const error = new Error(`Cannot find module ${name}`);
				error.code = 'MODULE_NOT_FOUND';
				throw error;
			},
		});

		expect(selected).toMatchObject({
			id: 'node:sqlite',
			databaseClassName: 'DatabaseSync',
			nativeCompileDependency: false,
			experimental: true,
		});
	});

	test('rejects node:sqlite runtimes without backup support', () => {
		const { selectBuiltinSQLiteRuntime } = require('../../lib/kernel/sqlite-driver');

		expect(() => selectBuiltinSQLiteRuntime({
			requireModule(name) {
				if (name === 'node:sqlite') {
					return {
						DatabaseSync: function DatabaseSync() {},
					};
				}
				const error = new Error(`Cannot find module ${name}`);
				error.code = 'MODULE_NOT_FOUND';
				throw error;
			},
		})).toThrow(/node:sqlite is present but does not expose backup/);
	});

	test('fails with a clear remediation when no builtin SQLite runtime exists', () => {
		const { selectBuiltinSQLiteRuntime } = require('../../lib/kernel/sqlite-driver');

		expect(() => selectBuiltinSQLiteRuntime({
			requireModule(name) {
				const error = new Error(`Cannot find module ${name}`);
				error.code = 'MODULE_NOT_FOUND';
				throw error;
			},
		})).toThrow(/Forge Kernel requires a builtin SQLite runtime/);
	});

	test('validates the real builtin driver against WAL, busy_timeout, checkpoint, backup, and FTS5', async () => {
		const { validateBuiltinSQLiteRuntimeDriver } = require('../../lib/kernel/sqlite-driver');
		const databasePath = path.join(makeTempDir(), 'kernel.sqlite');

		const result = await validateBuiltinSQLiteRuntimeDriver({ databasePath });

		expect(result.runtime.id).toBe('bun:sqlite');
		expect(result.capabilities).toMatchObject({
			wal: true,
			busyTimeout: true,
			transactions: true,
			checkpoint: true,
			backup: true,
			fts5: true,
			nativeCompileDependency: false,
		});
		expect(result.databasePath).toBe(databasePath);
		expect(fs.existsSync(result.backupPath)).toBe(true);
	});

	test('removes internally-created validation temp directories', async () => {
		const { validateBuiltinSQLiteRuntimeDriver } = require('../../lib/kernel/sqlite-driver');
		const before = new Set(
			fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('forge-kernel-sqlite-')),
		);

		await validateBuiltinSQLiteRuntimeDriver();

		const leaked = fs.readdirSync(os.tmpdir())
			.filter((name) => name.startsWith('forge-kernel-sqlite-'))
			.filter((name) => !before.has(name));
		expect(leaked).toEqual([]);
	});

	test('creates parent directories for fresh file-backed broker databases', async () => {
		const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
		const databasePath = path.join(makeTempDir(), 'git-common-dir', 'forge', 'kernel.sqlite');
		const driver = createBuiltinSQLiteDriver({ databasePath });

		try {
			await driver.exec('CREATE TABLE broker_directory_probe (id INTEGER PRIMARY KEY);');
		} finally {
			driver.close();
		}

		expect(fs.existsSync(databasePath)).toBe(true);
	});

	test('derives the database path from broker config instead of opening memory', async () => {
		const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
		const databasePath = path.join(makeTempDir(), 'git-common-dir', 'forge', 'kernel.sqlite');
		const driver = createBuiltinSQLiteDriver();

		try {
			await driver.exec('CREATE TABLE broker_config_probe (id INTEGER PRIMARY KEY);', { databasePath });
		} finally {
			driver.close();
		}

		expect(fs.existsSync(databasePath)).toBe(true);
	});

	test('fails clearly when the driver has no database path or broker config', async () => {
		const { createBuiltinSQLiteDriver } = require('../../lib/kernel/sqlite-driver');
		const driver = createBuiltinSQLiteDriver();

		try {
			await expect(driver.exec('SELECT 1;')).rejects.toThrow(/requires a databasePath/);
		} finally {
			driver.close();
		}
	});

	test('can rerun real validation against the same database without leaving probe tables', async () => {
		const { Database } = require('bun:sqlite');
		const { validateBuiltinSQLiteRuntimeDriver } = require('../../lib/kernel/sqlite-driver');
		const databasePath = path.join(makeTempDir(), 'kernel.sqlite');

		await validateBuiltinSQLiteRuntimeDriver({ databasePath });
		await validateBuiltinSQLiteRuntimeDriver({ databasePath });

		const db = new Database(databasePath);
		try {
			const probeTables = db.query([
				"SELECT name FROM sqlite_master WHERE type = 'table'",
				"AND name LIKE 'forge_%_probe_%'",
				'ORDER BY name;',
			].join(' ')).all();
			expect(probeTables).toEqual([]);
		} finally {
			db.close();
		}
	});
});
