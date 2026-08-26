'use strict';

/**
 * Side-effecting half of owner-row shepherd reconciliation. The filesystem
 * lease elects one repository daemon; all per-PR lifecycle changes go through
 * the narrow watch-owner APIs.
 *
 * @module pr-monitor/reconcile-executor
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const shepherdLease = require('./shepherd-lease');
const watchOwner = require('./watch-owner');
const { reconcile: defaultReconcile } = require('./reconcile');
const { tick: defaultTick } = require('./reconcile-tick');
const { startPrWatcherDetached, forgeBin } = require('./watch-lifecycle');
const { privacySafeIdentity } = require('./flow-monitor');
const { processIdentityAlive, defaultPidStartedAt } = require('./process-identity');
const brokerMod = require('../kernel/broker');
const { secureExecFileSync } = require('../shell-utils');

const CANONICAL_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GH_COMMAND_TIMEOUT_MS = 30_000;
const MAX_OPEN_PRS = 1000;
const MAX_ACTIONS_PER_PASS = 128;
const MAX_LEGACY_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_MIGRATION_ATTEMPTS = 3;
const MAX_MONITOR_ID_LENGTH = 128;
const OWNER_HEARTBEAT_STALE_MS = 4 * 60_000;

function normalizeRepository(value) {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toLowerCase();
	return CANONICAL_REPOSITORY.test(normalized) ? normalized : null;
}

function legacyMonitorId(repo, pr) {
	const raw = privacySafeIdentity(`pr:${privacySafeIdentity(repo)}:${pr}`);
	return raw.length <= MAX_MONITOR_ID_LENGTH
		? raw
		: `pr:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

function resolveCanonicalRepository(runGh) {
	try {
		const raw = runGh(['repo', 'view', '--json', 'nameWithOwner,parent']);
		const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return normalizeRepository(value?.parent?.nameWithOwner || value?.nameWithOwner);
	} catch {
		return null;
	}
}

function githubRunner(opts = {}) {
	return opts.runGh || ((args) => secureExecFileSync('gh', args, {
		cwd: opts.projectRoot || process.cwd(), encoding: 'utf8', timeout: GH_COMMAND_TIMEOUT_MS, windowsHide: true,
	}));
}

function writeDaemonDiagnostic(gitCommonDir, entry, opts = {}) {
	if (!gitCommonDir) return false;
	try {
		const dir = path.join(gitCommonDir, 'forge');
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, 'shepherd-daemon.ndjson'), `${JSON.stringify(entry)}\n`, {
			encoding: 'utf8', mode: 0o600,
		});
		return true;
	} catch (error) {
		try { opts.onDiagnosticError?.(error); } catch { /* diagnostics remain best effort */ }
		return false;
	}
}

function recordDaemonDiagnostic(opts, gitCommonDir, kind, detail) {
	const entry = {
		kind,
		at: new Date((opts.now || (() => Date.now()))()).toISOString(),
		...(detail ? { detail: String(detail?.message || detail).slice(0, 500) } : {}),
	};
	try {
		(opts.writeDaemonDiagnostic || writeDaemonDiagnostic)(gitCommonDir, entry, opts);
	} catch { /* diagnostics never affect daemon lifecycle */ }
}

async function gatherDesired(gitCommonDir, opts = {}) {
	const runGh = githubRunner(opts);
	const suppliedRepo = normalizeRepository(opts.repo);
	const repo = suppliedRepo || resolveCanonicalRepository(runGh);
	if (!repo) return { openPrs: [], gitCommonDir, listingOk: false, repositoryOk: false };

	let ghPrs;
	try {
		const raw = runGh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(MAX_OPEN_PRS + 1), '--json', 'number,headRefName,headRefOid']);
		ghPrs = typeof raw === 'string' ? JSON.parse(raw) : raw;
		if (!Array.isArray(ghPrs)) throw new TypeError('PR listing is not an array');
		if (ghPrs.length > MAX_OPEN_PRS) throw new RangeError('PR listing exceeds safe reconciliation bound');
	} catch {
		return { openPrs: [], gitCommonDir, listingOk: false, repositoryOk: true, repo };
	}

	let prRows = [];
	try {
		if (opts.broker) prRows = await opts.broker.listOpenPrs(gitCommonDir);
	} catch {
		return { openPrs: [], gitCommonDir, listingOk: false, repositoryOk: true, repo };
	}
	const exactRows = new Map();
	for (const row of Array.isArray(prRows) ? prRows : []) {
		const rowRepo = normalizeRepository(row?.repo);
		const number = Number(row?.number);
		if (rowRepo !== repo || !Number.isSafeInteger(number) || number <= 0) continue;
		const current = exactRows.get(number);
		if (current) return { openPrs: [], gitCommonDir, listingOk: false, repositoryOk: false, repo };
		exactRows.set(number, row);
	}
	const openPrs = ghPrs.map((item) => {
		const number = Number(item?.number);
		const row = exactRows.get(number);
		return {
			repo,
			number,
			branch: item?.headRefName ?? null,
			headSha: item?.headRefOid ?? null,
			issueId: row?.issue_id ?? null,
			worktreeId: row?.worktree_id ?? null,
			journalPtr: row?.journal_ptr ?? null,
		};
	});
	if (openPrs.some(item => !Number.isSafeInteger(item.number) || item.number <= 0)) {
		return { openPrs: [], gitCommonDir, listingOk: false, repositoryOk: false, repo };
	}
	return { openPrs, gitCommonDir, listingOk: true, repositoryOk: true, repo };
}

function ownerOptions(ctx) {
	const isPidAlive = ctx.ownerOptions?.isPidAlive || ctx.isAlive || shepherdLease.pidAlive;
	// Both halves of an identity proof must describe the same process. A caller that
	// supplies its own liveness answer (tests, cached legacy evidence) is answering for
	// PIDs the built-in /proc probe knows nothing about, so pairing that answer with the
	// built-in probe would compare a fabricated PID's liveness against a real process's
	// start time and "prove" reuse. The built-in probe travels with the built-in
	// liveness check only; otherwise identity stays unprovable.
	const pidStartedAt = ctx.ownerOptions?.pidStartedAt || ctx.pidStartedAt
		|| (isPidAlive === shepherdLease.pidAlive ? defaultPidStartedAt : null);
	return {
		...(ctx.ownerOptions || {}),
		...(ctx.driver ? { driver: ctx.driver } : {}),
		...(ctx.databaseConfig ? { databaseConfig: ctx.databaseConfig } : {}),
		isPidAlive,
		pidStartedAt,
		verifyProviderEvidence: ctx.ownerOptions?.verifyProviderEvidence
			|| (async (evidence, expected) => expected.states.includes(String(evidence?.state || '').toLowerCase())),
		verifyTerminalReceipt: ctx.ownerOptions?.verifyTerminalReceipt
			|| ctx.verifyTerminalReceipt
			|| (async () => false),
	};
}

