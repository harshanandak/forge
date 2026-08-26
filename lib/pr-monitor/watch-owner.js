'use strict';

const journal = require('./journal');
const { processIdentityAlive } = require('./process-identity');

const VERSION = 1;
const MAX_REPO_BYTES = 256;
const MAX_GENERATION_BYTES = 128;
const MAX_RECEIPT_BYTES = 256;
const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PHASES = new Set(['starting', 'running', 'stop_requested', 'terminal_pending', 'complete', 'blocked']);
const BLOCK_REASONS = new Set([
	'legacy_live_pid',
	'legacy_conflict',
	'legacy_unreadable',
	'legacy_lossy',
	'legacy_receipt_unverified',
]);
const CONFLICT_CODES = new Set([
	'legacy_identity_unmappable',
	'legacy_snapshot_changed',
	'legacy_owner_conflict',
]);
const GATE_STATES = new Set(['quarantined', 'conflict', 'complete']);
const MONOTONIC_OWNER_METHODS = new Set([
	'watchOwnerReserveReopened', 'watchOwnerBindRunning', 'watchOwnerHeartbeat',
	'watchOwnerRequestStop', 'watchOwnerRecordTerminal', 'watchOwnerCompleteTerminal',
	'watchOwnerRecoverDeadStarting', 'watchOwnerRecoverDeadWatcher',
	'watchOwnerMarkLegacyBlocked', 'watchOwnerRecheckLegacyBlocked',
	'watchOwnerImportLegacyStarting', 'watchOwnerImportLegacyComplete',
]);

const MUTATION_INPUT_FIELDS = [
	'generation', 'controllerPid', 'pid', 'recoveryControllerPid',
	'expectedReceiptId', 'providerEvidence', 'terminalReceiptId',
	'blockReason', 'legacyEvidenceHash', 'snapshotHash', 'legacyPid',
	'action', 'updatedAt', 'startedAt', 'conflictCode', 'pidReuseProven',
	'expectedSnapshotHash', 'expectedConflictCode', 'replacementSnapshotHash',
];
const CAPTURED_INPUT = Symbol('capturedMutationInput');
const BOUND_OPTIONS = new WeakSet();
// Mirror of the builtin driver's enumeration caps (lib/kernel/sqlite-driver.js
// WATCH_OWNER_ENUMERATION_LIMIT/BYTES) so alternate adapters cannot allocate
// without bound through the public enumerateOwners API.
const OWNER_ENUMERATION_LIMIT = 4_096;
const OWNER_ENUMERATION_BYTES = 4 * 1024 * 1024;

function utf8Length(value) {
	return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : -1;
}

function positivePid(value) {
	return Number.isSafeInteger(value) && value > 0;
}

function canonicalTimestamp(value) {
	if (typeof value !== 'string' || utf8Length(value) !== 24 || !TIMESTAMP.test(value)) return false;
	try {
		return new Date(value).toISOString() === value;
	} catch {
		return false;
	}
}

function boundedString(value, maximum) {
	const bytes = utf8Length(value);
	return bytes > 0 && bytes <= maximum;
}

function validHash(value) {
	return typeof value === 'string' && SHA256.test(value);
}

function normalizeIdentity(ctx) {
	try {
		const repoValue = ctx?.repo;
		const pr = ctx?.pr;
		const repo = typeof repoValue === 'string' ? repoValue.toLowerCase() : '';
		if (!REPOSITORY.test(repo) || utf8Length(repo) > MAX_REPO_BYTES
			|| !Number.isSafeInteger(pr) || pr <= 0) return null;
		return { repo, pr };
	} catch {
		return null;
	}
}

// Read the caller's identity exactly once per operation and freeze it: an
// accessor-backed (or clock-mutated) ctx must not present repository A to the
// mutation and repository B to the CAS evidence read.
function captureIdentity(ctx) {
	const identity = normalizeIdentity(ctx);
	return identity ? Object.freeze(identity) : null;
}

function nowIso(opts = {}, fallback) {
	try {
		const value = fallback !== undefined
			? fallback
			: (opts.now !== undefined
				? (typeof opts.now === 'function' ? opts.now() : opts.now)
				: new Date().toISOString());
		return canonicalTimestamp(value) ? value : null;
	} catch {
		return null;
	}
}

function fromSqliteOwnerRow(row) {
	if (!row) return null;
	return {
		repo: row.repo,
		pr: row.pr,
		version: row.version,
		generation: row.generation,
		phase: row.phase,
		controllerPid: row.controller_pid,
		watcherPid: row.watcher_pid,
		startedAt: row.started_at,
		updatedAt: row.updated_at,
		heartbeatAt: row.heartbeat_at,
		terminalReceiptId: row.terminal_receipt_id,
		blockReason: row.block_reason,
		legacyEvidenceHash: row.legacy_evidence_hash,
	};
}

function captureRecord(record) {
	try {
		return {
			repo: record.repo,
			pr: record.pr,
			version: record.version,
			generation: record.generation,
			phase: record.phase,
			controllerPid: record.controllerPid,
			watcherPid: record.watcherPid,
			startedAt: record.startedAt,
			updatedAt: record.updatedAt,
			heartbeatAt: record.heartbeatAt,
			terminalReceiptId: record.terminalReceiptId,
			blockReason: record.blockReason,
			legacyEvidenceHash: record.legacyEvidenceHash,
		};
	} catch {
		return null;
	}
}

function validateRecord(record) {
	if (!record || typeof record !== 'object' || Array.isArray(record)) return 'invalid_identity';
	const value = captureRecord(record);
	if (!value) return 'invalid_record';
	const identity = normalizeIdentity(value);
	if (!identity || value.repo !== identity.repo || value.version !== VERSION) return 'invalid_identity';
	if (!boundedString(value.generation, MAX_GENERATION_BYTES) || !PHASES.has(value.phase)) return 'invalid_generation_or_phase';
	if (!canonicalTimestamp(value.startedAt) || !canonicalTimestamp(value.updatedAt)
		|| value.updatedAt < value.startedAt) return 'invalid_timestamp';
	if (value.heartbeatAt != null && !canonicalTimestamp(value.heartbeatAt)) return 'invalid_heartbeat';
	if (['running', 'stop_requested', 'terminal_pending'].includes(value.phase)
		&& value.heartbeatAt != null
		&& (value.heartbeatAt < value.startedAt || value.heartbeatAt > value.updatedAt)) return 'invalid_heartbeat';
	if (value.terminalReceiptId != null && !boundedString(value.terminalReceiptId, MAX_RECEIPT_BYTES)) return 'invalid_receipt';
	if (value.legacyEvidenceHash != null && !validHash(value.legacyEvidenceHash)) return 'invalid_evidence';
	if (value.controllerPid != null && !positivePid(value.controllerPid)) return 'invalid_controller_pid';
	if (value.watcherPid != null && !positivePid(value.watcherPid)) return 'invalid_watcher_pid';
	if (value.phase === 'starting') {
		return positivePid(value.controllerPid) && value.watcherPid == null && value.heartbeatAt == null
			&& value.terminalReceiptId == null && value.blockReason == null
			? null : 'invalid_starting';
	}
	if (value.phase === 'running' || value.phase === 'stop_requested') {
		return value.controllerPid == null && positivePid(value.watcherPid) && value.heartbeatAt != null
			&& value.terminalReceiptId == null && value.blockReason == null
			? null : 'invalid_active';
	}
	if (value.phase === 'terminal_pending') {
		return value.controllerPid == null && positivePid(value.watcherPid) && value.heartbeatAt != null
			&& value.terminalReceiptId != null && value.blockReason == null ? null : 'invalid_terminal_pending';
	}
	if (value.phase === 'complete') {
		return value.controllerPid == null && value.watcherPid == null && value.heartbeatAt == null
			&& value.terminalReceiptId != null && value.blockReason == null ? null : 'invalid_complete';
	}
	if (!BLOCK_REASONS.has(value.blockReason) || value.controllerPid != null || value.heartbeatAt != null
		|| !validHash(value.legacyEvidenceHash)) return 'invalid_blocked';
	return (value.blockReason === 'legacy_live_pid') === positivePid(value.watcherPid)
		? null : 'invalid_blocked_pid';
}

