'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: nodeSpawn, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const {
	ISSUE_COMMAND_SCHEMA_VERSION,
	ISSUE_COMMAND_EXIT_CODES,
	formatIssueCommandError,
	normalizePriority,
	resolveNextCommands,
} = require('./issue-command-contract');
const { buildReadinessIndex } = require('./readiness-model');
const { buildMemoryProjectionMigration, buildUsageEvidenceMigration, memoryFtsDdl } = require('./migrations');
const { assertFilesystemSafeForKernel } = require('./fs-class');
const { isTerminalStatus, rankForPriorityLabel } = require('./taxonomy-validator');
const { isLeaseExpired } = require('./lease-enforcer');
const { isLiveClaim, projectLiveClaims } = require('./live-claim-projection');
const {
	ClaimRepairError,
	buildClaimRepairPlan,
	publicClaimRepairPreflight,
	verifyClaimRepairBackup,
} = require('./legacy-claim-repair');
const { CONFLICT_SIGNAL, classifyConflictSignal } = require('./conflict-signal');
const { normalizeRecallHit } = require('../memory-recall');
const { getPackageRoot } = require('../package-root');
const { appendUsageEvidence, rebuildUsageProjection } = require('../../packages/memory');

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

// Requiring `node:sqlite` emits a one-time Node ExperimentalWarning via
// process.emitWarning AT REQUIRE TIME (before any CLI flag context exists), which
// would prepend noise to the CLI's human/JSON output. Suppress ONLY that SQLite
// warning around the require and restore process.emitWarning immediately after — every
// other warning passes through untouched. This never re-execs with --no-warnings.
function requireSqliteRuntimeModule(requireModule, id) {
	if (id !== 'node:sqlite') {
		return requireModule(id);
	}
	const originalEmitWarning = process.emitWarning;
	process.emitWarning = function suppressSqliteExperimentalWarning(warning, ...rest) {
		const message = typeof warning === 'string' ? warning : (warning && warning.message) || '';
		if (/SQLite/i.test(String(message))) {
			return undefined;
		}
		return originalEmitWarning.call(process, warning, ...rest);
	};
	try {
		return requireModule(id);
	} finally {
		process.emitWarning = originalEmitWarning;
	}
}