async function gatherObserved(gitCommonDir, _lock, opts = {}) {
	let prRows = [];
	try {
		if (opts.broker) prRows = await opts.broker.listOpenPrs(gitCommonDir);
	} catch {
		return { prRows: [], ownerRows: [], ownerRowsOk: false, migrationGate: null };
	}
	const authority = opts.authority || watchOwner;
	const options = ownerOptions(opts);
	const listed = await authority.enumerateOwners({}, options);
	const gate = typeof authority.readMigrationGate === 'function'
		? await authority.readMigrationGate({}, options)
		: { ok: false, reason: 'authority_unavailable' };
	if (!listed?.ok || !Array.isArray(listed.records) || !gate?.ok || !gate.gate) {
		return {
			prRows: Array.isArray(prRows) ? prRows : [], ownerRows: [], ownerRowsOk: false,
			migrationGate: gate?.gate || null,
		};
	}
	const isAlive = options.isPidAlive;
	const pidStartedAt = options.pidStartedAt;
	const observedAt = Number((opts.now || (() => Date.now()))());
	const heartbeatStaleMs = opts.ownerHeartbeatStaleMs ?? OWNER_HEARTBEAT_STALE_MS;
	const ownerRows = [];
	for (const record of listed.records) {
		const next = { ...record };
		if (record.controllerPid != null) {
			// The controller itself wrote this row at `updatedAt`, so it was running then.
			// A process holding the same number that booted afterwards is a different
			// process: the controller is gone and the PID was reused. Recovery must not
			// defer to it, and the proof travels with the row so the authority
			// transaction can accept recovery instead of rejecting on a bare live PID.
			const controllerState = await processIdentityAlive({
				pid: record.controllerPid, startedAt: record.updatedAt, isPidAlive: isAlive, pidStartedAt,
			});
			next.controllerAlive = controllerState === 'alive';
			if (controllerState === 'reused') next.controllerPidReuseProven = true;
		}
		if (record.watcherPid != null) {
			// The watcher stamps `heartbeatAt` itself, making it the tightest honest
			// marker for watcher identity.
			const watcherState = await processIdentityAlive({
				pid: record.watcherPid, startedAt: record.heartbeatAt, isPidAlive: isAlive, pidStartedAt,
			});
			if (watcherState === 'reused') next.watcherPidReuseProven = true;
			const pidAlive = watcherState === 'alive';
			const heartbeatRequired = record.phase === 'running'
				|| record.phase === 'stop_requested'
				|| record.phase === 'terminal_pending';
			const heartbeatAt = Date.parse(record.heartbeatAt);
			const heartbeatFresh = Number.isFinite(heartbeatAt)
				&& Number.isFinite(observedAt)
				&& observedAt >= heartbeatAt
				&& observedAt - heartbeatAt <= heartbeatStaleMs;
			next.watcherAlive = pidAlive && (!heartbeatRequired || heartbeatFresh);
		}
		ownerRows.push(next);
	}
	return {
		prRows: Array.isArray(prRows) ? prRows : [], ownerRows, ownerRowsOk: true,
		migrationGate: gate.gate,
	};
}

function identity(recordOrPr) {
	return { repo: recordOrPr.repo, pr: Number(recordOrPr.pr ?? recordOrPr.number) };
}

function operationInput(record) {
	return { generation: record.generation, pid: record.watcherPid };
}

async function bindSpawned(reservation, pr, s) {
	if (!reservation?.ok || !reservation.record) return reservation || { ok: false, reason: 'reservation_failed' };
	const record = reservation.record;
	let spawned;
	try {
		spawned = await s.spawnWatcher({
			prNumber: pr.number,
			repository: pr.repo,
			reservation,
			controllerPid: s.controllerPid,
			cwd: s.projectRoot,
			gitCommonDir: s.gitCommonDir,
			owner: s.authority,
			ownerOptions: s.options,
		});
	} catch {
		spawned = null;
	}
	const pid = Number(spawned?.pid);
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		return s.authority.abortStarting(identity(pr), {
			generation: record.generation, controllerPid: s.controllerPid,
		}, s.options);
	}
	return s.authority.bindRunning(identity(pr), {
		generation: record.generation, controllerPid: s.controllerPid, pid,
	}, s.options);
}

const ACTION_HANDLERS = {
	async reserveWatcher(action, s) {
		const result = await s.authority.reserveStarting(identity(action.pr), {
			controllerPid: s.controllerPid,
		}, s.options);
		return bindSpawned(result, action.pr, s);
	},
	async recoverStarting(action, s) {
		const result = await s.authority.recoverDeadStarting(identity(action.owner), {
			generation: action.owner.generation,
			controllerPid: action.owner.controllerPid,
			recoveryControllerPid: s.controllerPid,
			pidReuseProven: action.owner.controllerPidReuseProven === true,
		}, s.options);
		return bindSpawned(result, action.pr || { repo: action.owner.repo, number: action.owner.pr }, s);
	},
	async retryStarting(action, s) {
		const released = await s.authority.abortStarting(identity(action.owner), {
			generation: action.owner.generation, controllerPid: s.controllerPid,
		}, s.options);
		if (!released?.ok || released.changed !== true) {
			return released || { ok: false, reason: 'starting_release_failed' };
		}
		const pr = action.pr || { repo: action.owner.repo, number: action.owner.pr };
		const reservation = await s.authority.reserveStarting(identity(pr), {
			controllerPid: s.controllerPid,
		}, s.options);
		return bindSpawned(reservation, pr, s);
	},
	async recoverWatcher(action, s) {
		const result = await s.authority.recoverDeadWatcher(identity(action.owner), {
			...operationInput(action.owner),
			recoveryControllerPid: s.controllerPid,
			pidReuseProven: action.owner.watcherPidReuseProven === true,
			providerEvidence: { state: action.providerState },
		}, s.options);
		return bindSpawned(result, action.pr || { repo: action.owner.repo, number: action.owner.pr }, s);
	},
	async reopenWatcher(action, s) {
		const result = await s.authority.reserveReopened(identity(action.owner), {
			generation: action.owner.generation,
			expectedReceiptId: action.owner.terminalReceiptId,
			controllerPid: s.controllerPid,
			providerEvidence: { state: 'open' },
		}, s.options);
		return bindSpawned(result, action.pr, s);
	},
	async requestStop(action, s) {
		return s.authority.requestStop(identity(action.owner), operationInput(action.owner), s.options);
	},
	async completeTerminal(action, s) {
		return s.authority.completeTerminal(identity(action.owner), {
			...operationInput(action.owner),
			terminalReceiptId: action.owner.terminalReceiptId,
		}, s.options);
	},
	async recheckLegacyBlocked(action, s) {
		const complete = action.providerState === 'terminal' && action.owner.terminalReceiptId;
		return s.authority.recheckLegacyBlocked(identity(action.owner), {
			generation: action.owner.generation,
			legacyEvidenceHash: action.owner.legacyEvidenceHash,
			pid: action.owner.watcherPid,
			action: complete ? 'complete' : 'release',
			...(complete ? { terminalReceiptId: action.owner.terminalReceiptId } : {}),
		}, s.options);
	},
	async upsertPrRow(action, s) {
		if (!s.broker) return { ok: false, reason: 'kernel_unavailable' };
		try {
			const result = await s.broker.upsertPr(action.row);
			return result === false || result?.ok === false
				? { ok: false, reason: 'kernel_write_failed' }
				: { ok: true, changed: true };
		} catch {
			return { ok: false, reason: 'kernel_write_failed' };
		}
	},
	async retire(action, s) {
		if (!s.broker) return { ok: false, reason: 'kernel_unavailable' };
		try {
			await s.broker.retirePr(
				{ git_common_dir: s.gitCommonDir, repo: action.pr.repo, number: action.pr.number },
				{ state: 'closed', retired_at: new Date(s.now()).toISOString() },
			);
			return { ok: true, changed: true };
		} catch {
			return { ok: false, reason: 'kernel_write_failed' };
		}
	},
};