function copyMigrationGate(gate) {
	try {
		if (!gate || typeof gate !== 'object' || Array.isArray(gate)) return null;
		const copy = {
			singleton: gate.singleton,
			state: gate.state,
			snapshot_hash: gate.snapshot_hash,
			conflict_code: gate.conflict_code,
			updated_at: gate.updated_at,
		};
		if (copy.singleton !== 1 || !GATE_STATES.has(copy.state)
			|| !canonicalTimestamp(copy.updated_at)) return null;
		if (copy.state === 'quarantined') {
			if (copy.snapshot_hash != null && !validHash(copy.snapshot_hash)) return null;
			if (copy.conflict_code != null) return null;
		} else {
			if (!validHash(copy.snapshot_hash)) return null;
			if (copy.state === 'complete'
				? copy.conflict_code != null
				: !CONFLICT_CODES.has(copy.conflict_code)) return null;
		}
		return copy;
	} catch {
		return null;
	}
}

function sameMigrationGate(left, right) {
	if (left == null || right == null) return left == null && right == null;
	return ['singleton', 'state', 'snapshot_hash', 'conflict_code', 'updated_at']
		.every(field => Object.is(left[field], right[field]));
}

function gateMatchesMutation(method, input, gate, result) {
	// Every changed gate mutation stamps the durable checkpoint; only exact
	// idempotent replays may keep the prior timestamp.
	const advanced = result.changed === false
		? gate.updated_at <= input.now
		: gate.updated_at === input.now;
	const prior = input.expectedGate;
	if (result.reason === 'idempotent' && !sameMigrationGate(gate, prior)) return false;
	switch (method) {
	case 'watchGatePublishQuarantine':
		return gate.state === 'quarantined' && gate.conflict_code == null && advanced
			&& (result.reason === 'idempotent' ? prior?.state === 'quarantined' : prior == null);
	case 'watchGateBindSnapshot':
		return gate.state === 'quarantined' && gate.snapshot_hash === input.snapshotHash
			&& gate.conflict_code == null && advanced && prior?.state === 'quarantined'
			&& (result.reason === 'idempotent'
				? prior.snapshot_hash === input.snapshotHash
				: prior.snapshot_hash == null);
	case 'watchGatePublishConflict':
		return gate.state === 'conflict'
			&& gate.snapshot_hash === input.snapshotHash
			&& gate.conflict_code === input.conflictCode && advanced
			&& (result.reason === 'idempotent'
				? prior?.state === 'conflict'
				: prior?.state === 'quarantined' && prior.conflict_code == null
					&& (prior.snapshot_hash == null || prior.snapshot_hash === input.snapshotHash));
	case 'watchGateRetryConflict':
		return gate.state === 'quarantined'
			&& gate.snapshot_hash === input.replacementSnapshotHash
			&& gate.conflict_code == null && advanced
			&& prior?.state === 'conflict'
			&& prior.snapshot_hash === input.expectedSnapshotHash
			&& prior.conflict_code === input.expectedConflictCode;
	case 'watchGateCompleteMigration':
		return gate.state === 'complete' && gate.snapshot_hash === input.snapshotHash && gate.conflict_code == null
			&& advanced && (result.reason === 'idempotent'
				? prior?.state === 'complete'
				: prior?.state === 'quarantined' && prior.snapshot_hash === input.snapshotHash
					&& prior.conflict_code == null);
	default:
		return true;
	}
}

function envelope(ok, changed, reason, record = null) {
	return { ok, changed, reason, record };
}

function invalid(reason = 'invalid_input') {
	return envelope(false, false, reason);
}

function invalidGate(reason = 'invalid_input') {
	return { ok: false, changed: false, reason, gate: null };
}

function matchesIdentity(record, identity) {
	return record?.repo === identity.repo && record?.pr === identity.pr;
}

function matchesOwnerRecord(record, fields, phases) {
	if (!record || (phases && ![].concat(phases).includes(record.phase))) return false;
	return Object.entries(fields).every(([field, expected]) => Object.is(record[field], expected));
}

function matchesOwnerSnapshot(record, snapshot) {
	const expected = fromSqliteOwnerRow(snapshot);
	return expected != null && matchesOwnerRecord(record, expected);
}

function validOwnerSuccess(result, record, reason, fields, phases, allowIdempotent = false) {
	const idempotent = result.reason === 'idempotent';
	if ((!idempotent && result.reason !== reason) || (idempotent && !allowIdempotent)
		|| result.changed !== !idempotent) return false;
	return matchesOwnerRecord(record, fields, phases);
}

// Operations that rebuild the row mint a fresh generation; a success that kept
// the prior generation would be an un-recovered/un-reopened row, not a new one.
function mintedOwnerGeneration(input, record) {
	const priorGeneration = input.expectedSnapshot?.generation;
	if (priorGeneration == null) return false;
	return record != null && !Object.is(record.generation, priorGeneration);
}

// Import inserts mint a fresh generation while its idempotent replay keeps the
// original row, so the required relation to the prior snapshot flips by path.
// An idempotent replay without a captured prior row is impossible: replaying
// requires that a row was previously imported. expectedSnapshot fields are the
// raw snake_case driver row (deliberate).
function importedOwnerGeneration(result, input, record) {
	const priorGeneration = input.expectedSnapshot?.generation;
	if (!record) return false;
	if (result.reason === 'idempotent') {
		return priorGeneration != null && Object.is(record.generation, priorGeneration);
	}
	// A changed insert is only legal over an ABSENT owner; the builtin
	// transaction answers any existing row with owner_conflict/idempotent.
	return priorGeneration == null;
}

// A transitioned row must carry the submitted timestamp — an unchanged row
// returned as changed would fake durable-progress advancement. Idempotent
// replays legitimately keep their original timestamps.
function stampedOwnerTimestamp(result, input, record, field) {
	if (result.reason === 'idempotent') return true;
	return record != null && Object.is(record[field], input.now);
}

