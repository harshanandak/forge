'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { ISSUE_STATUSES } = require('./issue-command-contract');
const { CLAIM_STATES, isTerminalStatus } = require('./taxonomy-validator');
const REQUIRED_CLAIM_COLUMNS = Object.freeze([
	'id', 'issue_id', 'actor', 'state', 'session_id', 'worktree_id', 'claimed_at', 'expires_at',
]);
const REQUIRED_ISSUE_COLUMNS = Object.freeze(['id', 'status']);
const REQUIRED_INDEXES = Object.freeze({
	idx_kernel_claims_active_lease: Object.freeze({ columns: ['issue_id'], unique: true, partial: true }),
	idx_kernel_claims_actor_state: Object.freeze({ columns: ['actor', 'state'], unique: false, partial: false }),
	idx_kernel_claims_issue_state: Object.freeze({ columns: ['issue_id', 'state'], unique: false, partial: false }),
});

class ClaimRepairError extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.name = 'ClaimRepairError';
		this.code = code;
		this.details = details;
	}
}

function canonicalIso(value) {
	if (typeof value !== 'string') return false;
	const millis = Date.parse(value);
	return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function stableValue(value) {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!value || typeof value !== 'object') return value;
	const sorted = {};
	for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
		sorted[key] = stableValue(value[key]);
	}
	return sorted;
}

function stableStringify(value) {
	return JSON.stringify(stableValue(value));
}

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

function normalizeIndex(index = {}) {
	return {
		name: String(index.name || ''),
		columns: Array.isArray(index.columns) ? index.columns.map(String) : [],
		unique: Boolean(index.unique),
		partial: Boolean(index.partial),
		sql: String(index.sql || '').replace(/\s+/g, ' ').trim(),
	};
}

function collectSchemaErrors(snapshot) {
	const errors = [];
	if (snapshot.integrity !== 'ok') errors.push('integrity_check');
	if (snapshot.foreign_keys_enabled !== true) errors.push('foreign_keys_disabled');
	if (Number(snapshot.foreign_key_faults || 0) !== 0) errors.push('foreign_key_fault');
	if (Array.isArray(snapshot.read_errors) && snapshot.read_errors.length > 0) errors.push('schema_read_failure');

	const claimColumns = new Set(snapshot.claim_columns || []);
	const issueColumns = new Set(snapshot.issue_columns || []);
	if (REQUIRED_CLAIM_COLUMNS.some(column => !claimColumns.has(column))) errors.push('claim_schema_columns');
	if (REQUIRED_ISSUE_COLUMNS.some(column => !issueColumns.has(column))) errors.push('issue_schema_columns');

	const foreignKeys = snapshot.claim_foreign_keys || [];
	if (!foreignKeys.some(row => row.table === 'kernel_issues' && row.from === 'issue_id' && row.to === 'id')) {
		errors.push('claim_issue_foreign_key');
	}

	const indexes = new Map((snapshot.claim_indexes || []).map(index => [index.name, normalizeIndex(index)]));
	for (const [name, expected] of Object.entries(REQUIRED_INDEXES)) {
		const actual = indexes.get(name);
		if (!actual
			|| stableStringify(actual.columns) !== stableStringify(expected.columns)
			|| actual.unique !== expected.unique
			|| actual.partial !== expected.partial) {
			errors.push(`index:${name}`);
		}
	}
	const activeIndex = indexes.get('idx_kernel_claims_active_lease');
	if (activeIndex && !/\bon\s+kernel_claims\s*\(\s*issue_id\s*\)\s+where\s+state\s*=\s*'active'\s*;?$/i.test(activeIndex.sql)) {
		errors.push('index:idx_kernel_claims_active_lease_sql');
	}
	return errors;
}

function exactClaimRow(row) {
	return {
		id: row.id,
		issue_id: row.issue_id,
		actor: row.actor,
		state: row.state,
		session_id: row.session_id ?? null,
		worktree_id: row.worktree_id ?? null,
		claimed_at: row.claimed_at,
		expires_at: row.expires_at ?? null,
	};
}