async function execute(actions, ctx = {}) {
	if (!Array.isArray(actions)) {
		const error = new TypeError('Reconcile actions must be an array');
		error.code = 'INVALID_ACTIONS';
		throw error;
	}
	const authority = ctx.authority || watchOwner;
	const s = {
		authority,
		options: ownerOptions(ctx),
		controllerPid: Number.isSafeInteger(ctx.controllerPid) && ctx.controllerPid > 0 ? ctx.controllerPid : process.pid,
		spawnWatcher: ctx.spawnWatcher || startPrWatcherDetached,
		broker: ctx.broker || null,
		projectRoot: ctx.projectRoot,
		gitCommonDir: ctx.gitCommonDir,
		now: ctx.now || (() => Date.now()),
	};
	let changed = false;
	const results = [];
	for (const action of actions.slice(0, MAX_ACTIONS_PER_PASS)) {
		const handler = ACTION_HANDLERS[action?.type];
		if (!handler) continue;
		const result = await handler(action, s);
		results.push({ type: action.type, result });
		changed ||= result?.changed === true;
		if (result?.ok === false && (action.type === 'upsertPrRow' || result.reason === 'authority_unavailable')) break;
	}
	return { ok: results.every(item => item.result?.ok !== false), changed, results };
}

function activeOwnerCount(records) {
	return records.filter(record => record.phase !== 'complete').length;
}

async function convergeOnce(projectRoot, opts = {}) {
	const gitCommonDir = opts.gitCommonDir;
	const desired = opts.gatherDesired
		? await opts.gatherDesired()
		: await gatherDesired(gitCommonDir, { ...opts, projectRoot });
	if (!desired || desired.listingOk === false || desired.repositoryOk === false) {
		return { actions: [], desiredCount: null, authorityOk: false, activeOwnerCount: null, listingOk: false };
	}
	const observed = opts.gatherObserved
		? await opts.gatherObserved()
		: await gatherObserved(gitCommonDir, null, { ...opts, projectRoot });
	const controllerPid = Number.isSafeInteger(opts.controllerPid) && opts.controllerPid > 0
		? opts.controllerPid
		: process.pid;
	const decision = (opts.reconcile || defaultReconcile)(
		{ ...desired, controllerPid }, observed, (opts.now || (() => Date.now()))(),
	);
	const actions = Array.isArray(decision?.actions) ? decision.actions : [];
	const execution = await (opts.execute || execute)(actions, { ...opts, projectRoot, gitCommonDir });

	const authority = opts.authority || watchOwner;
	const listed = await authority.enumerateOwners({}, ownerOptions(opts));
	const authorityOk = listed?.ok === true && Array.isArray(listed.records);
	return {
		actions,
		desiredCount: desired.openPrs.length,
		authorityOk,
		activeOwnerCount: authorityOk ? activeOwnerCount(listed.records) : null,
		executionOk: execution?.ok === true,
	};
}

function daemonCanRetire(convergence) {
	return convergence?.desiredCount === 0
		&& convergence.authorityOk === true
		&& convergence.activeOwnerCount === 0
		&& convergence.executionOk !== false;
}

function stableJson(value) {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value).sort((left, right) => left.localeCompare(right)).map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

const LEGACY_HASH_ENTRY_FIELDS = [
	'repo', 'pr', 'pid', 'startedAt', 'terminalReceiptId', 'providerState', 'legacyPhase',
	'generation', 'controllerPid', 'blockReason',
	'lifecycleConflict', 'legacyEvidence',
];

function projectLegacyHashEntry(entry) {
	const projected = {};
	for (const field of LEGACY_HASH_ENTRY_FIELDS) {
		if (Object.hasOwn(entry || {}, field)) projected[field] = entry[field];
	}
	return projected;
}

function hashLegacyEntry(entry) {
	return crypto.createHash('sha256').update(stableJson(projectLegacyHashEntry(entry))).digest('hex');
}

// Legacy discovery labels each root by how the *invoking* checkout reached it, so the same
// shared marker is recorded as `.forge/pr-monitor/...` from the primary checkout and
// `git-common-root/.forge/pr-monitor/...` from a linked worktree. Hash a checkout-independent
// identity instead, or an interrupted cutover resumed from another checkout self-conflicts.
const LEGACY_ROOT_LABELS = [
	'git-common-root/.forge/pr-monitor',
	'git-common/forge/pr-monitor',
	'.forge/pr-monitor',
];

