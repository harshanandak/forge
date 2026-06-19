'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const {
	ISSUE_COMMAND_SCHEMA_VERSION,
	ISSUE_COMMAND_EXIT_CODES,
	formatIssueCommandError,
} = require('./issue-command-contract');
const { buildReadinessIndex } = require('./readiness-model');

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
		const hasBackupApi = typeof sqliteModule.backup === 'function'
			|| typeof sqliteModule.DatabaseSync.prototype.backup === 'function';
		if (!hasBackupApi) {
			throw new Error('node:sqlite is present but does not expose backup support; run with Node >= 22.16 or Bun >= 1.2');
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
		'Install/run Forge with Bun >= 1.2 or Node >= 22.16 with node:sqlite backup support.',
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

// Parameterized statement helpers — bun:sqlite and node:sqlite both bind positional
// `?` params, but expose them through different APIs. All issue-layer SQL MUST use these
// (never string interpolation of values) to stay injection-safe.
function allParams(runtime, db, sql, params = []) {
	if (runtime.id === 'bun:sqlite') {
		return db.query(sql).all(...params);
	}
	return db.prepare(sql).all(...params);
}

// Parameterized write helper (INSERT/UPDATE/DELETE). Like allParams, both runtimes
// bind positional `?` params but expose .run() through different statement APIs. All
// mutating issue-layer SQL MUST use this (never interpolate values) to stay
// injection-safe. Native UNIQUE-constraint errors are intentionally allowed to
// propagate unmodified — the broker parses their raw message to convert an
// idempotency/lease collision into a duplicate replay.
function runParams(runtime, db, sql, params = []) {
	if (runtime.id === 'bun:sqlite') {
		return db.query(sql).run(...params);
	}
	return db.prepare(sql).run(...params);
}

// A table may not exist on a partially-migrated DB; readiness inputs degrade to empty.
function safeAll(runtime, db, sql, params = []) {
	try {
		return allParams(runtime, db, sql, params);
	} catch {
		return [];
	}
}

function rowToIssueSummary(row, readinessEntry) {
	return {
		id: row.id,
		title: row.title,
		body: row.body ?? null,
		type: row.type,
		status: row.status,
		rank: Number(row.priority_rank) || 0,
		revision: Number(row.entity_revision) || 0,
		blocked: readinessEntry ? Boolean(readinessEntry.blocked) : false,
		claimed_by: row.claimed_by ?? null,
		updated_at: row.updated_at,
	};
}

function okIssueResponse(command, data, nextCommands = []) {
	return {
		ok: true,
		schema_version: ISSUE_COMMAND_SCHEMA_VERSION,
		command,
		data,
		next_commands: nextCommands,
	};
}

// Derive the whole-board readiness read model (D18) from the authority tables.
function loadBoardReadiness(runtime, db, context = {}) {
	const issues = allParams(runtime, db, 'SELECT * FROM kernel_issues');
	const dependencies = safeAll(runtime, db, 'SELECT * FROM kernel_dependencies');
	const conflicts = safeAll(runtime, db, 'SELECT * FROM kernel_conflicts');
	const claims = safeAll(runtime, db, 'SELECT * FROM kernel_claims');
	const index = buildReadinessIndex({
		issues,
		dependencies,
		conflicts,
		claims,
		now: context.now,
		actor: context.actor,
	});
	return { issues, index };
}

function firstPositional(args = []) {
	return (args || []).find(value => typeof value === 'string' && !value.startsWith('-'));
}

// Read-side of driver.issueOperation: ready/list/show/search/stats as parameterized
// SELECTs returning issue-command-contract shapes. Mutations are handled separately
// through the broker's guarded-event path (later wave).
function runIssueReadOperation(runtime, db, operation, args, context) {
	if (operation === 'list') {
		const { issues, index } = loadBoardReadiness(runtime, db, context);
		const summaries = issues
			.map(row => rowToIssueSummary(row, index.readinessById[row.id]))
			.sort((a, b) => (a.rank - b.rank) || String(a.id).localeCompare(String(b.id)));
		return okIssueResponse('issue.list', { issues: summaries, count: summaries.length });
	}
	if (operation === 'ready') {
		const { issues, index } = loadBoardReadiness(runtime, db, context);
		const byId = new Map(issues.map(row => [row.id, row]));
		const summaries = index.readyQueue.map(id => rowToIssueSummary(byId.get(id), index.readinessById[id]));
		return okIssueResponse('issue.ready', { issues: summaries, count: summaries.length });
	}
	if (operation === 'show') {
		const id = firstPositional(args);
		const rows = allParams(runtime, db, 'SELECT * FROM kernel_issues WHERE id = ?', [id]);
		if (!rows[0]) {
			return formatIssueCommandError({
				command: 'issue.show',
				code: 'FORGE_ISSUE_NOT_FOUND',
				message: `Issue ${id ?? '<missing id>'} not found`,
				exitCode: ISSUE_COMMAND_EXIT_CODES.notFound,
			});
		}
		const { index } = loadBoardReadiness(runtime, db, context);
		return okIssueResponse('issue.show', rowToIssueSummary(rows[0], index.readinessById[id]));
	}
	if (operation === 'search') {
		const term = `%${firstPositional(args) || ''}%`;
		const rows = allParams(
			runtime, db,
			'SELECT * FROM kernel_issues WHERE title LIKE ? OR body LIKE ? ORDER BY priority_rank ASC, id ASC',
			[term, term],
		);
		const { index } = loadBoardReadiness(runtime, db, context);
		const summaries = rows.map(row => rowToIssueSummary(row, index.readinessById[row.id]));
		return okIssueResponse('issue.search', { issues: summaries, count: summaries.length });
	}
	if (operation === 'stats') {
		const { index } = loadBoardReadiness(runtime, db, context);
		const statusRows = allParams(runtime, db, 'SELECT status, COUNT(*) AS n FROM kernel_issues GROUP BY status');
		const counts = {};
		for (const row of statusRows) {
			counts[row.status] = Number(row.n);
		}
		const activeClaims = Number(
			safeAll(runtime, db, "SELECT COUNT(*) AS n FROM kernel_claims WHERE state = 'active'")[0]?.n || 0,
		);
		return okIssueResponse('issue.stats', {
			counts,
			ready_count: index.readyQueue.length,
			blocked_count: index.blocked.length,
			active_claims: activeClaims,
		});
	}
	return null;
}

// --- Event-store primitives (Wave 2) -------------------------------------------
// Low-level reads/writes over kernel_events + kernel_issues that the broker's
// guarded-event path composes. Signatures mirror the inline fake drivers in
// broker-*.test.js exactly. CAS/idempotency/lease orchestration lives in the
// broker; these stay deliberately mechanical.

const KERNEL_EVENT_COLUMNS = Object.freeze([
	'id',
	'entity_type',
	'entity_id',
	'event_type',
	'idempotency_key',
	'expected_revision',
	'actor',
	'origin',
	'payload_json',
	'created_at',
]);

// Persist one event. The id is supplied by the caller or minted here (event ids are
// TEXT, not autoincrement). The event's payload is stored as payload_json: a
// pre-serialized payload_json wins, else the payload object is JSON-stringified. The
// native UNIQUE(idempotency_key) error is intentionally NOT caught here.
function insertKernelEventRow(runtime, db, event) {
	const id = event.id || randomUUID();
	const payloadJson = event.payload_json ?? JSON.stringify(event.payload ?? {});
	const row = {
		id,
		entity_type: event.entity_type,
		entity_id: event.entity_id,
		event_type: event.event_type,
		idempotency_key: event.idempotency_key,
		expected_revision: event.expected_revision,
		actor: event.actor,
		origin: event.origin,
		payload_json: payloadJson,
		created_at: event.created_at,
	};
	const placeholders = KERNEL_EVENT_COLUMNS.map(() => '?').join(', ');
	runParams(
		runtime,
		db,
		`INSERT INTO kernel_events (${KERNEL_EVENT_COLUMNS.join(', ')}) VALUES (${placeholders})`,
		KERNEL_EVENT_COLUMNS.map(column => row[column]),
	);
	// Return what we wrote (minted id included) so callers can build the projection
	// outbox entry — don't depend on .run()'s return shape across runtimes.
	return { ...event, ...row };
}

// Read the entity-revision row for an issue (the CAS authority). Only issues store
// entity_revision; any other entity type has no stored revision, so return null and
// let the evaluator treat it as a brand-new (revision-0) entity.
function loadKernelEntityRow(runtime, db, entityType, entityId) {
	if (entityType !== 'issue') return null;
	const rows = allParams(runtime, db, 'SELECT * FROM kernel_issues WHERE id = ?', [entityId]);
	return rows[0] || null;
}

// Read the full event stream for one entity, oldest first (matches
// idx_kernel_events_entity_created; there is no seq column, so created_at is the
// ordering key).
function listKernelEventRows(runtime, db, entityType, entityId) {
	return allParams(
		runtime,
		db,
		'SELECT * FROM kernel_events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at ASC',
		[entityType, entityId],
	);
}

// Look up the committed event for an idempotency key (the duplicate-replay probe).
// The broker calls this unconditionally inside a Promise.all even for keyless
// events, so guard a falsy key up front rather than binding undefined.
function loadKernelEventByIdempotencyKeyRow(runtime, db, idempotencyKey) {
	if (!idempotencyKey) return null;
	const rows = allParams(
		runtime,
		db,
		'SELECT * FROM kernel_events WHERE idempotency_key = ?',
		[idempotencyKey],
	);
	return rows[0] || null;
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
		const brokerDatabasePath = config && config.databasePath;
		if (configuredDatabasePath && brokerDatabasePath && configuredDatabasePath !== brokerDatabasePath) {
			throw new Error([
				'Kernel SQLite driver databasePath mismatch:',
				`driver is configured for ${configuredDatabasePath}`,
				`but broker config uses ${brokerDatabasePath}`,
			].join(' '));
		}
		const databasePath = brokerDatabasePath || configuredDatabasePath;
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
		async issueOperation(operation, args = [], context = {}, config = {}) {
			const database = getDatabase(config);
			const READ_OPERATIONS = new Set(['ready', 'list', 'show', 'search', 'stats']);
			if (READ_OPERATIONS.has(operation)) {
				return runIssueReadOperation(runtime, database, operation, args, context);
			}
			// Mutations (create/update/close/comment/dep.add/dep.remove/claim/release) are
			// implemented through the broker's guarded-event path in a later wave.
			throw new Error(`Kernel SQLite driver issueOperation: mutation operation '${operation}' is not implemented yet (reads only)`);
		},
		// --- Event-store primitives (Wave 2) — composed by broker.runGuardedEvent.
		// `context` is part of the broker contract but unused by these direct SQL
		// reads/writes (prefixed `_` for eslint no-unused-vars).
		async insertKernelEvent(event, _context = {}, config = {}) {
			return insertKernelEventRow(runtime, getDatabase(config), event);
		},
		async loadKernelEntity(entityType, entityId, _context = {}, config = {}) {
			return loadKernelEntityRow(runtime, getDatabase(config), entityType, entityId);
		},
		async listKernelEvents(entityType, entityId, _context = {}, config = {}) {
			return listKernelEventRows(runtime, getDatabase(config), entityType, entityId);
		},
		async loadKernelEventByIdempotencyKey(idempotencyKey, _context = {}, config = {}) {
			return loadKernelEventByIdempotencyKeyRow(runtime, getDatabase(config), idempotencyKey);
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
	let ownsTempDir = false;
	if (!tempDir && !options.databasePath && !options.backupPath) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-kernel-sqlite-'));
		ownsTempDir = true;
	}
	const databasePath = options.databasePath
		|| (tempDir ? path.join(tempDir, 'kernel.sqlite') : `${options.backupPath}.source.sqlite`);
	const backupPath = options.backupPath
		|| (tempDir ? path.join(tempDir, 'kernel.backup.sqlite') : `${databasePath}.backup.sqlite`);
	let db;

	try {
		db = createDatabase(runtime, databasePath);
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
		if (ownsTempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
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