function validOwnerOperationResult(method, input, result, record) {
	if (method === 'watchOwnerRead') {
		return result.changed === false
			&& (result.reason === 'read') === (record != null)
			&& (record != null || result.reason === 'absent');
	}
	if (result.reason === 'idempotent'
		&& (!matchesOwnerSnapshot(record, input.expectedSnapshot)
			|| [record.updatedAt, record.heartbeatAt]
				.filter(Boolean)
				.some(timestamp => timestamp > input.now))) return false;
	switch (method) {
	case 'watchOwnerReserveStarting':
		return input.expectedSnapshot === null && validOwnerSuccess(result, record, 'acquired', {
			controllerPid: input.controllerPid, legacyEvidenceHash: null,
		}, 'starting')
			&& stampedOwnerTimestamp(result, input, record, 'startedAt')
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt');
	case 'watchOwnerReserveReopened': {
		const prior = input.expectedSnapshot;
		if (!prior) return false;
		return validOwnerSuccess(result, record, 'reopened', {
			controllerPid: input.controllerPid,
			legacyEvidenceHash: prior.legacy_evidence_hash,
		}, 'starting') && mintedOwnerGeneration(input, record)
			&& stampedOwnerTimestamp(result, input, record, 'startedAt')
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt');
	}
	case 'watchOwnerBindRunning': {
		// Imported provenance and the original started_at survive the bind.
		const prior = input.expectedSnapshot;
		if (!prior || prior.legacy_evidence_hash === undefined
			|| prior.started_at === undefined) return false;
		if ((prior.phase === 'running') !== (result.reason === 'idempotent')) return false;
		return validOwnerSuccess(result, record, 'bound', {
			generation: input.generation, watcherPid: input.watcherPid,
		}, 'running', true)
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt')
			&& stampedOwnerTimestamp(result, input, record, 'heartbeatAt')
			&& Object.is(record.legacyEvidenceHash, prior.legacy_evidence_hash)
			&& Object.is(record.startedAt, prior.started_at);
	}
	case 'watchOwnerHeartbeat': {
		const prior = input.expectedSnapshot;
		if (!prior || (prior.phase !== 'running' && prior.phase !== 'stop_requested')) return false;
		// Imported provenance and the original started_at survive the beat.
		if (prior.legacy_evidence_hash === undefined || prior.started_at === undefined) return false;
		return validOwnerSuccess(result, record, 'heartbeat', {
			generation: input.generation, watcherPid: input.watcherPid,
			updatedAt: input.now, heartbeatAt: input.now,
			legacyEvidenceHash: prior.legacy_evidence_hash,
			startedAt: prior.started_at,
		}, [prior.phase]);
	}
	case 'watchOwnerRequestStop': {
		const prior = input.expectedSnapshot;
		if (!prior || !['running', 'stop_requested'].includes(prior.phase)) return false;
		if ((prior.phase === 'stop_requested') !== (result.reason === 'idempotent')) return false;
		return validOwnerSuccess(result, record, 'stop_requested', {
			generation: input.generation, watcherPid: input.watcherPid,
			heartbeatAt: prior.heartbeat_at,
			legacyEvidenceHash: prior.legacy_evidence_hash, startedAt: prior.started_at,
		}, 'stop_requested', true) && stampedOwnerTimestamp(result, input, record, 'updatedAt');
	}
	case 'watchOwnerRecordTerminal': {
		const prior = input.expectedSnapshot;
		if (!prior || !['running', 'stop_requested', 'terminal_pending'].includes(prior.phase)) return false;
		if ((prior.phase === 'terminal_pending') !== (result.reason === 'idempotent')) return false;
		return validOwnerSuccess(result, record, 'terminal_pending', {
			generation: input.generation, watcherPid: input.watcherPid,
			terminalReceiptId: input.terminalReceiptId,
			heartbeatAt: prior.heartbeat_at,
			legacyEvidenceHash: prior.legacy_evidence_hash, startedAt: prior.started_at,
		}, 'terminal_pending', true) && stampedOwnerTimestamp(result, input, record, 'updatedAt');
	}
	case 'watchOwnerCompleteTerminal': {
		const prior = input.expectedSnapshot;
		if (!prior || !['terminal_pending', 'complete'].includes(prior.phase)) return false;
		if ((prior.phase === 'complete') !== (result.reason === 'idempotent')) return false;
		return validOwnerSuccess(result, record, 'complete', {
			generation: input.generation, watcherPid: null,
			terminalReceiptId: input.terminalReceiptId,
			legacyEvidenceHash: prior.legacy_evidence_hash, startedAt: prior.started_at,
		}, 'complete', true) && stampedOwnerTimestamp(result, input, record, 'updatedAt');
	}
	case 'watchOwnerAbortStarting': {
		if (!input.expectedSnapshot) return false;
		return result.reason === 'aborted' && result.changed === true && record === null;
	}
	case 'watchOwnerReleaseNonterminal': {
		const prior = input.expectedSnapshot;
		return prior?.phase === 'stop_requested'
			&& prior.generation === input.generation
			&& prior.watcher_pid === input.watcherPid
			&& result.reason === 'released' && result.changed === true && record === null;
	}
	case 'watchOwnerRecoverDeadStarting': {
		const prior = input.expectedSnapshot;
		if (!prior) return false;
		return validOwnerSuccess(result, record, 'recovered', {
			controllerPid: input.controllerPid,
			legacyEvidenceHash: prior.legacy_evidence_hash,
		}, 'starting') && mintedOwnerGeneration(input, record)
			&& stampedOwnerTimestamp(result, input, record, 'startedAt')
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt');
	}
	case 'watchOwnerRecoverDeadWatcher': {
		const prior = input.expectedSnapshot;
		if (!prior || prior.phase !== 'running') return false;
		return validOwnerSuccess(result, record, 'recovered', {
			controllerPid: input.controllerPid,
			legacyEvidenceHash: prior.legacy_evidence_hash,
		}, 'starting') && mintedOwnerGeneration(input, record)
			&& stampedOwnerTimestamp(result, input, record, 'startedAt')
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt');
	}
	case 'watchOwnerMarkLegacyBlocked':
		if (!quarantinedGateMatches(input) || (input.expectedSnapshot && result.reason !== 'idempotent')) return false;
		return validOwnerSuccess(result, record, 'blocked', {
			watcherPid: input.watcherPid, terminalReceiptId: input.terminalReceiptId ?? null,
			blockReason: input.blockReason, legacyEvidenceHash: input.legacyEvidenceHash,
		}, 'blocked', true)
			&& stampedOwnerTimestamp(result, input, record, 'startedAt')
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt');
	case 'watchOwnerRecheckLegacyBlocked': {
		if (input.action === 'release') {
			if (input.expectedSnapshot?.block_reason !== 'legacy_live_pid') return false;
			return result.reason === 'released' && result.changed === true && record === null;
		}
		const prior = input.expectedSnapshot;
		if (!prior || prior.phase !== 'blocked') return false;
		return validOwnerSuccess(result, record, 'complete', {
			generation: input.generation, watcherPid: null,
			terminalReceiptId: input.terminalReceiptId, blockReason: null,
			legacyEvidenceHash: prior.legacy_evidence_hash, startedAt: prior.started_at,
		}, 'complete') && stampedOwnerTimestamp(result, input, record, 'updatedAt');
	}
	case 'watchOwnerImportLegacyStarting':
		return quarantinedGateMatches(input) && validOwnerSuccess(result, record, 'imported', {
			controllerPid: input.controllerPid, legacyEvidenceHash: input.legacyEvidenceHash,
		}, 'starting', true) && importedOwnerGeneration(result, input, record)
			&& stampedOwnerTimestamp(result, input, record, 'startedAt')
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt');
	case 'watchOwnerImportLegacyComplete':
		return quarantinedGateMatches(input) && validOwnerSuccess(result, record, 'imported', {
			watcherPid: null, terminalReceiptId: input.terminalReceiptId,
			legacyEvidenceHash: input.legacyEvidenceHash,
		}, 'complete', true) && importedOwnerGeneration(result, input, record)
			&& stampedOwnerTimestamp(result, input, record, 'startedAt')
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt');
	default:
		return false;
	}
}