function canonicalMarkerPath(rawPath) {
	let value = String(rawPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
	for (const label of LEGACY_ROOT_LABELS) {
		if (value === label || value.startsWith(`${label}/`)) {
			value = value.slice(label.length).replace(/^\/+/, '');
			break;
		}
	}
	return process.platform === 'win32' ? value.toLowerCase() : value;
}

function canonicalMarkers(sources) {
	const unique = new Map();
	for (const source of sources) {
		const marker = { path: canonicalMarkerPath(source?.path), content: source?.content };
		unique.set(stableJson(marker), marker);
	}
	return [...unique.values()].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function hashLegacySnapshot(snapshot) {
	const canonical = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
		? {
			corrupt: snapshot.corrupt === true,
			unmappable: snapshot.unmappable === true,
			entries: (Array.isArray(snapshot.entries) ? snapshot.entries : [])
				.map(projectLegacyHashEntry)
				.sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
			markers: canonicalMarkers((Array.isArray(snapshot.sources) ? snapshot.sources : [])
				.filter(source => /generation|cleanup/i.test(path.basename(String(source?.path || ''))))),
		}
		: snapshot;
	const encoded = stableJson(canonical);
	if (Buffer.byteLength(encoded, 'utf8') > MAX_LEGACY_SNAPSHOT_BYTES) {
		const error = new Error('Legacy watcher snapshot exceeds the migration bound');
		error.code = 'LEGACY_SNAPSHOT_TOO_LARGE';
		throw error;
	}
	return crypto.createHash('sha256').update(encoded).digest('hex');
}

const LEGACY_LIFECYCLE_FIELDS = [
	'pid', 'startedAt', 'terminalReceiptId', 'providerState', 'legacyPhase',
	'generation', 'controllerPid', 'blockReason',
];

function consolidateLegacyEntries(rawEntries) {
	const grouped = new Map();
	let unmappable = false;
	for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
		const repo = normalizeRepository(raw?.repo);
		const pr = Number(raw?.pr);
		if (!repo || !Number.isSafeInteger(pr) || pr <= 0) {
			unmappable = true;
			continue;
		}
		const key = `${repo}#${pr}`;
		let group = grouped.get(key);
		if (!group) {
			group = { repo, pr, values: {}, evidence: new Map(), lifecycleConflict: false };
			grouped.set(key, group);
		}
		const normalized = { repo, pr };
		for (const field of LEGACY_LIFECYCLE_FIELDS) {
			const value = raw?.[field] == null ? null : raw[field];
			normalized[field] = value;
			if (value == null) continue;
			if (group.values[field] != null && stableJson(group.values[field]) !== stableJson(value)) {
				group.lifecycleConflict = true;
			} else {
				group.values[field] = value;
			}
		}
		group.evidence.set(stableJson(normalized), normalized);
	}
	const entries = [...grouped.values()].map(group => ({
		repo: group.repo,
		pr: group.pr,
		...group.values,
		lifecycleConflict: group.lifecycleConflict,
		legacyEvidence: [...group.evidence.values()].sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
	})).sort((left, right) => left.repo.localeCompare(right.repo) || left.pr - right.pr);
	return { entries, unmappable };
}

const OWNER_REREAD_FIELDS = [
	'version', 'repo', 'pr', 'generation', 'phase', 'controllerPid', 'watcherPid',
	'startedAt', 'updatedAt', 'heartbeatAt', 'terminalReceiptId', 'blockReason', 'legacyEvidenceHash',
];

function ownerRereadProjection(record, fields = OWNER_REREAD_FIELDS) {
	const projected = {};
	for (const field of fields) {
		if (Object.hasOwn(record || {}, field)) projected[field] = record[field];
	}
	return projected;
}

function ownerRowsMatch(expectedRows, actualRows) {
	if (expectedRows.length !== actualRows.length) return false;
	const actualByKey = new Map();
	for (const row of actualRows) {
		const key = `${row?.repo}#${row?.pr}`;
		if (actualByKey.has(key)) return false;
		actualByKey.set(key, row);
	}
	return expectedRows.every((expected) => {
		const actual = actualByKey.get(`${expected.repo}#${expected.pr}`);
		if (!actual) return false;
		const fields = OWNER_REREAD_FIELDS.filter(field => Object.hasOwn(expected, field));
		return stableJson(ownerRereadProjection(actual, fields)) === stableJson(ownerRereadProjection(expected, fields));
	});
}

function readOptionalFile(file) {
	try { return fs.readFileSync(file, 'utf8'); } catch (error) {
		if (error?.code === 'ENOENT') return null;
		throw error;
	}
}

function defaultReadLegacySnapshot(projectRoot, opts = {}) {
	const gitCommonDir = opts.gitCommonDir || brokerMod.resolveGitCommonDir(projectRoot);
	const repo = normalizeRepository(opts.repo);
	const readDirectory = opts.readDirectory || fs.readdirSync;
	const sources = [];
	const entries = [];
	let unmappable = false;
	const commonRoot = path.basename(gitCommonDir).toLowerCase() === '.git'
		? path.dirname(gitCommonDir) : projectRoot;
	const leaseFile = path.join(gitCommonDir, 'forge', 'shepherd.lock');
	const leaseRaw = readOptionalFile(leaseFile);
	if (leaseRaw != null) {
		let lease;
		try { lease = JSON.parse(leaseRaw); } catch { return { entries, sources, corrupt: true, unmappable: false }; }
		const legacyWatchers = Array.isArray(lease.watchers) ? lease.watchers : [];
		sources.push({ path: 'shepherd.lock#watchers', content: stableJson(legacyWatchers) });
		for (const watcher of legacyWatchers) {
			const value = typeof watcher === 'number' ? { pr: watcher } : watcher;
			const pr = Number(value?.pr);
			const identityRepo = normalizeRepository(value?.repo) || repo;
			if (!identityRepo || !Number.isSafeInteger(pr) || pr <= 0) { unmappable = true; continue; }
			entries.push({ repo: identityRepo, pr, pid: Number(value?.pid) || null, startedAt: value?.startedAt || null });
		}
	}
	const roots = [
		{ dir: path.join(projectRoot, '.forge', 'pr-monitor'), label: '.forge/pr-monitor' },
		{ dir: path.join(commonRoot, '.forge', 'pr-monitor'), label: 'git-common-root/.forge/pr-monitor' },
		{ dir: path.join(gitCommonDir, 'forge', 'pr-monitor'), label: 'git-common/forge/pr-monitor' },
	];
	const seenRoots = new Set();
	for (const candidate of roots) {
		const resolved = path.resolve(candidate.dir).toLowerCase();
		if (seenRoots.has(resolved)) continue;
		seenRoots.add(resolved);
		let directories = [];
		try {
			directories = readDirectory(candidate.dir, { withFileTypes: true })
				.filter(item => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));
		}
		catch (error) { if (error?.code !== 'ENOENT') return { entries, sources, corrupt: true, unmappable }; }
		for (const directory of directories) {
			if (directory.name === 'owners') continue;
			const dir = path.join(candidate.dir, directory.name);
			const snapshotRaw = readOptionalFile(path.join(dir, 'snapshot.json'));
			const pidRaw = readOptionalFile(path.join(dir, 'watch.pid'));
			const startedAtRaw = readOptionalFile(path.join(dir, 'watch.startedat'));
			if (snapshotRaw == null && pidRaw == null && startedAtRaw == null) continue;
			const sourcePrefix = `${candidate.label}/${directory.name}`;
			sources.push({ path: `${sourcePrefix}/snapshot.json`, content: snapshotRaw });
			sources.push({ path: `${sourcePrefix}/watch.pid`, content: pidRaw });
			sources.push({ path: `${sourcePrefix}/watch.startedat`, content: startedAtRaw });
			let markerFiles = [];
			try {
				markerFiles = readDirectory(dir, { withFileTypes: true })
					.filter(item => item.isFile() && /(?:generation|cleanup)/i.test(item.name))
					.sort((left, right) => left.name.localeCompare(right.name));
			} catch (error) {
				if (error?.code !== 'ENOENT') return { entries, sources, corrupt: true, unmappable };
			}
			for (const marker of markerFiles) {
				sources.push({ path: `${sourcePrefix}/${marker.name}`, content: readOptionalFile(path.join(dir, marker.name)) });
			}
			let record;
			try { record = snapshotRaw == null ? null : JSON.parse(snapshotRaw); }
			catch { return { entries, sources, corrupt: true, unmappable }; }
			const snapshot = record?.snapshot || record;
			const terminalReceiptId = record?.terminalReceiptId || snapshot?.terminalReceiptId || null;
			const hasLifecycleAuthority = pidRaw != null || startedAtRaw != null || markerFiles.length > 0
				|| terminalReceiptId != null || record?.startedAt != null || snapshot?.startedAt != null;
			const identityRepo = normalizeRepository(snapshot?.repo) || repo;
			const pr = Number(snapshot?.pr);
			if (!identityRepo || !Number.isSafeInteger(pr) || pr <= 0) { unmappable = true; continue; }
			if (!hasLifecycleAuthority) continue;
			entries.push({
				repo: identityRepo,
				pr,
				pid: pidRaw == null ? null : Number(pidRaw.trim()),
				startedAt: snapshot?.startedAt || startedAtRaw?.trim() || null,
				terminalReceiptId,
				providerState: snapshot?.state || null,
			});
		}
		const ownersRoot = path.join(candidate.dir, 'owners');
		let ownerDirectories = [];
		try {
			ownerDirectories = readDirectory(ownersRoot, { withFileTypes: true })
				.filter(item => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));
		}
		catch (error) { if (error?.code !== 'ENOENT') return { entries, sources, corrupt: true, unmappable }; }
		for (const directory of ownerDirectories) {
			const relative = `${candidate.label}/owners/${directory.name}/watch.owner.json`;
			const raw = readOptionalFile(path.join(ownersRoot, directory.name, 'watch.owner.json'));
			if (raw == null) continue;
			sources.push({ path: relative, content: raw });
			let record;
			try { record = JSON.parse(raw); } catch { return { entries, sources, corrupt: true, unmappable }; }
			const identityRepo = normalizeRepository(record?.repo);
			const pr = Number(record?.pr);
			if (!identityRepo || !Number.isSafeInteger(pr) || pr <= 0) { unmappable = true; continue; }
			entries.push({
				repo: identityRepo,
				pr,
				pid: record.pid == null ? null : Number(record.pid),
				startedAt: record.startedAt || null,
				terminalReceiptId: record.terminalReceiptId || null,
				legacyPhase: record.phase || null,
				generation: record.generation || null,
				controllerPid: record.controllerPid == null ? null : Number(record.controllerPid),
				blockReason: record.blockReason || null,
			});
		}
	}
	entries.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
	sources.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
	return { entries, sources, corrupt: false, unmappable };
}

