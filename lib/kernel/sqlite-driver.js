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
// ONLY a missing-table error is tolerated — a locked/corrupt DB or a real SQL
// regression must surface, not silently produce wrong readiness/stats/projection.
function safeAll(runtime, db, sql, params = []) {
	try {
		return allParams(runtime, db, sql, params);
	} catch (error) {
		if (/no such table/i.test(String(error?.message || ''))) {
			return [];
		}
		throw error;
	}
}

// Labels are stored as a JSON-array TEXT column (canonical, written by KAP-4) but a
// legacy comma-separated value is tolerated. Always returns a string[] — [] when the
// column is null/empty/unparseable — so the projection never surfaces a raw blob.
function parseLabels(raw) {
	if (raw == null || raw === '') return [];
	if (Array.isArray(raw)) return raw.map(String);
	if (typeof raw !== 'string') return [];
	const trimmed = raw.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed);
			return Array.isArray(parsed) ? parsed.map(String) : [];
		} catch {
			return [];
		}
	}
	return trimmed.split(',').map(value => value.trim()).filter(Boolean);
}

function rowToIssueSummary(row, readinessEntry, claimedBy = null, dependencyIds = []) {
	return {
		id: row.id,
		title: row.title,
		body: row.body ?? null,
		type: row.type,
		status: row.status,
		// priority is the stored label (notNull default 'P2'); rank is the numeric sort key.
		priority: row.priority,
		rank: Number(row.priority_rank) || 0,
		revision: Number(row.entity_revision) || 0,
		blocked: readinessEntry ? Boolean(readinessEntry.blocked) : false,
		// kernel_issues has no claimed_by column; the active lease in kernel_claims is
		// the authority. Derive the holder from the issue's active claim (the
		// partial-UNIQUE index guarantees at most one), defaulting to null when free.
		claimed_by: claimedBy ?? row.claimed_by ?? null,
		// KAP-2: parent/labels/dependencies/created_at are all stored; surface them so
		// agents get the full issue shape without a second query. dependencies are the
		// ids this issue depends on (blocks_issue_id where issue_id === this row).
		parent_id: row.parent_id ?? null,
		labels: parseLabels(row.labels),
		dependencies: Array.isArray(dependencyIds) ? dependencyIds : [],
		created_at: row.created_at,
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
	// Surface the active lease holder per issue for issue summaries. Filter on state
	// only (matches loadActiveKernelClaimRow); the partial-UNIQUE active-lease index
	// guarantees at most one active row per issue, so the map is unambiguous.
	// Null-prototype map: issue ids are unconstrained external strings, so a literal `{}`
	// keyed by them would be a prototype-pollution vector (matches buildReadinessIndex).
	const claimedById = Object.create(null);
	for (const claim of claims) {
		if ((claim.state || 'active') === 'active' && claim.issue_id) {
			claimedById[claim.issue_id] = claim.actor ?? null;
		}
	}
	// Per-issue declared dependency edges (the ids each issue depends on, i.e.
	// blocks_issue_id where issue_id === the dependent). Distinct from readiness'
	// blocked_by, which drops done/cancelled blockers — this is the full declared set.
	// Null-prototype map: issue ids are unconstrained external strings.
	const dependenciesById = Object.create(null);
	for (const dependency of dependencies) {
		if (!dependency.issue_id || dependency.blocks_issue_id == null) continue;
		const list = dependenciesById[dependency.issue_id]
			|| (dependenciesById[dependency.issue_id] = []);
		list.push(dependency.blocks_issue_id);
	}
	for (const issueId of Object.keys(dependenciesById)) {
		dependenciesById[issueId] = [...new Set(dependenciesById[issueId])]
			.sort((a, b) => String(a).localeCompare(String(b)));
	}
	return { issues, index, claimedById, dependenciesById };
}

function firstPositional(args = []) {
	return (args || []).find(value => typeof value === 'string' && !value.startsWith('-'));
}

// Read-side of driver.issueOperation: ready/list/show/search/stats as parameterized
// SELECTs returning issue-command-contract shapes. Mutations are handled separately
// through the broker's guarded-event path (later wave).
function runIssueReadOperation(runtime, db, operation, args, context) {
	if (operation === 'list') {
		const { issues, index, claimedById, dependenciesById } = loadBoardReadiness(runtime, db, context);
		const summaries = issues
			.map(row => rowToIssueSummary(row, index.readinessById[row.id], claimedById[row.id], dependenciesById[row.id]))
			.sort((a, b) => (a.rank - b.rank) || String(a.id).localeCompare(String(b.id)));
		return okIssueResponse('issue.list', { issues: summaries, count: summaries.length });
	}
	if (operation === 'ready') {
		const { issues, index, claimedById, dependenciesById } = loadBoardReadiness(runtime, db, context);
		const byId = new Map(issues.map(row => [row.id, row]));
		const summaries = index.readyQueue.map(id => rowToIssueSummary(byId.get(id), index.readinessById[id], claimedById[id], dependenciesById[id]));
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
		const { index, claimedById, dependenciesById } = loadBoardReadiness(runtime, db, context);
		return okIssueResponse('issue.show', rowToIssueSummary(rows[0], index.readinessById[id], claimedById[id], dependenciesById[id]));
	}
	if (operation === 'search') {
		const term = `%${firstPositional(args) || ''}%`;
		const rows = allParams(
			runtime, db,
			'SELECT * FROM kernel_issues WHERE title LIKE ? OR body LIKE ? ORDER BY priority_rank ASC, id ASC',
			[term, term],
		);
		const { index, claimedById, dependenciesById } = loadBoardReadiness(runtime, db, context);
		const summaries = rows.map(row => rowToIssueSummary(row, index.readinessById[row.id], claimedById[row.id], dependenciesById[row.id]));
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

// --- Guarded-event commit writes (Wave 3) -------------------------------------
// commitGuardedAccept (broker) opens BEGIN IMMEDIATE, inserts the event + outbox,
// and — via the typeof-guarded applyAcceptedIssueMutation hook — calls back into
// the driver to apply the accepted issue mutation to the authority tables. These
// writes run on the SAME connection inside the broker's transaction, so an event
// insert and its issue-row effect commit (or roll back) atomically.

// kernel_conflicts has no `reason`/`payload` columns; persist only the stored
// schema columns (the evaluator's reason is encoded inside payload_json).
const KERNEL_CONFLICT_COLUMNS = Object.freeze([
	'id',
	'entity_type',
	'entity_id',
	'expected_revision',
	'actual_revision',
	'status',
	'payload_json',
	'created_at',
]);

function insertKernelConflictRow(runtime, db, conflict) {
	const row = {
		id: conflict.id || randomUUID(),
		entity_type: conflict.entity_type,
		entity_id: conflict.entity_id,
		expected_revision: Number(conflict.expected_revision || 0),
		actual_revision: Number(conflict.actual_revision || 0),
		status: conflict.status || 'quarantined',
		payload_json: conflict.payload_json ?? JSON.stringify(conflict.payload ?? {}),
		created_at: conflict.created_at,
	};
	const placeholders = KERNEL_CONFLICT_COLUMNS.map(() => '?').join(', ');
	runParams(
		runtime,
		db,
		`INSERT INTO kernel_conflicts (${KERNEL_CONFLICT_COLUMNS.join(', ')}) VALUES (${placeholders})`,
		KERNEL_CONFLICT_COLUMNS.map(column => row[column]),
	);
	return { ...conflict, id: row.id };
}

// kernel_outbox status/attempts default in the schema, but we write them explicitly
// so a freshly-enqueued entry is fully specified regardless of runtime defaults.
const KERNEL_OUTBOX_COLUMNS = Object.freeze([
	'id',
	'event_id',
	'target',
	'status',
	'attempts',
	'next_attempt_at',
	'created_at',
]);

function enqueueKernelProjectionRow(runtime, db, entry) {
	const row = {
		id: entry.id || randomUUID(),
		event_id: entry.event_id,
		target: entry.target,
		status: entry.status || 'pending',
		attempts: Number(entry.attempts || 0),
		next_attempt_at: entry.next_attempt_at ?? null,
		created_at: entry.created_at,
	};
	const placeholders = KERNEL_OUTBOX_COLUMNS.map(() => '?').join(', ');
	runParams(
		runtime,
		db,
		`INSERT INTO kernel_outbox (${KERNEL_OUTBOX_COLUMNS.join(', ')}) VALUES (${placeholders})`,
		KERNEL_OUTBOX_COLUMNS.map(column => row[column]),
	);
	return { ...entry, id: row.id };
}

// --- Projection-outbox read/update primitives (Wave 5) ------------------------
// The outbox consumer (projection-jsonl-writer.runJsonlProjectionConsumer) is the
// PRECISE spec for these shapes. They are additive read/update writes over
// kernel_outbox + kernel_dead_letters — they NEVER touch the append/CAS path
// (insertKernelEvent / enqueueKernelProjection) and never mutate Kernel authority
// tables. A projection failure is recorded out-of-band so the event log stays
// the single source of truth.

// List the drainable outbox rows for one target. `now` gates backoff: a row that
// failed and was scheduled forward (next_attempt_at in the future) MUST NOT be
// re-listed until its backoff elapses, else recordProjectionFailure's exponential
// backoff is dead and a poison row re-drains every tick. A NULL next_attempt_at
// (never-retried) is always eligible. Ordered by created_at so the snapshot the
// consumer takes reflects insertion order deterministically.
function listProjectionOutboxRows(runtime, db, filter = {}) {
	const clauses = [];
	const params = [];
	if (filter.target !== undefined) {
		clauses.push('target = ?');
		params.push(filter.target);
	}
	if (filter.status !== undefined) {
		clauses.push('status = ?');
		params.push(filter.status);
	}
	if (filter.now !== undefined) {
		clauses.push('(next_attempt_at IS NULL OR next_attempt_at <= ?)');
		params.push(filter.now);
	}
	const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
	return allParams(
		runtime,
		db,
		`SELECT * FROM kernel_outbox${where} ORDER BY created_at ASC, id ASC`,
		params,
	);
}

// The full projection read-model: every authority issue/comment/dependency row.
// The consumer renders ONE full snapshot per drain, so this returns the whole
// board (not a delta). Tables may be empty on a fresh DB; safeAll degrades a
// partially-migrated table to [].
function loadProjectionModelRows(runtime, db) {
	return {
		issues: safeAll(runtime, db, 'SELECT * FROM kernel_issues ORDER BY id ASC'),
		comments: safeAll(runtime, db, 'SELECT * FROM kernel_comments ORDER BY issue_id ASC, created_at ASC, id ASC'),
		dependencies: safeAll(runtime, db, 'SELECT * FROM kernel_dependencies ORDER BY issue_id ASC, blocks_issue_id ASC, id ASC'),
	};
}

// Mark the drained outbox rows delivered. Builds one `?` placeholder per id (never
// interpolate ids) and guards an empty list so we don't emit `IN ()` (a syntax
// error on both runtimes). Returns {updated:n} — the count the consumer reports.
function markProjectionDeliveredRows(runtime, db, ids = [], _meta = {}) {
	const list = Array.isArray(ids) ? ids.filter(id => id !== undefined && id !== null) : [];
	if (list.length === 0) return { updated: 0 };
	const placeholders = list.map(() => '?').join(', ');
	runParams(
		runtime,
		db,
		`UPDATE kernel_outbox SET status = 'delivered' WHERE id IN (${placeholders})`,
		list,
	);
	return { updated: list.length };
}

// Record a transient projection failure: bump attempts + schedule the next retry
// while keeping the row pending. kernel_outbox has NO error column, so the
// record.error has nowhere to land here (it is surfaced only when the row is
// finally dead-lettered) — that is intentional, not a dropped field.
function recordProjectionFailureRows(runtime, db, record = {}) {
	runParams(
		runtime,
		db,
		"UPDATE kernel_outbox SET status = 'pending', attempts = ?, next_attempt_at = ? WHERE id = ?",
		[Number(record.attempts || 0), record.next_attempt_at ?? null, record.id],
	);
	return { id: record.id, attempts: Number(record.attempts || 0) };
}

const KERNEL_DEAD_LETTER_COLUMNS = Object.freeze([
	'id',
	'outbox_id',
	'target',
	'status',
	'error',
	'payload_json',
	'created_at',
]);

// Terminal projection failure: insert a dead_letters row AND transition the source
// outbox row out of 'pending' (→ 'dead') so it is never re-drained. Both writes run
// on the same connection; the consumer calls this from its catch path, not inside a
// guarded transaction, so the two writes are best-effort sequential (a projection
// failure must not block authority). Returns {id} (the new dead-letter id).
function deadLetterProjectionRows(runtime, db, record = {}) {
	const id = record.id || randomUUID();
	const row = {
		id,
		outbox_id: record.outbox_id ?? null,
		target: record.target,
		status: record.status || 'open',
		error: record.error ?? '',
		payload_json: record.payload_json ?? JSON.stringify(record.payload ?? {}),
		created_at: record.created_at ?? record.now,
	};
	const placeholders = KERNEL_DEAD_LETTER_COLUMNS.map(() => '?').join(', ');
	runParams(
		runtime,
		db,
		`INSERT INTO kernel_dead_letters (${KERNEL_DEAD_LETTER_COLUMNS.join(', ')}) VALUES (${placeholders})`,
		KERNEL_DEAD_LETTER_COLUMNS.map(column => row[column]),
	);
	if (record.outbox_id) {
		runParams(
			runtime,
			db,
			"UPDATE kernel_outbox SET status = 'dead' WHERE id = ?",
			[record.outbox_id],
		);
	}
	return { id };
}

// All blocking edges, so the evaluator can detect a cycle the new dependency.add
// edge would close. The broker only calls this for dependency.add events with a
// complete scope; an empty/absent table degrades to []. The cycle check needs the
// whole graph (not just the scoped edge), so `scope` is currently informational.
function listKernelDependencyRows(runtime, db, _scope = {}) {
	return safeAll(runtime, db, 'SELECT * FROM kernel_dependencies');
}

// Read the single live-lease candidate for an issue: the row in state='active'.
// Filter on STATE ONLY, never on expiry — planClaimAcquisition needs the
// expired-but-active row to fire its reclaim/supersede branch. Dropping it here
// would null the active row and the next insert would collide on the partial
// UNIQUE index (idx_kernel_claims_active_lease). The partial index guarantees at
// most one such row, so the first match is authoritative.
function loadActiveKernelClaimRow(runtime, db, issueId) {
	const rows = allParams(
		runtime,
		db,
		"SELECT * FROM kernel_claims WHERE issue_id = ? AND state = 'active' ORDER BY claimed_at ASC LIMIT 1",
		[issueId],
	);
	return rows[0] || null;
}

// The 8 columns buildClaimRow (lease-enforcer) produces. The native
// partial-UNIQUE(issue_id WHERE state='active') error is intentionally NOT caught
// here — the broker's recoverGuardedFailure parses it to convert a cross-owner
// lease collision into a claim_conflict quarantine.
const KERNEL_CLAIM_COLUMNS = Object.freeze([
	'id',
	'issue_id',
	'actor',
	'state',
	'session_id',
	'worktree_id',
	'claimed_at',
	'expires_at',
]);

function insertKernelClaimRow(runtime, db, claim) {
	const row = {
		id: claim.id || randomUUID(),
		issue_id: claim.issue_id,
		actor: claim.actor,
		state: claim.state || 'active',
		session_id: claim.session_id ?? null,
		worktree_id: claim.worktree_id ?? null,
		claimed_at: claim.claimed_at,
		expires_at: claim.expires_at ?? null,
	};
	const placeholders = KERNEL_CLAIM_COLUMNS.map(() => '?').join(', ');
	runParams(
		runtime,
		db,
		`INSERT INTO kernel_claims (${KERNEL_CLAIM_COLUMNS.join(', ')}) VALUES (${placeholders})`,
		KERNEL_CLAIM_COLUMNS.map(column => row[column]),
	);
	return { ...claim, id: row.id };
}

// Transition a claim row's state (e.g. active → reclaimable when superseding an
// expired lease). Moving a row out of 'active' frees the partial-UNIQUE slot so a
// fresh active lease can be inserted in the same transaction.
function updateKernelClaimStateRow(runtime, db, claimId, state) {
	runParams(
		runtime,
		db,
		'UPDATE kernel_claims SET state = ? WHERE id = ?',
		[state, claimId],
	);
	return { id: claimId, state };
}

// Columns the issue upsert may set from an accepted event payload. id/title are
// required for a create; the rest are optional and only overwritten when present.
const ISSUE_MUTABLE_COLUMNS = Object.freeze([
	'title',
	'body',
	'type',
	'status',
	'priority',
	'priority_rank',
	'parent_id',
	'sprint_id',
	'release_id',
	'stage_state',
	'labels',
	'acceptance_criteria',
	'estimate',
]);

// close drives the issue to a terminal status; an explicit payload.status (rework
// transitions) still wins so the broker can model any accepted lifecycle move.
function resolveMutationStatus(eventType, payload) {
	if (typeof payload.status === 'string' && payload.status) return payload.status;
	if (eventType === 'issue.close') return 'done';
	return null;
}

// Upsert the issue row for an accepted issue event and bump entity_revision. The
// evaluator already enforced CAS (expected_revision === stored), so the new
// revision is monotonic: stored + 1 for an update, 0 for a fresh create.
function applyAcceptedIssueEvent(runtime, db, event) {
	const payload = event.payload || (event.payload_json ? JSON.parse(event.payload_json) : {});
	const issueId = event.entity_id;
	const now = event.created_at;
	const existing = loadKernelEntityRow(runtime, db, 'issue', issueId);
	const status = resolveMutationStatus(event.event_type, payload);

	if (!existing) {
		// Fresh create: seed required NOT NULL columns, then overwrite with any
		// supplied payload values via the shared column map below.
		runParams(
			runtime,
			db,
			`INSERT INTO kernel_issues (id, title, type, status, priority, priority_rank, created_at, updated_at, entity_revision)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
			[
				issueId,
				payload.title ?? issueId,
				payload.type ?? 'task',
				status ?? payload.status ?? 'open',
				payload.priority ?? 'P2',
				Number(payload.priority_rank ?? 0),
				now,
				now,
			],
		);
	}

	const assignments = [];
	const values = [];
	for (const column of ISSUE_MUTABLE_COLUMNS) {
		const value = column === 'status' ? status : payload[column];
		if (value === undefined || value === null) continue;
		assignments.push(`${column} = ?`);
		values.push(value);
	}
	assignments.push('updated_at = ?');
	values.push(now);
	// Monotonic CAS bump: increment the stored revision on every accepted write
	// (a create stays at 0 because the INSERT seeded 0 and this UPDATE runs once).
	const expectedRevision = Number(existing ? existing.entity_revision || 0 : 0);
	const nextRevision = existing ? expectedRevision + 1 : 0;
	assignments.push('entity_revision = ?');
	values.push(nextRevision);
	if (existing) {
		// Optimistic CAS at the row write for revision-bumping mutations (update/close).
		// The evaluator pre-reads the entity OUTSIDE this transaction, so two writers
		// that both pre-read rev=N both pass the evaluator; BEGIN IMMEDIATE then
		// serializes them and the second would otherwise apply on top of N+1 — a silent
		// lost update. Gate the WHERE on the event's expected_revision: if the row's
		// actual revision has moved (0 rows changed), throw a tagged conflict the broker
		// converts into a stale_revision quarantine. A create INSERTs a fresh row (the PK
		// guards it) so it takes the un-gated path below.
		const result = runParams(
			runtime,
			db,
			`UPDATE kernel_issues SET ${assignments.join(', ')} WHERE id = ? AND entity_revision = ?`,
			[...values, issueId, Number(event.expected_revision || 0)],
		);
		// Both runtimes' run() return a changed-row count (bun:sqlite .changes;
		// node:sqlite StatementSync.run() → { changes, lastInsertRowid }). 0 changes
		// means the CAS predicate (entity_revision = expected) matched no row.
		if (Number(result?.changes || 0) === 0) {
			const error = new Error('kernel issue revision conflict');
			error.kernelRevisionConflict = true;
			error.entityId = issueId;
			error.expectedRevision = Number(event.expected_revision || 0);
			error.actualRevision = expectedRevision;
			throw error;
		}
		return { id: issueId, revision: nextRevision };
	}
	runParams(
		runtime,
		db,
		`UPDATE kernel_issues SET ${assignments.join(', ')} WHERE id = ?`,
		[...values, issueId],
	);
	return { id: issueId, revision: nextRevision };
}

// Append a comment row for an accepted issue.comment event.
function applyAcceptedCommentEvent(runtime, db, event) {
	const payload = event.payload || (event.payload_json ? JSON.parse(event.payload_json) : {});
	const commentId = payload.comment_id || randomUUID();
	runParams(
		runtime,
		db,
		`INSERT INTO kernel_comments (id, issue_id, body, actor, visibility, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`,
		[
			commentId,
			payload.issue_id ?? event.entity_id,
			payload.body ?? '',
			event.actor ?? payload.actor ?? 'forge',
			payload.visibility ?? 'local',
			event.created_at,
		],
	);
	// A comment never bumps the issue revision; report the host issue's current one.
	const issue = loadKernelEntityRow(runtime, db, 'issue', payload.issue_id ?? event.entity_id);
	return { id: payload.issue_id ?? event.entity_id, revision: Number(issue?.entity_revision || 0), comment_id: commentId };
}

// Insert the dependency edge for an accepted dependency.add event. The event's
// entity_id IS the dependency row id (the broker scopes the event on the
// 'dependency' entity stream), so the row is uniquely keyed without minting a new
// id. This is the ONLY place dependency rows are written — the cycle guard already
// fired in the evaluator before this accepted event reached the commit.
function applyAcceptedDependencyAddEvent(runtime, db, event) {
	const payload = event.payload || (event.payload_json ? JSON.parse(event.payload_json) : {});
	const dependencyId = event.entity_id;
	runParams(
		runtime,
		db,
		`INSERT INTO kernel_dependencies (id, issue_id, blocks_issue_id, dependency_type, created_at)
			VALUES (?, ?, ?, ?, ?)`,
		[
			dependencyId,
			payload.issue_id,
			payload.blocks_issue_id,
			payload.dependency_type || 'blocks',
			event.created_at,
		],
	);
	return { id: dependencyId, revision: 0, dependency_id: dependencyId };
}

// Delete the dependency edge for an accepted dependency.remove event, keyed by the
// (issue_id, blocks_issue_id) pair the payload names — the dependent's id is not
// the dependency row id, so delete by the edge endpoints, not entity_id.
function applyAcceptedDependencyRemoveEvent(runtime, db, event) {
	const payload = event.payload || (event.payload_json ? JSON.parse(event.payload_json) : {});
	runParams(
		runtime,
		db,
		'DELETE FROM kernel_dependencies WHERE issue_id = ? AND blocks_issue_id = ?',
		[payload.issue_id, payload.blocks_issue_id],
	);
	return { id: event.entity_id, revision: 0, dependency_id: event.entity_id };
}

// Clear the active lease for an accepted claim.release event. Conservatively
// releases the issue's active lease (the required ownership model is same-actor
// "release clears it"; cross-owner authorization is deliberately out of scope).
// claim.create is NOT handled here — its lease row is inserted by the broker's
// insertKernelClaim inside commitGuardedAccept; re-inserting it here would be a
// double-INSERT that trips the partial-UNIQUE index.
function applyAcceptedClaimReleaseEvent(runtime, db, event) {
	const payload = event.payload || (event.payload_json ? JSON.parse(event.payload_json) : {});
	runParams(
		runtime,
		db,
		"UPDATE kernel_claims SET state = 'released' WHERE issue_id = ? AND state = 'active'",
		[payload.issue_id],
	);
	return { id: event.entity_id, revision: 0, claim_id: event.entity_id };
}

// Apply an accepted event's authority-table effect. Returns the mutation summary
// ({id, revision, comment_id?/dependency_id?/claim_id?}) the broker threads back
// into the issue-command response, or null for events with no synchronous
// side effect here (claim.create's lease is written by the broker's
// insertKernelClaim inside the transaction). The entity_type guard is critical:
// dependency/claim events must NEVER fall into the issue-upsert branch, which
// would corrupt kernel_issues with a bogus row keyed by the dep/claim id.
function applyAcceptedMutation(runtime, db, event) {
	if (event.entity_type === 'dependency') {
		if (event.event_type === 'dependency.remove') {
			return applyAcceptedDependencyRemoveEvent(runtime, db, event);
		}
		return applyAcceptedDependencyAddEvent(runtime, db, event);
	}
	if (event.entity_type === 'claim') {
		if (event.event_type === 'claim.release') {
			return applyAcceptedClaimReleaseEvent(runtime, db, event);
		}
		// claim.create: the lease row is written by the broker's insertKernelClaim
		// inside commitGuardedAccept; no authority-table effect to apply here.
		return null;
	}
	if (event.entity_type === 'issue' && event.event_type === 'issue.comment') {
		return applyAcceptedCommentEvent(runtime, db, event);
	}
	if (event.entity_type === 'issue') {
		return applyAcceptedIssueEvent(runtime, db, event);
	}
	return null;
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
		async insertKernelConflict(conflict, _context = {}, config = {}) {
			return insertKernelConflictRow(runtime, getDatabase(config), conflict);
		},
		async enqueueKernelProjection(entry, _context = {}, config = {}) {
			return enqueueKernelProjectionRow(runtime, getDatabase(config), entry);
		},
		// --- Projection-outbox read/update surface (Wave 5) — composed by the
		// broker's projection-outbox methods, consumed by runJsonlProjectionConsumer.
		// These never touch the append/CAS path; `context` is part of the broker
		// contract but unused by these direct reads/writes (prefixed `_`).
		async listProjectionOutbox(filter = {}, _context = {}, config = {}) {
			return listProjectionOutboxRows(runtime, getDatabase(config), filter);
		},
		async loadProjectionModel(_context = {}, config = {}) {
			return loadProjectionModelRows(runtime, getDatabase(config));
		},
		async markProjectionDelivered(ids = [], meta = {}, _context = {}, config = {}) {
			return markProjectionDeliveredRows(runtime, getDatabase(config), ids, meta);
		},
		async recordProjectionFailure(record, _context = {}, config = {}) {
			return recordProjectionFailureRows(runtime, getDatabase(config), record);
		},
		async deadLetterProjection(record, _context = {}, config = {}) {
			return deadLetterProjectionRows(runtime, getDatabase(config), record);
		},
		async listKernelDependencies(scope, _context = {}, config = {}) {
			return listKernelDependencyRows(runtime, getDatabase(config), scope);
		},
		// Claim-lease primitives (Wave 4) — composed by commitGuardedAccept /
		// resolveClaimAcquisition. loadActiveKernelClaim feeds planClaimAcquisition;
		// insertKernelClaim / updateKernelClaimState are the lease writes. The DB
		// partial-UNIQUE index (idx_kernel_claims_active_lease) enforces the
		// single-active-claim-per-issue invariant under concurrent writers.
		async loadActiveKernelClaim(issueId, _context = {}, config = {}) {
			return loadActiveKernelClaimRow(runtime, getDatabase(config), issueId);
		},
		async insertKernelClaim(claim, _context = {}, config = {}) {
			return insertKernelClaimRow(runtime, getDatabase(config), claim);
		},
		async updateKernelClaimState(claimId, state, _context = {}, config = {}) {
			return updateKernelClaimStateRow(runtime, getDatabase(config), claimId, state);
		},
		// commitGuardedAccept invokes this (typeof-guarded) INSIDE its BEGIN IMMEDIATE
		// transaction to apply an accepted issue event to the authority tables. The
		// returned summary ({id, revision, comment_id?}) flows back through
		// runGuardedEvent's result so runIssueOperation can shape the mutation response.
		async applyAcceptedIssueMutation(event, _context = {}, config = {}) {
			return applyAcceptedMutation(runtime, getDatabase(config), event);
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