function quarantinedGateMatches(input) {
	return input.expectedGate?.state === 'quarantined'
		&& input.expectedGate.snapshot_hash === input.snapshotHash
		&& input.expectedGate.conflict_code == null;
}

function bindAuthorityOptions(opts = {}, methods = []) {
	try {
		if (BOUND_OPTIONS.has(opts)) return opts;
		const driver = opts?.driver;
		const databaseConfig = opts?.databaseConfig || {};
		const stableDatabaseConfig = databaseConfig && typeof databaseConfig === 'object'
			? Object.freeze({ ...databaseConfig })
			: databaseConfig;
		const authorityMethods = {};
		for (const method of methods) {
			const candidate = driver && typeof driver[method] === 'function' ? driver[method] : null;
			if (candidate) authorityMethods[method] = candidate.bind(driver);
		}
		const bound = {
			...opts,
			driver,
			databaseConfig: stableDatabaseConfig,
			authorityMethods: Object.freeze(authorityMethods),
		};
		BOUND_OPTIONS.add(bound);
		return Object.freeze(bound);
	} catch {
		return Object.freeze({ authorityMethods: Object.freeze({}) });
	}
}

function captureMutationInput(input = {}) {
	const captured = {};
	try {
		const hasUpdatedAt = input != null && Object.prototype.hasOwnProperty.call(input, 'updatedAt');
		const hasStartedAt = input != null && Object.prototype.hasOwnProperty.call(input, 'startedAt');
		for (const field of MUTATION_INPUT_FIELDS) captured[field] = input == null ? undefined : input[field];
		Object.defineProperty(captured, CAPTURED_INPUT, {
			value: { hasUpdatedAt, hasStartedAt },
		});
		return captured;
	} catch {
		return null;
	}
}

function invoke(method, identity, input, opts) {
	const operation = opts?.authorityMethods?.[method];
	if (typeof operation !== 'function') return invalid('authority_unavailable');
	if (ownerMutationRegresses(method, { ...identity, ...input })) return invalid('stale_evidence');
	try {
		const result = operation({ ...identity, ...input }, opts.databaseConfig || {});
		if (result && typeof result.then === 'function') {
			// Consume the orphaned rejection so a rejecting async adapter cannot crash the host.
			Promise.resolve(result).then(() => {}, () => {});
			return invalid('invalid_operation');
		}
		if (!result || typeof result !== 'object' || Array.isArray(result)) return invalid('corrupt');
		// Snapshot once: accessor-backed results must not flip between
		// validation and the returned envelope.
		const snap = {
			ok: result.ok === true,
			changed: result.changed === true,
			reason: typeof result.reason === 'string' ? result.reason : '',
			row: result.row,
		};
		const record = fromSqliteOwnerRow(snap.row);
		if (snap.row != null && (validateRecord(record) || !matchesIdentity(record, identity))) return invalid('corrupt');
		if (!snap.ok && snap.changed) return invalid('corrupt');
		if (snap.ok && !validOwnerOperationResult(method, { ...identity, ...input }, snap, record)) return invalid('corrupt');
		return envelope(snap.ok, snap.changed, snap.reason, record);
	} catch (error) {
		return invalid(error?.code === 'AUTHORITY_UNAVAILABLE' ? 'authority_unavailable' : 'store_error');
	}
}

function ownerMutationRegresses(method, input) {
	const prior = input.expectedSnapshot;
	if (!prior || !MONOTONIC_OWNER_METHODS.has(method)
		|| (method === 'watchOwnerRecheckLegacyBlocked' && input.action === 'release')) return false;
	return [prior.updated_at, prior.heartbeat_at]
		.filter(Boolean)
		.some(timestamp => Date.parse(input.now) < Date.parse(timestamp));
}

function captureAuthoritySnapshot(identity, opts) {
	if (!identity) return { ok: false, reason: 'invalid_input' };
	const operation = opts?.authorityMethods?.watchOwnerRead;
	if (typeof operation !== 'function') return { ok: false, reason: 'authority_unavailable' };
	try {
		const result = operation(identity, opts.databaseConfig || {});
		if (result && typeof result.then === 'function') {
			Promise.resolve(result).then(() => {}, () => {});
			return { ok: false, reason: 'invalid_operation' };
		}
		if (!result || typeof result !== 'object' || Array.isArray(result)) return { ok: false, reason: 'corrupt' };
		// Snapshot once: accessor-backed results must not flip between the
		// read-invariant probe and the evidence snapshot taken from them.
		const snap = {
			ok: result.ok === true,
			changed: result.changed === true,
			reason: typeof result.reason === 'string' ? result.reason : '',
			row: result.row,
		};
		if (!snap.ok && snap.changed) return { ok: false, reason: 'corrupt' };
		if (!snap.ok) return { ok: false, reason: snap.reason };
		// Bind the evidence to one plain copy of the row: accessor-backed
		// fields must not present different owners to the probe and the CAS
		// snapshot.
		let rawRow = null;
		if (snap.row != null) {
			if (typeof snap.row !== 'object' || Array.isArray(snap.row)) return { ok: false, reason: 'corrupt' };
			rawRow = { ...snap.row };
		}
		const probe = rawRow && fromSqliteOwnerRow(rawRow);
		if (snap.changed !== false
			|| (snap.reason === 'read') !== (probe != null)
			|| (probe == null && snap.reason !== 'absent')) {
			return { ok: false, reason: 'corrupt' };
		}
		if (!rawRow) return { ok: true, identity, snapshot: null };
		const record = fromSqliteOwnerRow(rawRow);
		if (validateRecord(record) || !matchesIdentity(record, identity)) return { ok: false, reason: 'corrupt' };
		return { ok: true, identity, snapshot: Object.freeze(rawRow) };
	} catch (error) {
		return { ok: false, reason: error?.code === 'AUTHORITY_UNAVAILABLE' ? 'authority_unavailable' : 'store_error' };
	}
}

async function evidenceVerified(identity, evidence, states, opts) {
	if (typeof opts.verifyProviderEvidence !== 'function') return false;
	try {
		return await opts.verifyProviderEvidence(evidence, { ...identity, states }) === true;
	} catch {
		return false;
	}
}

async function receiptVerified(identity, receipt, opts) {
	if (!boundedString(receipt, MAX_RECEIPT_BYTES) || typeof opts.verifyTerminalReceipt !== 'function') return false;
	try {
		return await opts.verifyTerminalReceipt(receipt, Object.freeze({ ...identity })) === true;
	} catch {
		return false;
	}
}

async function pidState(pid, opts) {
	const inspect = opts.isPidAlive || journal.pidAlive;
	try {
		return await inspect(pid);
	} catch {
		return null;
	}
}