async function defaultReadProviderState(entry, opts = {}) {
	const runGh = githubRunner(opts);
	try {
		const raw = runGh(['pr', 'view', String(entry.pr), '--repo', entry.repo, '--json', 'state']);
		const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
		return typeof value?.state === 'string' ? value.state.toLowerCase() : null;
	} catch {
		return null;
	}
}

async function collectLegacyEntryEvidence(entry, options, opts, projectRoot) {
	const ctx = identity(entry);
	const pid = Number(entry.pid);
	let hasPid = Number.isSafeInteger(pid) && pid > 0;
	let pidState = false;
	let pidReused = false;
	// A bare `isPidAlive` hit is not proof the LEGACY watcher is alive: an unrelated
	// long-lived process may have inherited the number. Importing that as
	// blocked/legacy_live_pid is unrecoverable, because every later recheck sees the
	// same live PID and the PR stays unwatched forever. Compare the process start time
	// against the legacy start marker; a process that booted materially AFTER the
	// marker cannot be the watcher that wrote it, so its PID evidence is discarded.
	// An unknown start time changes nothing (fail closed on the live PID).
	if (hasPid) {
		let identityState;
		try {
			identityState = await processIdentityAlive({
				pid,
				startedAt: entry.startedAt,
				isPidAlive: options.isPidAlive,
				pidStartedAt: options.pidStartedAt,
			});
		} catch { identityState = 'unknown'; }
		if (identityState === 'alive') pidState = true;
		else if (identityState === 'unknown') pidState = null;
		else pidState = false;
		if (identityState === 'reused') {
			hasPid = false;
			pidReused = true;
		}
	}
	let conflictingPidUnsafe = false;
	if (entry.lifecycleConflict) {
		const conflictPids = [...new Set((entry.legacyEvidence || [])
			.map(value => Number(value?.pid)).filter(value => Number.isSafeInteger(value) && value > 0))];
		for (const conflictPid of conflictPids) {
			try {
				if (await options.isPidAlive(conflictPid) !== false) conflictingPidUnsafe = true;
			} catch { conflictingPidUnsafe = true; }
		}
	}
	let providerState = '';
	let providerReadable;
	try {
		providerState = String(
			await (opts.readProviderState || defaultReadProviderState)(entry, { ...opts, projectRoot }) || '',
		).toLowerCase();
		providerReadable = providerState.length > 0;
	} catch { providerReadable = false; }
	const providerTerminal = ['closed', 'merged', 'terminal'].includes(providerState);
	let providerVerified = false;
	if ((hasPid || pidReused) && providerState === 'open' && typeof options.verifyProviderEvidence === 'function') {
		try {
			providerVerified = await options.verifyProviderEvidence(
				{ state: providerState }, { ...ctx, states: ['open'] },
			) === true;
		} catch { providerVerified = false; }
	}
	let receiptVerified = false;
	if (entry.terminalReceiptId && providerTerminal && typeof options.verifyTerminalReceipt === 'function') {
		try { receiptVerified = await options.verifyTerminalReceipt(entry.terminalReceiptId, ctx) === true; }
		catch { receiptVerified = false; }
	}
	return {
		entry,
		entryHash: hashLegacyEntry(entry),
		ctx,
		pid,
		hasPid,
		pidState,
		providerState,
		providerReadable,
		providerTerminal,
		providerVerified,
		receiptVerified,
		conflictingPidUnsafe,
		pidReused,
	};
}

function cachedLegacyEvidenceOptions(options, evidence) {
	const sameIdentity = value => value?.repo === evidence.ctx.repo && value?.pr === evidence.ctx.pr;
	return {
		...options,
		isPidAlive: async pid => (pid === evidence.pid ? evidence.pidState : null),
		// Cached liveness has no start-time counterpart; identity was already settled
		// while the evidence was collected.
		pidStartedAt: null,
		verifyProviderEvidence: async (providerEvidence, expected) => evidence.providerVerified
			&& sameIdentity(expected)
			&& String(providerEvidence?.state || '').toLowerCase() === evidence.providerState
			&& Array.isArray(expected?.states)
			&& expected.states.includes(evidence.providerState),
		verifyTerminalReceipt: async (receipt, ownerIdentity) => evidence.receiptVerified
			&& sameIdentity(ownerIdentity)
			&& receipt === evidence.entry.terminalReceiptId,
	};
}