function digestSnapshot(snapshot, observedAt, claims) {
	const indexes = (snapshot.claim_indexes || []).map(normalizeIndex)
		.sort((left, right) => left.name.localeCompare(right.name));
	const referencedIssueIds = new Set(claims.map(claim => claim.issue_id));
	const issues = (snapshot.issues || [])
		.filter(issue => referencedIssueIds.has(issue.id))
		.map(issue => ({ id: issue.id, status: issue.status }))
		.sort((left, right) => String(left.id).localeCompare(String(right.id)));
	const canonicalClaims = claims.map(exactClaimRow)
		.sort((left, right) => String(left.id).localeCompare(String(right.id)));
	const claimsById = new Map(canonicalClaims.map(claim => [claim.id, claim]));
	const authoritySchema = [...(snapshot.authority_schema || [])]
		.map(row => ({ type: row.type, name: row.name, table_name: row.tbl_name, sql: row.sql ?? null }))
		.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
	const authorityTables = [...(snapshot.authority_tables || [])]
		.map(table => {
			const rows = (table.rows || []).map(row => {
				if (table.name !== 'kernel_claims') return stableValue(row);
				const claim = claimsById.get(row.id);
				return stableValue(claim ? { ...row, state: claim.state } : row);
			}).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
			return { name: table.name, rows };
		})
		.sort((left, right) => left.name.localeCompare(right.name));
	return sha256(stableStringify({
		schema_version: 'forge.claim-repair.snapshot.v2',
		observed_at: observedAt,
		authority: { schema: authoritySchema, tables: authorityTables },
		schema: {
			claim_columns: [...(snapshot.claim_columns || [])]
				.sort((left, right) => String(left).localeCompare(String(right))),
			issue_columns: [...(snapshot.issue_columns || [])]
				.sort((left, right) => String(left).localeCompare(String(right))),
			claim_foreign_keys: [...(snapshot.claim_foreign_keys || [])]
				.map(row => ({ table: row.table, from: row.from, to: row.to }))
				.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right))),
			claim_indexes: indexes,
		},
		issues,
		claims: canonicalClaims,
	}));
}

function validateIssueRows(issues, errors) {
	const issuesById = new Map();
	for (const issue of issues) {
		if (typeof issue.id !== 'string' || issue.id.length === 0 || !ISSUE_STATUSES.includes(issue.status)) {
			errors.push('invalid_issue_state');
		}
		if (issuesById.has(issue.id)) errors.push('duplicate_issue_id');
		issuesById.set(issue.id, issue);
	}
	return issuesById;
}

function claimRowErrors(claim, claimIds, issuesById) {
	const errors = [];
	if (typeof claim.id !== 'string' || claim.id.length === 0 || claimIds.has(claim.id)) {
		errors.push('duplicate_or_invalid_claim_id');
	}
	if (typeof claim.issue_id !== 'string' || !issuesById.has(claim.issue_id)) errors.push('orphan_claim');
	if (typeof claim.actor !== 'string' || claim.actor.trim() === '') errors.push('invalid_claim_actor');
	if (!CLAIM_STATES.includes(claim.state)) errors.push('invalid_claim_state');
	if (!canonicalIso(claim.claimed_at)) errors.push('invalid_claimed_at');
	if (claim.expires_at !== null && claim.expires_at !== undefined && !canonicalIso(claim.expires_at)) {
		errors.push('invalid_expires_at');
	}
	return errors;
}

function validateClaimRows(claims, issuesById, errors) {
	const claimIds = new Set();
	const activeByIssue = new Map();
	for (const claim of claims) {
		errors.push(...claimRowErrors(claim, claimIds, issuesById));
		claimIds.add(claim.id);
		if (claim.state === 'active') {
			activeByIssue.set(claim.issue_id, Number(activeByIssue.get(claim.issue_id) || 0) + 1);
		}
	}
	if ([...activeByIssue.values()].some(count => count > 1)) errors.push('duplicate_active_claim');
}

function throwClaimRepairErrors(errors) {
	if (errors.length === 0) return;
	const counts = Object.create(null);
	for (const error of errors) counts[error] = Number(counts[error] || 0) + 1;
	const labels = Object.keys(counts).sort((left, right) => left.localeCompare(right));
	throw new ClaimRepairError(
		'CLAIM_REPAIR_PREFLIGHT_FAILED',
		`Claim repair preflight failed closed (${labels.join(', ')})`,
		{ errors: counts },
	);
}