function selectBuiltinSQLiteRuntime(deps = {}) {
	const requireModule = deps.requireModule || require;
	const unavailable = [];

	for (const id of BUILTIN_SQLITE_RUNTIME_ORDER) {
		try {
			return loadRuntimeDescriptor(id, requireSqliteRuntimeModule(requireModule, id));
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

function createExistingWatchOwnerDatabase(runtime, databasePath) {
	if (runtime.id === 'bun:sqlite') {
		return new runtime.module.Database(databasePath, { readwrite: true });
	}
	if (runtime.id === 'node:sqlite') {
		const databaseUrl = pathToFileURL(databasePath);
		databaseUrl.searchParams.set('mode', 'rw');
		return new runtime.module.DatabaseSync(databaseUrl);
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

function createUsageEvidenceAdapter(runtime, db) {
	return {
		exec(sql) { execSql(runtime, db, sql); },
		run(sql, params = []) { return runParams(runtime, db, sql, params); },
		one(sql, params = []) { return allParams(runtime, db, sql, params)[0] || null; },
		transaction(callback) {
			let active = false;
			try {
				execSql(runtime, db, 'BEGIN IMMEDIATE;');
				active = true;
				const result = callback();
				execSql(runtime, db, 'COMMIT;');
				active = false;
				return result;
			} catch (error) {
				if (active) {
					try { execSql(runtime, db, 'ROLLBACK;'); } catch { /* preserve the write failure */ }
				}
				throw error;
			}
		},
		assertUsageWriterEnabled() {
			const row = allParams(runtime, db,
				'SELECT enabled FROM memory_usage_writer_state WHERE singleton = 1')[0];
			if (!row || Number(row.enabled) !== 1) throw new Error('memory usage evidence writer is disabled');
		},
	};
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

function rowToIssueSummary(row, readinessEntry, claimedBy = null, dependencyIds = [], dependentIds = []) {
	const summary = {
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
		// Epic/reverse-dependency exposure: `dependents` are the ids that depend on this
		// issue (the inverse of `dependencies` — issue_id where blocks_issue_id === this
		// row), and `blocked_by` is the readiness model's LIVE blocker subset (dependencies
		// still open; done/cancelled blockers dropped). Both are a strict additive superset
		// surfaced on every read op so consumers never run a second reverse-scan query.
		dependents: Array.isArray(dependentIds) ? dependentIds : [],
		blocked_by: readinessEntry ? (readinessEntry.blocked_by ?? []) : [],
		created_at: row.created_at,
		updated_at: row.updated_at,
		// KAP-10 (acceptance_criteria/design/notes) + KAP-11 (assignee): authored
		// content fields and the persistent assignee, each null when unset. assignee is
		// distinct from claimed_by (the transient lease holder) — both coexist.
		acceptance_criteria: row.acceptance_criteria ?? null,
		design: row.design ?? null,
		notes: row.notes ?? null,
		assignee: row.assignee ?? null,
		// Beads full-fidelity import: author, close timestamp, raw close reason and the
		// verbatim metadata JSON blob, each null when the column is unset.
		created_by: row.created_by ?? null,
		closed_at: row.closed_at ?? null,
		close_reason: row.close_reason ?? null,
		metadata: row.metadata ?? null,
	};
	if (readinessEntry?.contract_applicable) {
		summary.readiness_state = readinessEntry.state;
		summary.readiness_reasons = readinessEntry.reasons;
	}
	return summary;
}

function okIssueResponse(command, data, nextCommands) {
	return {
		ok: true,
		schema_version: ISSUE_COMMAND_SCHEMA_VERSION,
		command,
		data,
		// Default the read-op next_commands from the contract catalog (KAP-1's envelope
		// is worthless to agents if it carries an empty array). An explicit array still
		// wins; otherwise resolve + substitute the concrete id for single-issue responses.
		next_commands: Array.isArray(nextCommands) ? nextCommands : resolveNextCommands(command, data),
	};
}

function loadLiveKernelClaimRows(runtime, db, context = {}) {
	const rows = safeAll(
		runtime,
		db,
		`SELECT claim.*, issue.status AS issue_status
		 FROM kernel_claims AS claim
		 JOIN kernel_issues AS issue ON issue.id = claim.issue_id
		 WHERE claim.state = 'active'`,
	);
	const issues = rows.map(row => ({ id: row.issue_id, status: row.issue_status }));
	return projectLiveClaims(rows, issues, context.now || new Date().toISOString())
		.map(row => {
			const claim = { ...row };
			delete claim.issue_status;
			return claim;
		});
}

// Derive the whole-board readiness read model (D18) from the authority tables.
function loadBoardReadiness(runtime, db, context = {}) {
	const issues = allParams(runtime, db, 'SELECT * FROM kernel_issues');
	const dependencies = safeAll(runtime, db, 'SELECT * FROM kernel_dependencies');
	const conflicts = safeAll(runtime, db, 'SELECT * FROM kernel_conflicts');
	const now = context.now || new Date().toISOString();
	const liveClaims = loadLiveKernelClaimRows(runtime, db, { ...context, now });
	const index = buildReadinessIndex({
		issues,
		dependencies,
		conflicts,
		claims: liveClaims,
		now,
		actor: context.actor,
		contractPolicy: context.contractPolicy,
		isTrustedAdoption: context.isTrustedAdoption,
	});
	// Surface only the shared live-authority projection as claimed_by. The partial
	// UNIQUE active-lease index guarantees at most one live row per issue.
	// Null-prototype map: issue ids are unconstrained external strings, so a literal `{}`
	// keyed by them would be a prototype-pollution vector (matches buildReadinessIndex).
	const claimedById = Object.create(null);
	for (const claim of liveClaims) {
		if (claim.issue_id) claimedById[claim.issue_id] = claim.actor ?? null;
	}
	// Per-issue declared dependency edges (the ids each issue depends on, i.e.
	// blocks_issue_id where issue_id === the dependent). Distinct from readiness'
	// blocked_by, which drops done/cancelled blockers — this is the full declared set.
	// Null-prototype map: issue ids are unconstrained external strings.
	const dependenciesById = Object.create(null);
	// Per-issue reverse edges (the ids that depend ON each issue, i.e. issue_id where
	// blocks_issue_id === the blocker). This is the inverse of dependenciesById and the
	// same query computeNewlyUnblocked runs on the close path, lifted to the board load
	// so every read op can surface `dependents` without a second reverse scan.
	// Null-prototype map: issue ids are unconstrained external strings.
	const dependentsById = Object.create(null);
	for (const dependency of dependencies) {
		if (!dependency.issue_id || dependency.blocks_issue_id == null) continue;
		const list = dependenciesById[dependency.issue_id]
			|| (dependenciesById[dependency.issue_id] = []);
		list.push(dependency.blocks_issue_id);
		const dependents = dependentsById[dependency.blocks_issue_id]
			|| (dependentsById[dependency.blocks_issue_id] = []);
		dependents.push(dependency.issue_id);
	}
	for (const issueId of Object.keys(dependenciesById)) {
		dependenciesById[issueId] = [...new Set(dependenciesById[issueId])]
			.sort((a, b) => String(a).localeCompare(String(b)));
	}
	for (const issueId of Object.keys(dependentsById)) {
		dependentsById[issueId] = [...new Set(dependentsById[issueId])]
			.sort((a, b) => String(a).localeCompare(String(b)));
	}
	return { issues, index, liveClaims, claimedById, dependenciesById, dependentsById };
}

function firstPositional(args = []) {
	return (args || []).find(value => typeof value === 'string' && !value.startsWith('-'));
}

// KAP-6: parse the `list` op's --status / --type / --label flags from the arg array.
// Accepts both `--flag value` (value is the next array element) and `--flag=value`
// (value follows the `=`). A key is only set when a value is actually present, so an
// absent flag leaves it undefined and does not constrain that dimension. Unknown flags
// are ignored. Values are never interpolated into SQL — filtering runs JS-side over the
// already-built issue summaries (status/type/labels[]).
const LIST_FILTER_FLAGS = Object.freeze(['status', 'type', 'label', 'priority']);

function parseListFilters(args = []) {
	const filters = Object.create(null);
	const list = args || [];
	for (let i = 0; i < list.length; i += 1) {
		const arg = list[i];
		if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
		const eq = arg.indexOf('=');
		const name = (eq === -1 ? arg.slice(2) : arg.slice(2, eq));
		if (!LIST_FILTER_FLAGS.includes(name)) continue;
		if (eq !== -1) {
			// `--status=` (empty value) is treated as MISSING, not an empty-string filter
			// that would match nothing — matches the documented "only set when present".
			const value = arg.slice(eq + 1);
			if (value !== '') {
				filters[name] = value;
			}
			continue;
		}
		const next = list[i + 1];
		if (typeof next === 'string' && !next.startsWith('-')) {
			filters[name] = next;
			i += 1;
		}
	}
	return filters;
}

// KAP-7: parse the `stale` op's --days threshold (both `--days <n>` and `--days=<n>`
// forms). Returns the integer day window. A missing flag, or a NaN / non-positive
// value, falls back to STALE_DEFAULT_DAYS — a zero/negative window would make every
// open issue "stale", which is never the intended query. Mirrors parseListFilters'
// flag-scan; the value is never interpolated into SQL (the threshold compares JS-side).
const STALE_DEFAULT_DAYS = 14;

function parseStaleDays(args = []) {
	const list = args || [];
	for (let i = 0; i < list.length; i += 1) {
		const arg = list[i];
		if (typeof arg !== 'string') continue;
		let raw;
		if (arg === '--days') {
			raw = list[i + 1];
		} else if (arg.startsWith('--days=')) {
			raw = arg.slice('--days='.length);
		} else {
			continue;
		}
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.floor(parsed);
		}
		return STALE_DEFAULT_DAYS;
	}
	return STALE_DEFAULT_DAYS;
}

// KAP-7: shared list-style sort for derived read queries (rank asc, then id) — the
// exact ordering `list`/the contract tests expect, so blocked/stale/orphans are
// deterministic.
function sortIssueSummaries(summaries) {
	return summaries.sort((a, b) => (a.rank - b.rank) || String(a.id).localeCompare(String(b.id)));
}

// Epic rollup over a list of child issue summaries. The kernel owns the status
// vocabulary (open|in_progress|review|done|cancelled), so emitting the rollup means
// consumers never hard-code status names (notably the beads `closed` the shells used
// to count). Locked maintainer decisions: percentage is done-ONLY (cancelled does NOT
// count toward complete) and `total` is the direct-children count. `blocked` counts
// children whose readiness model flips blocked. `by_status` is the full per-status
// histogram; an unknown status (taxonomy-validator forbids it) is counted in `total`
// but not bucketed.
const ROLLUP_STATUSES = Object.freeze(['open', 'in_progress', 'review', 'done', 'cancelled', 'backlog']);

function buildRollup(children) {
	const byStatus = Object.create(null);
	for (const status of ROLLUP_STATUSES) {
		byStatus[status] = 0;
	}
	let blocked = 0;
	for (const child of children) {
		if (Object.prototype.hasOwnProperty.call(byStatus, child.status)) {
			byStatus[child.status] += 1;
		}
		if (child.blocked) blocked += 1;
	}
	const total = children.length;
	const done = byStatus.done;
	const percentage = total === 0 ? 0 : Math.round((done / total) * 100);
	return {
		total,
		done,
		in_progress: byStatus.in_progress,
		open: byStatus.open,
		review: byStatus.review,
		cancelled: byStatus.cancelled,
		backlog: byStatus.backlog,
		blocked,
		percentage,
		by_status: { ...byStatus },
	};
}

function runIssueOwnsRead(runtime, db, args, context) {
	// Lease-ownership verification (kernel d71a824b). A claim returning ok:true does
	// not prove the caller won the lease: a duplicate replay also returns ok:true, so
	// a worker must CONFIRM it holds the live lease before mutating a claimed issue.
	// `owned` is true iff the resolving actor holds the shared live-authority claim.
	// loadActiveKernelClaimRow remains state-only for acquisition/reclaim planning;
	// isLiveClaim applies expiry and issue-terminal fencing here. Actor resolution mirrors the mutation
	// path's `context.actor || 'forge'` default so a bare CLI invocation matches its
	// own claims; `now` falls back to the wall clock like the mutation route.
	const id = firstPositional(args);
	const rows = allParams(runtime, db, 'SELECT * FROM kernel_issues WHERE id = ?', [id]);
	if (!rows[0]) {
		return formatIssueCommandError({
			command: 'issue.owns',
			code: 'FORGE_ISSUE_NOT_FOUND',
			message: `Issue ${id ?? '<missing id>'} not found`,
			exitCode: ISSUE_COMMAND_EXIT_CODES.notFound,
		});
	}
	const now = context.now || new Date().toISOString();
	const actor = context.actor || 'forge';
	const claim = loadActiveKernelClaimRow(runtime, db, id);
	const liveClaim = isLiveClaim(claim, rows[0], now) ? claim : null;
	const claimedBy = liveClaim ? (liveClaim.actor ?? null) : null;
	const expired = claim ? isLeaseExpired(claim, now) : false;
	// Ownership is per-SESSION, not just per-actor (kernel d71a824b): two agents
	// sharing one human actor but running as DIFFERENT sessions must not both read
	// OWNED for a lease only one of them holds. When BOTH the caller and the live
	// lease carry a session-id they must match; if either side is session-less (a
	// no-env caller, or a pre-session claim) we fall back to actor-only ownership so
	// historical behavior is preserved byte-for-byte. An empty/whitespace-only
	// session-id counts as session-LESS on BOTH sides — the SAME trim-truthy test the
	// claim-key write uses (buildClaimMutationEvent in lib/kernel/broker.js) — so ''
	// can never count as "present" here and "absent" there.
	const normalizeSession = value => (typeof value === 'string' && value.trim() !== '' ? value : null);
	const contextSession = normalizeSession(context.sessionId);
	const claimSession = claim ? normalizeSession(claim.session_id) : null;
	const sessionMismatch = contextSession !== null
		&& claimSession !== null
		&& contextSession !== claimSession;
	const owned = Boolean(liveClaim) && claimedBy === actor && !sessionMismatch;
	return okIssueResponse('issue.owns', {
		id,
		actor,
		claimed_by: claimedBy,
		owned,
		expired,
		expires_at: claim ? (claim.expires_at ?? null) : null,
	});
}

// Read-side of driver.issueOperation: ready/list/show/search/stats as parameterized
// SELECTs returning issue-command-contract shapes. Mutations are handled separately
// through the broker's guarded-event path (later wave).
function runIssueReadOperation(runtime, db, operation, args, context) {
	if (operation === 'list') {
		const { issues, index, claimedById, dependenciesById, dependentsById } = loadBoardReadiness(runtime, db, context);
		// KAP-6: server-side --status/--type/--label filtering. Filter the summaries (they
		// already carry status/type/parsed labels[]) so the readiness load stays shared and
		// untouched. status/type are exact-match; --label keeps issues whose labels[] include
		// the value. Multiple filters AND; an absent filter does not constrain that dimension;
		// an unknown value simply matches nothing (exact-match → empty result, no special case).
		const filters = parseListFilters(args);
		// Normalize the --priority filter ONCE to its canonical label; each candidate's
		// stored priority is normalized too before the exact-match compare. Legacy rows
		// store a mixed bare-int / P-label form, so '1' and 'P1' rows both match
		// --priority=1 AND --priority=P1 (the filter arg and the stored value canonicalize
		// to the same label). An unknown value normalizes to itself and matches nothing.
		const priorityFilter = filters.priority === undefined ? undefined : normalizePriority(filters.priority);
		const summaries = issues
			.map(row => rowToIssueSummary(row, index.readinessById[row.id], claimedById[row.id], dependenciesById[row.id], dependentsById[row.id]))
			.filter(summary => (filters.status === undefined || summary.status === filters.status)
				&& (filters.type === undefined || summary.type === filters.type)
				&& (filters.label === undefined || summary.labels.includes(filters.label))
				&& (priorityFilter === undefined || normalizePriority(summary.priority) === priorityFilter))
			.sort((a, b) => (a.rank - b.rank) || String(a.id).localeCompare(String(b.id)));
		return okIssueResponse('issue.list', { issues: summaries, count: summaries.length });
	}
	if (operation === 'ready') {
		const { issues, index, claimedById, dependenciesById, dependentsById } = loadBoardReadiness(runtime, db, context);
		const byId = new Map(issues.map(row => [row.id, row]));
		const summaries = index.readyQueue.map(id => rowToIssueSummary(byId.get(id), index.readinessById[id], claimedById[id], dependenciesById[id], dependentsById[id]));
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
		const { index, claimedById, dependenciesById, dependentsById } = loadBoardReadiness(runtime, db, context);
		// KAP-3: `show` (and only `show`) attaches the issue's comments, ordered oldest
		// first. Map to the contract's { id, body, actor, created_at } shape — never the
		// raw row — so the projection stays stable.
		const commentRows = allParams(
			runtime, db,
			'SELECT * FROM kernel_comments WHERE issue_id = ? ORDER BY created_at ASC, id ASC',
			[id],
		);
		const comments = commentRows.map(comment => ({
			id: comment.id,
			body: comment.body ?? null,
			actor: comment.actor,
			created_at: comment.created_at,
		}));
		// f61601ab: surface the REAL workflow phase from kernel_stage_runs (latest
		// active, else latest completed) so consumers read the phase instead of
		// guessing from status+claim. Null when no stage runs exist.
		const currentStageRow = loadCurrentStageRunRow(runtime, db, id);
		return okIssueResponse('issue.show', {
			...rowToIssueSummary(rows[0], index.readinessById[id], claimedById[id], dependenciesById[id], dependentsById[id]),
			current_stage: currentStageRow ? currentStageRow.stage : null,
			current_stage_status: currentStageRow ? currentStageRow.status : null,
			comments,
		});
	}
	if (operation === 'owns') {
		return runIssueOwnsRead(runtime, db, args, context);
	}
	if (operation === 'search') {
		const term = `%${firstPositional(args) || ''}%`;
		const rows = allParams(
			runtime, db,
			'SELECT * FROM kernel_issues WHERE title LIKE ? OR body LIKE ? ORDER BY priority_rank ASC, id ASC',
			[term, term],
		);
		const { index, claimedById, dependenciesById, dependentsById } = loadBoardReadiness(runtime, db, context);
		const summaries = rows.map(row => rowToIssueSummary(row, index.readinessById[row.id], claimedById[row.id], dependenciesById[row.id], dependentsById[row.id]));
		return okIssueResponse('issue.search', { issues: summaries, count: summaries.length });
	}
	if (operation === 'stats') {
		const { index, liveClaims } = loadBoardReadiness(runtime, db, context);
		const statusRows = allParams(runtime, db, 'SELECT status, COUNT(*) AS n FROM kernel_issues GROUP BY status');
		const counts = {};
		for (const row of statusRows) {
			counts[row.status] = Number(row.n);
		}
		return okIssueResponse('issue.stats', {
			counts,
			ready_count: index.readyQueue.length,
			blocked_count: index.blocked.length,
			active_claims: liveClaims.length,
		});
	}
	// KAP-7: derived read query — every issue whose readiness is blocked
	// (index.readinessById[id].blocked === true; dependency/conflict/quarantine).
	// Summaries are sorted like `list` for deterministic output.
	if (operation === 'blocked') {
		const { issues, index, claimedById, dependenciesById, dependentsById } = loadBoardReadiness(runtime, db, context);
		const summaries = sortIssueSummaries(
			issues
				.filter(row => Boolean(index.readinessById[row.id]?.blocked))
				.map(row => rowToIssueSummary(row, index.readinessById[row.id], claimedById[row.id], dependenciesById[row.id], dependentsById[row.id])),
		);
		return okIssueResponse('issue.blocked', { issues: summaries, count: summaries.length });
	}
	// KAP-7: derived read query — open/in_progress issues whose updated_at is
	// STRICTLY older than (now - threshold_days). Default 14 days; --days <n> /
	// --days=<n> overrides (NaN/<=0 → default). "now" is context.now when the broker
	// supplies a deterministic clock, else the wall clock. review/done/cancelled are
	// excluded — only actively-open work can go stale. The cutoff compares the stored
	// ISO updated_at lexicographically, which is correct for UTC `Z` ISO-8601 strings.
	if (operation === 'stale') {
		const thresholdDays = parseStaleDays(args);
		// Guard a malformed context.now: Date.parse → NaN would make new Date(NaN)
		// throw "Invalid time value" on toISOString(); fall back to the wall clock.
		const parsedNow = typeof context?.now === 'string' ? Date.parse(context.now) : NaN;
		const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
		const cutoffIso = new Date(nowMs - thresholdDays * 24 * 60 * 60 * 1000).toISOString();
		const { issues, index, claimedById, dependenciesById, dependentsById } = loadBoardReadiness(runtime, db, context);
		// Only actively-open work can go stale. backlog (parked ideas) is deliberately
		// excluded alongside review/done/cancelled — parked work is never stale.
		const STALE_STATUSES = new Set(['open', 'in_progress']);
		const summaries = sortIssueSummaries(
			issues
				.filter(row => STALE_STATUSES.has(row.status) && String(row.updated_at) < cutoffIso)
				.map(row => rowToIssueSummary(row, index.readinessById[row.id], claimedById[row.id], dependenciesById[row.id], dependentsById[row.id])),
		);
		return okIssueResponse('issue.stale', { issues: summaries, count: summaries.length, threshold_days: thresholdDays });
	}
	// KAP-7: derived read query — issues touched by a DANGLING dependency edge. An
	// orphan edge is a kernel_dependencies row whose issue_id OR blocks_issue_id
	// names an id absent from kernel_issues (normally prevented by the FK, but
	// detectable if FK enforcement was ever bypassed or data was migrated in). The
	// EXISTING endpoint(s) of each dangling edge are the affected issues; both
	// endpoints missing contributes nothing. Results are deduped and sorted like list.
	if (operation === 'orphans') {
		const { issues, index, claimedById, dependenciesById, dependentsById } = loadBoardReadiness(runtime, db, context);
		const byId = new Map(issues.map(row => [row.id, row]));
		const dependencies = safeAll(runtime, db, 'SELECT * FROM kernel_dependencies');
		const orphanIds = new Set();
		for (const edge of dependencies) {
			const issueExists = byId.has(edge.issue_id);
			const blocksExists = byId.has(edge.blocks_issue_id);
			if (issueExists && blocksExists) continue; // clean edge
			// One endpoint dangles: the existing endpoint(s) are the affected issues.
			if (issueExists) orphanIds.add(edge.issue_id);
			if (blocksExists) orphanIds.add(edge.blocks_issue_id);
		}
		const summaries = sortIssueSummaries(
			[...orphanIds].map(id => rowToIssueSummary(byId.get(id), index.readinessById[id], claimedById[id], dependenciesById[id], dependentsById[id])),
		);
		return okIssueResponse('issue.orphans', { issues: summaries, count: summaries.length });
	}
	// KAP-12: read-only content lint — issues that FAIL required-content validation.
	// An issue FAILS iff its type is task|bug AND acceptance_criteria is null or
	// empty/whitespace-only. epic/decision are EXEMPT (no acceptance_criteria
	// requirement). Each failing issue carries its standard summary PLUS a
	// `validation: { rules_failed: ['missing_acceptance_criteria'] }`. The predicate
	// references ONLY base-existing columns (type/acceptance_criteria); both arrive on
	// the loadBoardReadiness rows via `SELECT *`. Results sort like list (rank asc).
	if (operation === 'lint') {
		const { issues, index, claimedById, dependenciesById, dependentsById } = loadBoardReadiness(runtime, db, context);
		const LINTED_TYPES = new Set(['task', 'bug']);
		const summaries = sortIssueSummaries(
			issues
				.filter(row => LINTED_TYPES.has(row.type) && String(row.acceptance_criteria ?? '').trim() === '')
				.map(row => ({
					...rowToIssueSummary(row, index.readinessById[row.id], claimedById[row.id], dependenciesById[row.id], dependentsById[row.id]),
					validation: { rules_failed: ['missing_acceptance_criteria'] },
				})),
		);
		return okIssueResponse('issue.lint', { issues: summaries, count: summaries.length });
	}
	// Epic support: DIRECT children of <epic> (one level — `WHERE parent_id = ?`, the
	// membership model is the first-class parent_id field, NOT dependency edges) plus a
	// kernel-computed rollup. The target is accepted as ANY existing id (not gated on
	// type === 'epic' — parent_id is generic); a missing id returns FORGE_ISSUE_NOT_FOUND
	// (mirrors `show`, and epic.sh already has a not-found path). Children carry the full
	// summary (assignee/status/blocked_by/dependents), so consumers build their
	// per-developer + blocked views off this single query.
	if (operation === 'children') {
		const epicId = firstPositional(args);
		const epicRows = allParams(runtime, db, 'SELECT * FROM kernel_issues WHERE id = ?', [epicId]);
		if (!epicRows[0]) {
			return formatIssueCommandError({
				command: 'issue.children',
				code: 'FORGE_ISSUE_NOT_FOUND',
				message: `Issue ${epicId ?? '<missing id>'} not found`,
				exitCode: ISSUE_COMMAND_EXIT_CODES.notFound,
			});
		}
		const epicRow = epicRows[0];
		const { issues, index, claimedById, dependenciesById, dependentsById } = loadBoardReadiness(runtime, db, context);
		const children = sortIssueSummaries(
			issues
				.filter(row => row.parent_id === epicId)
				.map(row => rowToIssueSummary(row, index.readinessById[row.id], claimedById[row.id], dependenciesById[row.id], dependentsById[row.id])),
		);
		return okIssueResponse('issue.children', {
			epic: { id: epicRow.id, title: epicRow.title, type: epicRow.type, status: epicRow.status },
			children,
			rollup: buildRollup(children),
			count: children.length,
		});
	}
	// Dashboard lease rows consume the same live-authority projection as stats,
	// claimed_by, owns, and readiness. Sort by claimed_at then issue_id for stable output.
	if (operation === 'claims') {
		const liveClaims = loadLiveKernelClaimRows(runtime, db, context);
		const claims = liveClaims
			.map(row => ({
				id: row.id,
				issue_id: row.issue_id,
				actor: row.actor ?? null,
				session_id: row.session_id ?? null,
				worktree_id: row.worktree_id ?? null,
				claimed_at: row.claimed_at ?? null,
				expires_at: row.expires_at ?? null,
			}))
			.sort((a, b) => String(a.claimed_at).localeCompare(String(b.claimed_at))
				|| String(a.issue_id).localeCompare(String(b.issue_id)));
		return okIssueResponse('issue.claims', { claims, count: claims.length });
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

function assertGenericEventNamespace(event) {
	if (!String(event.idempotency_key || '').startsWith('claim.repair:')) return;
	throw new ClaimRepairError(
		'CLAIM_REPAIR_RECEIPT_RESERVED',
		'Generic event insertion cannot write the reserved claim-repair receipt namespace',
	);
}

// Persist one event. The id is supplied by the caller or minted here (event ids are
// TEXT, not autoincrement). The event's payload is stored as payload_json: a
// pre-serialized payload_json wins, else the payload object is JSON-stringified. The
// native UNIQUE(idempotency_key) error is intentionally NOT caught here.
function insertKernelEventRow(runtime, db, event) {
	assertGenericEventNamespace(event);
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
// idx_kernel_events_entity_created. SQLite rowid is the authoritative local
// insertion sequence when timestamps tie; event ids are random and cannot order
// same-clock approval/rejection decisions.
function listKernelEventRows(runtime, db, entityType, entityId) {
	return allParams(
		runtime,
		db,
		'SELECT * FROM kernel_events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at ASC, rowid ASC',
		[entityType, entityId],
	);
}

// Bulk activity read (Slice C2, additive + read-only) across ALL entities, newest first,
// for `forge insights`. `since` is an optional ISO cutoff (created_at >= since); `limit`
// bounds the row count (default 1000). Imported beads interactions live here as
// `beads.interaction.<kind>` events, so insights derives interaction patterns from this
// instead of the retired legacy interactions log. Creates/migrates nothing.
function listRecentKernelEventRows(runtime, db, since, limit) {
	const params = [];
	let where = '';
	if (since) {
		where = 'WHERE created_at >= ?';
		params.push(since);
	}
	const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 1000;
	params.push(cap);
	return allParams(
		runtime,
		db,
		`SELECT * FROM kernel_events ${where} ORDER BY created_at DESC LIMIT ?`,
		params,
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

function listActiveKernelClaimRows(runtime, db) {
	return safeAll(runtime, db, "SELECT * FROM kernel_claims WHERE state = 'active' ORDER BY claimed_at ASC, issue_id ASC");
}

// Reconciliation must never release whichever lease happens to occupy an issue's
// active slot after its evidence was gathered. Bind every ownership discriminator
// from the observed row so a concurrent replacement makes this a zero-row no-op.
function releaseExactKernelClaimRow(runtime, db, claim) {
	const result = runParams(
		runtime,
		db,
		`UPDATE kernel_claims SET state = 'released'
		 WHERE id = ? AND issue_id = ? AND actor IS ? AND session_id IS ?
			AND worktree_id IS ? AND state = 'active'`,
		[claim.id, claim.issue_id, claim.actor ?? null, claim.session_id ?? null, claim.worktree_id ?? null],
	);
	return Number(result?.changes || 0) === 1;
}

function releaseExactKernelClaimIfWorktreeMissing(runtime, db, claim, expectedWorktree, isMissing) {
	if (!expectedWorktree || typeof isMissing !== 'function') return false;
	execSql(runtime, db, 'BEGIN IMMEDIATE;');
	try {
		const rows = safeAll(
			runtime,
			db,
			`SELECT * FROM kernel_worktrees
			 WHERE id = ? AND git_common_dir IS ? AND path = ? AND branch IS ?
				AND actor IS ? AND issue_id IS ? AND work_folder IS ?
				AND registered_at IS ? AND state = 'active'`,
			[
				expectedWorktree.id,
				expectedWorktree.git_common_dir ?? null,
				expectedWorktree.path,
				expectedWorktree.branch ?? null,
				expectedWorktree.actor ?? null,
				expectedWorktree.issue_id ?? null,
				expectedWorktree.work_folder ?? null,
				expectedWorktree.registered_at ?? null,
			],
		);
		const exact = rows.length === 1 && rows[0];
		// This check deliberately runs under BEGIN IMMEDIATE to close the
		// worktree-state TOCTOU window. Keep callbacks synchronous, local, and fast.
		if (!exact || isMissing(exact.path, exact) !== true) {
			execSql(runtime, db, 'ROLLBACK;');
			return false;
		}
		const released = releaseExactKernelClaimRow(runtime, db, claim);
		if (!released) {
			execSql(runtime, db, 'ROLLBACK;');
			return false;
		}
		execSql(runtime, db, 'COMMIT;');
		return true;
	} catch (error) {
		try { execSql(runtime, db, 'ROLLBACK;'); } catch { /* preserve original failure */ }
		throw error;
	}
}

// --- Worktree-linkage primitives (P0 kernel linkage backbone). The kernel_worktrees
// table is a plain authority registry (NOT event-sourced): `forge worktree create`
// writes a row here so the kernel records issue → worktree → work-folder, and
// orientation / `forge worktree list` read it back instead of guessing. The row is
// keyed by absolute worktree `path`; re-registering the same path UPDATEs in place so
// the write is idempotent (a worktree can be re-created / re-linked without duplicating).
const KERNEL_WORKTREE_COLUMNS = Object.freeze([
	'id',
	'git_common_dir',
	'path',
	'branch',
	'actor',
	'issue_id',
	'work_folder',
	'registered_at',
	'state',
]);

function loadWorktreeRowByPath(runtime, db, worktreePath) {
	if (!worktreePath) return null;
	const rows = safeAll(
		runtime,
		db,
		'SELECT * FROM kernel_worktrees WHERE path = ? ORDER BY registered_at DESC LIMIT 1',
		[worktreePath],
	);
	return rows[0] || null;
}

// The idempotent upsert key. `forge plan` registers MULTIPLE branches from ONE
// checkout (same absolute path), so keying by path ALONE made a second plan-first
// feature UPDATE-in-place over the first branch's row and dead-end its ship (R1).
// Key by (path, branch) so each branch keeps its own row; fall back to path-only
// when no branch is supplied (worktree flows use distinct paths, so behavior there
// is unchanged).
function loadWorktreeRowByPathAndBranch(runtime, db, worktreePath, branch) {
	if (!worktreePath) return null;
	if (!branch) return loadWorktreeRowByPath(runtime, db, worktreePath);
	const rows = safeAll(
		runtime,
		db,
		'SELECT * FROM kernel_worktrees WHERE path = ? AND branch = ? ORDER BY registered_at DESC LIMIT 1',
		[worktreePath, branch],
	);
	return rows[0] || null;
}

// A git branch is checked out in exactly ONE worktree, so a NEW active registration
// for a branch supersedes any prior ACTIVE row carrying that same branch under a
// different id (be18881c): a reused/deleted-and-recreated branch must not keep a
// stale binding to the OLD issue. Marking those rows state='superseded' lets the
// active-only branch resolver skip them regardless of their timestamp.
function supersedePriorBranchRegistrations(runtime, db, branch, keepId) {
	if (!branch) return;
	runParams(
		runtime,
		db,
		"UPDATE kernel_worktrees SET state = 'superseded' WHERE branch = ? AND state = 'active' AND id != ?",
		[branch, keepId || ''],
	);
}

function upsertWorktreeRow(runtime, db, input) {
	const existing = loadWorktreeRowByPathAndBranch(runtime, db, input.path, input.branch);
	const row = {
		id: input.id || existing?.id || randomUUID(),
		git_common_dir: input.git_common_dir,
		path: input.path,
		branch: input.branch,
		actor: input.actor ?? null,
		issue_id: input.issue_id ?? null,
		work_folder: input.work_folder ?? null,
		registered_at: input.registered_at || new Date().toISOString(),
		state: input.state || 'active',
	};
	if (existing) {
		runParams(
			runtime,
			db,
			'UPDATE kernel_worktrees SET git_common_dir = ?, branch = ?, actor = ?, issue_id = ?, work_folder = ?, registered_at = ?, state = ? WHERE id = ?',
			[row.git_common_dir, row.branch, row.actor, row.issue_id, row.work_folder, row.registered_at, row.state, row.id],
		);
	} else {
		const placeholders = KERNEL_WORKTREE_COLUMNS.map(() => '?').join(', ');
		runParams(
			runtime,
			db,
			`INSERT INTO kernel_worktrees (${KERNEL_WORKTREE_COLUMNS.join(', ')}) VALUES (${placeholders})`,
			KERNEL_WORKTREE_COLUMNS.map(column => row[column]),
		);
	}
	if (row.state === 'active') {
		supersedePriorBranchRegistrations(runtime, db, row.branch, row.id);
	}
	return row;
}

function listWorktreeRows(runtime, db, filter = {}) {
	if (filter && filter.state) {
		return safeAll(
			runtime,
			db,
			'SELECT * FROM kernel_worktrees WHERE state = ? ORDER BY registered_at DESC',
			[filter.state],
		);
	}
	return safeAll(runtime, db, 'SELECT * FROM kernel_worktrees ORDER BY registered_at DESC');
}

const TRACE_MAX_PULL_REQUESTS = 128;
const TRACE_MAX_ITERATIONS = 128;

function resolvePrLinkageRow(runtime, db, input = {}) {
	let worktree = null;
	if (input.worktree_id) {
		worktree = safeAll(
			runtime,
			db,
			"SELECT * FROM kernel_worktrees WHERE id = ? AND state = 'active' LIMIT 1",
			[input.worktree_id],
		)[0] || null;
	} else if (input.branch && input.git_common_dir) {
		worktree = safeAll(
			runtime,
			db,
			`SELECT * FROM kernel_worktrees
			 WHERE git_common_dir = ? AND branch = ? AND state = 'active'
			 ORDER BY registered_at DESC LIMIT 1`,
			[input.git_common_dir, input.branch],
		)[0] || null;
	}
	const inferredIssueId = worktree?.issue_id ?? null;
	const issueId = input.issue_id ?? inferredIssueId;
	const issue = issueId
		? safeAll(runtime, db, 'SELECT id, entity_revision FROM kernel_issues WHERE id = ? LIMIT 1', [issueId])[0] || null
		: null;
	return {
		issue_id: issueId,
		inferred_issue_id: inferredIssueId,
		issue_revision: issue?.entity_revision ?? null,
		worktree_id: worktree?.id ?? null,
		worktree_matches: Boolean(worktree
			&& worktree.git_common_dir === input.git_common_dir
			&& worktree.branch === input.branch
			&& worktree.issue_id === issueId),
	};
}

function parseTraceEvent(row) {
	let payload;
	try {
		payload = JSON.parse(row.payload_json || '{}');
	} catch {
		payload = {};
	}
	return {
		id: row.id,
		type: row.event_type,
		at: row.created_at,
		issue_id: payload.issue_id ?? null,
		worktree_id: payload.worktree_id ?? null,
		issue_revision: payload.issue_revision ?? null,
		head_sha: payload.head_sha ?? null,
		work_packet_hash: payload.work_packet_hash ?? null,
		work_packet_identity: payload.work_packet_identity ?? null,
		run_receipt_hash: payload.run_receipt_hash ?? null,
		run_id: payload.run_id ?? null,
		attempt_id: payload.attempt_id ?? null,
		risk_manifest_digest: payload.risk_manifest_digest ?? null,
		gate_receipts: payload.gate_receipts ?? null,
		url: payload.url ?? null,
	};
}

function isCompleteTraceIteration(event) {
	if (!event.type?.startsWith('pr.')) return true;
	return typeof event.issue_id === 'string' && event.issue_id.length > 0
		&& typeof event.worktree_id === 'string' && event.worktree_id.length > 0
		&& Number.isInteger(event.issue_revision) && event.issue_revision >= 0
		&& /^[0-9a-f]{40}$/.test(event.head_sha)
		&& /^[0-9a-f]{64}$/.test(event.work_packet_hash)
		&& typeof event.work_packet_identity === 'string' && event.work_packet_identity.length > 0
		&& /^[0-9a-f]{64}$/.test(event.run_receipt_hash)
		&& /^[0-9a-f]{64}$/.test(event.risk_manifest_digest)
		&& Array.isArray(event.gate_receipts) && event.gate_receipts.length > 0
		&& event.gate_receipts.every(receipt => typeof receipt === 'string' && receipt.length > 0);
}

function loadPrTraceRow(runtime, db, row, gaps) {
	let iterations = safeAll(
		runtime,
		db,
		"SELECT * FROM kernel_events WHERE entity_type = 'pr' AND entity_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?",
		[row.id, TRACE_MAX_ITERATIONS + 1],
	);
	if (iterations.length > TRACE_MAX_ITERATIONS) {
		iterations = iterations.slice(0, TRACE_MAX_ITERATIONS);
		gaps.push(`iterations:${row.id}:overflow`);
	}
	const parsedIterations = iterations.map(parseTraceEvent);
	const prIterations = parsedIterations.filter(event => event.type?.startsWith('pr.'));
	if (prIterations.length === 0) {
		gaps.push(`iterations:${row.id}:missing`);
	} else if (prIterations.some(event => !isCompleteTraceIteration(event))) {
		gaps.push(`iterations:${row.id}:incomplete`);
	}
	return {
		...row,
		url: parsedIterations.find(event => event.url)?.url ?? null,
		iterations: parsedIterations,
	};
}

function loadSelectedTracePr(runtime, db, target) {
	if (target.pr_number === undefined || target.pr_number === null) return null;
	const clauses = ['number = ?'];
	const params = [Number(target.pr_number)];
	if (target.repo) {
		clauses.push('repo = ?');
		params.push(target.repo);
	}
	if (target.git_common_dir) {
		clauses.push('git_common_dir = ?');
		params.push(target.git_common_dir);
	}
	const matches = safeAll(
		runtime,
		db,
		`SELECT * FROM kernel_pr WHERE ${clauses.join(' AND ')} ORDER BY registered_at DESC LIMIT 2`,
		params,
	);
	if (matches.length > 1) throw new Error('Kernel trace PR target is ambiguous; supply repo and git_common_dir');
	return matches[0] || null;
}

function appendSelectedTracePr(pullRequests, selectedPr, issueId, gaps) {
	if (!selectedPr || pullRequests.some(row => row.id === selectedPr.id)) return pullRequests;
	if (issueId && selectedPr.issue_id !== issueId) {
		gaps.push(`pull_requests:${selectedPr.id}:unlinked_issue`);
	}
	const retained = pullRequests.length >= TRACE_MAX_PULL_REQUESTS
		? pullRequests.slice(0, TRACE_MAX_PULL_REQUESTS - 1)
		: pullRequests;
	if (retained.length < pullRequests.length && !gaps.includes('pull_requests:overflow')) {
		gaps.push('pull_requests:overflow');
	}
	return [...retained, selectedPr];
}

function loadTraceRows(runtime, db, target = {}) {
	const gaps = [];
	const selectedPr = loadSelectedTracePr(runtime, db, target);

	const issueId = target.issue_id ?? selectedPr?.issue_id ?? null;
	const issue = issueId
		? safeAll(runtime, db, 'SELECT * FROM kernel_issues WHERE id = ? LIMIT 1', [issueId])[0] || null
		: null;
	let pullRequests = issue
		? safeAll(
			runtime,
			db,
			' SELECT * FROM kernel_pr WHERE issue_id = ? ORDER BY registered_at ASC, number ASC LIMIT ?',
			[issue.id, TRACE_MAX_PULL_REQUESTS + 1],
		)
		: [];
	if (pullRequests.length > TRACE_MAX_PULL_REQUESTS) {
		pullRequests = pullRequests.slice(0, TRACE_MAX_PULL_REQUESTS);
		gaps.push('pull_requests:overflow');
	}
	pullRequests = appendSelectedTracePr(pullRequests, selectedPr, issueId, gaps);

	let worktree = null;
	const issueWorktreeId = pullRequests.find(row => row.issue_id === issueId && row.worktree_id)?.worktree_id;
	const selectedWorktreeId = !issueId || selectedPr?.issue_id === issueId ? selectedPr?.worktree_id : null;
	const preferredWorktreeId = selectedWorktreeId || issueWorktreeId;
	if (preferredWorktreeId) {
		worktree = safeAll(runtime, db, 'SELECT * FROM kernel_worktrees WHERE id = ? LIMIT 1', [preferredWorktreeId])[0] || null;
	}
	if (!worktree && issue) {
		worktree = safeAll(
			runtime,
			db,
			`SELECT * FROM kernel_worktrees WHERE issue_id = ?
			 ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, registered_at DESC LIMIT 1`,
			[issue.id],
		)[0] || null;
	}

	return {
		issue,
		worktree,
		work_folder: worktree?.work_folder ?? null,
		gaps,
		pull_requests: pullRequests.map(row => loadPrTraceRow(runtime, db, row, gaps)),
	};
}

// --- Stage-run registry (f61601ab). kernel_stage_runs records the REAL workflow
// phase per issue so the dashboard/`show` read the phase instead of guessing it
// from status+claim (a claimed-open issue with a merged PR would otherwise still
// show "dev"). Like kernel_worktrees this is a plain authority registry written
// DIRECTLY (not event-sourced): a stage row is keyed by (issue_id, stage) and the
// write is idempotent per that pair — re-starting a stage UPDATEs in place instead
// of duplicating. `start` opens an active row (started_at, completed_at NULL);
// `complete` stamps completed_at + status='done' on that same row.
const KERNEL_STAGE_RUN_COLUMNS = Object.freeze([
	'id',
	'issue_id',
	'stage',
	'substage',
	'status',
	'started_at',
	'completed_at',
	'evidence_id',
]);

function loadStageRunRow(runtime, db, issueId, stage) {
	if (!issueId || !stage) return null;
	const rows = safeAll(
		runtime,
		db,
		'SELECT * FROM kernel_stage_runs WHERE issue_id = ? AND stage = ? ORDER BY started_at DESC LIMIT 1',
		[issueId, stage],
	);
	return rows[0] || null;
}

// Idempotent per (issue_id, stage). action 'start' opens/keeps an active row;
// action 'complete' stamps completed_at + status='done' (creating the row first
// if the stage was never explicitly started, so a bare `complete` still records
// that the stage ran).
function recordStageRunRow(runtime, db, input) {
	const stage = input.stage;
	if (!input.issue_id || !stage) {
		throw new Error('recordStageRun requires issue_id and stage');
	}
	const action = input.action || 'start';
	if (action !== 'start' && action !== 'complete') {
		throw new Error(`recordStageRun: unknown action "${action}" (expected start|complete)`);
	}
	const now = input.now || new Date().toISOString();
	const existing = loadStageRunRow(runtime, db, input.issue_id, stage);

	if (action === 'start') {
		if (existing) {
			// Re-start is idempotent: keep the id + original started_at, ensure the row
			// is active again (supports a rework loop re-opening a completed stage).
			const row = {
				...existing,
				substage: input.substage ?? existing.substage ?? null,
				status: 'active',
				completed_at: null,
				evidence_id: input.evidence_id ?? existing.evidence_id ?? null,
			};
			runParams(
				runtime,
				db,
				'UPDATE kernel_stage_runs SET substage = ?, status = ?, completed_at = ?, evidence_id = ? WHERE id = ?',
				[row.substage, row.status, row.completed_at, row.evidence_id, row.id],
			);
			return row;
		}
		const row = {
			id: input.id || randomUUID(),
			issue_id: input.issue_id,
			stage,
			substage: input.substage ?? null,
			status: 'active',
			started_at: input.started_at || now,
			completed_at: null,
			evidence_id: input.evidence_id ?? null,
		};
		const placeholders = KERNEL_STAGE_RUN_COLUMNS.map(() => '?').join(', ');
		runParams(
			runtime,
			db,
			`INSERT INTO kernel_stage_runs (${KERNEL_STAGE_RUN_COLUMNS.join(', ')}) VALUES (${placeholders})`,
			KERNEL_STAGE_RUN_COLUMNS.map(column => row[column]),
		);
		return row;
	}

	// action === 'complete'
	if (existing) {
		const row = {
			...existing,
			substage: input.substage ?? existing.substage ?? null,
			status: 'done',
			completed_at: now,
			evidence_id: input.evidence_id ?? existing.evidence_id ?? null,
		};
		runParams(
			runtime,
			db,
			'UPDATE kernel_stage_runs SET substage = ?, status = ?, completed_at = ?, evidence_id = ? WHERE id = ?',
			[row.substage, row.status, row.completed_at, row.evidence_id, row.id],
		);
		return row;
	}
	const row = {
		id: input.id || randomUUID(),
		issue_id: input.issue_id,
		stage,
		substage: input.substage ?? null,
		status: 'done',
		started_at: input.started_at || now,
		completed_at: now,
		evidence_id: input.evidence_id ?? null,
	};
	const placeholders = KERNEL_STAGE_RUN_COLUMNS.map(() => '?').join(', ');
	runParams(
		runtime,
		db,
		`INSERT INTO kernel_stage_runs (${KERNEL_STAGE_RUN_COLUMNS.join(', ')}) VALUES (${placeholders})`,
		KERNEL_STAGE_RUN_COLUMNS.map(column => row[column]),
	);
	return row;
}

// Atomic stage transition: complete the `from` stage and start the `to` stage as
// ONE all-or-nothing write. Auto-recording from a `stage: <from> -> <to>` comment
// (5a5ba3a6) used to issue these as two separate recordStageRun calls at the caller;
// if the second threw, the first had already persisted — leaving a half-transition
// (from marked done, to never started) so `current_stage` was wrong. Wrapping both
// writes in a single BEGIN IMMEDIATE transaction makes a mid-transition failure roll
// back cleanly. Best-effort/non-blocking is the CALLER's contract; this method still
// throws on failure so the caller can observe it (and roll back has happened).
function recordStageTransitionRow(runtime, db, input) {
	const issueId = input && input.issue_id;
	const from = input && input.from;
	const to = input && input.to;
	if (!issueId || !from || !to) {
		throw new Error('recordStageTransition requires issue_id, from, and to');
	}
	const now = input.now || new Date().toISOString();
	execSql(runtime, db, 'BEGIN IMMEDIATE;');
	try {
		const completed = recordStageRunRow(runtime, db, {
			issue_id: issueId, stage: from, action: 'complete', now,
		});
		const started = recordStageRunRow(runtime, db, {
			issue_id: issueId, stage: to, action: 'start', now,
		});
		execSql(runtime, db, 'COMMIT;');
		return { from: completed, to: started };
	} catch (error) {
		try {
			execSql(runtime, db, 'ROLLBACK;');
		} catch {
			// A rollback failure must not mask the original transition error.
		}
		throw error;
	}
}

const PLAN_SNAPSHOT_METADATA_KEY = 'forge.plan.v1';

function parseIssueMetadataObject(metadata) {
	if (metadata == null || metadata === '') return {};
	const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('issue metadata must be a JSON object');
	}
	return parsed;
}

function loadPlanSnapshotRow(runtime, db, issueId) {
	const issue = loadKernelEntityRow(runtime, db, 'issue', issueId);
	if (!issue) throw new Error(`Issue ${issueId} not found in the kernel`);
	return parseIssueMetadataObject(issue.metadata)[PLAN_SNAPSHOT_METADATA_KEY] || null;
}

// Persist the plan snapshot and the plan->dev transition as one authority write.
// The issue metadata column already exists, so this adds no schema or migration.
// A normal issue.update event is appended in the same transaction so revision/CAS
// history remains truthful rather than mutating the issue projection out-of-band.
function recordPlanSnapshotTransitionRow(runtime, db, input) {
	const issueId = input && input.issue_id;
	const snapshot = input && input.snapshot;
	if (!issueId || !snapshot) {
		throw new Error('recordPlanSnapshotTransition requires issue_id and snapshot');
	}
	const now = input.now || new Date().toISOString();
	execSql(runtime, db, 'BEGIN IMMEDIATE;');
	try {
		const issue = loadKernelEntityRow(runtime, db, 'issue', issueId);
		if (!issue) throw new Error(`Issue ${issueId} not found in the kernel`);
		const metadata = parseIssueMetadataObject(issue.metadata);
		const established = metadata[PLAN_SNAPSHOT_METADATA_KEY];
		if (established) {
			if (established.digest === snapshot.digest) {
				execSql(runtime, db, 'COMMIT;');
				return { idempotent: true };
			}
			throw new Error('Kernel plan snapshot is immutable; reconcile repository drift before retrying');
		}
		metadata[PLAN_SNAPSHOT_METADATA_KEY] = snapshot;
		const event = {
			id: randomUUID(),
			entity_type: 'issue',
			entity_id: issueId,
			event_type: 'issue.update',
			idempotency_key: `plan.snapshot:${issueId}:${snapshot.digest}`,
			expected_revision: Number(issue.entity_revision ?? 0),
			actor: input.actor || 'forge-plan',
			origin: 'local',
			payload: { metadata: JSON.stringify(metadata) },
			created_at: now,
		};
		insertKernelEventRow(runtime, db, event);
		applyAcceptedIssueEvent(runtime, db, event, {});
		const transition = {
			from: recordStageRunRow(runtime, db, { issue_id: issueId, stage: 'plan', action: 'complete', now }),
			to: recordStageRunRow(runtime, db, { issue_id: issueId, stage: 'dev', action: 'start', now }),
		};
		execSql(runtime, db, 'COMMIT;');
		return transition;
	} catch (error) {
		try {
			execSql(runtime, db, 'ROLLBACK;');
		} catch {
			// Preserve the original failure.
		}
		throw error;
	}
}

function listStageRunRows(runtime, db, issueId) {
	if (!issueId) return [];
	// Deterministic order: started_at first, then rowid (the implicit INSERT sequence)
	// as a STABLE tie-break. Fast callers can mint two runs in the same millisecond, so
	// ordering by started_at alone leaves ties undefined (differs local vs CI vs OS).
	// rowid gives intuitive insertion order for a history list; the random-UUID `id`
	// would not reflect insertion order, so it is unsuitable as the tie-break.
	return safeAll(
		runtime,
		db,
		'SELECT * FROM kernel_stage_runs WHERE issue_id = ? ORDER BY started_at ASC, rowid ASC',
		[issueId],
	);
}

// Current stage = latest ACTIVE run (completed_at IS NULL) by started_at; when none
// is active, the latest COMPLETED run by completed_at. Returns null when the issue
// has no stage runs (caller falls back to the status+claim heuristic).
function loadCurrentStageRunRow(runtime, db, issueId) {
	const rows = listStageRunRows(runtime, db, issueId);
	if (rows.length === 0) return null;
	const active = rows.filter(row => !row.completed_at);
	if (active.length > 0) {
		return active.reduce((latest, row) => (String(row.started_at) >= String(latest.started_at) ? row : latest));
	}
	return rows.reduce((latest, row) => (
		String(row.completed_at || row.started_at) >= String(latest.completed_at || latest.started_at) ? row : latest
	));
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
	// KAP-10 (design/notes) + KAP-11 (assignee): persisted on create AND update via
	// the same assignment loop. assignee is the persistent owner, distinct from the
	// transient kernel_claims lease.
	'design',
	'notes',
	'assignee',
	// Author, close timestamp + raw close reason, and a verbatim metadata JSON blob.
	// The importer sets these explicitly on an issue event payload; a native CLI close
	// also auto-fills closed_at/close_reason from the close event (9197b0c8) — explicit
	// payload values always win, preserving import fidelity.
	'created_by',
	'closed_at',
	'close_reason',
	'metadata',
]);

// close drives the issue to a terminal status; an explicit payload.status (rework
// transitions) still wins so the broker can model any accepted lifecycle move.
function resolveMutationStatus(eventType, payload) {
	if (typeof payload.status === 'string' && payload.status) return payload.status;
	if (eventType === 'issue.close') return 'done';
	return null;
}

// KAP-8: after a close COMMITS the issue to a terminal status, compute the issues
// that become newly READY because this issue is now done. This is a LOCALIZED
// post-write read on the SAME connection/transaction — the issue row is already
// `done`, so loadBoardReadiness sees the post-close state. We restrict the result
// to DIRECT dependents of the closed issue (kernel_dependencies rows where
// blocks_issue_id === closedId) whose readiness now flips to ready (the closed
// blocker is terminal and dropped, and they carry no OTHER live blocker). Sorted
// for a deterministic response.
function computeNewlyUnblocked(runtime, db, closedIssueId, context = {}) {
	const dependents = safeAll(
		runtime,
		db,
		'SELECT DISTINCT issue_id FROM kernel_dependencies WHERE blocks_issue_id = ?',
		[closedIssueId],
	).map(row => row.issue_id).filter(Boolean);
	if (dependents.length === 0) return [];
	const { index } = loadBoardReadiness(runtime, db, context);
	return dependents
		.filter(id => Boolean(index.readinessById[id]?.ready))
		.sort((a, b) => String(a).localeCompare(String(b)));
}

// Upsert the issue row for an accepted issue event and bump entity_revision. The
// evaluator already enforced CAS (expected_revision === stored), so the new
// revision is monotonic: stored + 1 for an update, 0 for a fresh create.
function applyAcceptedIssueEvent(runtime, db, event, context = {}) {
	const payload = event.payload || (event.payload_json ? JSON.parse(event.payload_json) : {});
	const issueId = event.entity_id;
	const now = event.created_at;
	const existing = loadKernelEntityRow(runtime, db, 'issue', issueId);
	const status = resolveMutationStatus(event.event_type, payload);

	// 9197b0c8: a native close must persist its OWN close metadata. The importer
	// supplies closed_at/close_reason explicitly, but a CLI `close --reason` only
	// carries the event-payload `reason` — both COLUMNS stayed NULL and every real
	// close failed gate.issue_verify's read-back. Stamp the columns from the close
	// event (explicit payload values, e.g. import fidelity, still win).
	if (event.event_type === 'issue.close') {
		if (payload.closed_at === undefined || payload.closed_at === null) {
			payload.closed_at = now;
		}
		if (
			(payload.close_reason === undefined || payload.close_reason === null)
			&& typeof payload.reason === 'string' && payload.reason
		) {
			payload.close_reason = payload.reason;
		}
	}

	if (!existing) {
		// Fresh create: seed required NOT NULL columns, then overwrite with any
		// supplied payload values via the shared column map below. priority_rank is
		// DERIVED from the (possibly defaulted) priority LABEL so a no-`--priority`
		// create still sorts by its P2 default — seeding rank 0 would otherwise rank the
		// common default-priority issue ABOVE an explicit P1 in `list` (priority order
		// inverted). The CLI/broker already supplies priority_rank when --priority is
		// given, so this fallback only fires for the defaulted/raw-event path.
		const priorityLabel = payload.priority ?? 'P2';
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
				priorityLabel,
				Number(payload.priority_rank ?? rankForPriorityLabel(priorityLabel)),
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
		// KAP-4: labels arrive as a string[] (broker parseLabelFlag). SQLite cannot
		// bind an array param, so persist as JSON-array TEXT — the canonical form
		// parseLabels reads back on the read side. Every other column binds as-is.
		values.push(column === 'labels' ? JSON.stringify(value) : value);
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
			// Driver-supplied TYPED conflict signal (issues 89bf8930 / d4ce47bb): the
			// broker branches on this code, never on error text. kernelRevisionConflict
			// is retained as the structural marker classifyConflictSignal also honors.
			error.conflictSignal = CONFLICT_SIGNAL.CAS_STALE;
			error.kernelRevisionConflict = true;
			error.entityId = issueId;
			error.expectedRevision = Number(event.expected_revision || 0);
			error.actualRevision = expectedRevision;
			throw error;
		}
		return finalizeIssueMutation(runtime, db, event, issueId, nextRevision, context);
	}
	runParams(
		runtime,
		db,
		`UPDATE kernel_issues SET ${assignments.join(', ')} WHERE id = ?`,
		[...values, issueId],
	);
	return finalizeIssueMutation(runtime, db, event, issueId, nextRevision, context);
}

// Build the issue-mutation summary, attaching KAP-8 newly_unblocked for a close.
// The issue row is already at its terminal status here (the UPDATE above committed
// on this connection), so computeNewlyUnblocked sees the post-close readiness.
function finalizeIssueMutation(runtime, db, event, issueId, revision, context) {
	const summary = { id: issueId, revision };
	const issue = loadKernelEntityRow(runtime, db, 'issue', issueId);
	if (isTerminalStatus(issue?.status)) {
		const claim = loadActiveKernelClaimRow(runtime, db, issueId);
		if (claim && !releaseExactKernelClaimRow(runtime, db, claim)) {
			const error = new Error(`failed to release current claim for terminal issue ${issueId}`);
			error.code = 'FORGE_CLAIM_TERMINAL_RELEASE_CONFLICT';
			throw error;
		}
	}
	if (event.event_type === 'issue.close') {
		summary.newly_unblocked = computeNewlyUnblocked(runtime, db, issueId, context);
	}
	return summary;
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
function applyAcceptedMutation(runtime, db, event, context = {}) {
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
		// context carries now/actor so KAP-8's post-close readiness recompute uses the
		// same clock/actor the rest of the guarded path did.
		return applyAcceptedIssueEvent(runtime, db, event, context);
	}
	return null;
}

// --- Faithful import write path (beads → kernel) ------------------------------
// Direct authority-table writes that PRESERVE an imported issue's ORIGINAL
// created_at/updated_at, terminal status (done/cancelled), priority(+rank), labels,
// acceptance/content and beads-fidelity columns — BYPASSING applyAcceptedIssueEvent's
// now-stamping create/CAS path. This is the ONLY path that writes an issue's original
// timestamps; the normal create/update flow is unchanged. Consumed exclusively by the
// broker's importIssues entry point (the `forge migrate` write path). Each call is
// idempotent (ON CONFLICT(id) DO NOTHING — an existing id is skipped, never duplicated
// or thrown) and transactional (one BEGIN IMMEDIATE per call; all-or-nothing).

// The full kernel_issues column set the importer writes. Every NOT NULL column is
// seeded with a default in buildImportIssueRow, so a sparse record (only id/title)
// still inserts a valid row, while a full-fidelity record round-trips verbatim.
const IMPORT_ISSUE_COLUMNS = Object.freeze([
	'id', 'title', 'body', 'type', 'status', 'priority', 'priority_rank',
	'created_at', 'updated_at', 'entity_revision',
	'parent_id', 'sprint_id', 'release_id', 'stage_state', 'labels',
	'acceptance_criteria', 'estimate', 'design', 'notes', 'assignee',
	'created_by', 'closed_at', 'close_reason', 'metadata',
]);

const IMPORT_COMMENT_COLUMNS = Object.freeze(['id', 'issue_id', 'body', 'actor', 'visibility', 'created_at']);
const IMPORT_DEPENDENCY_COLUMNS = Object.freeze(['id', 'issue_id', 'blocks_issue_id', 'dependency_type', 'created_at']);
// The kernel_events column set the importer writes for legacy beads activity events +
// interactions (records.activityEvents). Every NOT NULL column is seeded with a default in
// buildImportEventRow so a sparse record still inserts a valid row.
const IMPORT_EVENT_COLUMNS = Object.freeze([
	'id', 'entity_type', 'entity_id', 'event_type', 'idempotency_key',
	'expected_revision', 'actor', 'origin', 'payload_json', 'created_at',
]);

// The mapper carries an issue's terminal close metadata on a SEPARATE
// `beads.issue.closed` event (kernel.events), not on the issue record — mirror the
// adapter's getCloseMetadataByIssue so closed_at/close_reason land on the issue row.
function buildImportCloseMetadata(events = []) {
	const byIssue = new Map();
	for (const event of Array.isArray(events) ? events : []) {
		if (!event || event.event_type !== 'beads.issue.closed') continue;
		let payload;
		try {
			payload = event.payload_json ? JSON.parse(event.payload_json) : (event.payload || {});
		} catch {
			payload = {};
		}
		byIssue.set(event.entity_id, {
			closed_at: payload.closed_at ?? event.created_at ?? null,
			close_reason: payload.close_reason ?? null,
		});
	}
	return byIssue;
}

// Build the full insert row for one imported issue record. NOT NULL columns default so a
// sparse record stays valid; created_at/updated_at fall back to the original created_at
// (then `now`) rather than always-now, so the imported issue's history is preserved.
// labels are stored verbatim (the mapper already JSON-encodes them) — an accidental array
// is re-encoded defensively. Close metadata prefers a record-level column, else the
// close-event sidecar.
function buildImportIssueRow(record, closeMeta, now) {
	const priority = record.priority ?? 'P2';
	const createdAt = record.created_at ?? now;
	const close = closeMeta || {};
	const labels = Array.isArray(record.labels) ? JSON.stringify(record.labels) : (record.labels ?? null);
	return {
		id: record.id,
		title: record.title ?? record.id,
		body: record.body ?? null,
		type: record.type ?? 'task',
		status: record.status ?? 'open',
		priority,
		priority_rank: Number(record.priority_rank ?? rankForPriorityLabel(priority)),
		created_at: createdAt,
		updated_at: record.updated_at ?? createdAt,
		entity_revision: Number(record.entity_revision ?? 0),
		parent_id: record.parent_id ?? null,
		sprint_id: record.sprint_id ?? null,
		release_id: record.release_id ?? null,
		stage_state: record.stage_state ?? null,
		labels,
		acceptance_criteria: record.acceptance_criteria ?? null,
		estimate: record.estimate ?? null,
		design: record.design ?? null,
		notes: record.notes ?? null,
		assignee: record.assignee ?? null,
		created_by: record.created_by ?? null,
		closed_at: record.closed_at ?? close.closed_at ?? null,
		close_reason: record.close_reason ?? close.close_reason ?? null,
		metadata: record.metadata ?? null,
	};
}

// Build the full insert row for one imported activity event (records.activityEvents: legacy
// beads events.jsonl + interactions.jsonl mapped to kernel_events). NOT NULL columns default so
// a sparse record stays valid; the mapper already supplies a deterministic id/idempotency_key so
// the insert is idempotent under ON CONFLICT(id).
function buildImportEventRow(record, now) {
	return {
		id: record.id,
		entity_type: record.entity_type ?? 'issue',
		entity_id: record.entity_id ?? '',
		event_type: record.event_type ?? 'beads.event',
		idempotency_key: record.idempotency_key ?? record.id,
		expected_revision: Number(record.expected_revision ?? 0),
		actor: record.actor ?? 'beads',
		origin: record.origin ?? 'beads_import',
		payload_json: record.payload_json ?? JSON.stringify(record.payload ?? {}),
		created_at: record.created_at ?? now,
	};
}

// Insert a kernel records bundle ({ issues, comments, dependencies, events, activityEvents })
// into the authority tables inside ONE transaction. Order is issues → comments → dependencies →
// activity events so every child FK resolves; children whose endpoint id is absent (a dangling
// edge) are filtered out rather than aborting the whole batch on the live FK. activityEvents
// (kernel_events has no entity FK) always insert. Returns per-table {inserted, skipped} counts
// (skipped = an id that already existed or a filtered child).
function importIssueRecords(runtime, db, records = {}, options = {}) {
	const now = options.now || new Date().toISOString();
	const issues = Array.isArray(records.issues) ? records.issues : [];
	const comments = Array.isArray(records.comments) ? records.comments : [];
	const dependencies = Array.isArray(records.dependencies) ? records.dependencies : [];
	const activityEvents = Array.isArray(records.activityEvents) ? records.activityEvents : [];
	const closeByIssue = buildImportCloseMetadata(records.events);
	const summary = {
		issues: { inserted: 0, skipped: 0 },
		comments: { inserted: 0, skipped: 0 },
		dependencies: { inserted: 0, skipped: 0 },
		events: { inserted: 0, skipped: 0 },
	};
	const wasInserted = result => Number(result?.changes || 0) > 0;

	execSql(runtime, db, 'BEGIN IMMEDIATE;');
	try {
		const issueSql = `INSERT INTO kernel_issues (${IMPORT_ISSUE_COLUMNS.join(', ')})`
			+ ` VALUES (${IMPORT_ISSUE_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(id) DO NOTHING`;
		for (const record of issues) {
			if (!record || record.id == null) { summary.issues.skipped += 1; continue; }
			const row = buildImportIssueRow(record, closeByIssue.get(record.id), now);
			const result = runParams(runtime, db, issueSql, IMPORT_ISSUE_COLUMNS.map(column => row[column]));
			summary.issues[wasInserted(result) ? 'inserted' : 'skipped'] += 1;
		}

		// FK-safe child filtering: an id present after the issue inserts (imported OR
		// pre-existing) is a valid endpoint; anything else would trip the live FK.
		const existingIds = new Set(allParams(runtime, db, 'SELECT id FROM kernel_issues').map(issue => issue.id));

		const commentSql = `INSERT INTO kernel_comments (${IMPORT_COMMENT_COLUMNS.join(', ')})`
			+ ` VALUES (${IMPORT_COMMENT_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(id) DO NOTHING`;
		for (const comment of comments) {
			if (!comment || comment.id == null || !existingIds.has(comment.issue_id)) { summary.comments.skipped += 1; continue; }
			const result = runParams(runtime, db, commentSql, [
				comment.id,
				comment.issue_id,
				comment.body ?? '',
				comment.actor ?? 'beads',
				comment.visibility ?? 'local',
				comment.created_at ?? now,
			]);
			summary.comments[wasInserted(result) ? 'inserted' : 'skipped'] += 1;
		}

		const dependencySql = `INSERT INTO kernel_dependencies (${IMPORT_DEPENDENCY_COLUMNS.join(', ')})`
			+ ` VALUES (${IMPORT_DEPENDENCY_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(id) DO NOTHING`;
		for (const dependency of dependencies) {
			if (!dependency || dependency.id == null
				|| !existingIds.has(dependency.issue_id) || !existingIds.has(dependency.blocks_issue_id)) {
				summary.dependencies.skipped += 1;
				continue;
			}
			const result = runParams(runtime, db, dependencySql, [
				dependency.id,
				dependency.issue_id,
				dependency.blocks_issue_id,
				dependency.dependency_type ?? 'blocks',
				dependency.created_at ?? now,
			]);
			summary.dependencies[wasInserted(result) ? 'inserted' : 'skipped'] += 1;
		}

		// Legacy activity log → kernel_events. No entity FK, so every record inserts; the
		// deterministic id (ON CONFLICT DO NOTHING) makes re-migration idempotent.
		const eventSql = `INSERT INTO kernel_events (${IMPORT_EVENT_COLUMNS.join(', ')})`
			+ ` VALUES (${IMPORT_EVENT_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(id) DO NOTHING`;
		for (const event of activityEvents) {
			if (!event || event.id == null) { summary.events.skipped += 1; continue; }
			const row = buildImportEventRow(event, now);
			assertGenericEventNamespace(row);
			const result = runParams(runtime, db, eventSql, IMPORT_EVENT_COLUMNS.map(column => row[column]));
			summary.events[wasInserted(result) ? 'inserted' : 'skipped'] += 1;
		}

		execSql(runtime, db, 'COMMIT;');
	} catch (error) {
		try {
			execSql(runtime, db, 'ROLLBACK;');
		} catch {
			// A rollback failure must not mask the original import error.
		}
		throw error;
	}
	return summary;
}

// --- Project-memory read-model primitives -------------------------------------
// kernel_memories is a Forge read model written DIRECTLY (NOT through the guarded-event
// path), so these are plain synchronous SQL helpers. project-memory.js owns the memory
// entry shape; here we (de)serialize the JSON columns and upsert by key. The driver
// methods are synchronous so the (synchronous) project-memory facade can persist without
// awaiting the async broker.initialize().
const KERNEL_MEMORY_COLUMNS = Object.freeze([
	'key',
	'value_json',
	'source_agent',
	'scope',
	'confidence',
	'tags_json',
	'supersedes_json',
	'beads_refs_json',
	'created_at',
	'updated_at',
]);

function parseMemoryJsonColumn(raw, fallback) {
	if (raw === null || raw === undefined || raw === '') return fallback;
	try {
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
}

// Map a stored row back to the memory entry shape. Optional fields are omitted when
// unset (matches the legacy entry shape); tags and timestamp are always present. The
// entry's logical `timestamp` is the mutable "as-of" time (updated_at), so re-writing a
// key surfaces the latest write — matching the legacy single-timestamp behavior, where
// every write refreshed the stored timestamp. created_at stays as immutable first-seen
// provenance and is intentionally not part of the entry shape.
function memoryRowToEntry(row) {
	if (!row) return null;
	const entry = {
		key: row.key,
		value: parseMemoryJsonColumn(row.value_json, row.value_json),
		sourceAgent: row.source_agent,
		tags: parseMemoryJsonColumn(row.tags_json, []),
		timestamp: row.updated_at,
	};
	if (row.scope !== null && row.scope !== undefined) entry.scope = row.scope;
	if (row.confidence !== null && row.confidence !== undefined) entry.confidence = Number(row.confidence);
	const supersedes = parseMemoryJsonColumn(row.supersedes_json, undefined);
	if (Array.isArray(supersedes)) entry.supersedes = supersedes;
	const beadsRefs = parseMemoryJsonColumn(row.beads_refs_json, undefined);
	if (Array.isArray(beadsRefs)) entry.beadsRefs = beadsRefs;
	return entry;
}

function memoryEntryToRow(entry, now) {
	const tags = Array.isArray(entry.tags) ? entry.tags : [];
	return {
		key: entry.key,
		value_json: JSON.stringify(entry.value ?? null),
		source_agent: entry.sourceAgent ?? entry['source-agent'] ?? '',
		scope: entry.scope ?? null,
		confidence: entry.confidence ?? null,
		tags_json: JSON.stringify(tags),
		supersedes_json: Array.isArray(entry.supersedes) ? JSON.stringify(entry.supersedes) : null,
		beads_refs_json: Array.isArray(entry.beadsRefs) ? JSON.stringify(entry.beadsRefs) : null,
		// created_at is first-seen provenance (kept across upserts); updated_at is the
		// entry's logical timestamp (the "as-of" the read model surfaces). Both default to
		// the wall clock when the caller omits a timestamp (e.g. a direct driver write).
		created_at: entry.timestamp || now,
		updated_at: entry.timestamp || now,
	};
}

// Upsert by key: insert a fresh row, or refresh every value column on a key collision
// while keeping the original created_at (only updated_at advances).
function upsertMemoryRow(runtime, db, entry) {
	const now = new Date().toISOString();
	const row = memoryEntryToRow(entry, now);
	const placeholders = KERNEL_MEMORY_COLUMNS.map(() => '?').join(', ');
	runParams(
		runtime,
		db,
		`INSERT INTO kernel_memories (${KERNEL_MEMORY_COLUMNS.join(', ')}) VALUES (${placeholders})
			ON CONFLICT(key) DO UPDATE SET
				value_json = excluded.value_json,
				source_agent = excluded.source_agent,
				scope = excluded.scope,
				confidence = excluded.confidence,
				tags_json = excluded.tags_json,
				supersedes_json = excluded.supersedes_json,
				beads_refs_json = excluded.beads_refs_json,
				updated_at = excluded.updated_at`,
		KERNEL_MEMORY_COLUMNS.map(column => row[column]),
	);
	return memoryRowToEntry(row);
}

function loadMemoryRow(runtime, db, key) {
	const rows = allParams(runtime, db, 'SELECT * FROM kernel_memories WHERE key = ?', [key]);
	return memoryRowToEntry(rows[0] || null);
}

function listMemoryRows(runtime, db) {
	return allParams(runtime, db, 'SELECT * FROM kernel_memories ORDER BY key ASC').map(memoryRowToEntry);
}

// Token-AND LIKE search across key + value_json. Each whitespace-separated token must
// appear (in either column); an empty query lists everything. Parameterized, so the
// tokens never interpolate into SQL.
function searchMemoryRows(runtime, db, query) {
	const tokens = String(query ?? '').trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return listMemoryRows(runtime, db);
	}
	const clauses = tokens.map(() => '(key LIKE ? OR value_json LIKE ?)').join(' AND ');
	const params = tokens.flatMap(token => {
		const like = `%${token}%`;
		return [like, like];
	});
	return allParams(
		runtime,
		db,
		`SELECT * FROM kernel_memories WHERE ${clauses} ORDER BY key ASC`,
		params,
	).map(memoryRowToEntry);
}

// Optional source-agent and kind filters become one parameterized WHERE clause. This keeps
// typed recall complete even when its oldest match lies outside a broad recent-note window.
function memoryReadFilter(options = {}, table = 'kernel_memories') {
	const predicates = [];
	const params = [];
	if (options.includeSuperseded !== true) {
		predicates.push(`(COALESCE(${table}.scope, ''), ${table}.key) NOT IN (
			SELECT COALESCE(superseder.scope, ''), superseded.value
			FROM kernel_memories superseder,
				json_each(COALESCE(superseder.supersedes_json, '[]')) superseded
			WHERE superseded.type = 'text'
				AND superseder.key != superseded.value
		)`);
	}
	if (Array.isArray(options.agents) && options.agents.length > 0) {
		predicates.push(`${table}.source_agent IN (${options.agents.map(() => '?').join(', ')})`);
		params.push(...options.agents);
	}
	if (typeof options.kind === 'string' && options.kind.trim()) {
		predicates.push(`EXISTS (
			SELECT 1 FROM json_each(${table}.tags_json)
			WHERE lower(json_each.value) = ?
		)`);
		params.push(`type:${options.kind.trim().toLowerCase()}`);
	}
	return {
		clause: predicates.length > 0 ? ` WHERE ${predicates.join(' AND ')}` : '',
		params,
	};
}

// The newest `limit` entries by logical (as-of) timestamp — the default read model for
// `recall` with no query. rowid breaks ties so same-timestamp rows are still deterministic.
// Optional `agents` and `kind` filters scope the view before the limit is applied.
function recentMemoryRows(runtime, db, limit, options = {}) {
	const capped = Number.isInteger(limit) && limit > 0 ? limit : 20;
	const { clause, params } = memoryReadFilter(options);
	return allParams(
		runtime,
		db,
		`SELECT * FROM kernel_memories${clause} ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
		[...params, capped],
	).map(memoryRowToEntry);
}

// Total number of stored memories (optionally scoped by `agents` and `kind`) — paired with
// recentMemoryRows so `recall` can report "showing N of TOTAL" instead of silently truncating.
function countMemoryRows(runtime, db, options = {}) {
	const { clause, params } = memoryReadFilter(options);
	const rows = allParams(runtime, db, `SELECT count(*) AS count FROM kernel_memories${clause}`, params);
	return Number((rows[0] || {}).count) || 0;
}

// Turn a free-form query into an FTS5 MATCH expression: extract alphanumeric barewords,
// quote each as a phrase (so an FTS operator token can never break the syntax), and AND
// them together. Order-independent token-AND matching — "auth bug" matches a note holding
// both tokens in any order. Returns '' when the query has no usable tokens.
function buildMemoryFtsMatch(query) {
	const tokens = String(query ?? '').match(/[\p{L}\p{N}]+/gu);
	if (!tokens || tokens.length === 0) return '';
	return tokens.map(token => `"${token}"`).join(' AND ');
}

// Like buildMemoryFtsMatch but OR-joins the tokens: a natural-language prompt matches a note
// containing ANY of its keywords, not EVERY one. Used ONLY by the relevance-only SCORED read
// (the per-turn recall hook) — a raw prompt ("why is my forge push taking so long") token-ANDed
// required every word in one note and matched nothing (0% recall). Each token is double-quoted
// for FTS5 safety (tokens may be non-Latin unicode). Returns '' when the query has no tokens.
function buildMemoryFtsMatchOr(query) {
	const tokens = String(query ?? '').match(/[\p{L}\p{N}]+/gu);
	if (!tokens || tokens.length === 0) return '';
	return tokens.map(token => `"${token}"`).join(' OR ');
}

// BM25 top-N recall over the kernel_memories_fts index (migration 008). Joins the FTS
// rowid back to the memory row and orders by bm25 (lower = better match). An empty/tokenless
// query falls back to recent entries so `recall` never returns a bare full dump.
function searchMemoryRowsRanked(runtime, db, query, limit, options = {}) {
	const capped = Number.isInteger(limit) && limit > 0 ? limit : 20;
	const match = buildMemoryFtsMatch(query);
	if (!match) {
		return recentMemoryRows(runtime, db, capped, options);
	}
	const { clause, params } = memoryReadFilter({
		kind: options.kind,
		includeSuperseded: options.includeSuperseded,
	}, 'm');
	const kindPredicate = clause ? clause.replace(/^ WHERE /, ' AND ') : '';
	return allParams(
		runtime,
		db,
		`SELECT m.* FROM kernel_memories m
			JOIN kernel_memories_fts ON kernel_memories_fts.rowid = m.rowid
			WHERE kernel_memories_fts MATCH ?${kindPredicate}
			ORDER BY bm25(kernel_memories_fts)
			LIMIT ?`,
		[match, ...params, capped],
	).map(memoryRowToEntry);
}

// Relevance-ONLY BM25 recall that exposes the raw bm25 score on each entry. The
// per-turn auto-recall hook needs the score to apply a relevance FLOOR (inject nothing
// when nothing clears the bar) — ordinal rank can't express "nothing was relevant".
// Unlike searchMemoryRowsRanked, a no-match (or empty) query returns [] with NO recency
// fallback: the whole point is to avoid surfacing recent-but-irrelevant notes. bm25()
// returns more-negative for stronger matches, so rows come back best (lowest) first.
function confirmedMemorySql(alias) {
	return `(EXISTS (
		SELECT 1 FROM json_each(${alias}.tags_json)
		WHERE lower(json_each.value) = 'trust:confirmed'
	) OR (${alias}.source_agent = 'forge remember'
		AND json_type(${alias}.value_json) = 'text'
		AND NOT EXISTS (
			SELECT 1 FROM json_each(${alias}.tags_json)
			WHERE lower(json_each.value) LIKE 'trust:%'
				OR lower(json_each.value) = 'forge:auto-capture'
		)))`;
}

function projectMemoryScopeSql(alias) {
	return `(${alias}.scope IS NULL OR ${alias}.scope = 'project' OR ${alias}.scope = ?)`;
}

function suggestedFreshnessCutoff(now) {
	const timestamp = Date.parse(now || new Date().toISOString());
	return new Date(timestamp - (7 * 24 * 60 * 60 * 1000)).toISOString();
}

function searchMemoryRowsRankedScored(runtime, db, query, limit, options = {}) {
	const capped = Number.isInteger(limit) && limit > 0 ? limit : 20;
	// keyword-OR (NOT the token-AND of searchMemoryRowsRanked): this relevance-only read backs
	// the per-turn recall hook, where a natural-language prompt must match on ANY keyword.
	const match = buildMemoryFtsMatchOr(query);
	if (!match) {
		return [];
	}
	const projectId = options.projectId;
	if (typeof projectId !== 'string' || !projectId) return [];
	const cutoff = suggestedFreshnessCutoff(options.now);
	const excludeKeys = Array.isArray(options.excludeKeys)
		? [...new Set(options.excludeKeys.filter(key => typeof key === 'string'))].slice(0, 256)
		: [];
	const seenSql = excludeKeys.length > 0
		? `AND m.key NOT IN (${excludeKeys.map(() => '?').join(', ')})`
		: '';
	const confirmed = confirmedMemorySql('m');
	const supersederConfirmed = confirmedMemorySql('s');
	const supersessionPredicate = options.includeSuperseded === true
		? ''
		: `AND NOT EXISTS (
			SELECT 1
			FROM eligible_superseders superseder
			WHERE superseder.memory_key = m.key
			AND (superseder.is_confirmed = 1 OR NOT ${confirmed})
		)`;
	// Expand eligible supersession edges once. A correlated json_each scan repeated the
	// entire memory table for every FTS candidate and dominated the 1,000-row prompt path.
	// Recall temporarily waits less than the connection default so a real lock cannot outlive
	// the prompt hook; the finally block restores the caller's normal connection behavior.
	const previousBusyTimeout = Number(queryOne(runtime, db, 'PRAGMA busy_timeout;').timeout) || 0;
	const requestedBusyTimeout = Number(options.busyTimeoutMs);
	const busyTimeout = Number.isFinite(requestedBusyTimeout) && requestedBusyTimeout >= 0
		? Math.floor(requestedBusyTimeout)
		: Math.min(previousBusyTimeout, 2_500);
	if (busyTimeout !== previousBusyTimeout) {
		execSql(runtime, db, `PRAGMA busy_timeout=${busyTimeout};`);
	}
	try {
		return allParams(
			runtime,
			db,
			`WITH eligible_superseders AS MATERIALIZED (
				SELECT superseded.value AS memory_key,
					CASE WHEN ${supersederConfirmed} THEN 1 ELSE 0 END AS is_confirmed
				FROM kernel_memories s,
					json_each(COALESCE(s.supersedes_json, '[]')) superseded
				WHERE ${projectMemoryScopeSql('s')}
				AND (${supersederConfirmed} OR s.updated_at >= ?)
			)
			SELECT m.*, bm25(kernel_memories_fts) AS __score FROM kernel_memories m
			JOIN kernel_memories_fts ON kernel_memories_fts.rowid = m.rowid
			WHERE kernel_memories_fts MATCH ?
			AND ${projectMemoryScopeSql('m')}
			AND (${confirmed} OR m.updated_at >= ?)
			${seenSql}
			${supersessionPredicate}
			ORDER BY bm25(kernel_memories_fts),
				CASE WHEN ${confirmed} THEN 0 ELSE 1 END,
				m.source_agent ASC, m.updated_at DESC, m.key ASC
			LIMIT ?`,
			[projectId, cutoff, match, projectId, cutoff, ...excludeKeys, capped],
		).map(row => normalizeRecallHit(
			{ ...memoryRowToEntry(row), score: row.__score },
			projectId,
		));
	} finally {
		if (busyTimeout !== previousBusyTimeout) {
			execSql(runtime, db, `PRAGMA busy_timeout=${previousBusyTimeout};`);
		}
	}
}

function closeDatabase(db) {
	if (db && typeof db.close === 'function') {
		db.close();
	}
}

const WATCH_OWNER_TABLE = 'kernel_pr_watch_owners';
const WATCH_GATE_TABLE = 'kernel_pr_watch_migration_gate';
const WATCH_OWNER_SCHEMA_COLUMNS = Object.freeze([
	{ name: 'repo', type: 'TEXT', notnull: 1, pk: 1 },
	{ name: 'pr', type: 'INTEGER', notnull: 1, pk: 2 },
	{ name: 'version', type: 'INTEGER', notnull: 1, pk: 0 },
	{ name: 'generation', type: 'TEXT', notnull: 1, pk: 0 },
	{ name: 'phase', type: 'TEXT', notnull: 1, pk: 0 },
	{ name: 'controller_pid', type: 'INTEGER', notnull: 0, pk: 0 },
	{ name: 'watcher_pid', type: 'INTEGER', notnull: 0, pk: 0 },
	{ name: 'started_at', type: 'TEXT', notnull: 1, pk: 0 },
	{ name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
	{ name: 'heartbeat_at', type: 'TEXT', notnull: 0, pk: 0 },
	{ name: 'terminal_receipt_id', type: 'TEXT', notnull: 0, pk: 0 },
	{ name: 'block_reason', type: 'TEXT', notnull: 0, pk: 0 },
	{ name: 'legacy_evidence_hash', type: 'TEXT', notnull: 0, pk: 0 },
]);
const WATCH_GATE_SCHEMA_COLUMNS = Object.freeze([
	{ name: 'singleton', type: 'INTEGER', notnull: 1, pk: 1 },
	{ name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
	{ name: 'snapshot_hash', type: 'TEXT', notnull: 0, pk: 0 },
	{ name: 'conflict_code', type: 'TEXT', notnull: 0, pk: 0 },
	{ name: 'updated_at', type: 'TEXT', notnull: 1, pk: 0 },
]);

function watchOwnerStoreError(code, message, cause) {
	const error = new Error(message);
	error.code = code;
	if (cause) error.cause = cause;
	return error;
}

function assertWatchOwnerDatabasePath(databasePath, options = {}) {
	if (typeof databasePath !== 'string' || !databasePath
		|| databasePath === ':memory:' || databasePath.startsWith('file:')) {
		throw watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority requires an existing file-backed Kernel database');
	}
	const resolved = path.resolve(databasePath);
	const filesystemDeps = options.watchOwnerFilesystemDeps || {};
	const authorityFilesystemDeps = {
		...filesystemDeps,
		env: { ...(filesystemDeps.env || process.env), FORGE_KERNEL_ALLOW_UNSAFE_FS: '' },
	};
	if (path.basename(resolved) !== 'kernel.sqlite' || path.basename(path.dirname(resolved)) !== 'forge') {
		throw watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority database path is outside the canonical forge/kernel.sqlite location');
	}
	try {
		assertFilesystemSafeForKernel(resolved, authorityFilesystemDeps);
	} catch (error) {
		throw watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority database is on a refused filesystem class', error);
	}
	let stat;
	try {
		stat = fs.statSync(resolved);
	} catch (error) {
		throw watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority database does not exist', error);
	}
	if (!stat.isFile()) {
		throw watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority database is not a regular file');
	}
	let realPath;
	try {
		realPath = fs.realpathSync(resolved);
	} catch (error) {
		throw watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority database path cannot be resolved', error);
	}
	if (path.basename(realPath) !== 'kernel.sqlite' || path.basename(path.dirname(realPath)) !== 'forge') {
		throw watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority database resolves outside the canonical forge/kernel.sqlite location');
	}
	try {
		assertFilesystemSafeForKernel(realPath, authorityFilesystemDeps);
	} catch (error) {
		throw watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority database resolves through a refused filesystem class', error);
	}
	return { realPath, dev: stat.dev, ino: stat.ino };
}

function sameWatchOwnerDatabaseIdentity(expected, actual) {
	return expected.realPath === actual.realPath
		&& expected.dev === actual.dev
		&& expected.ino === actual.ino;
}

function openWatchOwnerDatabase(runtime, validated) {
	let database;
	let guard;
	try {
		// SQLite's filename constructor may create a missing file. Hold a must-exist
		// descriptor across the open so a path swap after validation fails before any
		// runtime can create or rebind the authority database.
		guard = fs.openSync(validated.realPath, 'r+');
		const guardedStat = fs.fstatSync(guard);
		if (!sameWatchOwnerDatabaseIdentity(validated, {
			realPath: validated.realPath, dev: guardedStat.dev, ino: guardedStat.ino,
		})) {
			throw new Error('authority file identity changed before open');
		}
		database = createExistingWatchOwnerDatabase(runtime, validated.realPath);
		const main = queryAll(runtime, database, 'PRAGMA database_list;')
			.find(row => row.name === 'main');
		if (!main || typeof main.file !== 'string' || !main.file) {
			throw new Error('opened database did not expose a file-backed main database');
		}
		const openedPath = path.resolve(main.file);
		const openedRealPath = fs.realpathSync(openedPath);
		const openedStat = fs.statSync(openedRealPath);
		const actual = { realPath: openedRealPath, dev: openedStat.dev, ino: openedStat.ino };
		if (!sameWatchOwnerDatabaseIdentity(validated, actual)) {
			throw new Error('opened database identity differs from the validated authority file');
		}
		return database;
	} catch (error) {
		closeDatabase(database);
		throw watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority database changed while opening', error);
	} finally {
		if (guard != null) {
			try { fs.closeSync(guard); } catch { /* preserve the open/identity result */ }
		}
	}
}

function watchOwnerBusyTimeout(options = {}) {
	const requested = Number(options.watchOwnerBusyTimeoutMs);
	if (!Number.isFinite(requested)) return 1_000;
	return Math.max(0, Math.min(5_000, Math.floor(requested)));
}

function hasExactWatchSchemaColumns(runtime, db, tableName, expectedColumns) {
	const columns = queryAll(runtime, db, `PRAGMA table_info('${tableName}')`);
	return columns.length === expectedColumns.length
		&& columns.every((column, index) => {
			const expected = expectedColumns[index];
			return column.name === expected.name
				&& String(column.type).toUpperCase() === expected.type
				&& Number(column.notnull) === expected.notnull
				&& Number(column.pk) === expected.pk;
		});
}

function hasUnexpectedWatchAuthorityTriggers(runtime, db) {
	return allParams(
		runtime,
		db,
		"SELECT name FROM sqlite_master WHERE type = 'trigger' AND lower(tbl_name) IN (?, ?)",
		[WATCH_OWNER_TABLE, WATCH_GATE_TABLE],
	).length > 0;
}

// Inbound ON DELETE CASCADE foreign keys would make abort/release delete rows
// in unrelated tables (or vice versa), so any referencing table fails closed.
// Outbound cascades declared on the authority tables themselves are equally
// forbidden: deleting a referenced parent must never erase authority rows.
function hasForbiddenWatchOwnerForeignKeys(runtime, db) {
	const tables = allParams(
		runtime,
		db,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN (?, ?)",
		[WATCH_OWNER_TABLE, WATCH_GATE_TABLE],
	);
	for (const { name } of tables) {
		const references = allParams(runtime, db, `PRAGMA foreign_key_list("${name.replace(/"/g, '""')}")`);
		if (references.some(reference => String(reference.table).toLowerCase() === WATCH_OWNER_TABLE)) return true;
	}
	for (const table of [WATCH_OWNER_TABLE, WATCH_GATE_TABLE]) {
		if (allParams(runtime, db, `PRAGMA foreign_key_list("${table}")`).length > 0) return true;
	}
	return false;
}

// Extra uniqueness constraints (e.g. UNIQUE(repo) ON CONFLICT REPLACE) let a
// later insert silently delete an earlier authority row, so anything beyond
// the migration's primary-key indexes fails closed.
function hasUnexpectedWatchAuthorityIndexes(runtime, db) {
	for (const table of [WATCH_OWNER_TABLE, WATCH_GATE_TABLE]) {
		const indexes = allParams(runtime, db, `PRAGMA index_list("${table}")`);
		if (indexes.some(index => index.origin !== 'pk')) return true;
	}
	return false;
}

function assertWatchOwnerSchema(runtime, db) {
	const rows = allParams(
		runtime,
		db,
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)",
		[WATCH_OWNER_TABLE, WATCH_GATE_TABLE],
	);
	const tables = new Set(rows.map(row => row.name));
	if (!tables.has(WATCH_OWNER_TABLE) || !tables.has(WATCH_GATE_TABLE)) {
		throw watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority schema is not initialized; run Kernel migrations');
	}
	if (!hasExactWatchSchemaColumns(runtime, db, WATCH_OWNER_TABLE, WATCH_OWNER_SCHEMA_COLUMNS)
		|| !hasExactWatchSchemaColumns(runtime, db, WATCH_GATE_TABLE, WATCH_GATE_SCHEMA_COLUMNS)
		|| hasUnexpectedWatchAuthorityTriggers(runtime, db)
		|| hasUnexpectedWatchAuthorityIndexes(runtime, db)) {
		throw watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority schema does not match the Kernel migration');
	}
	if (hasForbiddenWatchOwnerForeignKeys(runtime, db)) {
		throw watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority rows are referenced by an inbound foreign key cascade');
	}
}

const activeWatchOwnerConnections = new WeakSet();

function runWatchOwnerTransactionOnConnection(runtime, database, options, operation) {
	if (typeof operation !== 'function'
		|| operation.constructor?.name === 'AsyncFunction') {
		throw watchOwnerStoreError('INVALID_OPERATION', 'Watcher authority transactions require a synchronous operation');
	}
	if (activeWatchOwnerConnections.has(database)) {
		throw watchOwnerStoreError('INVALID_OPERATION', 'Watcher authority transaction re-entry on the same connection is forbidden');
	}
	activeWatchOwnerConnections.add(database);
	const timeout = watchOwnerBusyTimeout(options);
	let active = false;
	let committed = false;
	try {
		let previousTimeout;
		let timeoutInstalled = false;
		let result;
		let transactionError;
		let restorationError;
		try {
			previousTimeout = Number(queryOne(runtime, database, 'PRAGMA busy_timeout;').timeout) || 0;
			execSql(runtime, database, `PRAGMA busy_timeout=${timeout};`);
			timeoutInstalled = true;
			execSql(runtime, database, 'PRAGMA foreign_keys=ON;');
			execSql(runtime, database, 'BEGIN IMMEDIATE;');
			active = true;
			assertWatchOwnerSchema(runtime, database);
			result = operation(database, nestedOperation => runWatchOwnerTransactionOnConnection(
				runtime, database, options, nestedOperation,
			));
			if (result && typeof result.then === 'function') {
				throw watchOwnerStoreError('INVALID_OPERATION', 'Watcher authority transactions cannot return a thenable');
			}
			execSql(runtime, database, 'COMMIT;');
			active = false;
			committed = true;
		} catch (error) {
			if (active) rollbackTransaction(runtime, database);
			transactionError = /database is locked|SQLITE_BUSY/i.test(String(error?.message || ''))
				? watchOwnerStoreError('AUTHORITY_UNAVAILABLE', `Watcher authority remained busy after ${timeout}ms`, error)
				: error;
		} finally {
			if (timeoutInstalled) {
				try {
					execSql(runtime, database, `PRAGMA busy_timeout=${previousTimeout};`);
				} catch (error) {
					restorationError = watchOwnerStoreError('AUTHORITY_UNAVAILABLE', 'Watcher authority timeout restoration failed', error);
				}
			}
		}
		if (transactionError) throw transactionError;
		if (restorationError && !committed) throw restorationError;
		return result;
	} finally {
		activeWatchOwnerConnections.delete(database);
	}
}

function runWatchOwnerTransaction(runtime, databasePath, options, operation) {
	const validated = assertWatchOwnerDatabasePath(databasePath, options);
	const database = openWatchOwnerDatabase(runtime, validated);
	try {
		return runWatchOwnerTransactionOnConnection(runtime, database, options, operation);
	} finally {
		closeDatabase(database);
	}
}

const WATCH_OWNER_PHASES = new Set(['starting', 'running', 'stop_requested', 'terminal_pending', 'complete', 'blocked']);
const WATCH_OWNER_BLOCK_REASONS = new Set([
	'legacy_live_pid',
	'legacy_conflict',
	'legacy_unreadable',
	'legacy_lossy',
	'legacy_receipt_unverified',
]);
const WATCH_OWNER_GENERATION_OPERATIONS = new Set([
	'reserveReopened', 'bindRunning', 'heartbeat', 'requestStop', 'recordTerminal',
	'completeTerminal', 'abortStarting', 'releaseNonterminal', 'recoverDeadStarting',
	'recoverDeadWatcher', 'recheckLegacyBlocked',
]);
const WATCH_OWNER_MONOTONIC_OPERATIONS = new Set([
	'reserveReopened', 'bindRunning', 'heartbeat', 'requestStop', 'recordTerminal',
	'completeTerminal', 'recoverDeadStarting', 'recoverDeadWatcher', 'markLegacyBlocked',
	'recheckLegacyBlocked', 'importLegacyStarting', 'importLegacyComplete',
]);
const WATCH_OWNER_EVIDENCE_BOUND_OPERATIONS = new Set([
	'reserveReopened', 'recordTerminal', 'completeTerminal', 'abortStarting',
	'recoverDeadStarting', 'recoverDeadWatcher', 'markLegacyBlocked', 'recheckLegacyBlocked',
	'importLegacyStarting', 'importLegacyComplete',
]);
const WATCH_OWNER_SNAPSHOT_FIELDS = Object.freeze([
	'repo', 'pr', 'version', 'generation', 'phase', 'controller_pid', 'watcher_pid',
	'started_at', 'updated_at', 'heartbeat_at', 'terminal_receipt_id', 'block_reason',
	'legacy_evidence_hash',
]);
const WATCH_OWNER_MUTATION_FIELDS = Object.freeze([
	'repo', 'pr', 'controllerPid', 'watcherPid', 'expectedControllerPid', 'generation',
	'terminalReceiptId', 'expectedReceiptId', 'now', 'snapshotHash', 'legacyEvidenceHash',
	'blockReason', 'action', 'expectedSnapshot',
]);
const WATCH_GATE_STATES = new Set(['quarantined', 'conflict', 'complete']);
const WATCH_GATE_CONFLICT_CODES = new Set([
	'legacy_identity_unmappable',
	'legacy_snapshot_changed',
	'legacy_owner_conflict',
]);
const WATCH_REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const WATCH_SHA256 = /^[0-9a-f]{64}$/;
const WATCH_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const WATCH_OWNER_ENUMERATION_LIMIT = 4_096;
const WATCH_OWNER_ENUMERATION_BYTES = 4 * 1024 * 1024;

function watchUtf8Bytes(value) {
	return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : -1;
}

function watchTimestamp(value) {
	if (typeof value !== 'string' || watchUtf8Bytes(value) !== 24 || !WATCH_TIMESTAMP.test(value)) return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function positiveWatchPid(value) {
	return Number.isSafeInteger(value) && value > 0;
}

function boundedWatchString(value, maxBytes) {
	const bytes = watchUtf8Bytes(value);
	return typeof value === 'string' && bytes > 0 && bytes <= maxBytes;
}

function optionalWatchString(value, maxBytes) {
	return value == null || boundedWatchString(value, maxBytes);
}

function validWatchRepository(value) {
	return boundedWatchString(value, 256) && WATCH_REPOSITORY.test(value);
}

function validWatchHash(value) {
	return typeof value === 'string' && WATCH_SHA256.test(value);
}

function validWatchOwnerRow(row) {
	if (!row || row.version !== 1 || !validWatchRepository(row.repo)
		|| !Number.isSafeInteger(row.pr) || row.pr <= 0
		|| !boundedWatchString(row.generation, 128)
		|| !WATCH_OWNER_PHASES.has(row.phase) || !watchTimestamp(row.started_at)
		|| !watchTimestamp(row.updated_at) || row.updated_at < row.started_at
		|| !optionalWatchString(row.terminal_receipt_id, 256)) return false;
	const controller = row.controller_pid;
	const watcher = row.watcher_pid;
	if ((controller != null && !positiveWatchPid(controller)) || (watcher != null && !positiveWatchPid(watcher))) return false;
	if (row.heartbeat_at != null && (!watchTimestamp(row.heartbeat_at)
		|| row.heartbeat_at < row.started_at || row.heartbeat_at > row.updated_at)) return false;
	if (row.legacy_evidence_hash != null && !validWatchHash(row.legacy_evidence_hash)) return false;
	if (row.phase === 'starting') {
		return controller != null && watcher == null && row.heartbeat_at == null
			&& row.terminal_receipt_id == null && row.block_reason == null;
	}
	if (row.phase === 'running' || row.phase === 'stop_requested') {
		return controller == null && watcher != null && row.heartbeat_at != null
			&& row.terminal_receipt_id == null && row.block_reason == null;
	}
	if (row.phase === 'terminal_pending') {
		return controller == null && watcher != null && row.heartbeat_at != null
			&& row.terminal_receipt_id != null && row.block_reason == null;
	}
	if (row.phase === 'complete') {
		return controller == null && watcher == null && row.heartbeat_at == null
			&& row.terminal_receipt_id != null && row.block_reason == null;
	}
	if (!WATCH_OWNER_BLOCK_REASONS.has(row.block_reason) || row.legacy_evidence_hash == null
		|| controller != null || row.heartbeat_at != null) return false;
	return row.block_reason === 'legacy_live_pid' ? watcher != null : watcher == null;
}

function validWatchGateRow(row) {
	if (!row || row.singleton !== 1 || !WATCH_GATE_STATES.has(row.state)
		|| !watchTimestamp(row.updated_at)) return false;
	if (row.state === 'quarantined') {
		return (row.snapshot_hash == null || validWatchHash(row.snapshot_hash)) && row.conflict_code == null;
	}
	if (!validWatchHash(row.snapshot_hash)) return false;
	return row.state === 'complete'
		? row.conflict_code == null
		: WATCH_GATE_CONFLICT_CODES.has(row.conflict_code);
}

function readWatchOwnerRow(runtime, database, input) {
	return allParams(
		runtime,
		database,
		`SELECT * FROM ${WATCH_OWNER_TABLE} WHERE repo = ? AND pr = ?`,
		[input.repo, input.pr],
	)[0] || null;
}

function saveWatchOwnerRow(runtime, database, row, insert = false) {
	const columns = [
		row.repo, row.pr, row.version, row.generation, row.phase, row.controller_pid,
		row.watcher_pid, row.started_at, row.updated_at, row.heartbeat_at,
		row.terminal_receipt_id, row.block_reason, row.legacy_evidence_hash,
	];
	if (insert) {
		runParams(runtime, database, `INSERT INTO ${WATCH_OWNER_TABLE}
			(repo, pr, version, generation, phase, controller_pid, watcher_pid, started_at,
			 updated_at, heartbeat_at, terminal_receipt_id, block_reason, legacy_evidence_hash)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, columns);
		return;
	}
	runParams(runtime, database, `UPDATE ${WATCH_OWNER_TABLE} SET
		version = ?, generation = ?, phase = ?, controller_pid = ?, watcher_pid = ?,
		started_at = ?, updated_at = ?, heartbeat_at = ?, terminal_receipt_id = ?,
		block_reason = ?, legacy_evidence_hash = ? WHERE repo = ? AND pr = ?`, [
		row.version, row.generation, row.phase, row.controller_pid, row.watcher_pid,
		row.started_at, row.updated_at, row.heartbeat_at, row.terminal_receipt_id,
		row.block_reason, row.legacy_evidence_hash, row.repo, row.pr,
	]);
}

function deleteWatchOwnerRow(runtime, database, input) {
	runParams(runtime, database, `DELETE FROM ${WATCH_OWNER_TABLE} WHERE repo = ? AND pr = ?`, [input.repo, input.pr]);
}

function watchOwnerResult(ok, changed, reason, row = null) {
	return { ok, changed, reason, row };
}

function watchOwnerMismatch(current, input, phases) {
	if (!current) return 'absent';
	if (!validWatchOwnerRow(current)) return 'corrupt';
	if (input.generation != null && current.generation !== input.generation) return 'generation_mismatch';
	if (phases && ![].concat(phases).includes(current.phase)) return 'phase_mismatch';
	return null;
}

function watchOwnerUpdatedAtRegresses(operation, current, input) {
	if (!current || !WATCH_OWNER_MONOTONIC_OPERATIONS.has(operation)) return false;
	if (operation === 'recheckLegacyBlocked' && input.action === 'release') return false;
	return [current.updated_at, current.heartbeat_at]
		.filter(Boolean)
		.some(timestamp => Date.parse(input.now) < Date.parse(timestamp));
}

function sameWatchOwnerSnapshot(current, expected) {
	if (current == null || expected == null) return current == null && expected == null;
	return WATCH_OWNER_SNAPSHOT_FIELDS.every(field => Object.is(current[field], expected[field]));
}

function startingWatchOwnerRow(input, generation = randomUUID()) {
	return {
		repo: input.repo,
		pr: input.pr,
		version: 1,
		generation,
		phase: 'starting',
		controller_pid: input.controllerPid,
		watcher_pid: null,
		started_at: input.now,
		updated_at: input.now,
		heartbeat_at: null,
		terminal_receipt_id: null,
		block_reason: null,
		legacy_evidence_hash: null,
	};
}

function validWatchOwnerIdentity(input) {
	return validWatchRepository(input?.repo) && Number.isSafeInteger(input.pr) && input.pr > 0;
}

function captureWatchOwnerIdentity(input) {
	try {
		return { repo: input?.repo, pr: input?.pr };
	} catch {
		return null;
	}
}

function validWatchOwnerMutationInput(operation, input) {
	if (!validWatchOwnerIdentity(input)) return false;
	if (WATCH_OWNER_EVIDENCE_BOUND_OPERATIONS.has(operation)
		&& (!Object.prototype.hasOwnProperty.call(input, 'expectedSnapshot')
			|| input.expectedSnapshot === undefined)) return false;
	if (!['abortStarting', 'releaseNonterminal'].includes(operation) && !watchTimestamp(input.now)) return false;
	if (!['controllerPid', 'watcherPid', 'expectedControllerPid'].every(field => (
		input[field] == null || positiveWatchPid(input[field])
	))) return false;
	if (!['generation', 'terminalReceiptId', 'expectedReceiptId'].every(field => (
		input[field] == null || boundedWatchString(input[field], field === 'generation' ? 128 : 256)
	))) return false;
	if (WATCH_OWNER_GENERATION_OPERATIONS.has(operation)
		&& !boundedWatchString(input.generation, 128)) return false;
	if (!['snapshotHash', 'legacyEvidenceHash'].every(field => (
		input[field] == null || validWatchHash(input[field])
	))) return false;
	if (input.blockReason != null && !WATCH_OWNER_BLOCK_REASONS.has(input.blockReason)) return false;
	if (operation === 'recheckLegacyBlocked') {
		return ['release', 'complete'].includes(input.action);
	}
	return input.action == null || ['release', 'complete'].includes(input.action);
}

function captureWatchOwnerMutationInput(input) {
	try {
		const enumerableFields = new Set(Object.keys(input));
		const prepared = {};
		for (const field of WATCH_OWNER_MUTATION_FIELDS) {
			if (enumerableFields.has(field)) prepared[field] = input[field];
		}
		return prepared;
	} catch {
		return null;
	}
}

function copyWatchOwnerSnapshot(snapshot) {
	if (snapshot === null) return null;
	if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined;
	try {
		Object.keys(snapshot);
		const copy = {};
		for (const field of WATCH_OWNER_SNAPSHOT_FIELDS) {
			const value = snapshot[field];
			if (value !== null && !['number', 'string'].includes(typeof value)) return undefined;
			copy[field] = value;
		}
		return validWatchOwnerRow(copy) ? Object.freeze(copy) : undefined;
	} catch {
		return undefined;
	}
}

function prepareWatchOwnerMutationInput(operation, input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
	const prepared = captureWatchOwnerMutationInput(input);
	if (!prepared) return null;
	if (!validWatchOwnerMutationInput(operation, prepared)) return null;
	if (!WATCH_OWNER_EVIDENCE_BOUND_OPERATIONS.has(operation)) return Object.freeze(prepared);
	const expectedSnapshot = copyWatchOwnerSnapshot(prepared.expectedSnapshot);
	return expectedSnapshot === undefined ? null : Object.freeze({ ...prepared, expectedSnapshot });
}

function applyWatchOwnerOperation(runtime, databasePath, options, operation, rawInput) {
	const input = prepareWatchOwnerMutationInput(operation, rawInput);
	if (!input) return watchOwnerResult(false, false, 'invalid_input');
	return runWatchOwnerTransaction(runtime, databasePath, options, database => {
		const current = readWatchOwnerRow(runtime, database, input);
		if (current && !validWatchOwnerRow(current)) return watchOwnerResult(false, false, 'corrupt', current);
		if (Object.prototype.hasOwnProperty.call(input, 'expectedSnapshot')
			&& !sameWatchOwnerSnapshot(current, input.expectedSnapshot)) {
			return watchOwnerResult(false, false, 'stale_evidence', current);
		}
		if (watchOwnerUpdatedAtRegresses(operation, current, input)) {
			return watchOwnerResult(false, false, 'stale_evidence', current);
		}
		let row;
		let mismatch;
		switch (operation) {
		case 'reserveStarting':
			if (current) return watchOwnerResult(false, false, 'busy', current);
			row = startingWatchOwnerRow(input);
			if (!validWatchOwnerRow(row)) return watchOwnerResult(false, false, 'invalid_transition');
			saveWatchOwnerRow(runtime, database, row, true);
			return watchOwnerResult(true, true, 'acquired', row);
		case 'reserveReopened':
			mismatch = watchOwnerMismatch(current, input, 'complete');
			if (mismatch) return watchOwnerResult(false, false, mismatch, current);
			if (current.terminal_receipt_id !== input.expectedReceiptId) return watchOwnerResult(false, false, 'receipt_mismatch', current);
			row = { ...startingWatchOwnerRow(input), legacy_evidence_hash: current.legacy_evidence_hash };
			if (!validWatchOwnerRow(row)) return watchOwnerResult(false, false, 'invalid_transition', current);
			saveWatchOwnerRow(runtime, database, row);
			return watchOwnerResult(true, true, 'reopened', row);
		case 'bindRunning':
			if (current?.phase === 'running' && current.generation === input.generation
				&& current.watcher_pid === input.watcherPid) return watchOwnerResult(true, false, 'idempotent', current);
			mismatch = watchOwnerMismatch(current, input, 'starting');
			if (mismatch) return watchOwnerResult(false, false, mismatch, current);
			if (current.controller_pid !== input.controllerPid) return watchOwnerResult(false, false, 'controller_pid_mismatch', current);
			row = { ...current, phase: 'running', controller_pid: null, watcher_pid: input.watcherPid,
				updated_at: input.now, heartbeat_at: input.now };
			break;
		case 'heartbeat':
			mismatch = watchOwnerMismatch(current, input, ['running', 'stop_requested']);
			if (mismatch) return watchOwnerResult(false, false, mismatch, current);
			if (current.watcher_pid !== input.watcherPid) return watchOwnerResult(false, false, 'pid_mismatch', current);
			if (Date.parse(input.now) < Math.max(Date.parse(current.updated_at), Date.parse(current.heartbeat_at))) {
				return watchOwnerResult(false, false, 'stale_evidence', current);
			}
			row = { ...current, updated_at: input.now, heartbeat_at: input.now };
			break;
		case 'requestStop':
			if (current?.phase === 'stop_requested' && current.generation === input.generation
				&& current.watcher_pid === input.watcherPid) return watchOwnerResult(true, false, 'idempotent', current);
			mismatch = watchOwnerMismatch(current, input, 'running');
			if (mismatch) return watchOwnerResult(false, false, mismatch, current);
			if (current.watcher_pid !== input.watcherPid) return watchOwnerResult(false, false, 'pid_mismatch', current);
			row = { ...current, phase: 'stop_requested', updated_at: input.now };
			break;
		case 'recordTerminal':
			if (current?.phase === 'terminal_pending' && current.generation === input.generation
				&& current.watcher_pid === input.watcherPid
				&& current.terminal_receipt_id === input.terminalReceiptId) return watchOwnerResult(true, false, 'idempotent', current);
			mismatch = watchOwnerMismatch(current, input, ['running', 'stop_requested']);
			if (mismatch) return watchOwnerResult(false, false, mismatch, current);
			if (current.watcher_pid !== input.watcherPid) return watchOwnerResult(false, false, 'pid_mismatch', current);
			row = { ...current, phase: 'terminal_pending', terminal_receipt_id: input.terminalReceiptId, updated_at: input.now };
			break;
		case 'completeTerminal':
			if (current?.phase === 'complete' && current.generation === input.generation
				&& current.terminal_receipt_id === input.terminalReceiptId) return watchOwnerResult(true, false, 'idempotent', current);
			mismatch = watchOwnerMismatch(current, input, 'terminal_pending');
			if (mismatch) return watchOwnerResult(false, false, mismatch, current);
			if (current.watcher_pid !== input.watcherPid) return watchOwnerResult(false, false, 'pid_mismatch', current);
			if (current.terminal_receipt_id !== input.terminalReceiptId) return watchOwnerResult(false, false, 'receipt_mismatch', current);
			row = { ...current, phase: 'complete', watcher_pid: null, heartbeat_at: null, updated_at: input.now };
			break;
		case 'abortStarting':
			mismatch = watchOwnerMismatch(current, input, 'starting');
			if (mismatch) return watchOwnerResult(false, false, mismatch, current);
			if (current.controller_pid !== input.controllerPid) return watchOwnerResult(false, false, 'controller_pid_mismatch', current);
			deleteWatchOwnerRow(runtime, database, input);
			return watchOwnerResult(true, true, 'aborted');
		case 'releaseNonterminal':
			mismatch = watchOwnerMismatch(current, input, 'stop_requested');
			if (mismatch) return watchOwnerResult(false, false, mismatch, current);
			if (current.watcher_pid !== input.watcherPid) return watchOwnerResult(false, false, 'pid_mismatch', current);
			deleteWatchOwnerRow(runtime, database, input);
			return watchOwnerResult(true, true, 'released');
		case 'recoverDeadStarting':
			mismatch = watchOwnerMismatch(current, input, 'starting');
			if (mismatch) return watchOwnerResult(false, false, mismatch, current);
			if (current.controller_pid !== input.expectedControllerPid) return watchOwnerResult(false, false, 'controller_pid_mismatch', current);
			row = { ...startingWatchOwnerRow(input), legacy_evidence_hash: current.legacy_evidence_hash };
			break;
		case 'recoverDeadWatcher':
			mismatch = watchOwnerMismatch(current, input, ['running', 'stop_requested']);
			if (mismatch) return watchOwnerResult(false, false, mismatch, current);
			if (current.watcher_pid !== input.watcherPid) return watchOwnerResult(false, false, 'pid_mismatch', current);
			row = { ...startingWatchOwnerRow(input), legacy_evidence_hash: current.legacy_evidence_hash };
			break;
		case 'importLegacyStarting': {
			const gate = allParams(runtime, database,
				`SELECT * FROM ${WATCH_GATE_TABLE} WHERE singleton = 1`)[0] || null;
			if (!validWatchGateRow(gate)) return watchOwnerResult(false, false, gate ? 'corrupt' : 'gate_mismatch', current);
			if (gate.state !== 'quarantined' || gate.snapshot_hash !== input.snapshotHash) {
				return watchOwnerResult(false, false, 'gate_mismatch', current);
			}
			if (current) {
				const same = validWatchOwnerRow(current) && current.phase === 'starting'
					&& current.controller_pid === input.controllerPid
					&& current.legacy_evidence_hash === input.legacyEvidenceHash;
				return watchOwnerResult(same, false, same ? 'idempotent' : 'owner_conflict', current);
			}
			row = { ...startingWatchOwnerRow(input), legacy_evidence_hash: input.legacyEvidenceHash };
			if (!validWatchOwnerRow(row)) return watchOwnerResult(false, false, 'invalid_transition');
			saveWatchOwnerRow(runtime, database, row, true);
			return watchOwnerResult(true, true, 'imported', row);
		}
		case 'markLegacyBlocked':
			{
				const gate = allParams(runtime, database,
					`SELECT * FROM ${WATCH_GATE_TABLE} WHERE singleton = 1`)[0] || null;
				if (!validWatchGateRow(gate)) return watchOwnerResult(false, false, gate ? 'corrupt' : 'gate_mismatch', current);
				if (gate.state !== 'quarantined' || gate.snapshot_hash !== input.snapshotHash) {
					return watchOwnerResult(false, false, 'gate_mismatch', current);
				}
			}
			if (current) {
				const same = validWatchOwnerRow(current) && current.phase === 'blocked'
					&& current.controller_pid == null && current.watcher_pid === input.watcherPid
					&& current.terminal_receipt_id === input.terminalReceiptId
					&& current.block_reason === input.blockReason
					&& current.legacy_evidence_hash === input.legacyEvidenceHash;
				return watchOwnerResult(same, false, same ? 'idempotent' : 'owner_conflict', current);
			}
			row = { ...startingWatchOwnerRow(input), phase: 'blocked', controller_pid: null,
				watcher_pid: input.watcherPid, terminal_receipt_id: input.terminalReceiptId,
				block_reason: input.blockReason, legacy_evidence_hash: input.legacyEvidenceHash };
			if (!validWatchOwnerRow(row)) return watchOwnerResult(false, false, 'invalid_transition');
			saveWatchOwnerRow(runtime, database, row, true);
			return watchOwnerResult(true, true, 'blocked', row);
		case 'recheckLegacyBlocked':
			mismatch = watchOwnerMismatch(current, input, 'blocked');
			if (mismatch) return watchOwnerResult(false, false, mismatch, current);
			if (current.legacy_evidence_hash !== input.legacyEvidenceHash) return watchOwnerResult(false, false, 'evidence_mismatch', current);
			if ((current.block_reason === 'legacy_live_pid' || input.watcherPid != null)
				&& current.watcher_pid !== input.watcherPid) {
				return watchOwnerResult(false, false, 'pid_mismatch', current);
			}
			if (input.action === 'release') {
				if (current.block_reason !== 'legacy_live_pid') {
					return watchOwnerResult(false, false, 'invalid_transition', current);
				}
				deleteWatchOwnerRow(runtime, database, input);
				return watchOwnerResult(true, true, 'released');
			}
			row = { ...current, phase: 'complete', watcher_pid: null, heartbeat_at: null,
				terminal_receipt_id: input.terminalReceiptId, block_reason: null, updated_at: input.now };
			break;
		case 'importLegacyComplete': {
			const gate = allParams(runtime, database,
				`SELECT * FROM ${WATCH_GATE_TABLE} WHERE singleton = 1`)[0] || null;
			if (!validWatchGateRow(gate)) return watchOwnerResult(false, false, gate ? 'corrupt' : 'gate_mismatch', current);
			if (gate.state !== 'quarantined' || gate.snapshot_hash !== input.snapshotHash) {
				return watchOwnerResult(false, false, 'gate_mismatch', current);
			}
			if (current) {
				const same = validWatchOwnerRow(current) && current.phase === 'complete'
					&& current.legacy_evidence_hash === input.legacyEvidenceHash
					&& current.terminal_receipt_id === input.terminalReceiptId;
				return watchOwnerResult(same, false, same ? 'idempotent' : 'owner_conflict', current);
			}
			row = { ...startingWatchOwnerRow(input), phase: 'complete', controller_pid: null,
				terminal_receipt_id: input.terminalReceiptId, legacy_evidence_hash: input.legacyEvidenceHash };
			if (!validWatchOwnerRow(row)) return watchOwnerResult(false, false, 'invalid_transition');
			saveWatchOwnerRow(runtime, database, row, true);
			return watchOwnerResult(true, true, 'imported', row);
		}
		default:
			throw watchOwnerStoreError('INVALID_OPERATION', 'Unknown watcher authority operation');
		}
		if (!validWatchOwnerRow(row)) return watchOwnerResult(false, false, 'invalid_transition', current);
		saveWatchOwnerRow(runtime, database, row);
		return watchOwnerResult(true, true, {
			bindRunning: 'bound',
			heartbeat: 'heartbeat',
			requestStop: 'stop_requested',
			recordTerminal: 'terminal_pending',
			completeTerminal: 'complete',
			recoverDeadStarting: 'recovered',
			recoverDeadWatcher: 'recovered',
			recheckLegacyBlocked: 'complete',
		}[operation], row);
	});
}

function readWatchOwner(runtime, databasePath, options, input) {
	const identity = captureWatchOwnerIdentity(input);
	if (!identity || !validWatchOwnerIdentity(identity)) {
		return watchOwnerResult(false, false, 'invalid_input');
	}
	return runWatchOwnerTransaction(runtime, databasePath, options, database => {
		const row = readWatchOwnerRow(runtime, database, identity);
		if (!row) return watchOwnerResult(true, false, 'absent');
		return validWatchOwnerRow(row)
			? watchOwnerResult(true, false, 'read', row)
			: watchOwnerResult(false, false, 'corrupt', row);
	});
}

function listWatchOwners(runtime, databasePath, options) {
	return runWatchOwnerTransaction(runtime, databasePath, options, database => {
		const rows = allParams(runtime, database,
			`SELECT * FROM ${WATCH_OWNER_TABLE} ORDER BY repo, pr LIMIT ?`,
			[WATCH_OWNER_ENUMERATION_LIMIT + 1]);
		if (rows.length > WATCH_OWNER_ENUMERATION_LIMIT) {
			return { ok: false, changed: false, reason: 'enumeration_overflow', rows: [] };
		}
		let bytes = 0;
		for (const row of rows) {
			if (!validWatchOwnerRow(row)) return { ok: false, changed: false, reason: 'corrupt', rows: [] };
			bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
			if (bytes > WATCH_OWNER_ENUMERATION_BYTES) {
				return { ok: false, changed: false, reason: 'enumeration_overflow', rows: [] };
			}
		}
		return { ok: true, changed: false, reason: 'read', rows };
	});
}

function readWatchGate(runtime, databasePath, options) {
	return runWatchOwnerTransaction(runtime, databasePath, options, database => {
		const gate = allParams(runtime, database,
			`SELECT * FROM ${WATCH_GATE_TABLE} WHERE singleton = 1`)[0] || null;
		if (!gate) return { ok: false, changed: false, reason: 'absent', gate: null };
		return validWatchGateRow(gate)
			? { ok: true, changed: false, reason: 'read', gate }
			: { ok: false, changed: false, reason: 'corrupt', gate };
	});
}

function validWatchGateMutationInput(operation, input) {
	if (!input || !watchTimestamp(input.now)) return false;
	if (operation === 'publishQuarantine') return true;
	if (operation === 'retryConflict') {
		return validWatchHash(input.expectedSnapshotHash)
			&& WATCH_GATE_CONFLICT_CODES.has(input.expectedConflictCode)
			&& validWatchHash(input.replacementSnapshotHash)
			&& input.replacementSnapshotHash !== input.expectedSnapshotHash;
	}
	if (!validWatchHash(input.snapshotHash)) return false;
	return operation !== 'publishConflict' || WATCH_GATE_CONFLICT_CODES.has(input.conflictCode);
}

function captureWatchGateMutationInput(operation, input) {
	if (!input) return null;
	try {
		const captured = { now: input.now };
		if (operation === 'retryConflict') {
			captured.expectedSnapshotHash = input.expectedSnapshotHash;
			captured.expectedConflictCode = input.expectedConflictCode;
			captured.replacementSnapshotHash = input.replacementSnapshotHash;
		} else {
			if (operation !== 'publishQuarantine') captured.snapshotHash = input.snapshotHash;
			if (operation === 'publishConflict') captured.conflictCode = input.conflictCode;
		}
		return Object.freeze(captured);
	} catch {
		return null;
	}
}

function applyWatchGateOperation(runtime, databasePath, options, operation, input) {
	input = captureWatchGateMutationInput(operation, input);
	if (!validWatchGateMutationInput(operation, input)) {
		return { ok: false, changed: false, reason: 'invalid_input', gate: null };
	}
	return runWatchOwnerTransaction(runtime, databasePath, options, database => {
		const current = allParams(runtime, database,
			`SELECT * FROM ${WATCH_GATE_TABLE} WHERE singleton = 1`)[0] || null;
		if (current && !validWatchGateRow(current)) return { ok: false, changed: false, reason: 'corrupt', gate: current };
		if (current && input.now < current.updated_at) {
			return { ok: false, changed: false, reason: 'stale_evidence', gate: current };
		}
		if (operation === 'publishQuarantine') {
			if (current) return { ok: current.state === 'quarantined', changed: false,
				reason: current.state === 'quarantined' ? 'idempotent' : 'gate_conflict', gate: current };
			runParams(runtime, database, `INSERT INTO ${WATCH_GATE_TABLE}
				(singleton, state, snapshot_hash, conflict_code, updated_at) VALUES (1, 'quarantined', NULL, NULL, ?)`, [input.now]);
			return { ok: true, changed: true, reason: 'quarantined', gate: {
				singleton: 1, state: 'quarantined', snapshot_hash: null, conflict_code: null, updated_at: input.now,
			} };
		}
		if (!current) {
			return { ok: false, changed: false, reason: 'absent', gate: null };
		}
		if (operation === 'bindSnapshot') {
			if (current.state !== 'quarantined') return { ok: false, changed: false, reason: 'phase_mismatch', gate: current };
			if (current.snapshot_hash === input.snapshotHash) return { ok: true, changed: false, reason: 'idempotent', gate: current };
			if (current.snapshot_hash != null) return { ok: false, changed: false, reason: 'snapshot_mismatch', gate: current };
			runParams(runtime, database, `UPDATE ${WATCH_GATE_TABLE} SET snapshot_hash = ?, updated_at = ? WHERE singleton = 1`,
				[input.snapshotHash, input.now]);
			return { ok: true, changed: true, reason: 'bound', gate: { ...current, snapshot_hash: input.snapshotHash, updated_at: input.now } };
		}
		if (operation === 'publishConflict') {
			if (!WATCH_SHA256.test(input.snapshotHash) || !WATCH_GATE_CONFLICT_CODES.has(input.conflictCode)) {
				return { ok: false, changed: false, reason: 'invalid_conflict', gate: current };
			}
			if (current.state === 'conflict') {
				const idempotent = current.snapshot_hash === input.snapshotHash
					&& current.conflict_code === input.conflictCode;
				return { ok: idempotent, changed: false,
					reason: idempotent ? 'idempotent' : 'conflict_mismatch', gate: current };
			}
			if (current.state !== 'quarantined') return { ok: false, changed: false, reason: 'phase_mismatch', gate: current };
			if (current.snapshot_hash != null && current.snapshot_hash !== input.snapshotHash) {
				return { ok: false, changed: false, reason: 'snapshot_mismatch', gate: current };
			}
			runParams(runtime, database, `UPDATE ${WATCH_GATE_TABLE} SET state = 'conflict', snapshot_hash = ?, conflict_code = ?, updated_at = ? WHERE singleton = 1`,
				[input.snapshotHash, input.conflictCode, input.now]);
			return { ok: true, changed: true, reason: 'conflict', gate: { ...current, state: 'conflict', snapshot_hash: input.snapshotHash,
				conflict_code: input.conflictCode, updated_at: input.now } };
		}
		if (operation === 'retryConflict') {
			if (current.state !== 'conflict') return { ok: false, changed: false, reason: 'phase_mismatch', gate: current };
			if (current.snapshot_hash !== input.expectedSnapshotHash
				|| current.conflict_code !== input.expectedConflictCode) {
				return { ok: false, changed: false, reason: 'conflict_mismatch', gate: current };
			}
			runParams(runtime, database, `UPDATE ${WATCH_GATE_TABLE}
				SET state = 'quarantined', snapshot_hash = ?, conflict_code = NULL, updated_at = ? WHERE singleton = 1`,
			[input.replacementSnapshotHash, input.now]);
			return { ok: true, changed: true, reason: 'retry_bound', gate: {
				...current, state: 'quarantined', snapshot_hash: input.replacementSnapshotHash,
				conflict_code: null, updated_at: input.now,
			} };
		}
		if (operation === 'completeMigration') {
			if (current.state === 'complete' && current.snapshot_hash === input.snapshotHash) {
				return { ok: true, changed: false, reason: 'idempotent', gate: current };
			}
			if (current.state !== 'quarantined' || current.snapshot_hash !== input.snapshotHash) {
				return { ok: false, changed: false, reason: 'snapshot_mismatch', gate: current };
			}
			runParams(runtime, database, `UPDATE ${WATCH_GATE_TABLE} SET state = 'complete', updated_at = ? WHERE singleton = 1`, [input.now]);
			return { ok: true, changed: true, reason: 'complete', gate: { ...current, state: 'complete', updated_at: input.now } };
		}
		throw watchOwnerStoreError('INVALID_OPERATION', 'Unknown watcher migration-gate operation');
	});
}

function rollbackTransaction(runtime, db) {
	try {
		execSql(runtime, db, 'ROLLBACK;');
	} catch {
		// Preserve the original failure when SQLite has already closed the transaction.
	}
}

const MONITOR_HASH = /^[0-9a-f]{64}$/;
const MONITOR_TARGET = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MONITOR_SECRET_PATTERNS = [
	/gh[pousr]_[a-z0-9]{20,}/i,
	/github_pat_[a-z0-9_]{20,}/i,
	/sk_(?:live|test)_[a-z0-9]{16,}/i,
	/sk-[a-z0-9]{16,}/i,
	/AKIA[0-9A-Z]{16}/i,
	/(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S{8,}/i,
];
const MONITOR_MAX_TARGETS = 32;
const MONITOR_MAX_TARGET_LENGTH = 128;
const MONITOR_MAX_ENVELOPE_BYTES = 16_384;

const MONITOR_MAX_ENVELOPE_DEPTH = 8;
const MONITOR_MAX_ENVELOPE_ITEMS = 128;
const MONITOR_MAX_ENVELOPE_PROPERTIES = 64;
const MONITOR_MAX_ENVELOPE_NODES = 1_024;
const MONITOR_DEFAULT_READ_LIMIT = 128;
const MONITOR_MAX_READ_LIMIT = 4_096;

function monitorStoreError(code, message, cause) {
	const error = new Error(message, cause ? { cause } : undefined);
	error.code = code;
	return error;
}

function containsMonitorSecret(value) {
	return MONITOR_SECRET_PATTERNS.some(pattern => pattern.test(value));
}

const MONITOR_PRIVATE_PATH_ROOTS = ['users', 'home', 'root'];
const MONITOR_MAX_PRIVATE_SCAN_LENGTH = MONITOR_MAX_ENVELOPE_BYTES;

function hasNonWhitespacePathSegment(segment) {
	return Boolean(segment && segment.trim());
}

function containsMonitorPrivatePath(value) {
	if (typeof value !== 'string') return false;
	if (value.length > MONITOR_MAX_PRIVATE_SCAN_LENGTH) return true;
	const normalized = value.replaceAll('\\', '/').toLowerCase();
	for (const root of MONITOR_PRIVATE_PATH_ROOTS) {
		const marker = `/${root}/`;
		let offset = 0;
		while (true) {
			const index = normalized.indexOf(marker, offset);
			if (index < 0) break;
			const segment = normalized.slice(index + marker.length).split('/')[0];
			if (hasNonWhitespacePathSegment(segment)) return true;
			offset = index + marker.length;
		}
	}
	for (let code = 97; code <= 122; code += 1) {
		const marker = `${String.fromCharCode(code)}:/users/`;
		const index = normalized.indexOf(marker);
		if (index >= 0 && hasNonWhitespacePathSegment(
			normalized.slice(index + marker.length).split('/')[0],
		)) return true;
	}
	return false;
}

function invalidMonitorPlainData() {
	throw new Error('monitor envelope must contain only bounded plain JSON data');
}

function cloneMonitorArray(value, descriptors, keys, state, depth) {
	const length = descriptors.length?.value;
	if (!Number.isInteger(length) || length < 0 || length > MONITOR_MAX_ENVELOPE_ITEMS
		|| keys.length !== length + 1) {
		invalidMonitorPlainData();
	}
	const clone = [];
	for (let index = 0; index < length; index += 1) {
		const descriptor = descriptors[String(index)];
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalidMonitorPlainData();
		clone.push(cloneMonitorPlainData(descriptor.value, state, depth + 1));
	}
	return clone;
}

function cloneMonitorObject(descriptors, keys, state, depth) {
	const clone = Object.create(null);
	for (const key of keys) {
		const descriptor = descriptors[key];
		if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalidMonitorPlainData();
		clone[key] = cloneMonitorPlainData(descriptor.value, state, depth + 1);
	}
	return clone;
}

function cloneMonitorPlainData(value, state, depth = 0) {
	const traversal = state || { ancestors: new WeakSet(), nodes: 0 };
	traversal.nodes += 1;
	if (traversal.nodes > MONITOR_MAX_ENVELOPE_NODES || depth > MONITOR_MAX_ENVELOPE_DEPTH) {
		invalidMonitorPlainData();
	}
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) invalidMonitorPlainData();
		return value;
	}
	if (typeof value !== 'object' || isProxy(value) || traversal.ancestors.has(value)) {
		invalidMonitorPlainData();
	}

	let prototype;
	let descriptors;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		invalidMonitorPlainData();
	}
	const keys = Reflect.ownKeys(descriptors);
	if (keys.some(key => typeof key !== 'string' || key === 'toJSON')) invalidMonitorPlainData();

	traversal.ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (prototype !== Array.prototype) invalidMonitorPlainData();
			return cloneMonitorArray(value, descriptors, keys, traversal, depth);
		}

		if ((prototype !== Object.prototype && prototype !== null)
			|| keys.length > MONITOR_MAX_ENVELOPE_PROPERTIES) {
			invalidMonitorPlainData();
		}
		return cloneMonitorObject(descriptors, keys, traversal, depth);
	} finally {
		traversal.ancestors.delete(value);
	}
}

function containsPrivateMonitorData(value) {
	if (typeof value === 'string') {
		return containsMonitorSecret(value) || containsMonitorPrivatePath(value);
	}
	if (!value || typeof value !== 'object') return false;
	return Object.entries(value).some(([key, nestedValue]) => (
		containsMonitorSecret(key)
		|| containsMonitorPrivatePath(key)
		|| containsPrivateMonitorData(nestedValue)
	));
}

function assertMonitorEnvelope(envelope, schemaId) {
	const plainEnvelope = cloneMonitorPlainData(envelope);
	const serialized = JSON.stringify(plainEnvelope);
	const safeEnvelope = JSON.parse(serialized);
	if (containsPrivateMonitorData(safeEnvelope)) {
		throw new Error(`private content rejected from ${schemaId}`);
	}
	const payload = safeEnvelope?.payload;
	const validCommon = safeEnvelope?.schema_id === schemaId
		&& MONITOR_HASH.test(safeEnvelope?.content_hash)
		&& typeof safeEnvelope?.created_at === 'string'
		&& payload && typeof payload === 'object' && !Array.isArray(payload);
	let validPayload = false;
	if (schemaId === 'forge.memory.monitor-event.v1') {
		validPayload = typeof payload?.monitor_id === 'string' && payload.monitor_id.length > 0
			&& typeof payload?.event_id === 'string' && payload.event_id.length > 0
			&& Number.isInteger(payload?.sequence) && payload.sequence >= 0;
	} else if (schemaId === 'forge.memory.delivery-receipt.v1') {
		validPayload = typeof payload?.event_id === 'string' && payload.event_id.length > 0
			&& Number.isInteger(payload?.attempt) && payload.attempt > 0;
	} else if (schemaId === 'forge.memory.monitor-receipt.v1') {
		validPayload = typeof payload?.monitor_id === 'string' && payload.monitor_id.length > 0
			&& Number.isInteger(payload?.last_sequence) && payload.last_sequence >= 0;
	}
	if (!validCommon || !validPayload || Buffer.byteLength(serialized, 'utf8') > MONITOR_MAX_ENVELOPE_BYTES) {
		throw new Error(`invalid ${schemaId.replace('forge.memory.', '').replace('.v1', '').replaceAll('-', ' ')} envelope`);
	}
	return safeEnvelope;
}

function assertMonitorTarget(target) {
	if (typeof target !== 'string' || target.length === 0 || target.length > MONITOR_MAX_TARGET_LENGTH
		|| !MONITOR_TARGET.test(target) || containsMonitorSecret(target) || containsMonitorPrivatePath(target)) {
		throw new Error('invalid or private monitor delivery target');
	}
	return target;
}

function normalizeMonitorTargets(targets) {
	if (!Array.isArray(targets) || targets.length === 0 || targets.length > MONITOR_MAX_TARGETS) {
		throw new Error(`monitor delivery targets must contain 1-${MONITOR_MAX_TARGETS} entries`);
	}
	return [...new Set(targets.map(assertMonitorTarget))];
}

function compareMonitorTargets(left, right) {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function assertMonitorWriterEnabled(runtime, db, config = {}) {
	if (config.monitorDurabilityEnabled === false) {
		throw monitorStoreError('MONITOR_UNAVAILABLE', 'Monitor durability writers are disabled; retained evidence remains readable');
	}
	let row;
	try {
		row = allParams(runtime, db,
			'SELECT enabled FROM memory_monitor_writer_state WHERE singleton = 1')[0];
	} catch (error) {
		if (/no such table/i.test(String(error?.message || ''))) {
			throw monitorStoreError('MONITOR_UNAVAILABLE', 'Monitor durability schema is not initialized; run Kernel migrations', error);
		}
		throw error;
	}
	if (Number(row?.enabled) !== 1) {
		throw monitorStoreError('MONITOR_UNAVAILABLE', 'Monitor durability writers are disabled; retained evidence remains readable');
	}
}

function monitorBusyTimeout(config = {}) {
	const requested = Number(config.monitorBusyTimeoutMs);
	if (!Number.isFinite(requested)) return 1_000;
	return Math.max(0, Math.min(5_000, Math.floor(requested)));
}

function runMonitorTransaction(runtime, db, config, operation) {
	const timeout = monitorBusyTimeout(config);
	const previousTimeout = Number(queryOne(runtime, db, 'PRAGMA busy_timeout;').timeout) || 0;
	execSql(runtime, db, `PRAGMA busy_timeout=${timeout};`);
	let active = false;
	try {
		execSql(runtime, db, 'BEGIN IMMEDIATE;');
		active = true;
		const result = operation();
		execSql(runtime, db, 'COMMIT;');
		active = false;
		return result;
	} catch (error) {
		if (active) rollbackTransaction(runtime, db);
		if (/database is locked|SQLITE_BUSY/i.test(String(error?.message || ''))) {
			throw monitorStoreError('MONITOR_UNAVAILABLE', `Monitor durability write remained busy after ${timeout}ms`, error);
		}
		throw error;
	} finally {
		execSql(runtime, db, `PRAGMA busy_timeout=${previousTimeout};`);
	}
}

function monitorEventRow(envelope) {
	const payload = envelope.payload || {};
	return {
		event_id: payload.event_id,
		monitor_id: payload.monitor_id,
		sequence: payload.sequence,
		content_hash: envelope.content_hash,
		envelope_json: JSON.stringify(envelope),
		artifact_digest: payload.artifact_digest ?? null,
		created_at: envelope.created_at,
	};
}

function appendMonitorEventRow(runtime, db, envelope, targets, config) {
	const row = monitorEventRow(envelope);
	return runMonitorTransaction(runtime, db, config, () => {
		assertMonitorWriterEnabled(runtime, db, config);
		const existingById = allParams(runtime, db,
			'SELECT event_id, monitor_id, sequence, content_hash FROM memory_monitor_events WHERE event_id = ?', [row.event_id])[0];
		const existingBySequence = allParams(runtime, db,
			'SELECT event_id, monitor_id, sequence, content_hash FROM memory_monitor_events WHERE monitor_id = ? AND sequence = ?', [row.monitor_id, row.sequence])[0];
		const existing = existingById || existingBySequence;
		if (existing) {
			if (existing.content_hash !== row.content_hash) throw monitorStoreError('MONITOR_EVENT_CONFLICT', 'monitor event conflict: immutable identity has different content_hash');
			const storedTargets = allParams(runtime, db,
				'SELECT target FROM memory_monitor_outbox WHERE event_id = ? ORDER BY target ASC', [existing.event_id])
				.map(entry => entry.target);
			const replayTargets = [...targets].sort(compareMonitorTargets);
			if (storedTargets.length !== replayTargets.length
				|| storedTargets.some((target, index) => target !== replayTargets[index])) {
				throw monitorStoreError('MONITOR_TARGET_SET_CONFLICT', 'monitor event target set conflict: identical event replay changed delivery targets');
			}
			return { idempotent: true, event_id: existing.event_id, monitor_id: existing.monitor_id, sequence: existing.sequence };
		}
		const terminalReceipt = allParams(runtime, db,
			'SELECT monitor_id FROM memory_monitor_receipts WHERE monitor_id = ?', [row.monitor_id])[0];
		if (terminalReceipt) throw monitorStoreError('MONITOR_TERMINAL', 'monitor already has a terminal receipt');

		runParams(runtime, db,
			`INSERT INTO memory_monitor_events
				(event_id, monitor_id, sequence, content_hash, envelope_json, artifact_digest, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[row.event_id, row.monitor_id, row.sequence, row.content_hash, row.envelope_json, row.artifact_digest, row.created_at]);
		for (const target of targets) {
			runParams(runtime, db,
				`INSERT INTO memory_monitor_outbox
					(id, event_id, target, status, attempts, next_attempt_at, created_at)
				 VALUES (?, ?, ?, 'pending', 0, NULL, ?)`,
				[randomUUID(), row.event_id, target, row.created_at]);
		}
		return { idempotent: false, event_id: row.event_id, monitor_id: row.monitor_id, sequence: row.sequence };
	});
}

function recordMonitorDeliveryReceiptRow(runtime, db, envelope, config) {
	const payload = envelope.payload || {};
	const row = {
		event_id: payload.event_id,
		target: payload.target,
		attempt: payload.attempt,
		content_hash: envelope.content_hash,
		envelope_json: JSON.stringify(envelope),
		acknowledged: payload.acknowledged ? 1 : 0,
		delivered_at: payload.delivered_at,
		outcome: payload.outcome,
	};
	return runMonitorTransaction(runtime, db, config, () => {
		assertMonitorWriterEnabled(runtime, db, config);
		const existing = allParams(runtime, db,
			`SELECT content_hash FROM memory_monitor_delivery_receipts
			 WHERE event_id = ? AND target = ? AND attempt = ?`, [row.event_id, row.target, row.attempt])[0];
		if (existing) {
			if (existing.content_hash !== row.content_hash) throw monitorStoreError('MONITOR_DELIVERY_CONFLICT', 'monitor delivery receipt conflict: attempt has different content_hash');
			return { idempotent: true, event_id: row.event_id, target: row.target, attempt: row.attempt };
		}
		const event = allParams(runtime, db,
			'SELECT monitor_id, sequence FROM memory_monitor_events WHERE event_id = ?', [row.event_id])[0];
		if (!event) throw monitorStoreError('MONITOR_DELIVERY_CONFLICT', 'monitor delivery receipt references an unknown event');
		const outbox = allParams(runtime, db,
			'SELECT id FROM memory_monitor_outbox WHERE event_id = ? AND target = ?', [row.event_id, row.target])[0];
		if (!outbox) throw monitorStoreError('MONITOR_DELIVERY_CONFLICT', 'monitor delivery receipt references an unplanned target');
		if (row.acknowledged) {
			const cursor = allParams(runtime, db,
				'SELECT sequence FROM memory_monitor_cursors WHERE monitor_id = ? AND target = ?',
				[event.monitor_id, row.target])[0];
			if (cursor && event.sequence < Number(cursor.sequence)) {
				throw monitorStoreError('MONITOR_STALE_CURSOR', 'stale monitor delivery cursor: acknowledged sequence is behind the durable cursor');
			}
		}

		runParams(runtime, db,
			`INSERT INTO memory_monitor_delivery_receipts
				(event_id, target, attempt, content_hash, envelope_json, acknowledged, delivered_at, outcome)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[row.event_id, row.target, row.attempt, row.content_hash, row.envelope_json, row.acknowledged, row.delivered_at, row.outcome]);
		if (row.acknowledged) {
			runParams(runtime, db,
				`INSERT INTO memory_monitor_cursors (monitor_id, target, sequence, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(monitor_id, target) DO UPDATE SET
					sequence = excluded.sequence,
					updated_at = excluded.updated_at
				 WHERE excluded.sequence > memory_monitor_cursors.sequence`,
				[event.monitor_id, row.target, event.sequence, row.delivered_at]);
			runParams(runtime, db,
				"UPDATE memory_monitor_outbox SET status = 'acknowledged', attempts = attempts + 1, next_attempt_at = NULL WHERE id = ?",
				[outbox.id]);
		}
		return { idempotent: false, event_id: row.event_id, target: row.target, attempt: row.attempt, acknowledged: Boolean(row.acknowledged) };
	});
}

function recordMonitorTerminalReceiptRow(runtime, db, envelope, config) {
	const payload = envelope.payload || {};
	const row = {
		monitor_id: payload.monitor_id,
		content_hash: envelope.content_hash,
		envelope_json: JSON.stringify(envelope),
		owner_run_id: payload.owner_run_id,
		terminal_state: payload.terminal_state,
		last_sequence: payload.last_sequence,
		evidence_digest: payload.evidence_digest,
		undelivered_cursor: payload.undelivered_cursor ?? null,
		created_at: envelope.created_at,
	};
	return runMonitorTransaction(runtime, db, config, () => {
		assertMonitorWriterEnabled(runtime, db, config);
		const existing = allParams(runtime, db,
			'SELECT content_hash FROM memory_monitor_receipts WHERE monitor_id = ?', [row.monitor_id])[0];
		if (existing) {
			if (existing.content_hash !== row.content_hash) throw monitorStoreError('MONITOR_RECEIPT_CONFLICT', 'monitor receipt conflict: terminal evidence has different content_hash');
			return { idempotent: true, monitor_id: row.monitor_id };
		}
		const eventState = allParams(runtime, db,
			'SELECT COUNT(*) AS event_count, MAX(sequence) AS max_sequence FROM memory_monitor_events WHERE monitor_id = ?',
			[row.monitor_id])[0];
		const expectedLastSequence = Number(eventState.event_count) === 0 ? 0 : Number(eventState.max_sequence);
		if (row.last_sequence !== expectedLastSequence) {
			throw monitorStoreError('MONITOR_STALE_TERMINAL', 'stale monitor terminal sequence: last_sequence does not match durable events');
		}
		runParams(runtime, db,
			`INSERT INTO memory_monitor_receipts
				(monitor_id, content_hash, envelope_json, owner_run_id, terminal_state, last_sequence, evidence_digest, undelivered_cursor, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[row.monitor_id, row.content_hash, row.envelope_json, row.owner_run_id, row.terminal_state, row.last_sequence, row.evidence_digest, row.undelivered_cursor, row.created_at]);
		return { idempotent: false, monitor_id: row.monitor_id };
	});
}

function monitorReadLimit(options = {}, fallback = MONITOR_DEFAULT_READ_LIMIT) {
	const requested = options.limit ?? fallback;
	if (!Number.isSafeInteger(requested) || requested < 1 || requested > MONITOR_MAX_READ_LIMIT) {
		throw new TypeError(`monitor read limit must be an integer from 1 to ${MONITOR_MAX_READ_LIMIT}`);
	}
	return requested;
}

function getMonitorEventRow(runtime, db, eventId) {
	return allParams(
		runtime,
		db,
		`SELECT event_id, monitor_id, sequence, content_hash, envelope_json, artifact_digest, created_at
		 FROM memory_monitor_events WHERE event_id = ? LIMIT 1`,
		[eventId],
	)[0] || null;
}

function listMonitorEventRows(runtime, db, monitorId) {
	return allParams(
		runtime,
		db,
		`SELECT event_id, monitor_id, sequence, content_hash, envelope_json, artifact_digest, created_at
		 FROM memory_monitor_events WHERE monitor_id = ? ORDER BY sequence ASC, event_id ASC`,
		[monitorId],
	);
}

function readMonitorEventTailRows(runtime, db, monitorId, options = {}) {
	const limit = monitorReadLimit(options);
	const selected = allParams(
		runtime,
		db,
		`SELECT event_id, monitor_id, sequence, content_hash, envelope_json, artifact_digest, created_at
		 FROM memory_monitor_events WHERE monitor_id = ?
		 ORDER BY sequence DESC, event_id DESC LIMIT ?`,
		[monitorId, limit + 1],
	);
	const overflow = selected.length > limit;
	const events = selected.slice(0, limit).reverse();
	return {
		events,
		overflow,
		truncated_before_sequence: overflow && events.length > 0 ? Number(events[0].sequence) : null,
	};
}

function readMonitorDeliveryStateRows(runtime, db, monitorId, options = {}) {
	const limit = monitorReadLimit(options);
	const cursorRows = allParams(
		runtime,
		db,
		`SELECT monitor_id, target, sequence, updated_at FROM memory_monitor_cursors
		 WHERE monitor_id = ? ORDER BY target ASC LIMIT ?`,
		[monitorId, limit + 1],
	);
	const outboxRows = allParams(
		runtime,
		db,
		`SELECT o.id AS outbox_id, o.event_id, e.monitor_id, e.sequence, o.target,
			o.status, o.attempts, o.next_attempt_at, o.created_at
		 FROM memory_monitor_outbox o
		 JOIN memory_monitor_events e ON e.event_id = o.event_id
		 WHERE e.monitor_id = ?
		 ORDER BY e.sequence ASC, o.target ASC, o.id ASC LIMIT ?`,
		[monitorId, limit + 1],
	);
	const terminalReceipt = allParams(
		runtime,
		db,
		`SELECT monitor_id, content_hash, envelope_json, owner_run_id, terminal_state,
			last_sequence, evidence_digest, undelivered_cursor, created_at
		 FROM memory_monitor_receipts WHERE monitor_id = ? LIMIT 1`,
		[monitorId],
	)[0] || null;
	return {
		cursors: cursorRows.slice(0, limit),
		outbox: outboxRows.slice(0, limit),
		terminal_receipt: terminalReceipt,
		overflow: {
			cursors: cursorRows.length > limit,
			outbox: outboxRows.length > limit,
		},
	};
}

const CLAIM_REPAIR_INDEX_NAMES = Object.freeze([
	'idx_kernel_claims_active_lease',
	'idx_kernel_claims_actor_state',
	'idx_kernel_claims_issue_state',
]);
const CLAIM_REPAIR_AUTHORITY_ROWID_TABLES = new Set([
	'kernel_events',
	'kernel_memories',
	'kernel_stage_runs',
	'kernel_worktrees',
]);

function quoteSqlIdentifier(value) {
	return `"${String(value).replaceAll('"', '""')}"`;
}

function loadCompleteAuthoritySnapshot(runtime, db, guardedRead) {
	const schema = guardedRead(
		'authority_schema',
		() => allParams(
			runtime,
			db,
			`SELECT type, name, tbl_name, sql FROM sqlite_master
			 WHERE name NOT LIKE 'sqlite_%' ORDER BY type ASC, name ASC`,
		),
	);
	const tables = schema
		.filter(row => row.type === 'table')
		.map(row => ({
			name: row.name,
			rows: guardedRead(
				`authority_table:${row.name}`,
				() => allParams(
					runtime,
					db,
					`SELECT ${CLAIM_REPAIR_AUTHORITY_ROWID_TABLES.has(row.name) ? 'rowid AS __forge_rowid, ' : ''}* FROM ${quoteSqlIdentifier(row.name)}`,
				),
			),
		}));
	return { schema, tables };
}

function loadLegacyClaimRepairSnapshot(runtime, db) {
	const readErrors = [];
	const guardedRead = (label, read, fallback = []) => {
		try {
			return read();
		} catch {
			readErrors.push(label);
			return fallback;
		}
	};
	const integrityRows = guardedRead('integrity_check', () => queryAll(runtime, db, 'PRAGMA integrity_check;'));
	const foreignKeyState = guardedRead('foreign_keys', () => queryOne(runtime, db, 'PRAGMA foreign_keys;'), {});
	const foreignKeyFaults = guardedRead('foreign_key_check', () => queryAll(runtime, db, 'PRAGMA foreign_key_check;'));
	const claimColumns = guardedRead('claim_columns', () => queryAll(runtime, db, "PRAGMA table_info('kernel_claims');"));
	const issueColumns = guardedRead('issue_columns', () => queryAll(runtime, db, "PRAGMA table_info('kernel_issues');"));
	const claimForeignKeys = guardedRead('claim_foreign_keys', () => queryAll(runtime, db, "PRAGMA foreign_key_list('kernel_claims');"));
	const indexList = guardedRead('claim_indexes', () => queryAll(runtime, db, "PRAGMA index_list('kernel_claims');"));
	const indexSqlRows = guardedRead(
		'claim_index_sql',
		() => allParams(runtime, db, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'kernel_claims'"),
	);
	const indexSql = new Map(indexSqlRows.map(row => [row.name, row.sql]));
	const indexByName = new Map(indexList.map(row => [row.name, row]));
	const claimIndexes = CLAIM_REPAIR_INDEX_NAMES.map(name => {
		const index = indexByName.get(name) || {};
		const columns = guardedRead(
			`index_columns:${name}`,
			() => queryAll(runtime, db, `PRAGMA index_info('${name}');`),
		);
		return {
			name,
			columns: columns.map(row => row.name),
			unique: Number(index.unique) === 1,
			partial: Number(index.partial) === 1,
			sql: indexSql.get(name) || '',
		};
	});
	const issues = guardedRead(
		'issues',
		() => allParams(runtime, db, 'SELECT id, status, type FROM kernel_issues ORDER BY id ASC'),
	);
	const claims = guardedRead(
		'claims',
		() => allParams(
			runtime,
			db,
			`SELECT id, issue_id, actor, state, session_id, worktree_id, claimed_at, expires_at
			 FROM kernel_claims ORDER BY id ASC`,
		),
	);
	const authority = loadCompleteAuthoritySnapshot(runtime, db, guardedRead);
	return {
		integrity: integrityRows.length > 0
			&& integrityRows.every(row => String(row.integrity_check || '').toLowerCase() === 'ok')
			? 'ok'
			: 'failed',
		foreign_keys_enabled: Number(foreignKeyState.foreign_keys) === 1,
		foreign_key_faults: foreignKeyFaults.length,
		claim_columns: claimColumns.map(row => row.name),
		issue_columns: issueColumns.map(row => row.name),
		claim_foreign_keys: claimForeignKeys.map(row => ({ table: row.table, from: row.from, to: row.to })),
		claim_indexes: claimIndexes,
		issues,
		claims,
		authority_schema: authority.schema,
		authority_tables: authority.tables,
		read_errors: readErrors,
	};
}

function preflightLegacyClaimRepairRow(runtime, db, input = {}) {
	const snapshot = loadLegacyClaimRepairSnapshot(runtime, db);
	return publicClaimRepairPreflight(buildClaimRepairPlan(snapshot, input));
}

function assertClaimRepairApplyInput(input = {}) {
	const approvedDigest = input.approvedDigest;
	const proof = input.backupProof;
	if (!/^[0-9a-f]{64}$/.test(String(approvedDigest || ''))) {
		throw new ClaimRepairError('CLAIM_REPAIR_APPROVAL_REQUIRED', 'Apply requires the exact approved preflight digest');
	}
	if (proof?.schema_version !== 'forge.claim-repair.backup-proof.v1'
		|| proof.integrity !== 'ok'
		|| proof.plan_digest !== approvedDigest
		|| proof.restore_digest !== approvedDigest
		|| !/^[0-9a-f]{64}$/.test(String(proof.backup_sha256 || ''))) {
		throw new ClaimRepairError(
			'CLAIM_REPAIR_BACKUP_PROOF_REQUIRED',
			'Apply requires a verified separate backup restored from the exact approved snapshot',
		);
	}
	if (typeof input.actor !== 'string' || input.actor.trim() === '') {
		throw new ClaimRepairError('CLAIM_REPAIR_ACTOR_REQUIRED', 'Apply requires an explicit operator actor');
	}
}

function parseStoredClaimRepairReceipt(row, approvedDigest, backupProof = null) {
	if (!row) return null;
	let receipt;
	try {
		receipt = JSON.parse(row.payload_json);
	} catch {
		throw new ClaimRepairError('CLAIM_REPAIR_RECEIPT_INVALID', 'Stored claim repair receipt is malformed');
	}
	if (receipt?.schema_version !== 'forge.claim-repair.receipt.v1'
		|| row.id !== receipt.receipt_id
		|| row.entity_type !== 'claim_repair'
		|| row.entity_id !== 'legacy_claims'
		|| row.event_type !== 'claim.repair'
		|| row.origin !== 'forge.claim-repair'
		|| receipt.approved_digest !== approvedDigest
		|| (backupProof && receipt.backup_sha256 !== backupProof.backup_sha256)
		|| !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(receipt.recovery_ref || ''))
		|| !/^[0-9a-f]{64}$/.test(String(receipt.backup_sha256 || ''))
		|| !/^[0-9a-f]{64}$/.test(String(receipt.after_digest || ''))) {
		throw new ClaimRepairError('CLAIM_REPAIR_RECEIPT_INVALID', 'Stored claim repair receipt does not match the approved proof');
	}
	return receipt;
}

function claimRepairRecoveryPath(backupPath, recoveryReference) {
	return `${backupPath}.forge-recovery-${recoveryReference}`;
}

function attachClaimRepairRecoveryPath(receipt, backupPath) {
	if (!receipt || typeof backupPath !== 'string' || !path.isAbsolute(backupPath)) return receipt;
	return {
		...receipt,
		recovery_path: claimRepairRecoveryPath(backupPath, receipt.recovery_ref),
	};
}

function replayStoredClaimRepairReceipt(runtime, db, approvedDigest, observedAt, backupPath) {
	if (!/^[0-9a-f]{64}$/.test(String(approvedDigest || ''))) return null;
	const existingRow = allParams(
		runtime,
		db,
		'SELECT * FROM kernel_events WHERE idempotency_key = ? LIMIT 1',
		[`claim.repair:${approvedDigest}`],
	)[0];
	const receipt = parseStoredClaimRepairReceipt(existingRow, approvedDigest);
	if (receipt && receipt.observed_at !== observedAt) {
		throw new ClaimRepairError('CLAIM_REPAIR_RECEIPT_INVALID', 'Stored claim repair receipt does not match the fixed observation time');
	}
	return receipt
		? attachClaimRepairRecoveryPath({ ...receipt, replayed: true }, backupPath)
		: null;
}

function claimRepairSourceIdentities(databasePath) {
	return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]
		.filter(sourcePath => fs.existsSync(sourcePath))
		.map(sourcePath => {
			const stat = fs.statSync(sourcePath);
			return { device: stat.dev, inode: stat.ino };
		});
}

function assertNoClaimRepairBackupSidecars(backupPath) {
	for (const suffix of ['-wal', '-shm', '-journal']) {
		if (fs.existsSync(`${backupPath}${suffix}`)) throw new Error('backup sidecar exists');
	}
}

function hashOpenFileDescriptor(fileDescriptor) {
	const hash = createHash('sha256');
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let offset = 0;
	for (;;) {
		const bytesRead = fs.readSync(fileDescriptor, buffer, 0, buffer.length, offset);
		if (bytesRead === 0) break;
		hash.update(buffer.subarray(0, bytesRead));
		offset += bytesRead;
	}
	return hash.digest('hex');
}

function copyOpenFileDescriptor(sourceDescriptor, destinationDescriptor) {
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let offset = 0;
	for (;;) {
		const bytesRead = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, offset);
		if (bytesRead === 0) break;
		let written = 0;
		while (written < bytesRead) {
			const bytesWritten = fs.writeSync(
				destinationDescriptor,
				buffer,
				written,
				bytesRead - written,
				offset + written,
			);
			if (bytesWritten <= 0) throw new Error('recovery copy write made no progress');
			written += bytesWritten;
		}
		offset += bytesRead;
	}
	fs.fsyncSync(destinationDescriptor);
}

function syncClaimRepairRecoveryDirectory(recoveryPath, options = {}) {
	const platform = options.platform || process.platform;
	if (platform === 'win32') return;
	const fsApi = options.fsApi || fs;
	let directoryDescriptor;
	try {
		directoryDescriptor = fsApi.openSync(path.dirname(recoveryPath), 'r');
		fsApi.fsyncSync(directoryDescriptor);
	} finally {
		if (directoryDescriptor !== undefined) fsApi.closeSync(directoryDescriptor);
	}
}

async function verifyClaimRepairRecovery(receipt, backupPath, databasePath, options = {}) {
	const recoveryPath = claimRepairRecoveryPath(backupPath, receipt.recovery_ref);
	let fileDescriptor;
	try {
		await (options.hardenPath || hardenBackupPermissions)(recoveryPath);
		const sourceIdentities = claimRepairSourceIdentities(databasePath);
		const backupIdentity = fs.existsSync(backupPath) ? fs.statSync(backupPath) : null;
		fileDescriptor = fs.openSync(recoveryPath, 'r');
		const before = fs.fstatSync(fileDescriptor);
		const digest = hashOpenFileDescriptor(fileDescriptor);
		const after = fs.fstatSync(fileDescriptor);
		const named = fs.statSync(recoveryPath);
		if (digest !== receipt.backup_sha256
			|| before.size !== after.size
			|| before.mtimeMs !== after.mtimeMs
			|| named.dev !== before.dev
			|| named.ino !== before.ino
			|| (backupIdentity && backupIdentity.dev === before.dev && backupIdentity.ino === before.ino)
			|| sourceIdentities.some(source => source.device === before.dev && source.inode === before.ino)) {
			throw new Error('recovery copy changed');
		}
		return recoveryPath;
	} catch {
		throw new ClaimRepairError(
			'CLAIM_REPAIR_RECOVERY_INVALID',
			'Retained claim-repair recovery copy is missing, unsafe, or changed',
		);
	} finally {
		if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
	}
}

async function openClaimRepairBackupFence(databasePath, backupPath, backupProof, recoveryReference, options = {}) {
	let fileDescriptor;
	let recoveryFileDescriptor;
	let recoveryPath;
	try {
		const hardenPath = options.hardenPath || hardenBackupPermissions;
		const hardenPaths = options.hardenPaths;
		await hardenPath(backupPath);
		assertSafeBackupDestination(databasePath, backupPath);
		assertNoClaimRepairBackupSidecars(backupPath);
		const sourceIdentities = claimRepairSourceIdentities(databasePath);
		fileDescriptor = fs.openSync(backupPath, 'r');
		const before = fs.fstatSync(fileDescriptor);
		if (sourceIdentities.some(source => source.device === before.dev && source.inode === before.ino)) {
			throw new Error('pinned backup aliases source');
		}
		const digest = hashOpenFileDescriptor(fileDescriptor);
		const after = fs.fstatSync(fileDescriptor);
		const named = fs.statSync(backupPath);
		if (digest !== backupProof.backup_sha256
			|| before.size !== after.size
			|| before.mtimeMs !== after.mtimeMs
			|| before.dev !== named.dev
			|| before.ino !== named.ino) {
			throw new Error('backup identity or content changed');
		}
		recoveryPath = claimRepairRecoveryPath(backupPath, recoveryReference);
		recoveryFileDescriptor = fs.openSync(recoveryPath, 'wx+', 0o600);
		// The backup was hardened before opening its descriptor; harden the retained
		// copy in the same Windows PowerShell pass before copying any bytes.
		if (typeof hardenPaths === 'function') await hardenPaths([backupPath, recoveryPath]);
		else {
			await hardenPath(backupPath);
			await hardenPath(recoveryPath);
		}
		copyOpenFileDescriptor(fileDescriptor, recoveryFileDescriptor);
		syncClaimRepairRecoveryDirectory(recoveryPath);
		const sourceAfterCopy = fs.fstatSync(fileDescriptor);
		const sourceDigestAfterCopy = hashOpenFileDescriptor(fileDescriptor);
		const namedAfterCopy = fs.statSync(backupPath);
		const recoveryBefore = fs.fstatSync(recoveryFileDescriptor);
		const recoveryDigest = hashOpenFileDescriptor(recoveryFileDescriptor);
		const recoveryAfter = fs.fstatSync(recoveryFileDescriptor);
		const recoveryNamed = fs.statSync(recoveryPath);
		if (sourceDigestAfterCopy !== backupProof.backup_sha256
			|| before.size !== sourceAfterCopy.size
			|| before.mtimeMs !== sourceAfterCopy.mtimeMs
			|| namedAfterCopy.dev !== before.dev
			|| namedAfterCopy.ino !== before.ino
			|| recoveryDigest !== backupProof.backup_sha256
			|| recoveryBefore.size !== recoveryAfter.size
			|| recoveryBefore.mtimeMs !== recoveryAfter.mtimeMs
			|| recoveryNamed.dev !== recoveryBefore.dev
			|| recoveryNamed.ino !== recoveryBefore.ino
			|| (recoveryBefore.dev === before.dev && recoveryBefore.ino === before.ino)) {
			throw new Error('recovery copy does not preserve independent verified bytes');
		}
		return {
			databasePath,
			backupPath,
			backupSha256: backupProof.backup_sha256,
			fileDescriptor,
			device: before.dev,
			inode: before.ino,
			recoveryFileDescriptor,
			recoveryDevice: recoveryBefore.dev,
			recoveryInode: recoveryBefore.ino,
			recoverySize: recoveryBefore.size,
			recoveryMtimeMs: recoveryBefore.mtimeMs,
			recoveryPath,
		};
	} catch {
		if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
		if (recoveryFileDescriptor !== undefined) fs.closeSync(recoveryFileDescriptor);
		if (recoveryPath) {
			try { fs.rmSync(recoveryPath); } catch { /* cleanup only */ }
		}
		throw new ClaimRepairError(
			'CLAIM_REPAIR_BACKUP_DRIFT',
			'Verified claim-repair backup changed before receipt commit',
		);
	}
}

async function assertClaimRepairBackupFenceCurrent(fence, options = {}) {
	try {
		await (options.hardenPath || hardenBackupPermissions)(fence.backupPath);
		assertSafeBackupDestination(fence.databasePath, fence.backupPath);
		if (!options.sidecarsBlocked) assertNoClaimRepairBackupSidecars(fence.backupPath);
		const before = fs.fstatSync(fence.fileDescriptor);
		const digest = hashOpenFileDescriptor(fence.fileDescriptor);
		const after = fs.fstatSync(fence.fileDescriptor);
		const named = fs.statSync(fence.backupPath);
		const recoveryBefore = fs.fstatSync(fence.recoveryFileDescriptor);
		const recoveryDigest = hashOpenFileDescriptor(fence.recoveryFileDescriptor);
		const recoveryAfter = fs.fstatSync(fence.recoveryFileDescriptor);
		const recoveryNamed = fs.statSync(fence.recoveryPath);
		if (digest !== fence.backupSha256
			|| before.size !== after.size
			|| before.mtimeMs !== after.mtimeMs
			|| before.dev !== fence.device
			|| before.ino !== fence.inode
			|| named.dev !== fence.device
			|| named.ino !== fence.inode
			|| recoveryDigest !== fence.backupSha256
			|| recoveryBefore.size !== recoveryAfter.size
			|| recoveryBefore.size !== fence.recoverySize
			|| recoveryBefore.mtimeMs !== recoveryAfter.mtimeMs
			|| recoveryBefore.mtimeMs !== fence.recoveryMtimeMs
			|| recoveryBefore.dev !== fence.recoveryDevice
			|| recoveryBefore.ino !== fence.recoveryInode
			|| recoveryNamed.dev !== fence.recoveryDevice
			|| recoveryNamed.ino !== fence.recoveryInode
			|| (recoveryNamed.dev === fence.device && recoveryNamed.ino === fence.inode)) {
			throw new Error('backup fence changed');
		}
	} catch {
		throw new ClaimRepairError(
			'CLAIM_REPAIR_BACKUP_DRIFT',
			'Verified claim-repair backup changed before receipt commit',
		);
	}
}

function assertClaimRepairBackupSidecarsRemainAbsent(backupPath) {
	assertNoClaimRepairBackupSidecars(backupPath);
	const blockers = [];
	try {
		for (const suffix of ['-wal', '-shm', '-journal']) {
			const sidecarPath = `${backupPath}${suffix}`;
			fs.mkdirSync(sidecarPath);
			const stat = fs.statSync(sidecarPath);
			blockers.push({ path: sidecarPath, device: stat.dev, inode: stat.ino });
		}
		return blockers;
	} catch (error) {
		for (const blocker of blockers) {
			try { fs.rmdirSync(blocker.path); } catch { /* cleanup only */ }
		}
		throw error;
	}
}

function assertClaimRepairBackupSidecarBlockersCurrent(blockers = []) {
	for (const blocker of blockers) {
		const stat = fs.statSync(blocker.path);
		if (!stat.isDirectory() || stat.dev !== blocker.device || stat.ino !== blocker.inode) {
			throw new Error('backup sidecar blocker changed');
		}
	}
}

function removeClaimRepairBackupSidecarBlockers(blockers = []) {
	for (const blocker of blockers) {
		try {
			const stat = fs.statSync(blocker.path);
			if (stat.isDirectory() && stat.dev === blocker.device && stat.ino === blocker.inode) {
				fs.rmdirSync(blocker.path);
			}
		} catch { /* cleanup cannot change the committed receipt */ }
	}
}

function closeClaimRepairBackupFence(fence, options = {}) {
	if (!fence) return;
	try { fs.closeSync(fence.fileDescriptor); } catch { /* descriptor cleanup cannot change a committed receipt */ }
	try { fs.closeSync(fence.recoveryFileDescriptor); } catch { /* descriptor cleanup cannot change a committed receipt */ }
	if (options.removeRecovery) {
		try {
			const recovery = fs.statSync(fence.recoveryPath);
			if (recovery.dev === fence.recoveryDevice && recovery.ino === fence.recoveryInode) {
				fs.rmSync(fence.recoveryPath);
			}
		} catch { /* rolled-back cleanup cannot change authority */ }
	}
}

function injectClaimRepairFault(driverOptions, phase) {
	if (typeof driverOptions.claimRepairFaultInjector === 'function') {
		driverOptions.claimRepairFaultInjector(phase);
	}
}

function assertClaimRepairReplayInput(input = {}) {
	if (!/^[0-9a-f]{64}$/.test(String(input.approvedDigest || ''))) {
		throw new ClaimRepairError('CLAIM_REPAIR_APPROVAL_REQUIRED', 'Apply requires the exact approved preflight digest');
	}
	if (typeof input.actor !== 'string' || input.actor.trim() === '') {
		throw new ClaimRepairError('CLAIM_REPAIR_ACTOR_REQUIRED', 'Apply requires an explicit operator actor');
	}
	if (typeof input.observedAt !== 'string'
		|| !Number.isFinite(Date.parse(input.observedAt))
		|| new Date(Date.parse(input.observedAt)).toISOString() !== input.observedAt) {
		throw new ClaimRepairError('CLAIM_REPAIR_INVALID_TIME', 'Apply requires a fixed canonical UTC observation time');
	}
}

function updateExactClaimRepairAction(runtime, db, action) {
	const claim = action.claim;
	const result = runParams(
		runtime,
		db,
		`UPDATE kernel_claims SET state = ?
		 WHERE id = ? AND issue_id = ? AND actor = ? AND state = 'active'
			AND session_id IS ? AND worktree_id IS ? AND claimed_at = ? AND expires_at IS ?
			AND EXISTS (
				SELECT 1 FROM kernel_issues WHERE id = ? AND status = ?
			)`,
		[
			action.to_state,
			claim.id,
			claim.issue_id,
			claim.actor,
			claim.session_id,
			claim.worktree_id,
			claim.claimed_at,
			claim.expires_at,
			claim.issue_id,
			action.issue_status,
		],
	);
	if (Number(result?.changes || 0) !== 1) {
		throw new ClaimRepairError(
			'CLAIM_REPAIR_CAS_CONFLICT',
			'Claim repair exact-row compare-and-swap rejected concurrent drift',
		);
	}
}

const claimRepairApplyQueues = new Map();

function claimRepairApplyQueueKey(databasePath) {
	const canonicalPath = fs.realpathSync.native(databasePath);
	return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath;
}

async function withClaimRepairApplyQueue(databasePath, operation, queue = claimRepairApplyQueues) {
	const key = claimRepairApplyQueueKey(databasePath);
	const previous = queue.get(key) || Promise.resolve();
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const tail = previous.then(() => gate);
	queue.set(key, tail);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (queue.get(key) === tail) queue.delete(key);
	}
}

async function applyLegacyClaimRepairRow(runtime, db, input = {}, driverOptions = {}) {
	assertClaimRepairApplyInput(input);
	const idempotencyKey = `claim.repair:${input.approvedDigest}`;
	const hardenPath = driverOptions.hardenPath || hardenBackupPermissions;
	const hardenPaths = driverOptions.hardenPaths
		|| (driverOptions.hardenPath ? driverOptions.hardenPath.batch : hardenBackupPermissionsBatch);
	let backupFence;
	let sidecarBlockers = [];
	let committed = false;
	let rolledBack = false;
	execSql(runtime, db, 'BEGIN IMMEDIATE;');
	try {
		const existingRow = allParams(
			runtime,
			db,
			'SELECT * FROM kernel_events WHERE idempotency_key = ? LIMIT 1',
			[idempotencyKey],
		)[0];
		const existingReceipt = parseStoredClaimRepairReceipt(existingRow, input.approvedDigest, input.backupProof);
		if (existingReceipt) {
			await verifyClaimRepairRecovery(existingReceipt, input.backupPath, input.databasePath, { hardenPath });
			execSql(runtime, db, 'COMMIT;');
			return attachClaimRepairRecoveryPath({ ...existingReceipt, replayed: true }, input.backupPath);
		}
		const plan = buildClaimRepairPlan(loadLegacyClaimRepairSnapshot(runtime, db), {
			observedAt: input.observedAt,
		});
		if (plan.digest !== input.approvedDigest) {
			throw new ClaimRepairError(
				'CLAIM_REPAIR_DIGEST_DRIFT',
				'Live claim authority changed after approval; generate and approve a new fixed-time preflight',
			);
		}

		for (const action of plan.actions) updateExactClaimRepairAction(runtime, db, action);
		injectClaimRepairFault(driverOptions, 'after-mutations');
		const afterPlan = buildClaimRepairPlan(loadLegacyClaimRepairSnapshot(runtime, db), {
			observedAt: input.observedAt,
		});
		if (afterPlan.digest !== plan.afterDigest) {
			throw new ClaimRepairError('CLAIM_REPAIR_POSTCONDITION_FAILED', 'Claim repair postcondition digest did not match the approved plan');
		}
		injectClaimRepairFault(driverOptions, 'before-backup-commit-check');
		const recoveryReference = randomUUID();
		backupFence = await openClaimRepairBackupFence(
			input.databasePath,
			input.backupPath,
			input.backupProof,
			recoveryReference,
			{ hardenPath, hardenPaths },
		);
		injectClaimRepairFault(driverOptions, 'after-backup-fence');

		const receiptId = randomUUID();
		const receipt = {
			schema_version: 'forge.claim-repair.receipt.v1',
			receipt_id: receiptId,
			observed_at: input.observedAt,
			approved_digest: input.approvedDigest,
			after_digest: afterPlan.digest,
			backup_sha256: input.backupProof.backup_sha256,
			recovery_ref: recoveryReference,
			mutations: {
				released: plan.actions.filter(action => action.to_state === 'released').length,
				reclaimable: plan.actions.filter(action => action.to_state === 'reclaimable').length,
				total: plan.actions.length,
			},
			replayed: false,
		};
		runParams(
			runtime,
			db,
			`INSERT INTO kernel_events (
				id, entity_type, entity_id, event_type, idempotency_key,
				expected_revision, actor, origin, payload_json, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				receiptId,
				'claim_repair',
				'legacy_claims',
				'claim.repair',
				idempotencyKey,
				0,
				input.actor,
				'forge.claim-repair',
				JSON.stringify(receipt),
				new Date().toISOString(),
			],
		);
		injectClaimRepairFault(driverOptions, 'after-receipt-before-commit');
		await assertClaimRepairBackupFenceCurrent(backupFence, { hardenPath });
		sidecarBlockers = assertClaimRepairBackupSidecarsRemainAbsent(input.backupPath);
		await assertClaimRepairBackupFenceCurrent(backupFence, { hardenPath, sidecarsBlocked: true });
		execSql(runtime, db, 'COMMIT;');
		committed = true;
		injectClaimRepairFault(driverOptions, 'after-commit-before-backup-check');
		try {
			await assertClaimRepairBackupFenceCurrent(backupFence, { hardenPath, sidecarsBlocked: true });
			assertClaimRepairBackupSidecarBlockersCurrent(sidecarBlockers);
		} catch {
			throw new ClaimRepairError(
				'CLAIM_REPAIR_BACKUP_POSTCOMMIT_DRIFT',
				'Claim repair committed, but the named backup changed; preserve the verified recovery path',
				{ recovery_path: backupFence.recoveryPath },
			);
		}
		injectClaimRepairFault(driverOptions, 'after-postcommit-backup-check');
		return attachClaimRepairRecoveryPath(receipt, input.backupPath);
	} catch (error) {
		if (!committed) {
			try {
				execSql(runtime, db, 'ROLLBACK;');
				rolledBack = true;
			} catch { /* preserve the original failure and recovery copy */ }
		}
		throw error;
	} finally {
		removeClaimRepairBackupSidecarBlockers(sidecarBlockers);
		closeClaimRepairBackupFence(backupFence, { removeRecovery: rolledBack });
	}
}

function createDriver(runtime, configuredDatabasePath, driverOptions = {}) {
	let db;
	let openedDatabasePath;
	let memorySchemaEnsured = false;
	let usageEvidenceSchemaEnsured = false;

	// kernel_memories is created by migration 005 through broker.initialize(), but the
	// synchronous project-memory facade writes WITHOUT first running migrations. Lazily
	// ensure the table (idempotent CREATE IF NOT EXISTS, rendered from the same migration)
	// plus a busy_timeout for the second connection the issue backend may hold open.
	function ensureMemorySchema(database, busyTimeoutMs) {
		if (memorySchemaEnsured) return;
		const requestedBusyTimeout = Number(busyTimeoutMs);
		const busyTimeout = Number.isFinite(requestedBusyTimeout) && requestedBusyTimeout >= 0
			? Math.floor(requestedBusyTimeout)
			: 5_000;
		execSql(runtime, database, `PRAGMA busy_timeout=${busyTimeout};`);
		try {
			for (const statement of buildMemoryProjectionMigration().apply) {
				execSql(runtime, database, statement);
			}
		// FTS5 recall index (migration 008): create the virtual table + sync triggers
		// idempotently so a synchronous memory write stays indexed without a prior
		// broker.initialize(). When the index is NEWLY created, rebuild once to backfill any
		// rows written before it existed (a DB upgraded from before this feature, or rows the
		// insights engine wrote straight to kernel_memories) — the sync triggers keep it
		// current thereafter, so steady-state process starts skip the reindex.
		//
		// Staleness is detected by TABLE EXISTENCE (sqlite_master), never by count(*): on an
		// external-content FTS5 table `count(*)` returns the CONTENT row count, not the
		// indexed-doc count, so it can never reveal an un-backfilled index.
			const ftsDdl = memoryFtsDdl();
			const ftsExisted = Number(queryOne(
				runtime,
				database,
				"SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'kernel_memories_fts'",
			).count) > 0;
			execSql(runtime, database, ftsDdl.create);
			for (const trigger of ftsDdl.triggers) {
				execSql(runtime, database, trigger);
			}
			if (!ftsExisted) {
				execSql(runtime, database, ftsDdl.rebuild);
			}
			memorySchemaEnsured = true;
		} finally {
			if (busyTimeout !== 5_000) {
				execSql(runtime, database, 'PRAGMA busy_timeout=5000;');
			}
		}
	}

	function ensureUsageEvidenceSchema(database) {
		if (usageEvidenceSchemaEnsured) return;
		for (const statement of buildUsageEvidenceMigration().apply) {
			execSql(runtime, database, statement);
		}
		usageEvidenceSchemaEnsured = true;
	}

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
			execSql(runtime, db, 'PRAGMA foreign_keys=ON;');
			openedDatabasePath = databasePath;
		} else if (openedDatabasePath !== databasePath) {
			throw new Error(`Kernel SQLite driver is already open for ${openedDatabasePath}`);
		}
		return db;
	}

	const driver = {
		runtime: {
			id: runtime.id,
			databaseClassName: runtime.databaseClassName,
			nativeCompileDependency: runtime.nativeCompileDependency,
			experimental: runtime.experimental,
		},
		databasePath: configuredDatabasePath,
		forkConnection(config = {}) {
			const databasePath = resolveDatabasePath(config);
			if (databasePath === ':memory:') {
				const fork = Object.create(driver);
				Object.defineProperty(fork, 'close', { value() {} });
				Object.defineProperty(fork, 'transactionQueueKey', { value: driver });
				return fork;
			}
			return createDriver(runtime, databasePath, driverOptions);
		},
		async exec(statement, config) {
			execSql(runtime, getDatabase(config), statement);
		},
		async queryAll(statement, config) {
			return queryAll(runtime, getDatabase(config), statement);
		},
		watchOwnerRead(input, config = {}) {
			return readWatchOwner(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, input);
		},
		watchOwnerList(config = {}) {
			return listWatchOwners(runtime, resolveDatabasePath(config), { ...driverOptions, ...config });
		},
		watchOwnerReserveStarting(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'reserveStarting', input);
		},
		watchOwnerReserveReopened(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'reserveReopened', input);
		},
		watchOwnerBindRunning(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'bindRunning', input);
		},
		watchOwnerHeartbeat(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'heartbeat', input);
		},
		watchOwnerRequestStop(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'requestStop', input);
		},
		watchOwnerRecordTerminal(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'recordTerminal', input);
		},
		watchOwnerCompleteTerminal(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'completeTerminal', input);
		},
		watchOwnerAbortStarting(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'abortStarting', input);
		},
		watchOwnerReleaseNonterminal(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'releaseNonterminal', input);
		},
		watchOwnerRecoverDeadStarting(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'recoverDeadStarting', input);
		},
		watchOwnerRecoverDeadWatcher(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'recoverDeadWatcher', input);
		},
		watchOwnerMarkLegacyBlocked(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'markLegacyBlocked', input);
		},
		watchOwnerRecheckLegacyBlocked(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'recheckLegacyBlocked', input);
		},
		watchOwnerImportLegacyStarting(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'importLegacyStarting', input);
		},
		watchOwnerImportLegacyComplete(input, config = {}) {
			return applyWatchOwnerOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'importLegacyComplete', input);
		},
		watchGateRead(_input = {}, config = {}) {
			return readWatchGate(runtime, resolveDatabasePath(config), { ...driverOptions, ...config });
		},
		watchGatePublishQuarantine(input, config = {}) {
			return applyWatchGateOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'publishQuarantine', input);
		},
		watchGateBindSnapshot(input, config = {}) {
			return applyWatchGateOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'bindSnapshot', input);
		},
		watchGatePublishConflict(input, config = {}) {
			return applyWatchGateOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'publishConflict', input);
		},
		watchGateRetryConflict(input, config = {}) {
			return applyWatchGateOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'retryConflict', input);
		},
		watchGateCompleteMigration(input, config = {}) {
			return applyWatchGateOperation(runtime, resolveDatabasePath(config), { ...driverOptions, ...config }, 'completeMigration', input);
		},
		async issueOperation(operation, args = [], context = {}, config = {}) {
			const database = getDatabase(config);
			const READ_OPERATIONS = new Set(['ready', 'list', 'show', 'search', 'stats', 'blocked', 'stale', 'orphans', 'lint', 'children', 'owns', 'claims']);
			if (READ_OPERATIONS.has(operation)) {
				return runIssueReadOperation(runtime, database, operation, args, context);
			}
			// Mutations (create/update/close/comment/dep.add/dep.remove/claim/release) are
			// implemented through the broker's guarded-event path in a later wave.
			throw new Error(`Kernel SQLite driver issueOperation: mutation operation '${operation}' is not implemented yet (reads only)`);
		},
		// Git-style short-id support (kernel 9556660b): the candidate ids (+ titles)
		// whose id starts with `prefix`. Parameterized LIKE with escaped wildcards;
		// ordered by id ascending so an EXACT match (the shortest id sharing the
		// prefix) always sorts first and is never pushed out by the limit. Consumed
		// by the broker's issue-id prefix resolver, never by the contract directly.
		async findIssueIdsByPrefix(prefix, limit = 6, _context = {}, config = {}) {
			const escaped = String(prefix).replace(/[\\%_]/g, match => `\\${match}`);
			return allParams(
				runtime, getDatabase(config),
				"SELECT id, title FROM kernel_issues WHERE id LIKE ? ESCAPE '\\' ORDER BY id ASC LIMIT ?",
				[`${escaped}%`, limit],
			);
		},
		// Open PRs under shepherd for one repo (autonomous-shepherd design §3.4): the
		// reconciler's "open PRs in this repo" read, keyed by git_common_dir so every
		// worktree shares one view. Parameterized (git_common_dir is a filesystem path —
		// never interpolate it), covered by idx_pr_common_dir_state_repo_number. Ordered so
		// the result is deterministic. `context` is part of the broker contract but unused
		// by this direct SELECT (prefixed `_` for eslint no-unused-vars).
		async listOpenPrs(gitCommonDir, _context = {}, config = {}) {
			return allParams(
				runtime, getDatabase(config),
				"SELECT * FROM kernel_pr WHERE git_common_dir = ? AND state = 'open' ORDER BY repo ASC, number ASC",
				[gitCommonDir],
			);
		},
		// --- kernel_pr WRITE path (autonomous-shepherd design §5a). pr rows are DERIVED
		// reconcile state (reconstructable from GitHub), not audit-critical issue authority,
		// so they take a DIRECT idempotent upsert — NOT the event-sourced guarded path
		// (applyAcceptedIssueMutation). All target the physical `kernel_pr` table (matching
		// the listOpenPrs read) and are parameterized (git_common_dir/branch/head_sha are
		// externally-influenced values — never interpolate). `context` is part of the broker
		// contract but unused by these direct writes (prefixed `_` for eslint no-unused-vars).
		//
		// Register/refresh a PR row keyed by (git_common_dir, repo, number). Idempotent via
		// ON CONFLICT on the unique idx_pr_common_dir_repo_number: a re-upsert updates the
		// mutable columns and coalesces soft links (a later null never clobbers an existing
		// issue_id/worktree_id). registered_at is set on INSERT only; state defaults 'open'.
		async upsertPr(row, _context = {}, config = {}) {
			const id = row.id || randomUUID();
			const registeredAt = row.registered_at || new Date().toISOString();
			const state = row.state || 'open';
			runParams(
				runtime, getDatabase(config),
				`INSERT INTO kernel_pr
					(id, git_common_dir, repo, number, issue_id, worktree_id, branch, head_sha, journal_ptr, state, registered_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(git_common_dir, repo, number) DO UPDATE SET
					head_sha = excluded.head_sha,
					branch = excluded.branch,
					issue_id = coalesce(excluded.issue_id, kernel_pr.issue_id),
					worktree_id = coalesce(excluded.worktree_id, kernel_pr.worktree_id),
					-- journal_ptr is a soft link: coalesce it (like issue_id/worktree_id) so a
					-- head-only refresh that omits journalPtr never severs the ledger↔journal
					-- link with NULL. (Codex review, PR #426.)
					journal_ptr = coalesce(excluded.journal_ptr, kernel_pr.journal_ptr),
					-- REOPEN semantics: upsertPr is only ever called for PRs GitHub reports as
					-- OPEN, so re-registering a previously retired row (a reopened PR) must flip
					-- it back to open and clear retired_at — else listOpenPrs (state='open') would
					-- keep the reopened PR invisible forever. (Codex review, PR #426.)
					state = 'open',
					retired_at = NULL,
					-- A new commit INVALIDATES the prior verdict: when the head advances to a
					-- different non-null sha, clear verdict/source/at so a verdict computed
					-- against the OLD head is never presented as fresh for the new head (and the
					-- freshest-head guard in updatePrVerdict keeps intact evidence). IS NOT is the
					-- null-safe distinctness test; a headless refresh (excluded.head_sha NULL)
					-- never clears. (Codex review, PR #426.)
					verdict = CASE WHEN excluded.head_sha IS NOT NULL AND excluded.head_sha IS NOT kernel_pr.head_sha THEN NULL ELSE kernel_pr.verdict END,
					verdict_source = CASE WHEN excluded.head_sha IS NOT NULL AND excluded.head_sha IS NOT kernel_pr.head_sha THEN NULL ELSE kernel_pr.verdict_source END,
					verdict_at = CASE WHEN excluded.head_sha IS NOT NULL AND excluded.head_sha IS NOT kernel_pr.head_sha THEN NULL ELSE kernel_pr.verdict_at END`,
				[
					id,
					row.git_common_dir,
					row.repo,
					row.number,
					row.issue_id ?? null,
					row.worktree_id ?? null,
					row.branch ?? null,
					row.head_sha ?? null,
					row.journal_ptr ?? null,
					state,
					registeredAt,
				],
			);
			const persisted = allParams(
				runtime,
				getDatabase(config),
				'SELECT * FROM kernel_pr WHERE git_common_dir = ? AND repo = ? AND number = ? LIMIT 1',
				[row.git_common_dir, row.repo, row.number],
			)[0];
			if (!persisted) {
				throw new Error(`Kernel SQLite driver upsertPr: no kernel_pr row after upsert for ${row.repo}#${row.number}`);
			}
			return { ok: true, ...persisted };
		},
		async resolvePrLinkage(input, _context = {}, config = {}) {
			return resolvePrLinkageRow(runtime, getDatabase(config), input);
		},
		async readTrace(target, _context = {}, config = {}) {
			return loadTraceRows(runtime, getDatabase(config), target);
		},
		// The ONE verdict authority WRITE (design §1.2 rule 2) — FRESHEST-HEAD-SHA
		// PRECEDENCE enforced in the WHERE so a verdict computed against a SUPERSEDED head is
		// DISCARDED, not written (kills stale 9d35c14b at the write). A non-local (Actions
		// backstop) write lands only when its head_sha matches the row's current head (or the
		// row has none yet); a `local` verdict is computed live against the current head and
		// is always authoritative, so it bypasses the head match.
		async updatePrVerdict(key, patch = {}, _context = {}, config = {}) {
			const headSha = patch.head_sha ?? null;
			const source = patch.verdict_source ?? null;
			runParams(
				runtime, getDatabase(config),
				`UPDATE kernel_pr SET verdict = ?, verdict_source = ?, verdict_at = ?, head_sha = ?
				 WHERE git_common_dir = ? AND repo = ? AND number = ?
					AND (head_sha IS NULL OR head_sha = ? OR ? = 'local')`,
				[
					patch.verdict ?? null,
					source,
					patch.verdict_at ?? null,
					headSha,
					key.git_common_dir,
					key.repo,
					key.number,
					headSha,
					source,
				],
			);
			return { ok: true };
		},
		// Retire a PR row (merged/closed): flip state + stamp retired_at so it drops out of
		// the open-PR read while the reconcile history is retained.
		async retirePr(key, patch = {}, _context = {}, config = {}) {
			runParams(
				runtime, getDatabase(config),
				'UPDATE kernel_pr SET state = ?, retired_at = ? WHERE git_common_dir = ? AND repo = ? AND number = ?',
				[
					patch.state ?? 'closed',
					patch.retired_at ?? new Date().toISOString(),
					key.git_common_dir,
					key.repo,
					key.number,
				],
			);
			return { ok: true };
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
		// Additive bulk read for `forge insights` (Slice C2). Read-only; NOT part of the
		// GUARDED_DRIVER_METHODS write-path contract, so existing driver stubs stay valid.
		async listRecentKernelEvents({ since = null, limit = null } = {}, _context = {}, config = {}) {
			return listRecentKernelEventRows(runtime, getDatabase(config), since, limit);
		},
		async loadKernelEventByIdempotencyKey(idempotencyKey, _context = {}, config = {}) {
			return loadKernelEventByIdempotencyKeyRow(runtime, getDatabase(config), idempotencyKey);
		},
		async loadPrEventsByRunId(runId, _context = {}, config = {}) {
			return allParams(runtime, getDatabase(config),
				"SELECT * FROM kernel_events WHERE entity_type = 'pr' AND json_extract(payload_json, '$.run_id') = ? ORDER BY created_at ASC, rowid ASC",
				[runId]);
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
		async listActiveClaims(_context = {}, config = {}) {
			return listActiveKernelClaimRows(runtime, getDatabase(config));
		},
		async releaseExactClaim(claim, _evidence = {}, config = {}) {
			return releaseExactKernelClaimRow(runtime, getDatabase(config), claim);
		},
		async releaseExactClaimIfWorktreeMissing(claim, worktree, isMissing, _evidence = {}, config = {}) {
			return releaseExactKernelClaimIfWorktreeMissing(
				runtime, getDatabase(config), claim, worktree, isMissing,
			);
		},
		// Explicit operator-only legacy data repair. This surface is never called by
		// broker initialization or normal claim acquisition: dry-run is immutable,
		// while apply requires a separately verified backup and approved exact digest.
		async preflightLegacyClaimRepair(input = {}, config = {}) {
			return preflightLegacyClaimRepairRow(runtime, getDatabase(config), input);
		},
		async applyLegacyClaimRepair(input = {}, config = {}) {
			assertClaimRepairReplayInput(input);
			const databasePath = resolveDatabasePath(config);
			return withClaimRepairApplyQueue(databasePath, async () => {
				const database = createDatabase(runtime, databasePath);
				const hardenPath = driverOptions.hardenPath || hardenBackupPermissions;
				const hardenPaths = driverOptions.hardenPaths
					|| (driverOptions.hardenPath ? driverOptions.hardenPath.batch : hardenBackupPermissionsBatch);
				try {
					execSql(runtime, database, 'PRAGMA foreign_keys=ON;');
					const replayed = replayStoredClaimRepairReceipt(
						runtime,
						database,
						input.approvedDigest,
						input.observedAt,
						input.backupPath,
					);
					if (replayed) {
						await verifyClaimRepairRecovery(replayed, input.backupPath, databasePath, { hardenPath });
						return replayed;
					}
					if (!input.backupPath) {
						throw new ClaimRepairError(
							'CLAIM_REPAIR_BACKUP_PROOF_REQUIRED',
							'Apply requires the path to a separately verified SQLite backup',
						);
					}
					assertSafeBackupDestination(databasePath, input.backupPath);
					const backupProof = await verifyClaimRepairBackup({
						backupPath: input.backupPath,
						observedAt: input.observedAt,
						openDriver: restorePath => createDriver(runtime, restorePath),
						hardenPath,
						hardenPaths,
					});
					return await applyLegacyClaimRepairRow(
						runtime,
						database,
						{ ...input, databasePath, backupProof },
						driverOptions,
					);
				} finally {
					closeDatabase(database);
				}
			}, driverOptions.claimRepairApplyQueue);
		},
		// commitGuardedAccept invokes this (typeof-guarded) INSIDE its BEGIN IMMEDIATE
		// transaction to apply an accepted issue event to the authority tables. The
		// returned summary ({id, revision, comment_id?}) flows back through
		// runGuardedEvent's result so runIssueOperation can shape the mutation response.
		async applyAcceptedIssueMutation(event, context = {}, config = {}) {
			return applyAcceptedMutation(runtime, getDatabase(config), event, context);
		},
		// Faithful-import write path: insert a kernel records bundle ({ issues, comments,
		// dependencies, events, activityEvents }) DIRECTLY into the authority tables,
		// preserving each issue's original created_at/updated_at + terminal status (bypassing
		// the now-stamping create/CAS path) and landing the legacy beads activity log in
		// kernel_events. Idempotent + transactional. `context` is part of the driver contract
		// but unused by this direct write (prefixed `_`).
		async importIssues(records = {}, options = {}, _context = {}, config = {}) {
			return importIssueRecords(runtime, getDatabase(config), records, options);
		},
		// --- Project-memory read model (written directly, not via the guarded path).
		// Synchronous by design: the project-memory facade is synchronous, and these
		// lazily ensure the kernel_memories table so a write never needs a prior
		// (async) broker.initialize().
		// --- Worktree-linkage registry (written directly, not via the guarded event
		// path). Synchronous like the memory facade so `forge worktree create` and the
		// synchronous orientation read can use them without a prior broker.initialize().
		// registerWorktree requires the 007 columns (callers use a migrated driver);
		// getWorktreeLinkage/listWorktrees tolerate a missing/empty table (safeAll) and
		// return null/[] so orientation falls back to the folder heuristic.
		registerWorktree(input, config = {}) {
			return upsertWorktreeRow(runtime, getDatabase(config), input);
		},
		getWorktreeLinkage(filter = {}, config = {}) {
			return loadWorktreeRowByPath(runtime, getDatabase(config), filter.path);
		},
		listWorktrees(filter = {}, config = {}) {
			return listWorktreeRows(runtime, getDatabase(config), filter);
		},
		// --- Stage-run registry (f61601ab). Direct writes like the worktree registry
		// (bypass the guarded event path), synchronous so a CLI verb / orientation read
		// can use them without a prior async broker.initialize(). Idempotent per
		// (issue_id, stage). getCurrentStage powers the real workflow-phase read.
		recordStageRun(input, config = {}) {
			return recordStageRunRow(runtime, getDatabase(config), input);
		},
		// Atomic complete(from)+start(to) in ONE transaction: a mid-transition failure
		// rolls back both writes so `current_stage` never reflects a half-transition.
		recordStageTransition(input, config = {}) {
			return recordStageTransitionRow(runtime, getDatabase(config), input);
		},
		recordPlanSnapshotTransition(input, config = {}) {
			return recordPlanSnapshotTransitionRow(runtime, getDatabase(config), input);
		},
		loadPlanSnapshot(filter = {}, config = {}) {
			return loadPlanSnapshotRow(runtime, getDatabase(config), filter.issue_id);
		},
		listStageRuns(filter = {}, config = {}) {
			return listStageRunRows(runtime, getDatabase(config), filter.issue_id);
		},
		getCurrentStage(filter = {}, config = {}) {
			return loadCurrentStageRunRow(runtime, getDatabase(config), filter.issue_id);
		},
		recordMemory(entry, config = {}) {
			const database = getDatabase(config);
			ensureMemorySchema(database);
			return upsertMemoryRow(runtime, database, entry);
		},
		loadMemory(key, config = {}) {
			const database = getDatabase(config);
			ensureMemorySchema(database);
			return loadMemoryRow(runtime, database, key);
		},
		searchMemories(query, config = {}) {
			const database = getDatabase(config);
			ensureMemorySchema(database);
			return searchMemoryRows(runtime, database, query);
		},
		// BM25 top-N recall over the FTS5 index (token-AND). An empty query falls back to
		// the newest `limit` entries so recall never returns a bare full dump.
		searchMemoriesRanked(query, limit, config = {}) {
			const database = getDatabase(config);
			ensureMemorySchema(database);
			return searchMemoryRowsRanked(runtime, database, query, limit, config);
		},
		// Relevance-only BM25 recall that also returns the raw bm25 `score` per entry, so a
		// caller can apply a relevance floor. A no-match/empty query returns [] (no recency
		// fallback). Used by the per-turn memory-recall hook.
		searchMemoriesRankedScored(query, limit, config = {}) {
			const database = getDatabase(config);
			ensureMemorySchema(database, config.busyTimeoutMs);
			return searchMemoryRowsRankedScored(runtime, database, query, limit, config);
		},
		// The newest `limit` entries (default recall with no query). `options.agents` scopes
		// the read to a source_agent allow-list (e.g. human `remember` notes only).
		recentMemories(limit, options = {}, config = {}) {
			const database = getDatabase(config);
			ensureMemorySchema(database);
			return recentMemoryRows(runtime, database, limit, options);
		},
		// Total stored memories (optionally scoped by `options.agents` and `options.kind`) — lets recall report
		// "showing N of TOTAL".
		countMemories(options = {}, config = {}) {
			const database = getDatabase(config);
			ensureMemorySchema(database);
			return countMemoryRows(runtime, database, options);
		},
		appendUsageEvidence(event, config = {}) {
			const database = getDatabase(config);
			ensureUsageEvidenceSchema(database);
			return appendUsageEvidence(createUsageEvidenceAdapter(runtime, database), event);
		},
		rebuildUsageProjection(config = {}) {
			const database = getDatabase(config);
			ensureUsageEvidenceSchema(database);
			return rebuildUsageProjection(createUsageEvidenceAdapter(runtime, database));
		},
		loadUsageProjection(memoryId, config = {}) {
			const database = getDatabase(config);
			ensureUsageEvidenceSchema(database);
			return allParams(runtime, database,
				'SELECT scope, memory_id, last_used_at, use_count FROM memory_usage_projection WHERE memory_id = ?', [memoryId])[0] || null;
		},
		loadUsageProjections(memoryIds = [], config = {}) {
			const database = getDatabase(config);
			ensureUsageEvidenceSchema(database);
			const ids = [...new Set(Array.isArray(memoryIds) ? memoryIds : [])];
			if (ids.length === 0) return [];
			return allParams(runtime, database,
				`SELECT scope, memory_id, last_used_at, use_count FROM memory_usage_projection WHERE memory_id IN (${ids.map(() => '?').join(', ')})`, ids);
		},
		listMemories(config = {}) {
			const database = getDatabase(config);
			ensureMemorySchema(database);
			return listMemoryRows(runtime, database);
		},
		// --- Memory-owned monitor durability. Public callers use @forge/memory, while
		// these primitives independently reject malformed/private data as defense in depth.
		async appendMonitorEvent(envelope, targets = [], config = {}) {
			const database = getDatabase(config);
			const safeEnvelope = assertMonitorEnvelope(envelope, 'forge.memory.monitor-event.v1');
			return appendMonitorEventRow(runtime, database, safeEnvelope, normalizeMonitorTargets(targets), config);
		},
		async recordMonitorDeliveryReceipt(envelope, config = {}) {
			const database = getDatabase(config);
			const safeEnvelope = assertMonitorEnvelope(envelope, 'forge.memory.delivery-receipt.v1');
			assertMonitorTarget(safeEnvelope.payload.target);
			return recordMonitorDeliveryReceiptRow(runtime, database, safeEnvelope, config);
		},
		async recordMonitorTerminalReceipt(envelope, config = {}) {
			const database = getDatabase(config);
			const safeEnvelope = assertMonitorEnvelope(envelope, 'forge.memory.monitor-receipt.v1');
			return recordMonitorTerminalReceiptRow(runtime, database, safeEnvelope, config);
		},
		async getMonitorEvent(eventId, config = {}) {
			if (typeof eventId !== 'string' || !eventId || eventId.length > 255) {
				throw new TypeError('eventId must be a bounded non-empty string');
			}
			return getMonitorEventRow(runtime, getDatabase(config), eventId);
		},
		async readMonitorEventTail(monitorId, options = {}, config = {}) {
			return readMonitorEventTailRows(runtime, getDatabase(config), monitorId, options);
		},
		async readMonitorDeliveryState(monitorId, options = {}, config = {}) {
			return readMonitorDeliveryStateRows(runtime, getDatabase(config), monitorId, options);
		},
		async listMonitorEvents(monitorId, config = {}) {
			return listMonitorEventRows(runtime, getDatabase(config), monitorId);
		},
		async backup(destinationPath, config = {}, backupOptions = {}) {
			const databasePath = resolveDatabasePath(config);
			return createSafeBackup(
				runtime,
				getDatabase(config),
				databasePath,
				destinationPath,
				{ ...driverOptions, ...backupOptions },
			);
		},
		close() {
			closeDatabase(db);
			db = null;
			openedDatabasePath = null;
			memorySchemaEnsured = false;
			usageEvidenceSchemaEnsured = false;
		},
	};
	return driver;
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
		fs.writeFileSync(backupPath, db.serialize(), { mode: 0o600 });
		return;
	}

	throw new Error(`Unsupported builtin SQLite runtime: ${runtime.id}`);
}

function comparableFilePath(filePath) {
	const resolved = path.resolve(filePath);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertSafeBackupDestination(databasePath, backupPath) {
	if (!backupPath || databasePath === ':memory:' || String(databasePath).startsWith('file:')) {
		throw new Error('SQLite backup requires distinct file-backed source and destination paths');
	}
	const source = comparableFilePath(databasePath);
	const destination = comparableFilePath(backupPath);
	if ([source, `${source}-wal`, `${source}-shm`, `${source}-journal`].includes(destination)) {
		throw new Error('Backup destination must not alias the live SQLite database or its sidecars');
	}
	if (fs.existsSync(backupPath)) {
		const destinationStat = fs.statSync(backupPath);
		for (const sourcePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]) {
			if (!fs.existsSync(sourcePath)) continue;
			const sourceStat = fs.statSync(sourcePath);
			if (sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino) {
				throw new Error('Backup destination must not alias the live SQLite database or its sidecars');
			}
		}
	}
}

function verifyBackupFile(runtime, backupPath) {
	const backupDb = createDatabase(runtime, backupPath);
	try {
		const row = queryOne(runtime, backupDb, 'PRAGMA integrity_check;');
		if (String(row.integrity_check || '').toLowerCase() !== 'ok') {
			throw new Error('SQLite backup integrity verification failed');
		}
	} finally {
		closeDatabase(backupDb);
	}
}

async function hardenBackupPermissions(filePath, options = {}) {
	const platform = options.platform || process.platform;
	const fsApi = options.fsApi || fs;
	const effectiveUserId = options.effectiveUserId ?? (typeof process.geteuid === 'function' ? process.geteuid() : null);
	try {
		if (platform === 'win32') {
			const aclSecurer = options.aclSecurer || secureWindowsPathAcl;
			await aclSecurer(filePath);
			return;
		}
		const initial = fsApi.statSync(filePath);
		if (effectiveUserId !== null && Number(initial.uid) !== Number(effectiveUserId)) {
			throw new Error('path is not owned by the current effective user');
		}
		const ownerMode = typeof initial.isDirectory === 'function' && initial.isDirectory() ? 0o700 : 0o600;
		fsApi.chmodSync(filePath, ownerMode);
		if ((Number(fsApi.statSync(filePath).mode) & 0o077) !== 0) {
			throw new Error(`mode remains broader than ${ownerMode.toString(8)}`);
		}
	} catch (error) {
		throw new ClaimRepairError(
			'CLAIM_REPAIR_BACKUP_PERMISSIONS',
			'SQLite backup could not be secured with owner-only permissions',
			{ cause: error.message || String(error) },
		);
	}
}

async function hardenBackupPermissionsBatch(filePaths, options = {}) {
	if (!Array.isArray(filePaths) || filePaths.length === 0) return;
	const paths = [...new Set(filePaths)];
	const platform = options.platform || process.platform;
	if (platform === 'win32' && !options.aclSecurer && !options.fsApi) {
		try {
			// One owner readback serves the whole batch after each DACL is secured.
			await secureWindowsPathsAcl(paths);
			return;
		} catch (error) {
			throw new ClaimRepairError(
				'CLAIM_REPAIR_BACKUP_PERMISSIONS',
				'SQLite backup could not be secured with owner-only permissions',
				{ cause: error.message || String(error) },
			);
		}
	}
	for (const filePath of paths) await hardenBackupPermissions(filePath, options);
}

const WINDOWS_PRIVATE_ACL_SCRIPT_PATH = path.join(__dirname, 'windows-private-acl.js');
const WINDOWS_PRIVATE_ACL_SCRIPT_RELATIVE_PATH = path.join('lib', 'kernel', 'windows-private-acl.js');
const WINDOWS_PRIVATE_ACL_SCRIPT_SHA256 = '97f44c740bb843fcca0ea158e21d201b4e34b81eb1636a6a9e9410803a31e349';

function resolveWindowsSystemExecutable(name, environment = process.env) {
	const systemRoot = environment.SystemRoot;
	if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)) {
		throw new Error('Windows backup hardening requires an absolute SystemRoot');
	}
	return path.win32.join(systemRoot, 'System32', name);
}

function resolveWindowsCscriptPath(environment = process.env) {
	return resolveWindowsSystemExecutable('cscript.exe', environment);
}

function windowsAclScriptPath(fsApi = fs, packageRoot = getPackageRoot()) {
	const scriptPath = path.join(packageRoot, WINDOWS_PRIVATE_ACL_SCRIPT_RELATIVE_PATH);
	const script = fsApi.readFileSync(scriptPath);
	const digest = createHash('sha256').update(script).digest('hex');
	if (digest !== WINDOWS_PRIVATE_ACL_SCRIPT_SHA256) {
		throw new Error('Windows ACL hardening script integrity check failed');
	}
	return scriptPath;
}

async function runWindowsProcess(command, args, options = {}) {
	const runtime = options.runtime || (process.versions.bun ? 'bun' : 'node');
	const timeout = options.timeout;
	if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Windows ACL hardening subprocess timed out');
	const setTimer = options.setTimer || setTimeout;
	const clearTimer = options.clearTimer || clearTimeout;
	let timedOut = false;
	let exitCode;
	let stdout;

	if (runtime === 'bun') {
		const spawn = options.bunSpawn || globalThis.Bun.spawn;
		const child = spawn([command, ...args], {
			cwd: options.cwd,
			env: options.env,
			stderr: 'ignore',
			stdout: options.captureStdout ? 'pipe' : 'ignore',
			windowsHide: false,
		});
		const timer = setTimer(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeout);
		try {
			const output = options.captureStdout ? new Response(child.stdout).text() : Promise.resolve('');
			[exitCode, stdout] = await Promise.all([child.exited, output]);
		} finally {
			clearTimer(timer);
		}
	} else {
		const spawn = options.nodeSpawn || nodeSpawn;
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ['ignore', options.captureStdout ? 'pipe' : 'ignore', 'ignore'],
			windowsHide: false,
		});
		const chunks = [];
		if (options.captureStdout) child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
		const timer = setTimer(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, timeout);
		try {
			exitCode = await new Promise((resolve, reject) => {
				child.once('error', reject);
				child.once('close', resolve);
			});
			stdout = options.captureStdout ? Buffer.concat(chunks).toString('utf8') : '';
		} finally {
			clearTimer(timer);
		}
	}

	if (timedOut) throw new Error('Windows ACL hardening subprocess timed out');
	if (exitCode !== 0) throw new Error(`Windows ACL hardening subprocess failed (exit ${exitCode})`);
	return stdout;
}

const WHOAMI_SID_CSV_ERROR = 'Windows ACL hardening could not resolve the current SID';

function readQuotedCsvCharacter(input, index, state) {
	const character = input[index];
	if (character === '\r' || character === '\n') {
		throw new Error(WHOAMI_SID_CSV_ERROR);
	}
	if (character !== '"') {
		state.field += character;
		return index;
	}
	if (input[index + 1] === '"') {
		state.field += '"';
		return index + 1;
	}
	state.inQuotes = false;
	state.closedQuote = true;
	return index;
}

function readUnquotedCsvCharacter(character, state) {
	if (character === '"') {
		if (state.field !== '') {
			throw new Error(WHOAMI_SID_CSV_ERROR);
		}
		state.inQuotes = true;
		return;
	}
	if (character === ',') {
		state.fields.push(state.field);
		state.field = '';
		return;
	}
	if (character === '\r' || character === '\n') {
		throw new Error(WHOAMI_SID_CSV_ERROR);
	}
	state.field += character;
}

function parseWhoamiCsvRecord(stdout) {
	const input = String(stdout).replace(/\r?\n$/, '');
	const state = { fields: [], field: '', inQuotes: false, closedQuote: false };
	for (let index = 0; index < input.length; index += 1) {
		const character = input[index];
		if (state.inQuotes) {
			index = readQuotedCsvCharacter(input, index, state);
		} else if (state.closedQuote) {
			if (character !== ',') {
				throw new Error(WHOAMI_SID_CSV_ERROR);
			}
			state.fields.push(state.field);
			state.field = '';
			state.closedQuote = false;
		} else {
			readUnquotedCsvCharacter(character, state);
		}
	}
	if (state.inQuotes) throw new Error(WHOAMI_SID_CSV_ERROR);
	state.fields.push(state.field);
	return state.fields;
}

function parseWhoamiSid(stdout) {
	const fields = parseWhoamiCsvRecord(stdout);
	const sid = fields[1];
	if (fields.length !== 2 || !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(sid || '')) {
		throw new Error('Windows ACL hardening could not resolve the current SID');
	}
	return sid;
}

async function secureWindowsPathsAcl(filePaths, options = {}) {
	if (!Array.isArray(filePaths) || filePaths.length === 0 || filePaths.length > 128) {
		throw new Error('Windows ACL hardening requires one to 128 targets');
	}
	for (const filePath of filePaths) {
		if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) {
			throw new Error('Windows ACL hardening requires valid target paths');
		}
	}
	const targetPaths = [...new Set(filePaths.map(filePath => path.win32.resolve(filePath)))];
	const environment = options.environment || process.env;
	const cscriptPath = resolveWindowsCscriptPath(environment);
	const whoamiPath = resolveWindowsSystemExecutable('whoami.exe', environment);
	const systemDirectory = path.win32.dirname(cscriptPath);
	const scriptPath = windowsAclScriptPath(options.fsApi || fs, options.packageRoot || getPackageRoot());
	const now = options.now || Date.now;
	const deadline = now() + (options.timeout || 15_000);
	const remainingTimeout = () => {
		const remaining = deadline - now();
		if (remaining <= 0) throw new Error('Windows ACL hardening subprocess timed out');
		return remaining;
	};
	const processOptions = {
		bunSpawn: options.bunSpawn,
		clearTimer: options.clearTimer,
		cwd: systemDirectory,
		nodeSpawn: options.nodeSpawn,
		runtime: options.runtime,
		setTimer: options.setTimer,
	};
	const sid = parseWhoamiSid(await runWindowsProcess(whoamiPath, ['/user', '/fo', 'csv', '/nh'], {
		...processOptions,
		captureStdout: true,
		env: { SystemRoot: environment.SystemRoot },
		timeout: remainingTimeout(),
	}));
	const childEnvironment = {
		FORGE_PRIVATE_ACL_COUNT: String(targetPaths.length),
		FORGE_PRIVATE_ACL_SID: sid,
		SystemRoot: environment.SystemRoot,
	};
	targetPaths.forEach((filePath, index) => {
		childEnvironment[`FORGE_PRIVATE_ACL_TARGET_${index}`] = filePath;
	});
	await runWindowsProcess(cscriptPath, ['//B', '//Nologo', '//E:JScript', '//T:14', scriptPath], {
		...processOptions,
		captureStdout: false,
		env: childEnvironment,
		timeout: remainingTimeout(),
	});
}

async function secureWindowsPathAcl(filePath) {
	await secureWindowsPathsAcl([filePath]);
}

async function createPrivateBackupDirectory(backupPath, options = {}) {
	const directory = fs.mkdtempSync(path.join(path.dirname(backupPath), '.forge-sqlite-backup-'));
	try {
		if (process.platform === 'win32') await (options.hardenPath || secureWindowsPathAcl)(directory);
		else {
			fs.chmodSync(directory, 0o700);
			if ((Number(fs.statSync(directory).mode) & 0o077) !== 0) throw new Error('mode remains broader than 0700');
		}
	} catch (error) {
		fs.rmSync(directory, { recursive: true, force: true });
		throw new ClaimRepairError(
			'CLAIM_REPAIR_BACKUP_PERMISSIONS',
			'SQLite backup workspace could not be secured with owner-only permissions',
			{ cause: error.message || String(error) },
		);
	}
	return directory;
}

async function createSafeBackup(runtime, db, databasePath, backupPath, options = {}) {
	assertSafeBackupDestination(databasePath, backupPath);
	ensureFileBackedDatabaseDirectory(backupPath);
	const hardenPath = options.hardenPath || hardenBackupPermissions;
	const tempDirectory = await createPrivateBackupDirectory(backupPath, { hardenPath });
	const tempPath = path.join(tempDirectory, `${path.basename(backupPath)}.${process.pid}.${randomUUID()}.tmp`);
	const backupWriter = options.backupWriter || createBackup;
	const backupVerifier = options.backupVerifier || verifyBackupFile;
	const backupReplacer = options.backupReplacer || (options.noReplace
		? ((source, destination) => (process.platform === 'win32'
			? fs.linkSync(source, destination)
			: fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL)))
		: ((source, destination) => fs.renameSync(source, destination)));
	try {
		await backupWriter(runtime, db, tempPath);
		await hardenPath(tempPath);
		await backupVerifier(runtime, tempPath);
		await backupReplacer(tempPath, backupPath);
		await hardenPath(backupPath);
	} finally {
		fs.rmSync(tempDirectory, { recursive: true, force: true });
	}
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
	return createDriver(runtime, options.databasePath, options);
}

module.exports = {
	BUILTIN_SQLITE_RUNTIME_ORDER,
	CONFLICT_SIGNAL,
	classifyConflictSignal,
	createBuiltinSQLiteDriver,
	hardenBackupPermissions,
	hardenBackupPermissionsBatch,
	requireSqliteRuntimeModule,
	resolveWindowsCscriptPath,
	secureWindowsPathsAcl,
	selectBuiltinSQLiteRuntime,
	syncClaimRepairRecoveryDirectory,
	validateBuiltinSQLiteRuntimeDriver,
	WINDOWS_PRIVATE_ACL_SCRIPT_PATH,
	WINDOWS_PRIVATE_ACL_SCRIPT_SHA256,
	_runWindowsProcess: runWindowsProcess,
};