async function migrateLegacyAuthority(projectRoot, opts = {}) {
	const authority = opts.authority || watchOwner;
	const options = ownerOptions(opts);
	const now = new Date((opts.now || (() => Date.now()))()).toISOString();
	const readSnapshot = opts.readLegacySnapshot || (() => defaultReadLegacySnapshot(projectRoot, opts));
	// Legacy verification calls the SYNCHRONOUS provider runner once per entry, so the
	// heartbeat timer started by the daemon cannot fire while a read is in flight. A
	// handful of reads near the 30s command timeout would otherwise age the lease past
	// its 90s TTL, let a concurrent trigger reclaim it, and leave two controllers
	// mutating the same cutover gate. Stamp the lease around every entry, and re-verify
	// ownership by token before any mutation that commits migration results.
	const leaseGuarded = opts.token !== undefined && opts.token !== null;
	const stampLease = opts.stampLease || (opts.acquire ? () => true : shepherdLease.stamp);
	const ownsLease = opts.ownsLease || (opts.acquire ? () => true : shepherdLease.owns);
	const leaseArgs = { gitCommonDir: opts.gitCommonDir, token: opts.token };
	const heartbeatLease = () => {
		if (!leaseGuarded) return;
		try { stampLease(projectRoot, leaseArgs); } catch { /* best effort — ownership is rechecked below */ }
	};
	const holdsLease = () => {
		if (!leaseGuarded) return true;
		try { return ownsLease(projectRoot, leaseArgs) === true; } catch { return false; }
	};
	const initialGate = await authority.readMigrationGate({}, options);
	if (initialGate?.ok && initialGate.gate?.state === 'complete') {
		const completedSnapshot = await readSnapshot();
		const completedHash = hashLegacySnapshot(completedSnapshot);
		if (completedSnapshot?.corrupt || completedHash !== initialGate.gate.snapshot_hash) {
			return {
				ok: true, state: 'complete', snapshotHash: initialGate.gate.snapshot_hash,
				cleanupPending: true, reason: 'legacy_source_changed',
			};
		}
		try { await opts.cleanupLegacyEvidence?.(completedSnapshot); } catch {
			return { ok: true, state: 'complete', snapshotHash: completedHash, cleanupPending: true };
		}
		return { ok: true, state: 'complete', snapshotHash: completedHash };
	}
	if (initialGate?.ok && initialGate.gate?.state === 'conflict') {
		return { ok: false, state: 'conflict', reason: initialGate.gate.conflict_code || 'legacy_owner_conflict' };
	}
	if (!initialGate?.ok && initialGate?.reason !== 'absent') {
		return { ok: false, state: 'quarantined', reason: initialGate?.reason || 'authority_unavailable' };
	}
	const quarantined = initialGate?.ok
		? initialGate
		: await authority.publishMigrationQuarantine({ updatedAt: now }, options);
	if (!quarantined?.ok || quarantined.gate?.state !== 'quarantined') {
		return { ok: false, state: 'quarantined', reason: quarantined?.reason || 'authority_unavailable' };
	}
	const migrationStartedAt = quarantined.gate?.updated_at || now;
	// This process is the migrating controller; it owns rows whose legacy controller
	// PID proved reused and therefore cannot be trusted.
	const migrationControllerPid = Number.isSafeInteger(Number(opts.controllerPid)) && Number(opts.controllerPid) > 0
		? Number(opts.controllerPid)
		: process.pid;
	let snapshot;
	let snapshotHash;
	let verifiedEntries;
	for (let attempt = 0; attempt < MAX_MIGRATION_ATTEMPTS; attempt += 1) {
		const first = await readSnapshot();
		const firstHash = hashLegacySnapshot(first);
		const consolidated = first && !first.corrupt
			? consolidateLegacyEntries(first.entries)
			: null;
		const evidence = [];
		if (consolidated && !first.unmappable && !consolidated.unmappable) {
			for (const entry of consolidated.entries) {
				heartbeatLease();
				evidence.push(await collectLegacyEntryEvidence(entry, options, opts, projectRoot));
				heartbeatLease();
			}
		}
		if (!holdsLease()) return { ok: false, state: 'quarantined', reason: 'lease_lost' };
		const second = await readSnapshot();
		const secondHash = hashLegacySnapshot(second);
		if (firstHash === secondHash) {
			snapshot = second;
			snapshotHash = secondHash;
			if (consolidated && (first.unmappable || consolidated.unmappable)) {
				await authority.publishMigrationConflict({
					snapshotHash, conflictCode: 'legacy_identity_unmappable', updatedAt: now,
				}, options);
				return { ok: false, state: 'conflict', reason: 'legacy_identity_unmappable' };
			}
			verifiedEntries = consolidated ? evidence : null;
			break;
		}
		if (attempt === MAX_MIGRATION_ATTEMPTS - 1) {
			await authority.publishMigrationConflict({
				snapshotHash: secondHash, conflictCode: 'legacy_snapshot_changed', updatedAt: now,
			}, options);
			return { ok: false, state: 'conflict', reason: 'legacy_snapshot_changed' };
		}
	}
	if (!snapshot || snapshot.corrupt) {
		await authority.publishMigrationConflict({
			snapshotHash, conflictCode: 'legacy_owner_conflict', updatedAt: now,
		}, options);
		return { ok: false, state: 'conflict', reason: 'legacy_owner_conflict' };
	}
	if (verifiedEntries?.some(entry => entry.conflictingPidUnsafe)) {
		await authority.publishMigrationConflict({
			snapshotHash, conflictCode: 'legacy_owner_conflict', updatedAt: now,
		}, options);
		return { ok: false, state: 'conflict', reason: 'legacy_owner_conflict' };
	}
	// Ownership is rechecked BEFORE every mutation, not only after: a lease reclaimed
	// during the preceding await must not be able to bind a snapshot or write a single
	// owner row on the way to reporting lease_lost.
	if (!holdsLease()) return { ok: false, state: 'quarantined', reason: 'lease_lost' };
	const bound = await authority.bindMigrationSnapshot({ snapshotHash, updatedAt: now }, options);
	if (!bound?.ok) return { ok: false, state: 'conflict', reason: bound?.reason || 'snapshot_mismatch' };
	if (verifiedEntries?.some(entry => !entry.providerReadable)) {
		return { ok: false, state: 'quarantined', reason: 'legacy_provider_unreadable' };
	}

	const expectedRows = [];
	for (const evidence of verifiedEntries || []) {
		const {
			entry, entryHash, ctx, pid, hasPid, pidState, providerState, providerReadable,
			providerTerminal, providerVerified, receiptVerified, pidReused,
		} = evidence;
		if (!holdsLease()) return { ok: false, state: 'quarantined', reason: 'lease_lost' };
		const operationOptions = cachedLegacyEvidenceOptions(options, evidence);
		let result;
		if (entry.lifecycleConflict) {
			result = await authority.markLegacyBlocked(ctx, {
				blockReason: 'legacy_conflict', snapshotHash, legacyEvidenceHash: entryHash,
				startedAt: entry.startedAt || migrationStartedAt,
			}, operationOptions);
		} else if (pidState == null) {
			result = await authority.markLegacyBlocked(ctx, {
				blockReason: 'legacy_unreadable', snapshotHash, legacyEvidenceHash: entryHash,
				startedAt: entry.startedAt || migrationStartedAt,
			}, operationOptions);
		} else if (pidState === true) {
			result = await authority.markLegacyBlocked(ctx, {
				blockReason: 'legacy_live_pid', pid, snapshotHash, legacyEvidenceHash: entryHash,
				...(providerTerminal && receiptVerified ? { terminalReceiptId: entry.terminalReceiptId } : {}),
				startedAt: entry.startedAt || migrationStartedAt,
			}, operationOptions);
		} else if (entry.terminalReceiptId && providerTerminal && receiptVerified) {
			result = await authority.importLegacyComplete(ctx, {
				snapshotHash, legacyEvidenceHash: entryHash, legacyPid: hasPid ? pid : null,
				terminalReceiptId: entry.terminalReceiptId, startedAt: entry.startedAt || migrationStartedAt,
			}, operationOptions);
		} else if (entry.terminalReceiptId && providerTerminal) {
			result = await authority.markLegacyBlocked(ctx, {
				blockReason: 'legacy_receipt_unverified', terminalReceiptId: entry.terminalReceiptId,
				snapshotHash, legacyEvidenceHash: entryHash, startedAt: entry.startedAt || migrationStartedAt,
			}, operationOptions);
		} else if (!providerReadable) {
			result = await authority.markLegacyBlocked(ctx, {
				blockReason: 'legacy_unreadable', snapshotHash, legacyEvidenceHash: entryHash,
				startedAt: entry.startedAt || migrationStartedAt,
			}, operationOptions);
		} else if ((hasPid || pidReused) && providerState === 'open' && providerVerified
			&& typeof authority.importLegacyStarting === 'function') {
			// A proven-reused PID is proof the legacy watcher is DEAD, so an open PR must
			// import as a recoverable starting row rather than falling through to the
			// permanent blocked/legacy_lossy branch below (only legacy_live_pid blocks are
			// ever rechecked, and any blocked row suppresses inline passes). The reused
			// number must not become the controller — that would defer recovery to an
			// unrelated live process — so this migrating controller adopts the row.
			result = await authority.importLegacyStarting(ctx, {
				snapshotHash, legacyEvidenceHash: entryHash, legacyPid: pid,
				controllerPid: pidReused ? migrationControllerPid : pid,
				providerEvidence: { state: 'open' }, startedAt: entry.startedAt || migrationStartedAt,
			}, operationOptions);
		} else if (providerState === 'open') {
			result = await authority.markLegacyBlocked(ctx, {
				blockReason: hasPid ? 'legacy_unreadable' : 'legacy_lossy',
				snapshotHash, legacyEvidenceHash: entryHash, startedAt: entry.startedAt || migrationStartedAt,
			}, operationOptions);
		} else {
			result = await authority.markLegacyBlocked(ctx, {
				blockReason: providerState ? 'legacy_receipt_unverified' : 'legacy_lossy',
				snapshotHash, legacyEvidenceHash: entryHash, startedAt: entry.startedAt || migrationStartedAt,
			}, operationOptions);
		}
		// A migration that crashed mid-import leaves durable rows it already wrote. If
		// the PR's provider state has since drifted (an open PR that has closed), the
		// resumed pass legitimately selects a DIFFERENT decision and the authority
		// rejects it against the surviving row as `owner_conflict`. That is ordinary
		// drift, not two writers disagreeing: the durable row carries THIS entry's
		// legacy evidence hash, so it is our own prior import. Adopt it rather than
		// escalating to a repo-wide migration conflict that would disable every
		// watcher launch and inline pass. Only a row whose legacy evidence hash
		// differs is genuinely divergent.
		const priorImport = !result?.ok && result?.reason === 'owner_conflict'
			&& result.record && result.record.legacyEvidenceHash === entryHash
			? result.record
			: null;
		if (priorImport) {
			expectedRows.push(ownerRereadProjection(priorImport));
			continue;
		}
		if (!result?.ok || !result.record) {
			await authority.publishMigrationConflict({
				snapshotHash, conflictCode: 'legacy_owner_conflict', updatedAt: now,
			}, options);
			return { ok: false, state: 'conflict', reason: 'legacy_owner_conflict' };
		}
		expectedRows.push(ownerRereadProjection(result.record));
	}

	const rereadSnapshot = await readSnapshot();
	const rows = await authority.enumerateOwners({}, options);
	const gate = await authority.readMigrationGate({}, options);
	const exact = hashLegacySnapshot(rereadSnapshot) === snapshotHash
		&& rows?.ok === true
		&& gate?.ok === true
		&& gate.gate?.state === 'quarantined'
		&& gate.gate?.snapshot_hash === snapshotHash
		&& ownerRowsMatch(expectedRows, rows.records);
	if (!exact) return { ok: false, state: 'quarantined', reason: 'legacy_reread_mismatch' };
	if (!holdsLease()) return { ok: false, state: 'quarantined', reason: 'lease_lost' };
	const completed = await authority.completeMigrationGate({ snapshotHash, updatedAt: now }, options);
	if (!completed?.ok) return { ok: false, state: 'quarantined', reason: completed?.reason || 'gate_mismatch' };
	try { await opts.cleanupLegacyEvidence?.(snapshot); } catch {
		return { ok: true, state: 'complete', snapshotHash, cleanupPending: true };
	}
	return { ok: true, state: 'complete', snapshotHash };
}

