'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BUILTIN_SQLITE_RUNTIME_ORDER = Object.freeze(['bun:sqlite', 'node:sqlite']);
let probeCounter = 0;

function isModuleUnavailable(error) {
	return error && (
		error.code === 'MODULE_NOT_FOUND'
		|| error.code === 'ERR_UNKNOWN_BUILTIN_MODULE'
		|| /Cannot find module|No such built-in module/i.test(String(error.message || error))
	);
}

function loadRuntimeDescriptor(id, sqliteModule) {
	if (id === 'bun:sqlite') {
		if (typeof sqliteModule.Database !== 'function') {
			throw new Error('bun:sqlite is present but does not expose Database');
		}
		return {
			id,
			module: sqliteModule,
			databaseClassName: 'Database',
			nativeCompileDependency: false,
			experimental: false,
		};
	}

	if (id === 'node:sqlite') {
		if (typeof sqliteModule.DatabaseSync !== 'function') {
			throw new Error('node:sqlite is present but does not expose DatabaseSync');
		}
		return {
			id,
			module: sqliteModule,
			databaseClassName: 'DatabaseSync',
			nativeCompileDependency: false,
			experimental: true,
		};
	}

	throw new Error(`Unsupported builtin SQLite runtime: ${id}`);
}

function selectBuiltinSQLiteRuntime(deps = {}) {
	const requireModule = deps.requireModule || require;
	const unavailable = [];

	for (const id of BUILTIN_SQLITE_RUNTIME_ORDER) {
		try {
			return loadRuntimeDescriptor(id, requireModule(id));
		} catch (error) {
			if (!isModuleUnavailable(error)) {
				throw error;
			}
			unavailable.push(`${id}: ${error.message || error}`);
		}
	}

	throw new Error([
		'Forge Kernel requires a builtin SQLite runtime: bun:sqlite or node:sqlite.',
		'Install/run Forge with Bun >= 1.2 or Node >= 22.5 built with node:sqlite support.',
		'No native-compile SQLite package is installed by default.',
		`Detection failures: ${unavailable.join('; ')}`,
	].join(' '));
}

function ensureFileBackedDatabaseDirectory(databasePath) {
	if (!databasePath || databasePath === ':memory:' || String(databasePath).startsWith('file:')) {
		return;
	}
	const databaseDir = path.dirname(databasePath);
	if (databaseDir && databaseDir !== '.') {
		fs.mkdirSync(databaseDir, { recursive: true });
	}
}

function createDatabase(runtime, databasePath) {
	ensureFileBackedDatabaseDirectory(databasePath);
	if (runtime.id === 'bun:sqlite') {
		return new runtime.module.Database(databasePath, { create: true });
	}
	if (runtime.id === 'node:sqlite') {
		return new runtime.module.DatabaseSync(databasePath);
	}
	throw new Error(`Unsupported builtin SQLite runtime: ${runtime.id}`);
}

function execSql(_runtime, db, sql) {
	db.exec(sql);
}

function queryAll(runtime, db, sql) {
	if (runtime.id === 'bun:sqlite') {
		return db.query(sql).all();
	}
	return db.prepare(sql).all();
}

function queryOne(runtime, db, sql) {
	return queryAll(runtime, db, sql)[0] || {};
}

function closeDatabase(db) {
	if (db && typeof db.close === 'function') {
		db.close();
	}
}