/**
 * Recovery normally demands a dead PID. A caller that observed PID reuse may
 * instead present `pidReuseProven`, but the flag alone is never enough: this
 * authority re-derives the proof from the row's own marker (the timestamp the
 * owner process itself wrote) and an observed process start time. No flag, no
 * marker, or no start-time probe means no proof, and a live PID still blocks
 * recovery — fail closed.
 *
 * @param {number} pid
 * @param {string} marker owner-written timestamp the process must predate
 * @param {object} input captured mutation input
 * @param {object} opts bound authority options
 * @returns {Promise<boolean>} true when recovery may proceed
 */
async function pidDeadOrProvenReused(pid, marker, input, opts) {
	const state = await pidState(pid, opts);
	if (state === false) return true;
	if (input?.pidReuseProven !== true) return false;
	try {
		return await processIdentityAlive({
			pid, startedAt: marker, isPidAlive: async () => state, pidStartedAt: opts.pidStartedAt,
		}) === 'reused';
	} catch {
		return false;
	}
}

function mutationInput(identity, input, opts, { generation = true, now = true } = {}) {
	if (!identity) return null;
	const value = { ...identity };
	if (generation) {
		if (!boundedString(input?.generation, MAX_GENERATION_BYTES)) return null;
		value.generation = input.generation;
	}
	if (now) {
		const captured = input?.[CAPTURED_INPUT];
		const hasUpdatedAt = captured ? captured.hasUpdatedAt : input != null && Object.prototype.hasOwnProperty.call(input, 'updatedAt');
		const hasStartedAt = captured ? captured.hasStartedAt : input != null && Object.prototype.hasOwnProperty.call(input, 'startedAt');
		const timestamp = hasUpdatedAt ? input.updatedAt : (hasStartedAt ? input.startedAt : undefined);
		value.now = hasUpdatedAt || hasStartedAt
			? (canonicalTimestamp(timestamp) ? timestamp : null)
			: nowIso(opts);
		if (!value.now) return null;
	}
	return value;
}

async function readOwner(ctx, opts = {}) {
	const identity = captureIdentity(ctx);
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead']);
	return identity ? invoke('watchOwnerRead', identity, {}, boundOpts) : invalid();
}

async function enumerateOwners(_ctx, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerList']);
	const operation = boundOpts.authorityMethods?.watchOwnerList;
	if (typeof operation !== 'function') {
		return { ok: false, changed: false, reason: 'authority_unavailable', records: [] };
	}
	try {
		const result = operation(boundOpts.databaseConfig || {});
		if (result && typeof result.then === 'function') {
			Promise.resolve(result).then(() => {}, () => {});
			return { ok: false, changed: false, reason: 'invalid_operation', records: [] };
		}
		if (!result || typeof result !== 'object' || Array.isArray(result)) {
			return { ok: false, changed: false, reason: 'corrupt', records: [] };
		}
		// Snapshot once into a bounded plain array: an accessor-backed rows
		// property (or a retained Proxy array) must not report one length and
		// yield different iteration contents afterwards.
		const snap = {
			ok: result.ok === true,
			changed: result.changed === true,
			reason: typeof result.reason === 'string' ? result.reason : '',
			rows: result.rows,
		};
		if (!snap.ok && snap.changed) {
			return { ok: false, changed: false, reason: 'corrupt', records: [] };
		}
		if (snap.ok && (snap.changed !== false || snap.reason !== 'read')) {
			return { ok: false, changed: false, reason: 'corrupt', records: [] };
		}
		if (!Array.isArray(snap.rows) && typeof snap.rows?.[Symbol.iterator] !== 'function') {
			return { ok: false, changed: false, reason: 'corrupt', records: [] };
		}
		if (!snap.ok) {
			// Failed reads must never expose converted rows as if they were
			// authoritative data.
			return { ok: false, changed: false, reason: snap.reason, records: [] };
		}
		const rows = [];
		for (const row of snap.rows) {
			rows.push(row);
			if (rows.length > OWNER_ENUMERATION_LIMIT) {
				return { ok: false, changed: false, reason: 'enumeration_overflow', records: [] };
			}
		}
		let bytes = 0;
		let previous = null;
		const records = [];
		for (const row of rows) {
			const record = fromSqliteOwnerRow(row);
			if (validateRecord(record)) return { ok: false, changed: false, reason: 'corrupt', records: [] };
			if (previous && !(record.repo > previous.repo
				|| (record.repo === previous.repo && record.pr > previous.pr))) {
				return { ok: false, changed: false, reason: 'corrupt', records: [] };
			}
			previous = record;
			bytes += Buffer.byteLength(JSON.stringify(record), 'utf8');
			if (bytes > OWNER_ENUMERATION_BYTES) {
				return { ok: false, changed: false, reason: 'enumeration_overflow', records: [] };
			}
			records.push(record);
		}
		return { ok: snap.ok, changed: false, reason: snap.reason, records };
	} catch (error) {
		return { ok: false, changed: false,
			reason: error?.code === 'AUTHORITY_UNAVAILABLE' ? 'authority_unavailable' : 'store_error', records: [] };
	}
}

