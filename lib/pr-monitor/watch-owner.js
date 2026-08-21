'use strict';

const journal = require('./journal');

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

const MUTATION_INPUT_FIELDS = [
	'generation', 'controllerPid', 'pid', 'recoveryControllerPid',
	'expectedReceiptId', 'providerEvidence', 'terminalReceiptId',
	'blockReason', 'legacyEvidenceHash', 'snapshotHash', 'legacyPid',
	'action', 'updatedAt', 'startedAt', 'conflictCode',
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

function gateMatchesMutation(method, input, gate) {
	switch (method) {
	case 'watchGatePublishQuarantine':
		return gate.state === 'quarantined' && gate.conflict_code == null;
	case 'watchGateBindSnapshot':
		return gate.state === 'quarantined' && gate.snapshot_hash === input.snapshotHash && gate.conflict_code == null;
	case 'watchGatePublishConflict':
		return gate.state === 'conflict'
			&& gate.snapshot_hash === input.snapshotHash
			&& gate.conflict_code === input.conflictCode;
	case 'watchGateRetryConflict':
		return gate.state === 'quarantined'
			&& gate.snapshot_hash === input.replacementSnapshotHash
			&& gate.conflict_code == null;
	case 'watchGateCompleteMigration':
		return gate.state === 'complete' && gate.snapshot_hash === input.snapshotHash && gate.conflict_code == null;
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
	if (priorGeneration == null) return true;
	return !Object.is(record.generation, priorGeneration);
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
	switch (method) {
	case 'watchOwnerReserveStarting':
		return validOwnerSuccess(result, record, 'acquired', {
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
	case 'watchOwnerBindRunning':
		return validOwnerSuccess(result, record, 'bound', {
			generation: input.generation, watcherPid: input.watcherPid,
		}, 'running', true)
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt')
			&& stampedOwnerTimestamp(result, input, record, 'heartbeatAt');
	case 'watchOwnerHeartbeat':
		return validOwnerSuccess(result, record, 'heartbeat', {
			generation: input.generation, watcherPid: input.watcherPid,
			updatedAt: input.now, heartbeatAt: input.now,
		}, ['running', 'stop_requested']);
	case 'watchOwnerRequestStop':
		return validOwnerSuccess(result, record, 'stop_requested', {
			generation: input.generation, watcherPid: input.watcherPid,
		}, 'stop_requested', true) && stampedOwnerTimestamp(result, input, record, 'updatedAt');
	case 'watchOwnerRecordTerminal':
		return validOwnerSuccess(result, record, 'terminal_pending', {
			generation: input.generation, watcherPid: input.watcherPid,
			terminalReceiptId: input.terminalReceiptId,
		}, 'terminal_pending', true) && stampedOwnerTimestamp(result, input, record, 'updatedAt');
	case 'watchOwnerCompleteTerminal':
		return validOwnerSuccess(result, record, 'complete', {
			generation: input.generation, watcherPid: null,
			terminalReceiptId: input.terminalReceiptId,
		}, 'complete', true) && stampedOwnerTimestamp(result, input, record, 'updatedAt');
	case 'watchOwnerAbortStarting': {
		if (!input.expectedSnapshot) return false;
		return result.reason === 'aborted' && result.changed === true && record === null;
	}
	case 'watchOwnerReleaseNonterminal':
		return result.reason === 'released' && result.changed === true && record === null;
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
		if (!prior) return false;
		return validOwnerSuccess(result, record, 'recovered', {
			controllerPid: input.controllerPid,
			legacyEvidenceHash: prior.legacy_evidence_hash,
		}, 'starting') && mintedOwnerGeneration(input, record)
			&& stampedOwnerTimestamp(result, input, record, 'startedAt')
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt');
	}
	case 'watchOwnerMarkLegacyBlocked':
		return validOwnerSuccess(result, record, 'blocked', {
			watcherPid: input.watcherPid, terminalReceiptId: input.terminalReceiptId ?? null,
			blockReason: input.blockReason, legacyEvidenceHash: input.legacyEvidenceHash,
		}, 'blocked', true)
			&& stampedOwnerTimestamp(result, input, record, 'startedAt')
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt');
	case 'watchOwnerRecheckLegacyBlocked': {
		if (input.action === 'release') {
			if (!input.expectedSnapshot) return false;
			return result.reason === 'released' && result.changed === true && record === null;
		}
		return validOwnerSuccess(result, record, 'complete', {
			generation: input.generation, watcherPid: null,
			terminalReceiptId: input.terminalReceiptId, blockReason: null,
			legacyEvidenceHash: input.legacyEvidenceHash,
		}, 'complete') && stampedOwnerTimestamp(result, input, record, 'updatedAt');
	}
	case 'watchOwnerImportLegacyStarting':
		return validOwnerSuccess(result, record, 'imported', {
			controllerPid: input.controllerPid, legacyEvidenceHash: input.legacyEvidenceHash,
		}, 'starting', true) && importedOwnerGeneration(result, input, record)
			&& stampedOwnerTimestamp(result, input, record, 'startedAt')
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt');
	case 'watchOwnerImportLegacyComplete':
		return validOwnerSuccess(result, record, 'imported', {
			watcherPid: null, terminalReceiptId: input.terminalReceiptId,
			legacyEvidenceHash: input.legacyEvidenceHash,
		}, 'complete', true) && importedOwnerGeneration(result, input, record)
			&& stampedOwnerTimestamp(result, input, record, 'startedAt')
			&& stampedOwnerTimestamp(result, input, record, 'updatedAt');
	default:
		return false;
	}
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
	try {
		const result = operation({ ...identity, ...input }, opts.databaseConfig || {});
		if (result && typeof result.then === 'function') return invalid('invalid_operation');
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
		if (snap.ok && !validOwnerOperationResult(method, { ...identity, ...input }, snap, record)) return invalid('corrupt');
		return envelope(snap.ok, snap.changed, snap.reason, record);
	} catch (error) {
		return invalid(error?.code === 'AUTHORITY_UNAVAILABLE' ? 'authority_unavailable' : 'store_error');
	}
}

function captureAuthoritySnapshot(ctx, opts) {
	const identity = normalizeIdentity(ctx);
	if (!identity) return { ok: false, reason: 'invalid_input' };
	const operation = opts?.authorityMethods?.watchOwnerRead;
	if (typeof operation !== 'function') return { ok: false, reason: 'authority_unavailable' };
	try {
		const result = operation(identity, opts.databaseConfig || {});
		if (result && typeof result.then === 'function') return { ok: false, reason: 'invalid_operation' };
		if (!result || typeof result !== 'object' || Array.isArray(result)) return { ok: false, reason: 'corrupt' };
		// Snapshot once: accessor-backed results must not flip between the
		// read-invariant probe and the evidence snapshot taken from them.
		const snap = {
			ok: result.ok === true,
			changed: result.changed === true,
			reason: typeof result.reason === 'string' ? result.reason : '',
			row: result.row,
		};
		if (!snap.ok) return { ok: false, reason: snap.reason };
		const probe = fromSqliteOwnerRow(snap.row);
		if (snap.changed !== false
			|| (snap.reason === 'read') !== (probe != null)
			|| (probe == null && snap.reason !== 'absent')) {
			return { ok: false, reason: 'corrupt' };
		}
		if (snap.row == null) return { ok: true, identity, snapshot: null };
		if (typeof snap.row !== 'object' || Array.isArray(snap.row)) {
			return { ok: false, reason: 'corrupt' };
		}
		const snapshot = { ...snap.row };
		const record = fromSqliteOwnerRow(snapshot);
		if (validateRecord(record) || !matchesIdentity(record, identity)) return { ok: false, reason: 'corrupt' };
		return { ok: true, identity, snapshot: Object.freeze(snapshot) };
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

function mutationInput(ctx, input, opts, { generation = true, now = true } = {}) {
	const identity = normalizeIdentity(ctx);
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
	const identity = normalizeIdentity(ctx);
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
		if (snap.ok && (snap.changed !== false || snap.reason !== 'read')) {
			return { ok: false, changed: false, reason: 'corrupt', records: [] };
		}
		if (!Array.isArray(snap.rows) && typeof snap.rows?.[Symbol.iterator] !== 'function') {
			return { ok: false, changed: false, reason: 'corrupt', records: [] };
		}
		const rows = [];
		for (const row of snap.rows) {
			rows.push(row);
			if (rows.length > OWNER_ENUMERATION_LIMIT) {
				return { ok: false, changed: false, reason: 'enumeration_overflow', records: [] };
			}
		}
		let bytes = 0;
		for (const row of rows) {
			bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
			if (bytes > OWNER_ENUMERATION_BYTES) {
				return { ok: false, changed: false, reason: 'enumeration_overflow', records: [] };
			}
		}
		const records = [];
		for (const row of rows) {
			const record = fromSqliteOwnerRow(row);
			if (validateRecord(record)) return { ok: false, changed: false, reason: 'corrupt', records: [] };
			records.push(record);
		}
		return { ok: snap.ok, changed: false, reason: snap.reason, records };
	} catch (error) {
		return { ok: false, changed: false,
			reason: error?.code === 'AUTHORITY_UNAVAILABLE' ? 'authority_unavailable' : 'store_error', records: [] };
	}
}

async function reserveStarting(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerReserveStarting']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const value = mutationInput(ctx, input, boundOpts, { generation: false });
	if (!value || !positivePid(input?.controllerPid)) return invalid('invalid_reservation');
	return invoke('watchOwnerReserveStarting', value, { controllerPid: Number(input.controllerPid) }, boundOpts);
}

async function reserveReopened(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerReserveReopened']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const value = mutationInput(ctx, input, boundOpts);
	const controllerPid = input?.controllerPid;
	const expectedReceiptId = input?.expectedReceiptId;
	const providerEvidence = input?.providerEvidence;
	if (!value || !positivePid(controllerPid)
		|| !boundedString(expectedReceiptId, MAX_RECEIPT_BYTES)) return invalid('invalid_reservation');
	const captured = captureAuthoritySnapshot(ctx, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	if (!await evidenceVerified(value, providerEvidence, ['open'], boundOpts)) return invalid('provider_evidence_invalid');
	return invoke('watchOwnerReserveReopened', value, {
		controllerPid: Number(controllerPid), expectedReceiptId,
		expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function bindRunning(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerBindRunning']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const value = mutationInput(ctx, input, boundOpts);
	if (!value || !positivePid(input?.controllerPid) || !positivePid(input?.pid)) return invalid('invalid_pid');
	return invoke('watchOwnerBindRunning', value, {
		controllerPid: Number(input.controllerPid), watcherPid: Number(input.pid),
	}, boundOpts);
}

async function heartbeat(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerHeartbeat']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const value = mutationInput(ctx, input, boundOpts);
	if (!value || !positivePid(input?.pid)) return invalid('invalid_pid');
	return invoke('watchOwnerHeartbeat', value, { watcherPid: Number(input.pid) }, boundOpts);
}

async function requestStop(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRequestStop']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const value = mutationInput(ctx, input, boundOpts);
	if (!value || !positivePid(input?.pid)) return invalid('invalid_pid');
	return invoke('watchOwnerRequestStop', value, { watcherPid: Number(input.pid) }, boundOpts);
}

async function recordTerminal(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerRecordTerminal']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const value = mutationInput(ctx, input, boundOpts);
	const watcherPid = input?.pid;
	const terminalReceiptId = input?.terminalReceiptId;
	if (!value || !positivePid(watcherPid)) return invalid('invalid_pid');
	const captured = captureAuthoritySnapshot(ctx, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const exactTerminalReplay = captured.snapshot?.phase === 'terminal_pending'
		&& captured.snapshot.generation === value.generation
		&& captured.snapshot.watcher_pid === Number(watcherPid)
		&& captured.snapshot.terminal_receipt_id === terminalReceiptId;
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
	const value = mutationInput(ctx, input, boundOpts);
	const watcherPid = input?.pid;
	const terminalReceiptId = input?.terminalReceiptId;
	if (!value || !positivePid(watcherPid) || !boundedString(terminalReceiptId, MAX_RECEIPT_BYTES)) return invalid();
	const captured = captureAuthoritySnapshot(ctx, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const exactCompletedReplay = captured.snapshot?.phase === 'complete'
		&& captured.snapshot.generation === value.generation
		&& captured.snapshot.terminal_receipt_id === terminalReceiptId;
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
	const value = mutationInput(ctx, input, boundOpts, { now: false });
	const controllerPid = input?.controllerPid;
	if (!value || !positivePid(controllerPid)) return invalid('invalid_pid');
	const captured = captureAuthoritySnapshot(ctx, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	if (await pidState(Number(controllerPid), boundOpts) !== true) return invalid('controller_dead');
	return invoke('watchOwnerAbortStarting', value, {
		controllerPid: Number(controllerPid), expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function releaseNonterminal(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerReleaseNonterminal']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const value = mutationInput(ctx, input, boundOpts, { now: false });
	if (!value || !positivePid(input?.pid)) return invalid('invalid_pid');
	return invoke('watchOwnerReleaseNonterminal', value, { watcherPid: Number(input.pid) }, boundOpts);
}

async function recoverDeadStarting(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerRecoverDeadStarting']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const value = mutationInput(ctx, input, boundOpts);
	const controllerPid = input?.controllerPid;
	const recoveryControllerPid = input?.recoveryControllerPid;
	if (!value || !positivePid(controllerPid) || !positivePid(recoveryControllerPid)) return invalid('invalid_pid');
	const captured = captureAuthoritySnapshot(ctx, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	if (await pidState(Number(controllerPid), boundOpts) !== false) return invalid('pid_live');
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
	const value = mutationInput(ctx, input, boundOpts);
	const watcherPid = input?.pid;
	const recoveryControllerPid = input?.recoveryControllerPid;
	const providerEvidence = input?.providerEvidence;
	if (!value || !positivePid(watcherPid) || !positivePid(recoveryControllerPid)) return invalid('invalid_pid');
	const captured = captureAuthoritySnapshot(ctx, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	if (await pidState(Number(watcherPid), boundOpts) !== false) return invalid('pid_live');
	if (!await evidenceVerified(value, providerEvidence, ['open', 'terminal'], boundOpts)) return invalid('provider_evidence_invalid');
	return invoke('watchOwnerRecoverDeadWatcher', value, {
		watcherPid: Number(watcherPid), controllerPid: Number(recoveryControllerPid),
		expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function markLegacyBlocked(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerMarkLegacyBlocked']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const value = mutationInput(ctx, input, boundOpts, { generation: false });
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
	const captured = captureAuthoritySnapshot(ctx, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
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
		expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function recheckLegacyBlocked(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerRecheckLegacyBlocked']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const value = mutationInput(ctx, input, boundOpts);
	const action = input?.action;
	const legacyEvidenceHash = input?.legacyEvidenceHash;
	const pid = input?.pid;
	const terminalReceiptId = input?.terminalReceiptId;
	if (!value || !validHash(legacyEvidenceHash) || !['release', 'complete'].includes(action)) {
		return invalid('invalid_legacy_evidence');
	}
	const captured = captureAuthoritySnapshot(ctx, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const storedLivePid = captured.snapshot?.phase === 'blocked'
		&& captured.snapshot.block_reason === 'legacy_live_pid'
		? captured.snapshot.watcher_pid : null;
	if (storedLivePid != null && (!positivePid(pid) || pid !== storedLivePid)) {
		return invalid('pid_mismatch');
	}
	if (pid != null && await pidState(Number(pid), boundOpts) !== false) return invalid('pid_live');
	if (action === 'complete' && !await receiptVerified(value, terminalReceiptId, boundOpts)) return invalid('receipt_unverified');
	return invoke('watchOwnerRecheckLegacyBlocked', value, {
		action, legacyEvidenceHash,
		terminalReceiptId: action === 'complete' ? terminalReceiptId : null,
		watcherPid: pid == null ? null : Number(pid), expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function importLegacyComplete(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchOwnerRead', 'watchOwnerImportLegacyComplete']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const value = mutationInput(ctx, input, boundOpts, { generation: false });
	const snapshotHash = input?.snapshotHash;
	const legacyEvidenceHash = input?.legacyEvidenceHash;
	const legacyPid = input?.legacyPid;
	const terminalReceiptId = input?.terminalReceiptId;
	if (!value || !validHash(snapshotHash) || !validHash(legacyEvidenceHash)) {
		return invalid('invalid_legacy_evidence');
	}
	const captured = captureAuthoritySnapshot(ctx, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	if (legacyPid != null && !positivePid(legacyPid)) return invalid('invalid_legacy_evidence');
	const exactCompleteReplay = captured.snapshot?.phase === 'complete'
		&& captured.snapshot.legacy_evidence_hash === legacyEvidenceHash
		&& captured.snapshot.terminal_receipt_id === terminalReceiptId;
	if (!exactCompleteReplay) {
		if (legacyPid != null && await pidState(Number(legacyPid), boundOpts) !== false) return invalid('pid_live');
		if (!await receiptVerified(value, terminalReceiptId, boundOpts)) return invalid('receipt_unverified');
	}
	return invoke('watchOwnerImportLegacyComplete', value, {
		snapshotHash, legacyEvidenceHash,
		terminalReceiptId, expectedSnapshot: captured.snapshot,
	}, boundOpts);
}

async function importLegacyStarting(ctx, input, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, [
		'watchOwnerRead', 'watchGateRead', 'watchOwnerImportLegacyStarting',
	]);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalid();
	input = capturedInput;
	const value = mutationInput(ctx, input, boundOpts, { generation: false });
	const snapshotHash = input?.snapshotHash;
	const legacyEvidenceHash = input?.legacyEvidenceHash;
	const legacyPid = input?.legacyPid;
	const controllerPid = input?.controllerPid;
	const providerEvidence = input?.providerEvidence;
	if (!value || !validHash(snapshotHash) || !validHash(legacyEvidenceHash)
		|| !positivePid(legacyPid) || !positivePid(controllerPid)) {
		return invalid('invalid_legacy_evidence');
	}
	const captured = captureAuthoritySnapshot(ctx, boundOpts);
	if (!captured.ok) return invalid(captured.reason);
	const gate = await readMigrationGate({}, boundOpts);
	if (!gate.ok) return invalid(gate.reason === 'corrupt' ? 'corrupt' : gate.reason === 'authority_unavailable'
		? 'authority_unavailable' : 'gate_mismatch');
	if (gate.gate.state !== 'quarantined' || gate.gate.snapshot_hash !== snapshotHash) {
		return invalid('gate_mismatch');
	}
	const exactStartingReplay = captured.snapshot?.phase === 'starting'
		&& captured.snapshot.controller_pid === controllerPid
		&& captured.snapshot.legacy_evidence_hash === legacyEvidenceHash;
	if (!exactStartingReplay) {
		if (await pidState(legacyPid, boundOpts) !== false) return invalid('pid_live');
		if (!await evidenceVerified(value, providerEvidence, ['open'], boundOpts)) return invalid('provider_evidence_invalid');
	}
	return invoke('watchOwnerImportLegacyStarting', value, {
		snapshotHash, legacyEvidenceHash,
		controllerPid, expectedSnapshot: captured.snapshot,
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

function invokeGate(method, input, opts) {
	const operation = opts?.authorityMethods?.[method];
	if (typeof operation !== 'function') return { ok: false, changed: false, reason: 'authority_unavailable', gate: null };
	try {
		const result = operation(input, opts.databaseConfig || {});
		if (result && typeof result.then === 'function') return invalidGate('invalid_operation');
		if (!result || typeof result !== 'object' || Array.isArray(result)) return invalidGate('corrupt');
		// Snapshot once: accessor-backed results must not flip between
		// validation and the returned envelope.
		const snap = {
			ok: result.ok === true,
			changed: result.changed === true,
			reason: typeof result.reason === 'string' ? result.reason : '',
			gate: result.gate,
		};
		if (method === 'watchGateRead' && snap.ok
			&& (snap.changed !== false || snap.reason !== 'read')) {
			return invalidGate('corrupt');
		}
		if (snap.ok && snap.gate == null) return invalidGate('corrupt');
		if (snap.gate == null) {
			return { ok: snap.ok, changed: snap.changed, reason: snap.reason, gate: null };
		}
		const gate = copyMigrationGate(snap.gate);
		if (!gate || (snap.ok && !gateMatchesMutation(method, input, gate))) return invalidGate('corrupt');
		return { ok: snap.ok, changed: snap.changed, reason: snap.reason, gate };
	} catch (error) {
		return { ok: false, changed: false,
			reason: error?.code === 'AUTHORITY_UNAVAILABLE' ? 'authority_unavailable' : 'store_error', gate: null };
	}
}

async function readMigrationGate(input = {}, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchGateRead']);
	const capturedInput = captureMutationInput(input);
	return capturedInput ? invokeGate('watchGateRead', capturedInput, boundOpts) : invalidGate('invalid_input');
}

async function publishMigrationQuarantine(input = {}, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchGatePublishQuarantine']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalidGate('invalid_input');
	const value = gateInput(capturedInput, boundOpts);
	return value ? invokeGate('watchGatePublishQuarantine', value, boundOpts) : invalidGate();
}

async function bindMigrationSnapshot(input = {}, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchGateBindSnapshot']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalidGate('invalid_input');
	input = capturedInput;
	const value = gateInput(input, boundOpts);
	if (!value || !validHash(input.snapshotHash)) return invalidGate('invalid_snapshot');
	return invokeGate('watchGateBindSnapshot', { ...value, snapshotHash: input.snapshotHash }, boundOpts);
}

async function publishMigrationConflict(input = {}, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchGatePublishConflict']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalidGate('invalid_input');
	input = capturedInput;
	const value = gateInput(input, boundOpts);
	if (!value || !validHash(input.snapshotHash) || !CONFLICT_CODES.has(input.conflictCode)) return invalidGate('invalid_conflict');
	return invokeGate('watchGatePublishConflict', { ...value, snapshotHash: input.snapshotHash, conflictCode: input.conflictCode }, boundOpts);
}

async function retryMigrationConflict(input = {}, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchGateRetryConflict']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalidGate('invalid_input');
	input = capturedInput;
	const value = gateInput(input, boundOpts);
	if (!value || !validHash(input.expectedSnapshotHash)
		|| !CONFLICT_CODES.has(input.expectedConflictCode)
		|| !validHash(input.replacementSnapshotHash)
		|| input.replacementSnapshotHash === input.expectedSnapshotHash) return invalidGate('invalid_retry');
	return invokeGate('watchGateRetryConflict', {
		...value,
		expectedSnapshotHash: input.expectedSnapshotHash,
		expectedConflictCode: input.expectedConflictCode,
		replacementSnapshotHash: input.replacementSnapshotHash,
	}, boundOpts);
}

async function completeMigrationGate(input = {}, opts = {}) {
	const boundOpts = bindAuthorityOptions(opts, ['watchGateCompleteMigration']);
	const capturedInput = captureMutationInput(input);
	if (!capturedInput) return invalidGate('invalid_input');
	input = capturedInput;
	const value = gateInput(input, boundOpts);
	if (!value || !validHash(input.snapshotHash)) return invalidGate('invalid_snapshot');
	return invokeGate('watchGateCompleteMigration', { ...value, snapshotHash: input.snapshotHash }, boundOpts);
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