function createDriver(runtime, configuredDatabasePath) {
	let db;
	let openedDatabasePath;

	function resolveDatabasePath(config) {
		const databasePath = configuredDatabasePath || (config && config.databasePath);
		if (!databasePath) {
			throw new Error('Kernel SQLite driver requires a databasePath or broker config databasePath');
		}
		return databasePath;
	}

	function getDatabase(config) {
		const databasePath = resolveDatabasePath(config);
		if (!db) {
			db = createDatabase(runtime, databasePath);
			openedDatabasePath = databasePath;
		} else if (openedDatabasePath !== databasePath) {
			throw new Error(`Kernel SQLite driver is already open for ${openedDatabasePath}`);
		}
		return db;
	}

	return {
		runtime: {
			id: runtime.id,
			databaseClassName: runtime.databaseClassName,
			nativeCompileDependency: runtime.nativeCompileDependency,
			experimental: runtime.experimental,
		},
		databasePath: configuredDatabasePath,
		async exec(statement, config) {
			execSql(runtime, getDatabase(config), statement);
		},
		async queryAll(statement, config) {
			return queryAll(runtime, getDatabase(config), statement);
		},
		close() {
			closeDatabase(db);
			db = null;
			openedDatabasePath = null;
		},
	};
}

function assertCapability(runtime, capability, detail) {
	if (!detail.ok) {
		throw new Error(`Builtin SQLite runtime ${runtime.id} failed ${capability} validation: ${detail.reason}`);
	}
	return true;
}

function validateWal(runtime, db) {
	const row = queryOne(runtime, db, 'PRAGMA journal_mode=WAL;');
	const mode = String(row.journal_mode || '').toLowerCase();
	return { ok: mode === 'wal', reason: `journal_mode=${mode || 'unknown'}` };
}

function validateBusyTimeout(runtime, db) {
	const row = queryOne(runtime, db, 'PRAGMA busy_timeout=5000;');
	const timeout = Number(row.timeout);
	return { ok: timeout === 5000, reason: `timeout=${Number.isNaN(timeout) ? 'unknown' : timeout}` };
}

function createProbeTableName(prefix) {
	probeCounter += 1;
	return `${prefix}_${process.pid}_${probeCounter}`;
}

function validateTransactions(runtime, db) {
	const tableName = createProbeTableName('forge_transaction_probe');
	let committed = false;
	try {
		execSql(runtime, db, [
			'BEGIN IMMEDIATE;',
			`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, value TEXT NOT NULL);`,
			`INSERT INTO ${tableName} (value) VALUES ('ok');`,
			'COMMIT;',
		].join('\n'));
		committed = true;
		const row = queryOne(runtime, db, `SELECT value FROM ${tableName} WHERE id = 1;`);
		return { ok: row.value === 'ok', reason: `value=${row.value || 'missing'}` };
	} catch (error) {
		if (!committed) {
			try {
				execSql(runtime, db, 'ROLLBACK;');
			} catch {
				// Ignore rollback errors from runtimes that already closed the failed transaction.
			}
		}
		return { ok: false, reason: error.message || String(error) };
	} finally {
		try {
			execSql(runtime, db, `DROP TABLE IF EXISTS ${tableName};`);
		} catch {
			// Probe cleanup must not hide the original capability result.
		}
	}
}

function validateFts5(runtime, db) {
	const tableName = createProbeTableName('forge_fts_probe');
	try {
		execSql(runtime, db, `CREATE VIRTUAL TABLE ${tableName} USING fts5(content);`);
		execSql(runtime, db, `INSERT INTO ${tableName} (content) VALUES ('kernel sqlite driver');`);
		const row = queryOne(runtime, db, `SELECT count(*) AS count FROM ${tableName} WHERE ${tableName} MATCH 'sqlite';`);
		return { ok: Number(row.count) === 1, reason: `count=${row.count || 0}` };
	} catch (error) {
		return { ok: false, reason: error.message || String(error) };
	} finally {
		try {
			execSql(runtime, db, `DROP TABLE IF EXISTS ${tableName};`);
		} catch {
			// Probe cleanup must not hide the original capability result.
		}
	}
}

function validateCheckpoint(runtime, db) {
	try {
		const row = queryOne(runtime, db, 'PRAGMA wal_checkpoint(TRUNCATE);');
		return { ok: Number(row.busy) === 0, reason: `busy=${row.busy}` };
	} catch (error) {
		return { ok: false, reason: error.message || String(error) };
	}
}