function classifyClaimActions(claims, issuesById, observedAt) {
	const actions = [];
	let preservedNullExpiry = 0;
	let preservedUnexpired = 0;
	for (const claim of claims) {
		if (claim.state !== 'active') continue;
		const issue = issuesById.get(claim.issue_id);
		if (isTerminalStatus(issue.status)) {
			actions.push({ claim: exactClaimRow(claim), issue_status: issue.status, to_state: 'released' });
			continue;
		}
		if (claim.expires_at !== null && claim.expires_at !== undefined
			&& Date.parse(claim.expires_at) <= Date.parse(observedAt)) {
			actions.push({ claim: exactClaimRow(claim), issue_status: issue.status, to_state: 'reclaimable' });
			continue;
		}
		if (claim.expires_at === null || claim.expires_at === undefined) preservedNullExpiry += 1;
		else preservedUnexpired += 1;
	}
	return { actions, preservedNullExpiry, preservedUnexpired };
}

function buildClaimRepairCounts(issues, claims, classification) {
	const { actions, preservedNullExpiry, preservedUnexpired } = classification;
	const released = actions.filter(action => action.to_state === 'released').length;
	const reclaimable = actions.filter(action => action.to_state === 'reclaimable').length;
	return Object.freeze({
		total_issues: issues.length,
		total_claims: claims.length,
		active_claims: claims.filter(claim => claim.state === 'active').length,
		non_active_claims: claims.filter(claim => claim.state !== 'active').length,
		terminal_active_to_release: released,
		expired_nonterminal_to_reclaimable: reclaimable,
		preserved_null_expiry_active: preservedNullExpiry,
		preserved_unexpired_active: preservedUnexpired,
		planned_mutations: actions.length,
	});
}

function buildClaimRepairPlan(snapshot, options = {}) {
	const observedAt = options.observedAt;
	if (!canonicalIso(observedAt)) {
		throw new ClaimRepairError(
			'CLAIM_REPAIR_INVALID_OBSERVED_AT',
			'Claim repair requires an exact canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)',
		);
	}

	const errors = collectSchemaErrors(snapshot);
	const issues = Array.isArray(snapshot.issues) ? snapshot.issues : [];
	const claims = Array.isArray(snapshot.claims) ? snapshot.claims : [];
	const issuesById = validateIssueRows(issues, errors);
	validateClaimRows(claims, issuesById, errors);
	throwClaimRepairErrors(errors);
	const classification = classifyClaimActions(claims, issuesById, observedAt);
	const { actions } = classification;

	const digest = digestSnapshot(snapshot, observedAt, claims);
	const actionById = new Map(actions.map(action => [action.claim.id, action]));
	const afterClaims = claims.map(claim => {
		const action = actionById.get(claim.id);
		return action ? { ...claim, state: action.to_state } : claim;
	});
	const afterDigest = digestSnapshot(snapshot, observedAt, afterClaims);
	return {
		observedAt,
		digest,
		afterDigest,
		counts: buildClaimRepairCounts(issues, claims, classification),
		actions,
	};
}

function publicClaimRepairPreflight(plan) {
	return Object.freeze({
		schema_version: 'forge.claim-repair.preflight.v1',
		mode: 'dry-run',
		observed_at: plan.observedAt,
		digest: plan.digest,
		after_digest: plan.afterDigest,
		counts: plan.counts,
	});
}