async function defaultBuildBroker({ projectRoot, gitCommonDir }) {
	const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
	const { createMonitorStore } = require('../../packages/memory');
	const deps = await buildMigratedKernelIssueDeps({ projectRoot, gitCommonDir });
	const store = createMonitorStore(deps.kernelDriver);
	return {
		broker: deps.kernelBroker,
		driver: deps.kernelDriver,
		databaseConfig: { databasePath: deps.kernelDatabasePath },
		verifyTerminalReceipt: async (receiptId, ownerIdentity) => {
			const state = await store.readDeliveryState(legacyMonitorId(ownerIdentity.repo, ownerIdentity.pr));
			return state?.terminal_receipt?.object_id === receiptId;
		},
	};
}

async function runDaemon(projectRoot, opts = {}) {
	const gitCommonDir = opts.gitCommonDir || brokerMod.resolveGitCommonDir(projectRoot);
	const acquire = opts.acquire || shepherdLease.acquire;
	const release = opts.release || shepherdLease.release;
	const startHeartbeat = opts.startHeartbeat || shepherdLease.startHeartbeat;
	const stopHeartbeat = opts.stopHeartbeat || shepherdLease.stopHeartbeat;
	const ownsLease = opts.ownsLease || (opts.acquire ? (() => true) : shepherdLease.owns);
	const exit = typeof opts.exit === 'function' ? opts.exit : (opts.exit === false ? () => {} : code => process.exit(code));
	const held = acquire(projectRoot, { gitCommonDir });
	if (!held.ok) {
		// Distinguish "someone else legitimately owns the lease" from "the lease
		// file is unreadable and its bytes were deliberately left in place" — the
		// latter needs an operator, not a retry, and migration has NOT run yet.
		const reason = held.legacyMigrationPending === true
			? (held.reason || 'legacy-lease-unreadable')
			: 'foreign-lease';
		if (reason !== 'foreign-lease') recordDaemonDiagnostic(opts, gitCommonDir, reason);
		exit(0);
		return { ok: false, reason };
	}
	const token = held.token;
	const heartbeat = startHeartbeat(projectRoot, { gitCommonDir, token });
	const ownsBroker = !opts.broker;
	let built = null;
	try {
		built = opts.broker
			? { broker: opts.broker, driver: opts.driver, databaseConfig: opts.databaseConfig }
			: await (opts.buildBroker || defaultBuildBroker)({ projectRoot, gitCommonDir });
	} catch {
		built = null;
	}
	const retire = async () => {
		try { release(projectRoot, { gitCommonDir, token }); } catch { /* token-guarded best effort */ }
		try { stopHeartbeat(heartbeat); } catch { /* best effort */ }
		if (ownsBroker) {
			try { await built?.broker?.close?.(); } catch { /* best effort */ }
		}
	};
	if (!built?.driver) {
		await retire();
		return { ok: false, reason: 'authority-unavailable' };
	}
	const runGh = githubRunner({ ...opts, projectRoot });
	const repo = normalizeRepository(opts.repo) || resolveCanonicalRepository(runGh);
	if (!repo) {
		await retire();
		return { ok: false, reason: 'repository-unavailable' };
	}
	const args = {
		...opts, gitCommonDir, broker: built.broker, driver: built.driver, repo, runGh,
		databaseConfig: built.databaseConfig,
		verifyTerminalReceipt: opts.verifyTerminalReceipt || built.verifyTerminalReceipt,
		token,
	};
	let migration;
	try {
		migration = await (opts.migrateLegacyAuthority || migrateLegacyAuthority)(projectRoot, args);
	} catch (error) {
		recordDaemonDiagnostic(opts, gitCommonDir, 'migration-failed', error);
		await retire();
		return { ok: false, reason: 'migration-failed' };
	}
	if (!migration?.ok) {
		recordDaemonDiagnostic(opts, gitCommonDir, 'migration-blocked', migration?.reason);
		await retire();
		return { ok: false, reason: migration?.reason || 'migration-blocked' };
	}
	const converge = opts.convergeOnce || convergeOnce;
	if (opts.once) {
		const result = await converge(projectRoot, args);
		if (daemonCanRetire(result)) await retire();
		return { ok: true, token, ...result };
	}

	let stopped = false;
	let inFlight = false;
	let timer = null;
	const retireForLeaseLoss = async () => {
		stopped = true;
		if (timer) clearInterval(timer);
		recordDaemonDiagnostic(opts, gitCommonDir, 'lease-lost');
		await retire();
		exit(0);
	};
	const stillOwns = () => {
		try { return ownsLease(projectRoot, { gitCommonDir, token }); } catch { return false; }
	};
	const runPass = async () => {
		if (stopped || inFlight) return;
		if (!stillOwns()) { await retireForLeaseLoss(); return; }
		inFlight = true;
		try {
			const result = await converge(projectRoot, args);
			if (!stillOwns()) { await retireForLeaseLoss(); return; }
			if (daemonCanRetire(result)) {
				stopped = true;
				if (timer) clearInterval(timer);
				await retire();
				exit(0);
			}
		} catch (error) {
			recordDaemonDiagnostic(opts, gitCommonDir, 'converge-failed', error);
			if (!stillOwns()) await retireForLeaseLoss();
		} finally {
			inFlight = false;
		}
	};
	await runPass();
	if (stopped) return { ok: true, token, retired: true };
	timer = setInterval(runPass, opts.intervalMs || 60_000);
	const onSignal = async () => { await retire(); exit(0); };
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
	return { ok: true, token, heartbeat, timer };
}

