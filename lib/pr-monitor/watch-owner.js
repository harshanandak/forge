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

const MUTATION_INPUT_FIELDS = [
	'generation', 'controllerPid', 'pid', 'recoveryControllerPid',
	'expectedReceiptId', 'providerEvidence', 'terminalReceiptId',
	'blockReason', 'legacyEvidenceHash', 'snapshotHash', 'legacyPid',
	'action', 'updatedAt', 'startedAt', 'conflictCode',
];
const CAPTURED_INPUT = Symbol('capturedMutationInput');
const BOUND_OPTIONS = Symbol('boundAuthorityOptions');

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
		pr: Number(row.pr),
		version: Number(row.version),
		generation: row.generation,
		phase: row.phase,
		controllerPid: row.controller_pid == null ? null : Number(row.controller_pid),
		watcherPid: row.watcher_pid == null ? null : Number(row.watcher_pid),
		startedAt: row.started_at,
		updatedAt: row.updated_at,
		heartbeatAt: row.heartbeat_at,
		terminalReceiptId: row.terminal_receipt_id,
		blockReason: row.block_reason,
		legacyEvidenceHash: row.legacy_evidence_hash,
	};
}

function validateRecord(record) {
	const identity = normalizeIdentity(record);
	if (!identity || record?.repo !== identity.repo || record?.version !== VERSION) return 'invalid_identity';
	if (!boundedString(record.generation, MAX_GENERATION_BYTES) || !PHASES.has(record.phase)) return 'invalid_generation_or_phase';
	if (!canonicalTimestamp(record.startedAt) || !canonicalTimestamp(record.updatedAt)
		|| record.updatedAt < record.startedAt) return 'invalid_timestamp';
	if (record.heartbeatAt != null && !canonicalTimestamp(record.heartbeatAt)) return 'invalid_heartbeat';
	if (['running', 'stop_requested', 'terminal_pending'].includes(record.phase)
		&& record.heartbeatAt != null
		&& (record.heartbeatAt < record.startedAt || record.heartbeatAt > record.updatedAt)) return 'invalid_heartbeat';
	if (record.terminalReceiptId != null && !boundedString(record.terminalReceiptId, MAX_RECEIPT_BYTES)) return 'invalid_receipt';
	if (record.legacyEvidenceHash != null && !validHash(record.legacyEvidenceHash)) return 'invalid_evidence';
	if (record.controllerPid != null && !positivePid(record.controllerPid)) return 'invalid_controller_pid';
	if (record.watcherPid != null && !positivePid(record.watcherPid)) return 'invalid_watcher_pid';
	if (record.phase === 'starting') {
		return positivePid(record.controllerPid) && record.watcherPid == null && record.heartbeatAt == null
			&& record.terminalReceiptId == null && record.blockReason == null
			? null : 'invalid_starting';
	}
	if (record.phase === 'running' || record.phase === 'stop_requested') {
		return record.controllerPid == null && positivePid(record.watcherPid) && record.heartbeatAt != null
			&& record.terminalReceiptId == null && record.blockReason == null
			? null : 'invalid_active';
	}
	if (record.phase === 'terminal_pending') {
		return record.controllerPid == null && positivePid(record.watcherPid) && record.heartbeatAt != null
			&& record.terminalReceiptId != null && record.blockReason == null ? null : 'invalid_terminal_pending';
	}
	if (record.phase === 'complete') {
		return record.controllerPid == null && record.watcherPid == null && record.heartbeatAt == null
			&& record.terminalReceiptId != null && record.blockReason == null ? null : 'invalid_complete';
	}
	if (!BLOCK_REASONS.has(record.blockReason) || record.controllerPid != null
		|| !validHash(record.legacyEvidenceHash)) return 'invalid_blocked';
	return (record.blockReason === 'legacy_live_pid') === positivePid(record.watcherPid)
		? null : 'invalid_blocked_pid';
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

function bindAuthorityOptions(opts = {}, methods = []) {
	try {
		if (opts?.[BOUND_OPTIONS]) return opts;
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
		Object.defineProperty(bound, BOUND_OPTIONS, { value: true });
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
		return envelope(result.ok, result.changed, result.reason, fromSqliteOwnerRow(result.row));
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
		if (!result.ok) return { ok: false, reason: result.reason };
		return { ok: true, identity, snapshot: result.row };
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
		return await opts.verifyTerminalReceipt(receipt, identity) === true;
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
		return { ok: result.ok, changed: false, reason: result.reason,
			records: result.rows.map(fromSqliteOwnerRow) };
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
	if (!await receiptVerified(value, terminalReceiptId, boundOpts)) return invalid('receipt_unverified');
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
	if (await pidState(Number(watcherPid), boundOpts) !== false) return invalid('pid_live');
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
	if (watcherPid != null && await pidState(watcherPid, boundOpts) !== true) return invalid('pid_dead');
	if (terminalReceiptId != null && !boundedString(terminalReceiptId, MAX_RECEIPT_BYTES)) return invalid('invalid_legacy_evidence');
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
	if (legacyPid != null && await pidState(Number(legacyPid), boundOpts) !== false) return invalid('pid_live');
	if (!await receiptVerified(value, terminalReceiptId, boundOpts)) return invalid('receipt_unverified');
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
	if (await pidState(legacyPid, boundOpts) !== false) return invalid('pid_live');
	if (!await evidenceVerified(value, providerEvidence, ['open'], boundOpts)) return invalid('provider_evidence_invalid');
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
		return result && typeof result.then === 'function'
			? { ok: false, changed: false, reason: 'invalid_operation', gate: null }
			: result;
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
	completeMigrationGate,
};