async function hashFile(filePath) {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = fs.createReadStream(filePath);
		stream.on('error', reject);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

function cleanupRestoreProofDirectory(directory, fsApi = fs) {
	try {
		fsApi.rmSync(directory, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	} catch {
		// A closed SQLite handle can remain briefly locked on Windows. The proof is
		// already valid and the private OS temp directory can be reaped later.
	}
}

function prepareRestoreProofSnapshot(backupPath, restoreDir, restorePath, options = {}) {
	const fsApi = options.fsApi || fs;
	const hardenPath = options.hardenPath;
	if (typeof hardenPath !== 'function') {
		throw new ClaimRepairError(
			'CLAIM_REPAIR_BACKUP_PERMISSIONS',
			'Restore proof requires a platform permission hardener',
		);
	}
	hardenPath(restoreDir);
	fsApi.copyFileSync(backupPath, restorePath, fs.constants.COPYFILE_EXCL);
	hardenPath(restorePath);
}

async function verifyClaimRepairBackup(options = {}) {
	const { backupPath, observedAt, openDriver, hardenPath } = options;
	if (!backupPath || typeof openDriver !== 'function' || !fs.existsSync(backupPath)) {
		throw new ClaimRepairError('CLAIM_REPAIR_BACKUP_REQUIRED', 'A readable separate SQLite backup is required');
	}
	if (typeof hardenPath !== 'function') {
		throw new ClaimRepairError(
			'CLAIM_REPAIR_BACKUP_PERMISSIONS',
			'Backup verification requires a platform permission hardener',
		);
	}
	hardenPath(backupPath);
	const restoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-restore-proof-'));
	const restorePath = path.join(restoreDir, 'kernel.restored.sqlite');
	let restoreDriver;
	try {
		prepareRestoreProofSnapshot(backupPath, restoreDir, restorePath, { hardenPath });
		restoreDriver = openDriver(restorePath);
		const restored = await restoreDriver.preflightLegacyClaimRepair({ observedAt });
		const restoredHash = await hashFile(restorePath);
		const currentBackupHash = await hashFile(backupPath);
		if (currentBackupHash !== restoredHash) {
			throw new ClaimRepairError(
				'CLAIM_REPAIR_BACKUP_DRIFT',
				'Backup changed while its isolated restore proof was being verified',
			);
		}
		return Object.freeze({
			schema_version: 'forge.claim-repair.backup-proof.v1',
			integrity: 'ok',
			backup_sha256: restoredHash,
			plan_digest: restored.digest,
			restore_digest: restored.digest,
		});
	} finally {
		if (restoreDriver && typeof restoreDriver.close === 'function') restoreDriver.close();
		cleanupRestoreProofDirectory(restoreDir);
	}
}

async function createVerifiedClaimRepairBackup(options = {}) {
	const { sourceDriver, backupPath, observedAt, openDriver, hardenPath } = options;
	if (!sourceDriver || typeof sourceDriver.preflightLegacyClaimRepair !== 'function'
		|| typeof sourceDriver.backup !== 'function') {
		throw new ClaimRepairError('CLAIM_REPAIR_BACKUP_UNAVAILABLE', 'Source driver cannot create a verified SQLite backup');
	}
	if (!backupPath) {
		throw new ClaimRepairError('CLAIM_REPAIR_BACKUP_REQUIRED', 'A separate SQLite backup path is required');
	}
	if (fs.existsSync(backupPath)) {
		throw new ClaimRepairError(
			'CLAIM_REPAIR_BACKUP_EXISTS',
			'Refusing to overwrite an existing claim-repair backup; choose a new immutable path',
		);
	}
	const source = await sourceDriver.preflightLegacyClaimRepair({ observedAt });
	try {
		await sourceDriver.backup(backupPath, {}, { noReplace: true });
	} catch (error) {
		if (error?.code === 'EEXIST') {
			throw new ClaimRepairError(
				'CLAIM_REPAIR_BACKUP_EXISTS',
				'Refusing to overwrite a claim-repair backup path created during publication',
			);
		}
		throw error;
	}
	const proof = await verifyClaimRepairBackup({ backupPath, observedAt, openDriver, hardenPath });
	if (proof.restore_digest !== source.digest) {
		throw new ClaimRepairError(
			'CLAIM_REPAIR_BACKUP_DRIFT',
			'Backup does not restore to the exact preflight snapshot digest',
		);
	}
	return Object.freeze({ ...proof, plan_digest: source.digest });
}

module.exports = {
	CLAIM_STATES,
	ClaimRepairError,
	buildClaimRepairPlan,
	cleanupRestoreProofDirectory,
	createVerifiedClaimRepairBackup,
	prepareRestoreProofSnapshot,
	publicClaimRepairPreflight,
	verifyClaimRepairBackup,
};