async function createBackup(runtime, db, backupPath) {
	ensureFileBackedDatabaseDirectory(backupPath);
	if (fs.existsSync(backupPath)) {
		fs.rmSync(backupPath, { force: true });
	}

	if (runtime.id === 'node:sqlite') {
		if (typeof runtime.module.backup === 'function') {
			await runtime.module.backup(db, backupPath);
			return;
		}
		if (typeof db.backup === 'function') {
			await db.backup(backupPath);
			return;
		}
		throw new Error('node:sqlite backup API is unavailable');
	}

	if (runtime.id === 'bun:sqlite') {
		if (typeof db.serialize !== 'function') {
			throw new Error('bun:sqlite Database.serialize() is unavailable');
		}
		fs.writeFileSync(backupPath, db.serialize());
		return;
	}

	throw new Error(`Unsupported builtin SQLite runtime: ${runtime.id}`);
}

async function validateBackup(runtime, db, backupPath) {
	const tableName = createProbeTableName('forge_backup_probe');
	try {
		execSql(runtime, db, `CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, value TEXT NOT NULL);`);
		execSql(runtime, db, `INSERT INTO ${tableName} (value) VALUES ('ok');`);
		await createBackup(runtime, db, backupPath);
		const backupDb = createDatabase(runtime, backupPath);
		try {
			const row = queryOne(runtime, backupDb, `SELECT value FROM ${tableName} WHERE id = 1;`);
			return {
				ok: row.value === 'ok' && fs.existsSync(backupPath),
				reason: `value=${row.value || 'missing'}`,
			};
		} finally {
			closeDatabase(backupDb);
		}
	} catch (error) {
		return { ok: false, reason: error.message || String(error) };
	} finally {
		try {
			execSql(runtime, db, `DROP TABLE IF EXISTS ${tableName};`);
		} catch {
			// Probe cleanup must not hide the original capability result.
		}
	}
}

async function validateBuiltinSQLiteRuntimeDriver(options = {}, deps = {}) {
	const runtime = options.runtime || selectBuiltinSQLiteRuntime(deps);
	let tempDir = options.tempDir;
	if (!tempDir && !options.databasePath && !options.backupPath) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-kernel-sqlite-'));
	}
	const databasePath = options.databasePath
		|| (tempDir ? path.join(tempDir, 'kernel.sqlite') : `${options.backupPath}.source.sqlite`);
	const backupPath = options.backupPath
		|| (tempDir ? path.join(tempDir, 'kernel.backup.sqlite') : `${databasePath}.backup.sqlite`);
	const db = createDatabase(runtime, databasePath);

	try {
		const capabilities = {
			wal: assertCapability(runtime, 'WAL', validateWal(runtime, db)),
			busyTimeout: assertCapability(runtime, 'busy_timeout', validateBusyTimeout(runtime, db)),
			transactions: assertCapability(runtime, 'transaction', validateTransactions(runtime, db)),
			fts5: assertCapability(runtime, 'FTS5', validateFts5(runtime, db)),
			checkpoint: assertCapability(runtime, 'checkpoint', validateCheckpoint(runtime, db)),
			backup: assertCapability(runtime, 'backup', await validateBackup(runtime, db, backupPath)),
			nativeCompileDependency: runtime.nativeCompileDependency,
		};

		return {
			runtime: {
				id: runtime.id,
				databaseClassName: runtime.databaseClassName,
				nativeCompileDependency: runtime.nativeCompileDependency,
				experimental: runtime.experimental,
			},
			databasePath,
			backupPath,
			capabilities,
		};
	} finally {
		closeDatabase(db);
	}
}

function createBuiltinSQLiteDriver(options = {}, deps = {}) {
	const runtime = options.runtime || selectBuiltinSQLiteRuntime(deps);
	return createDriver(runtime, options.databasePath);
}

module.exports = {
	BUILTIN_SQLITE_RUNTIME_ORDER,
	createBuiltinSQLiteDriver,
	selectBuiltinSQLiteRuntime,
	validateBuiltinSQLiteRuntimeDriver,
};