function launchDaemon(ctx = {}) {
	const commonRoot = path.basename(ctx.gitCommonDir || '').toLowerCase() === '.git'
		? path.dirname(ctx.gitCommonDir) : ctx.projectRoot;
	if (ctx.harness?.hasBgShell && typeof ctx.harness.runBgShell === 'function') {
		try {
			ctx.harness.runBgShell([process.execPath, forgeBin(), 'shepherd', 'daemon'], { cwd: commonRoot });
			return { launched: true, via: 'bg-shell' };
		} catch { /* detached fallback */ }
	}
	try {
		const child = (ctx.spawnProcess || spawn)(process.execPath, [forgeBin(), 'shepherd', 'daemon'], {
			cwd: commonRoot, detached: true, stdio: 'ignore', windowsHide: true,
		});
		child?.on?.('error', error => recordDaemonDiagnostic(ctx, ctx.gitCommonDir, 'launch-failed', error));
		child?.unref?.();
		return { launched: true, via: 'detached', pid: child?.pid ?? null };
	} catch (error) {
		recordDaemonDiagnostic(ctx, ctx.gitCommonDir, 'launch-failed', error);
		return { launched: false };
	}
}

function railAutoShepherdEnabled(projectRoot) {
	try { return require('../commands/ship').autoShepherdRailEnabled(projectRoot); }
	catch { return true; }
}

function kernelInitialized(projectRoot) {
	try {
		const gitPath = path.join(projectRoot, '.git');
		const stat = fs.statSync(gitPath);
		let commonDir = gitPath;
		if (!stat.isDirectory()) {
			const match = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitPath, 'utf8'));
			if (!match) return false;
			const worktreeGitDir = path.resolve(projectRoot, match[1].trim());
			const marker = `${path.sep}worktrees${path.sep}`;
			const index = worktreeGitDir.lastIndexOf(marker);
			commonDir = index >= 0 ? worktreeGitDir.slice(0, index) : worktreeGitDir;
		}
		return fs.existsSync(path.join(commonDir, 'forge', 'kernel.sqlite'));
	} catch { return false; }
}

function fireAndForget(ctx = {}) {
	try {
		const env = ctx.env || process.env;
		if (env.FORGE_SHEPHERD_DISABLE || env.NODE_ENV === 'test' || env.BUN_ENV === 'test'
			|| env.CI || env.GITHUB_ACTIONS || env.GITLAB_CI || ctx.dryRun || !ctx.projectRoot) return;
		if (!(ctx.kernelInitialized || kernelInitialized)(ctx.projectRoot)) return;
		if (!(ctx.railEnabled || railAutoShepherdEnabled)(ctx.projectRoot)) return;
		const gitCommonDir = ctx.gitCommonDir
			|| brokerMod.resolveGitCommonDir(ctx.projectRoot, { warn: () => {} });
		const acquire = ctx.acquire || shepherdLease.acquire;
		const release = ctx.release || shepherdLease.release;
		let token = null;
		let legacyMigrationPending = false;
		const enumerate = () => {
			const result = acquire(ctx.projectRoot, { gitCommonDir, preserveLegacy: true });
			if (result.ok) token = result.token;
			legacyMigrationPending = result.legacyMigrationPending === true;
			return { desired: { openPrs: [], gitCommonDir }, observed: { ownerRows: [], ownerRowsOk: false, prRows: [] } };
		};
		const executeTick = () => {
			if (token == null && !legacyMigrationPending) return;
			const held = token;
			token = null;
			legacyMigrationPending = false;
			if (held != null) {
				try { release(ctx.projectRoot, { gitCommonDir, token: held }); } catch { /* best effort */ }
			}
			try { (ctx.launch || launchDaemon)({ ...ctx, gitCommonDir }); } catch { /* best effort */ }
		};
		(ctx.tick || defaultTick)({
			gitCommonDir, now: ctx.now, enumerate, execute: executeTick, minInterval: ctx.minInterval,
		});
	} catch { /* never affect triggering command */ }
}

module.exports = {
	normalizeRepository,
	gatherDesired,
	gatherObserved,
	execute,
	convergeOnce,
	runDaemon,
	launchDaemon,
	writeDaemonDiagnostic,
	defaultBuildBroker,
	migrateLegacyAuthority,
	defaultReadLegacySnapshot,
	defaultReadProviderState,
	hashLegacySnapshot,
	fireAndForget,
};