async function reserveStarting(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerReserveStarting']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts, { generation: false });
	if (!value || !positivePid(input?.controllerPid)) return invalid('invalid_reservation');
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	return invoke('watchOwnerReserveStarting', value, {
		controllerPid: Number(input.controllerPid), expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function reserveReopened(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerReserveReopened']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts);
	const controllerPid = input?.controllerPid;
	const expectedReceiptId = input?.expectedReceiptId;
	const providerEvidence = input?.providerEvidence;
	if (!value || !positivePid(controllerPid)
		|| !boundedString(expectedReceiptId, MAX_RECEIPT_BYTES)) return invalid('invalid_reservation');
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const prior = captured.snapshot;
	if (!prior || prior.phase !== 'complete'
		|| prior.generation !== value.generation
		|| prior.terminal_receipt_id !== input.expectedReceiptId) {
		return invalid('stale_evidence');
	}
	if (!await evidenceVerified(value, providerEvidence, ['open'], boundOpts)) return invalid('provider_evidence_invalid');
	return invoke('watchOwnerReserveReopened', value, {
		controllerPid: Number(controllerPid), expectedReceiptId,
		expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function bindRunning(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerBindRunning']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts);
	if (!value || !positivePid(input?.controllerPid) || !positivePid(input?.pid)) return invalid('invalid_pid');
	// Imported provenance (legacy evidence hash, started_at) must survive the
	// bind, so capture the starting row first and bind the result to it.
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	if (!captured.snapshot || !['starting', 'running'].includes(captured.snapshot.phase)) {
		return invalid('phase_mismatch');
	}
	if (captured.snapshot.generation !== value.generation) return invalid('generation_mismatch');
	if (captured.snapshot.phase === 'starting'
		&& captured.snapshot.controller_pid !== Number(input.controllerPid)) {
		return invalid('controller_pid_mismatch');
	}
	if (captured.snapshot.phase === 'running'
		&& captured.snapshot.watcher_pid !== Number(input.pid)) return invalid('pid_mismatch');
	return invoke('watchOwnerBindRunning', value, {
		controllerPid: Number(input.controllerPid), watcherPid: Number(input.pid),
		expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function heartbeat(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerHeartbeat']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts);
	if (!value || !positivePid(input?.pid)) return invalid('invalid_pid');
	// The heartbeated phase must be captured before the mutation so an
	// alternate driver cannot flip running↔stop_requested in its result.
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	if (!captured.snapshot || !['running', 'stop_requested'].includes(captured.snapshot.phase)) {
		return invalid('phase_mismatch');
	}
	if (captured.snapshot.generation !== value.generation) return invalid('generation_mismatch');
	if (captured.snapshot.watcher_pid !== Number(input.pid)) return invalid('pid_mismatch');
	return invoke('watchOwnerHeartbeat', value, {
		watcherPid: Number(input.pid), expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function requestStop(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerRequestStop']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts);
	if (!value || !positivePid(input?.pid)) return invalid('invalid_pid');
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const prior = captured.snapshot;
	if (!prior || !['running', 'stop_requested'].includes(prior.phase)) return invalid('phase_mismatch');
	if (prior.generation !== value.generation) return invalid('generation_mismatch');
	if (prior.watcher_pid !== Number(input.pid)) return invalid('pid_mismatch');
	return invoke('watchOwnerRequestStop', value, {
		watcherPid: Number(input.pid), expectedSnapshot: prior,
	}, boundOpts);
}

async function recordTerminal(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerRecordTerminal']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts);
	const watcherPid = input?.pid;
	const terminalReceiptId = input?.terminalReceiptId;
	if (!value || !positivePid(watcherPid)) return invalid('invalid_pid');
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const prior = captured.snapshot;
	const exactTerminalReplay = prior?.phase === 'terminal_pending'
		&& prior.generation === value.generation
		&& prior.watcher_pid === Number(watcherPid)
		&& prior.terminal_receipt_id === terminalReceiptId;
	const boundToSubmission = prior != null
		&& ['running', 'stop_requested'].includes(prior.phase)
		&& prior.generation === value.generation
		&& prior.watcher_pid === Number(watcherPid);
	if (!exactTerminalReplay && !boundToSubmission) return invalid('stale_evidence');
	if (!exactTerminalReplay && !await receiptVerified(value, terminalReceiptId, boundOpts)) return invalid('receipt_unverified');
	return invoke('watchOwnerRecordTerminal', value, {
		watcherPid: Number(watcherPid), terminalReceiptId,
		expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function completeTerminal(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerCompleteTerminal']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts);
	const watcherPid = input?.pid;
	const terminalReceiptId = input?.terminalReceiptId;
	if (!value || !positivePid(watcherPid) || !boundedString(terminalReceiptId, MAX_RECEIPT_BYTES)) return invalid();
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const prior = captured.snapshot;
	const exactCompletedReplay = prior?.phase === 'complete'
		&& prior.generation === value.generation
		&& prior.terminal_receipt_id === terminalReceiptId;
	const boundToSubmission = prior != null
		&& prior.phase === 'terminal_pending'
		&& prior.generation === value.generation
		&& prior.watcher_pid === Number(watcherPid)
		&& prior.terminal_receipt_id === terminalReceiptId;
	if (!exactCompletedReplay && !boundToSubmission) return invalid('stale_evidence');
	if (!exactCompletedReplay && await pidState(Number(watcherPid), boundOpts) !== false) return invalid('pid_live');
	return invoke('watchOwnerCompleteTerminal', value, {
		watcherPid: Number(watcherPid), terminalReceiptId,
		expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function abortStarting(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerAbortStarting']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts, { now: false });
	const controllerPid = input?.controllerPid;
	if (!value || !positivePid(controllerPid)) return invalid('invalid_pid');
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const prior = captured.snapshot;
	if (!prior || prior.phase !== 'starting'
		|| prior.generation !== value.generation
		|| prior.controller_pid !== Number(controllerPid)) {
		return invalid('stale_evidence');
	}
	if (await pidState(Number(controllerPid), boundOpts) !== true) return invalid('controller_dead');
	return invoke('watchOwnerAbortStarting', value, {
		controllerPid: Number(controllerPid), expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function releaseNonterminal(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerReleaseNonterminal']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts, { now: false });
	if (!value || !positivePid(input?.pid)) return invalid('invalid_pid');
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const prior = captured.snapshot;
	if (!prior || prior.phase !== 'stop_requested') return invalid('phase_mismatch');
	if (prior.generation !== value.generation) return invalid('generation_mismatch');
	if (prior.watcher_pid !== Number(input.pid)) return invalid('pid_mismatch');
	return invoke('watchOwnerReleaseNonterminal', value, {
		watcherPid: Number(input.pid), expectedSnapshot: prior,
	}, boundOpts);
}

async function recoverDeadStarting(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerRecoverDeadStarting']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts);
	const controllerPid = input?.controllerPid;
	const recoveryControllerPid = input?.recoveryControllerPid;
	if (!value || !positivePid(controllerPid) || !positivePid(recoveryControllerPid)) return invalid('invalid_pid');
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	if (!captured.snapshot || captured.snapshot.phase !== 'starting'
		|| captured.snapshot.generation !== value.generation
		|| captured.snapshot.controller_pid !== Number(controllerPid)) {
		return invalid('generation_mismatch');
	}
	if (!await pidDeadOrProvenReused(
		Number(controllerPid), captured.snapshot.updated_at, input, boundOpts,
	)) return invalid('pid_live');
	return invoke('watchOwnerRecoverDeadStarting', value, {
		expectedControllerPid: Number(controllerPid), controllerPid: Number(recoveryControllerPid),
		expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function recoverDeadWatcher(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerRecoverDeadWatcher']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts);
	const watcherPid = input?.pid;
	const recoveryControllerPid = input?.recoveryControllerPid;
	const providerEvidence = input?.providerEvidence;
	if (!value || !positivePid(watcherPid) || !positivePid(recoveryControllerPid)) return invalid('invalid_pid');
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	if (!captured.snapshot || captured.snapshot.phase !== 'running'
		|| captured.snapshot.generation !== value.generation
		|| captured.snapshot.watcher_pid !== Number(watcherPid)) {
		return invalid('generation_mismatch');
	}
	if (!await pidDeadOrProvenReused(
		Number(watcherPid), captured.snapshot.heartbeat_at, input, boundOpts,
	)) return invalid('pid_live');
	if (!await evidenceVerified(value, providerEvidence, ['open', 'terminal'], boundOpts)) return invalid('provider_evidence_invalid');
	return invoke('watchOwnerRecoverDeadWatcher', value, {
		watcherPid: Number(watcherPid), controllerPid: Number(recoveryControllerPid),
		expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function markLegacyBlocked(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, [
		'watchOwnerRead', 'watchGateRead', 'watchOwnerMarkLegacyBlocked',
	]);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts, { generation: false });
	const blockReason = input?.blockReason;
	const legacyEvidenceHash = input?.legacyEvidenceHash;
	const snapshotHash = input?.snapshotHash;
	const pid = input?.pid;
	const terminalReceiptId = input?.terminalReceiptId;
	if (!value || !BLOCK_REASONS.has(blockReason) || !validHash(legacyEvidenceHash)
		|| !validHash(snapshotHash)) {
		return invalid('invalid_legacy_evidence');
	}
	if (pid != null && !positivePid(pid)) return invalid('invalid_legacy_evidence');
	const watcherPid = pid == null ? null : pid;
	if ((blockReason === 'legacy_live_pid') !== positivePid(watcherPid)) return invalid('invalid_legacy_evidence');
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const gate = captureQuarantinedGate(snapshotHash, boundOpts);
	if (!gate.ok) return invalid(gate.reason);
	if (terminalReceiptId != null && !boundedString(terminalReceiptId, MAX_RECEIPT_BYTES)) return invalid('invalid_legacy_evidence');
	const exactBlockedReplay = captured.snapshot?.phase === 'blocked'
		&& captured.snapshot.block_reason === blockReason
		&& captured.snapshot.watcher_pid === watcherPid
		&& captured.snapshot.terminal_receipt_id === (terminalReceiptId || null)
		&& captured.snapshot.legacy_evidence_hash === legacyEvidenceHash;
	if (!exactBlockedReplay && watcherPid != null && await pidState(watcherPid, boundOpts) !== true) return invalid('pid_dead');
	return invoke('watchOwnerMarkLegacyBlocked', value, {
		watcherPid, blockReason, terminalReceiptId: terminalReceiptId || null,
		legacyEvidenceHash, snapshotHash,
		expectedSnapshot: captured.snapshot, expectedGate: gate.snapshot,
	}, boundOpts);
}

async function recheckLegacyBlocked(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerRecheckLegacyBlocked']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts);
	const action = input?.action;
	const legacyEvidenceHash = input?.legacyEvidenceHash;
	const pid = input?.pid;
	const terminalReceiptId = input?.terminalReceiptId;
	if (!value || !validHash(legacyEvidenceHash) || !['release', 'complete'].includes(action)) {
		return invalid('invalid_legacy_evidence');
	}
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const prior = captured.snapshot;
	if (!prior || prior.phase !== 'blocked'
		|| prior.generation !== value.generation
		|| prior.legacy_evidence_hash !== input.legacyEvidenceHash) {
		return invalid('stale_evidence');
	}
	if (action === 'release' && prior.block_reason !== 'legacy_live_pid') {
		return invalid('invalid_transition');
	}
	const watcherPid = pid == null ? null : pid;
	if (prior.watcher_pid !== watcherPid) return invalid('pid_mismatch');
	if (watcherPid != null && await pidState(watcherPid, boundOpts) !== false) return invalid('pid_live');
	if (action === 'complete' && !await receiptVerified(value, terminalReceiptId, boundOpts)) return invalid('receipt_unverified');
	return invoke('watchOwnerRecheckLegacyBlocked', value, {
		action, legacyEvidenceHash,
		terminalReceiptId: action === 'complete' ? terminalReceiptId : null,
		watcherPid, expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function importLegacyComplete(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, [
		'watchOwnerRead', 'watchGateRead', 'watchOwnerImportLegacyComplete',
	]);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts, { generation: false });
	const snapshotHash = input?.snapshotHash;
	const legacyEvidenceHash = input?.legacyEvidenceHash;
	const legacyPid = input?.legacyPid;
	const terminalReceiptId = input?.terminalReceiptId;
	if (!value || !validHash(snapshotHash) || !validHash(legacyEvidenceHash)) {
		return invalid('invalid_legacy_evidence');
	}
	if (legacyPid != null && !positivePid(legacyPid)) return invalid('invalid_legacy_evidence');
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const gate = captureQuarantinedGate(snapshotHash, boundOpts);
	if (!gate.ok) return invalid(gate.reason);
	const exactCompleteReplay = captured.snapshot?.phase === 'complete'
		&& captured.snapshot.legacy_evidence_hash === legacyEvidenceHash
		&& captured.snapshot.terminal_receipt_id === terminalReceiptId;
	if (!exactCompleteReplay) {
		if (legacyPid != null && await pidState(Number(legacyPid), boundOpts) !== false) return invalid('pid_live');
		if (!await receiptVerified(value, terminalReceiptId, boundOpts)) return invalid('receipt_unverified');
	}
	return invoke('watchOwnerImportLegacyComplete', value, {
		snapshotHash, legacyEvidenceHash,
		terminalReceiptId, expectedSnapshot: captured.snapshot, expectedGate: gate.snapshot,
	}, boundOpts);
}

async function importLegacyStarting(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, [
		'watchOwnerRead', 'watchGateRead', 'watchOwnerImportLegacyStarting',
	]);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const identity = captureIdentity(ctx);
	const value = mutationInput(identity, input, boundOpts, { generation: false });
	const snapshotHash = input?.snapshotHash;
	const legacyEvidenceHash = input?.legacyEvidenceHash;
	const legacyPid = input?.legacyPid;
	const controllerPid = input?.controllerPid;
	const providerEvidence = input?.providerEvidence;
	if (!value || !validHash(snapshotHash) || !validHash(legacyEvidenceHash)
		|| !positivePid(legacyPid) || !positivePid(controllerPid)) {
		return invalid('invalid_legacy_evidence');
	}
	const captured = captureAuthoritySnapshot(identity, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const gate = captureQuarantinedGate(snapshotHash, boundOpts);
	if (!gate.ok) return invalid(gate.reason);
	const exactStartingReplay = captured.snapshot?.phase === 'starting'
		&& captured.snapshot.controller_pid === controllerPid
		&& captured.snapshot.legacy_evidence_hash === legacyEvidenceHash;
	if (!exactStartingReplay) {
		if (await pidState(legacyPid, boundOpts) !== false) return invalid('pid_live');
		if (!await evidenceVerified(value, providerEvidence, ['open'], boundOpts)) return invalid('provider_evidence_invalid');
	}
	return invoke('watchOwnerImportLegacyStarting', value, {
		snapshotHash, legacyEvidenceHash,
		controllerPid, expectedSnapshot: captured.snapshot, expectedGate: gate.snapshot,
	}, boundOpts);
}

function gateInput(input, opts) {
	const captured = input?.[CAPTURED_INPUT];
	const hasUpdatedAt = captured ? captured.hasUpdatedAt
		: input != null && Object.prototype.hasOwnProperty.call(input, 'updatedAt');
	const now = hasUpdatedAt
		? (canonicalTimestamp(input.updatedAt) ? input.updatedAt : null)
		: nowIso(opts);
	return now ? { now } : null;
}

// Exact success envelopes the builtin gate driver can produce per method;
// anything else is a mutating or malformed adapter response.
const GATE_ENVELOPE_CONTRACTS = Object.freeze({
	watchGateRead: Object.freeze([Object.freeze({ changed: false, reason: 'read' })]),
	watchGatePublishQuarantine: Object.freeze([
		Object.freeze({ changed: true, reason: 'quarantined' }),
		Object.freeze({ changed: false, reason: 'idempotent' }),
	]),
	watchGateBindSnapshot: Object.freeze([
		Object.freeze({ changed: true, reason: 'bound' }),
		Object.freeze({ changed: false, reason: 'idempotent' }),
	]),
	watchGatePublishConflict: Object.freeze([
		Object.freeze({ changed: true, reason: 'conflict' }),
		Object.freeze({ changed: false, reason: 'idempotent' }),
	]),
	watchGateRetryConflict: Object.freeze([
		Object.freeze({ changed: true, reason: 'retry_bound' }),
	]),
	watchGateCompleteMigration: Object.freeze([
		Object.freeze({ changed: true, reason: 'complete' }),
		Object.freeze({ changed: false, reason: 'idempotent' }),
	]),
});

function invokeGate(method, input, opts) {
	const operation = opts?.authorityMethods?.[method];
	if (typeof operation !== 'function') return { ok: false, changed: false, reason: 'authority_unavailable', gate: null };
	if (input.expectedGate && Date.parse(input.now) < Date.parse(input.expectedGate.updated_at)) {
		return invalidGate('stale_evidence');
	}
	try {
		const expectedGate = input.expectedGate == null
			? input.expectedGate
			: Object.freeze({ ...input.expectedGate });
		const submitted = Object.freeze({ ...input, expectedGate });
		const result = operation({ ...submitted }, opts.databaseConfig || {});
		if (result && typeof result.then === 'function') {
			Promise.resolve(result).then(() => {}, () => {});
			return invalidGate('invalid_operation');
		}
		if (!result || typeof result !== 'object' || Array.isArray(result)) return invalidGate('corrupt');
		// Snapshot once: accessor-backed results must not flip between
		// validation and the returned envelope.
		const snap = {
			ok: result.ok === true,
			changed: result.changed === true,
			reason: typeof result.reason === 'string' ? result.reason : '',
			gate: result.gate,
		};
		if (!snap.ok && snap.changed) return invalidGate('corrupt');
		if (snap.ok) {
			const contract = GATE_ENVELOPE_CONTRACTS[method] || [];
			if (!contract.some(entry => entry.changed === snap.changed && entry.reason === snap.reason)) {
				return invalidGate('corrupt');
			}
		}
		if (method === 'watchGateRead' && snap.ok
			&& (snap.changed !== false || snap.reason !== 'read')) {
			return invalidGate('corrupt');
		}
		if (method === 'watchGateRead' && !snap.ok
			&& snap.reason === 'absent' && snap.gate != null) return invalidGate('corrupt');
		if (snap.ok && snap.gate == null) return invalidGate('corrupt');
		if (snap.gate == null) {
			return { ok: snap.ok, changed: snap.changed, reason: snap.reason, gate: null };
		}
		const gate = copyMigrationGate(snap.gate);
		if (!gate || (snap.ok && !gateMatchesMutation(method, submitted, gate, snap))) return invalidGate('corrupt');
		return { ok: snap.ok, changed: snap.changed, reason: snap.reason, gate };
	} catch (error) {
		return { ok: false, changed: false,
			reason: error?.code === 'AUTHORITY_UNAVAILABLE' ? 'authority_unavailable' : 'store_error', gate: null };
	}
}

function captureMigrationGate(opts) {
	const captured = invokeGate('watchGateRead', {}, opts);
	if (captured.ok) return { ok: true, snapshot: Object.freeze({ ...captured.gate }) };
	return captured.reason === 'absent'
		? { ok: true, snapshot: null }
		: { ok: false, reason: captured.reason };
}

function captureQuarantinedGate(snapshotHash, opts) {
	const captured = captureMigrationGate(opts);
	if (!captured.ok) {
		return { ok: false, reason: ['corrupt', 'authority_unavailable'].includes(captured.reason)
			? captured.reason : 'gate_mismatch' };
	}
	return captured.snapshot?.state === 'quarantined'
		&& captured.snapshot.snapshot_hash === snapshotHash
		&& captured.snapshot.conflict_code == null
		? captured
		: { ok: false, reason: 'gate_mismatch' };
}

async function readMigrationGate(input = {}, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchGateRead']);
	const capturedInput = captureMutationInput(input);
	return capturedInput ? invokeGate('watchGateRead', capturedInput, boundOpts) : invalidGate('invalid_input');
}

async function publishMigrationQuarantine(input = {}, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchGateRead', 'watchGatePublishQuarantine']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalidGate('invalid_input');
	const value = gateInput(capturedInput, boundOpts);
	if (!value) return invalidGate();
	const captured = captureMigrationGate(boundOpts);
	return captured.ok
		? invokeGate('watchGatePublishQuarantine', { ...value, expectedGate: captured.snapshot }, boundOpts)
		: invalidGate(captured.reason);
}

async function bindMigrationSnapshot(input = {}, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchGateRead', 'watchGateBindSnapshot']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalidGate('invalid_input');
	input = capturedInput;
	const value = gateInput(input, boundOpts);
	if (!value || !validHash(input.snapshotHash)) return invalidGate('invalid_snapshot');
	const captured = captureMigrationGate(boundOpts);
	return captured.ok
		? invokeGate('watchGateBindSnapshot', {
			...value, snapshotHash: input.snapshotHash, expectedGate: captured.snapshot,
		}, boundOpts)
		: invalidGate(captured.reason);
}

async function publishMigrationConflict(input = {}, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchGateRead', 'watchGatePublishConflict']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalidGate('invalid_input');
	input = capturedInput;
	const value = gateInput(input, boundOpts);
	if (!value || !validHash(input.snapshotHash) || !CONFLICT_CODES.has(input.conflictCode)) return invalidGate('invalid_conflict');
	const captured = captureMigrationGate(boundOpts);
	return captured.ok
		? invokeGate('watchGatePublishConflict', {
			...value, snapshotHash: input.snapshotHash, conflictCode: input.conflictCode,
			expectedGate: captured.snapshot,
		}, boundOpts)
		: invalidGate(captured.reason);
}

async function retryMigrationConflict(input = {}, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchGateRead', 'watchGateRetryConflict']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalidGate('invalid_input');
	input = capturedInput;
	const value = gateInput(input, boundOpts);
	if (!value || !validHash(input.expectedSnapshotHash)
		|| !CONFLICT_CODES.has(input.expectedConflictCode)
		|| !validHash(input.replacementSnapshotHash)
		|| input.replacementSnapshotHash === input.expectedSnapshotHash) return invalidGate('invalid_retry');
	const captured = captureMigrationGate(boundOpts);
	return captured.ok ? invokeGate('watchGateRetryConflict', {
		...value,
		expectedSnapshotHash: input.expectedSnapshotHash,
		expectedConflictCode: input.expectedConflictCode,
		replacementSnapshotHash: input.replacementSnapshotHash,
		expectedGate: captured.snapshot,
	}, boundOpts) : invalidGate(captured.reason);
}

async function completeMigrationGate(input = {}, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchGateRead', 'watchGateCompleteMigration']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalidGate('invalid_input');
	input = capturedInput;
	const value = gateInput(input, boundOpts);
	if (!value || !validHash(input.snapshotHash)) return invalidGate('invalid_snapshot');
	const captured = captureMigrationGate(boundOpts);
	return captured.ok
		? invokeGate('watchGateCompleteMigration', {
			...value, snapshotHash: input.snapshotHash, expectedGate: captured.snapshot,
		}, boundOpts)
		: invalidGate(captured.reason);
}

module.exports = {
	VERSION,
	PHASES,
	BLOCK_REASONS,
	CONFLICT_CODES,
	validateRecord,
	readOwner,
	enumerateOwners,
	reserveStarting,
	reserveReopened,
	bindRunning,
	heartbeat,
	requestStop,
	recordTerminal,
	completeTerminal,
	abortStarting,
	releaseNonterminal,
	recoverDeadStarting,
	recoverDeadWatcher,
	markLegacyBlocked,
	recheckLegacyBlocked,
	importLegacyStarting,
	importLegacyComplete,
	readMigrationGate,
	publishMigrationQuarantine,
	bindMigrationSnapshot,
	publishMigrationConflict,
	retryMigrationConflict,
	completeMigrationGate,
};
