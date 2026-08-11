'use strict';

const { getTypeBehavior, isTerminalStatus, normalizeRank, toEpochMillis } = require('./taxonomy-validator');
const { isLiveClaim } = require('./live-claim-projection');

// Readiness is a DERIVED read model (D18). `ready`/`blocked` are computed on demand
// from dependencies, claims, quarantine/conflicts, gates, defer windows, and policy —
// they are NEVER stored as issue status values.
const READINESS_REASONS = Object.freeze({
	DEPENDENCY: 'dependency',
	// A blocker that is itself PARKED (backlog): it will never complete on its own, so it
	// blocks its dependents indefinitely. Surfaced as a distinct code (not plain
	// `dependency`) so a parked blocker is not mistaken for ordinary in-flight work — a
	// consumer can flag it for promotion instead of waiting on it forever.
	DEPENDENCY_PARKED: 'dependency_parked',
	QUARANTINE: 'quarantine',
	CONFLICT: 'conflict',
	GATE: 'gate',
	CLAIM: 'claimed',
	DEFERRED: 'deferred',
	POLICY: 'policy_disabled',
	CONTRACT_MISSING: 'contract_missing',
	CONTRACT_INVALID: 'contract_invalid',
	CONTRACT_MISMATCH: 'contract_mismatch',
	CONTRACT_ADOPTION_REQUIRED: 'contract_adoption_required',
	CONTRACT_ADOPTION_UNVERIFIED: 'contract_adoption_unverified',
});

const READINESS_STATES = Object.freeze([
	'ready',
	'blocked',
	'gated',
	'deferred',
	'claimed',
	'disabled',
	'closed',
	'backlog',
]);

const WORKABLE_STATUSES = Object.freeze(['open', 'in_progress']);

/** @returns {boolean} true if `status` is a pickable working status (open/in_progress). */
function isWorkableStatus(status) {
	return WORKABLE_STATUSES.includes(status);
}

// Ready work must be claimable: epics (containers) and decisions are claimable:false, so they
// never belong in the ready queue even when unblocked. A known non-claimable type is excluded;
// an unknown/unspecified type is not penalised (callers may omit `type`).
function isReadyEligibleType(type) {
	const behavior = getTypeBehavior(type);
	return behavior ? behavior.claimable : true;
}

// Edge-only blocking test: keys off the dependency RELATIONSHIP (dependency_type),
// NOT the blocking issue's type. Distinct from taxonomy-validator's isBlockingDependency,
// which also falls back to `.type`; do not merge them (see readiness decision-dependency).
function isBlockingDependencyEdge(dependency) {
	return (dependency.dependency_type || 'blocks') === 'blocks';
}

function isDeferred(issue, now) {
	if (!issue.defer_until) return false;
	const deferMillis = toEpochMillis(issue.defer_until);
	if (deferMillis === null) return false; // an unparseable defer window is not a defer
	const nowMillis = toEpochMillis(now);
	// Fail closed: without a usable clock we cannot confirm the window elapsed, so a deferred
	// issue stays deferred rather than incorrectly surfacing as ready. Keeps the model pure
	// (caller supplies `now`) instead of reaching for a wall clock.
	if (nowMillis === null) return true;
	return deferMillis > nowMillis;
}

function findConflictingClaim(issue, claims, actor, now) {
	for (const claim of claims || []) {
		if (claim.issue_id !== issue.id) continue;
		if (!isLiveClaim(claim, issue, now)) continue;
		if (actor && claim.actor === actor) continue; // the requesting actor's own claim does not block them
		return claim;
	}
	return null;
}

function collectDependencyBlockers(context, reasons, blockedBy) {
	for (const dependency of context.dependencyStatuses || []) {
		if (!isBlockingDependencyEdge(dependency)) continue;
		// A terminal (done OR cancelled) blocker will never complete again, so it no longer
		// blocks — a cancelled dependency must not wedge the dependent as permanently blocked.
		if (isTerminalStatus(dependency.status)) continue;
		blockedBy.push(dependency.id);
		// A parked (backlog) blocker earns a distinct code + flag: it is stalled by design,
		// not being actively worked, so consumers can call it out for promotion.
		const isParked = dependency.status === 'backlog';
		const code = isParked ? READINESS_REASONS.DEPENDENCY_PARKED : READINESS_REASONS.DEPENDENCY;
		const reason = { code, issue_id: dependency.id, status: dependency.status };
		if (isParked) {
			reason.parked = true;
		}
		if (dependency.type === 'decision') {
			reason.decision = true;
		}
		reasons.push(reason);
	}
}

function collectConflictBlockers(issue, context, reasons) {
	let hasConflict = false;
	for (const conflict of context.conflicts || []) {
		// Conflicts are keyed by (entity_type, entity_id). Only issue-scoped conflicts block an
		// issue; a quarantined dependency/release/sprint that happens to share the id string must
		// not. Absent entity_type is treated as legacy issue-scoped.
		if (conflict.entity_type && conflict.entity_type !== 'issue') continue;
		if (conflict.entity_id && issue.id && conflict.entity_id !== issue.id) continue;
		hasConflict = true;
		const status = conflict.status || 'quarantined';
		const code = status === 'quarantined' ? READINESS_REASONS.QUARANTINE : READINESS_REASONS.CONFLICT;
		reasons.push({ code, status });
	}
	return hasConflict;
}

function collectGateBlockers(context, reasons) {
	let hasGate = false;
	for (const gate of context.gates || []) {
		if (gate.satisfied) continue;
		hasGate = true;
		reasons.push({ code: READINESS_REASONS.GATE, gate: gate.name });
	}
	return hasGate;
}

function nonEmptyText(value) {
	if (typeof value === 'string') return value.trim() !== '';
	return Array.isArray(value)
		&& value.length > 0
		&& value.every(item => typeof item === 'string' && item.trim() !== '');
}

function isPlainJsonObject(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function ownDataProperty(object, key) {
	if (!isPlainJsonObject(object)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
		? descriptor.value
		: undefined;
}

function parseMetadata(issue) {
	const metadata = ownDataProperty(issue, 'metadata');
	if (metadata == null) return {};
	if (isPlainJsonObject(metadata)) {
		return metadata;
	}
	if (typeof metadata !== 'string' || metadata.trim() === '') return {};
	try {
		const parsed = JSON.parse(metadata);
		return isPlainJsonObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function getIssueContract(issue) {
	const metadata = parseMetadata(issue);
	const candidate = ownDataProperty(metadata, 'forge.contract');
	const contract = isPlainJsonObject(candidate) ? candidate : {};
	return {
		contract: contract && typeof contract === 'object' && !Array.isArray(contract) ? contract : {},
		metadata,
	};
}

function normalizeIds(ids) {
	return [...new Set((Array.isArray(ids) ? ids : []).map(String))]
		.sort((left, right) => left.localeCompare(right));
}

function collectContractFieldReasons(issue, contract, context) {
	const reasons = [];
	if (!nonEmptyText(issue.body)) reasons.push({ code: READINESS_REASONS.CONTRACT_MISSING, field: 'purpose' });
	if (!nonEmptyText(issue.acceptance_criteria)) {
		reasons.push({ code: READINESS_REASONS.CONTRACT_MISSING, field: 'acceptance_criteria' });
	}
	const risk = ownDataProperty(contract, 'risk');
	const dependencies = ownDataProperty(contract, 'dependencies');
	const outOfScope = ownDataProperty(contract, 'out_of_scope');
	const version = ownDataProperty(contract, 'version');
	if (!nonEmptyText(risk)) reasons.push({ code: READINESS_REASONS.CONTRACT_MISSING, field: 'risk' });
	if (!Array.isArray(dependencies)) {
		reasons.push({ code: READINESS_REASONS.CONTRACT_MISSING, field: 'dependencies' });
	}
	if (!nonEmptyText(outOfScope)) {
		reasons.push({ code: READINESS_REASONS.CONTRACT_MISSING, field: 'out_of_scope' });
	}
	if (version !== 1) {
		reasons.push({
			code: READINESS_REASONS.CONTRACT_INVALID,
			field: 'version',
			expected: 1,
			actual: version ?? null,
		});
	}
	if (Array.isArray(dependencies) && Array.isArray(context.dependencyIds)) {
		const declared = normalizeIds(dependencies);
		const expected = normalizeIds(context.dependencyIds);
		if (JSON.stringify(declared) !== JSON.stringify(expected)) {
			reasons.push({
				code: READINESS_REASONS.CONTRACT_MISMATCH,
				field: 'dependencies',
				expected,
				declared,
			});
		}
	}
	return reasons;
}

function isTrustedContractAdoption(issue, metadata, adoptedBy, version, context) {
	const revision = ownDataProperty(issue, 'revision') ?? ownDataProperty(issue, 'entity_revision');
	const issueId = ownDataProperty(issue, 'id');
	if (typeof context.isTrustedAdoption !== 'function'
		|| !nonEmptyText(issueId)
		|| !Number.isInteger(revision)) return false;
	try {
		return context.isTrustedAdoption({
			actor: adoptedBy,
			issue_id: issueId,
			revision,
			metadata,
			contract_version: version,
		}) === true;
	} catch {
		return false;
	}
}

function collectAdoptionReasons(issue, metadata, contract, context) {
	const origin = ownDataProperty(issue, 'origin')
		?? ownDataProperty(metadata, 'origin')
		?? ownDataProperty(metadata, 'source');
	if (!['import', 'imported', 'fork', 'fork_pr'].includes(origin)) return [];
	const adoptedBy = ownDataProperty(contract, 'adopted_by');
	if (!nonEmptyText(adoptedBy)) {
		return [{ code: READINESS_REASONS.CONTRACT_ADOPTION_REQUIRED }];
	}
	const version = ownDataProperty(contract, 'version');
	return isTrustedContractAdoption(issue, metadata, adoptedBy, version, context)
		? []
		: [{ code: READINESS_REASONS.CONTRACT_ADOPTION_UNVERIFIED, adopter: adoptedBy }];
}

/**
 * Validate only the presence, shape, and authority agreement of an issue contract.
 * The policy deliberately does not score prose, dictate reasoning, or require headings.
 */
function evaluateIssueContract(issue = {}, policy = {}, context = {}) {
	const workClasses = Array.isArray(policy.workClasses) ? policy.workClasses : [];
	const applicable = policy.enabled === true && workClasses.includes(issue.type);
	if (!applicable) return { applicable: false, valid: true, reasons: [] };

	const { contract, metadata } = getIssueContract(issue);
	const reasons = [
		...collectContractFieldReasons(issue, contract, context),
		...collectAdoptionReasons(issue, metadata, contract, context),
	];

	return { applicable: true, valid: reasons.length === 0, reasons };
}

// Precedence high→low. `blocked` (dependencies/quarantine/conflict) always outranks the
// softer not-ready reasons; consumers picking next work should read the full reasons[]
// because a claim hidden behind a defer window is not reflected in this single summary.
function deriveState(flags) {
	if (flags.blocked) return 'blocked';
	if (flags.hasGate) return 'gated';
	if (flags.deferred) return 'deferred';
	if (flags.hasClaim) return 'claimed';
	if (flags.policyDisabled) return 'disabled';
	if (flags.ready) return 'ready';
	return 'backlog';
}

/**
 * Derive an issue's readiness (a read model, never stored) from its context.
 * @param {object} issue stored issue fields (id, status, defer_until, ...).
 * @param {object} context { now, actor, dependencyStatuses[], conflicts[], gates[], claims[], policyDisabled }.
 * @returns {{id, status, ready: boolean, blocked: boolean, blocked_by: string[], reasons: object[], state: string}}
 */
function deriveReadiness(issue = {}, context = {}) {
	const id = issue.id;
	const status = issue.status;

	if (isTerminalStatus(status)) {
		return { id, status, ready: false, blocked: false, blocked_by: [], reasons: [], state: 'closed' };
	}

	const contract = evaluateIssueContract(issue, context.contractPolicy, {
		dependencyIds: context.dependencyIds,
		isTrustedAdoption: context.isTrustedAdoption,
	});

	// A `backlog` (parked) issue is a first-class lifecycle state, not workable work: it
	// reads as parked regardless of any dependencies/gates — never ready, never blocked —
	// so parked ideas do not surface in ready/blocked queues or flag stale.
	if (status === 'backlog') {
		return {
			id,
			status,
			ready: false,
			blocked: false,
			blocked_by: [],
			reasons: contract.reasons,
			state: 'backlog',
			contract_applicable: contract.applicable,
		};
	}

	const reasons = [];
	const blockedBy = [];
	reasons.push(...contract.reasons);

	collectDependencyBlockers(context, reasons, blockedBy);
	const hasConflict = collectConflictBlockers(issue, context, reasons);
	const hasGate = collectGateBlockers(context, reasons);

	const deferred = isDeferred(issue, context.now);
	if (deferred) {
		reasons.push({ code: READINESS_REASONS.DEFERRED, until: issue.defer_until });
	}

	const policyDisabled = Boolean(context.policyDisabled);
	if (policyDisabled) {
		reasons.push({ code: READINESS_REASONS.POLICY });
	}

	const conflictingClaim = findConflictingClaim(issue, context.claims, context.actor, context.now);
	if (conflictingClaim) {
		reasons.push({ code: READINESS_REASONS.CLAIM, actor: conflictingClaim.actor });
	}

	const blocked = blockedBy.length > 0 || hasConflict;
	const ready = !blocked
		&& !hasGate
		&& !deferred
		&& !policyDisabled
		&& !conflictingClaim
		&& contract.valid
		&& isWorkableStatus(status)
		&& isReadyEligibleType(issue.type);

	const state = deriveState({
		blocked,
		hasGate,
		deferred,
		hasClaim: Boolean(conflictingClaim),
		policyDisabled,
		ready,
	});

	return {
		id,
		status,
		ready,
		blocked,
		blocked_by: blockedBy,
		reasons,
		state,
		contract_applicable: contract.applicable,
	};
}

// BETA stop-gap for claim thundering-herd (kernel 369c43d7): concurrent `forge ready`
// callers previously all saw the identical rank-0 top pick and raced to claim it (CAS
// lets exactly one win, but the rest burn a claim_conflict write + wasted pre-claim
// reasoning, then re-collide on rank-1, etc). Randomizing which of the top-K
// same-priority issues sorts first spreads concurrent agents across different ready
// issues. Priority tier ordering stays the PRIMARY, un-randomized sort key: only the
// contiguous run of issues sharing the single highest-ranked (lowest-number) priority
// tier is shuffled, and only its first `topK` members — a lower-priority issue can
// never be promoted ahead of a ready higher-priority one. Full fix is Phase-2 per-project
// lease dispatch; this is the cheap interim mitigation only.
const DEFAULT_TOP_K_READY_PICK = 5;

// Fisher-Yates, using an injectable rng (defaults to Math.random) so callers/tests can
// seed it for deterministic assertions. Mutates and returns `array`.
function shuffleInPlace(array, rng) {
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
	return array;
}

// Randomize only the top-K of the single highest-priority tier at the front of an
// already rank+id sorted `sortedIssues` array. Everything else (the tier's remainder
// beyond K, and every lower-priority tier) keeps its deterministic order untouched.
function applyTopKRandomizedPick(sortedIssues, { topK = DEFAULT_TOP_K_READY_PICK, rng = Math.random } = {}) {
	if (sortedIssues.length < 2) return sortedIssues;

	const topRank = normalizeRank(sortedIssues[0].priority_rank);
	let tierEnd = 0;
	while (tierEnd < sortedIssues.length && normalizeRank(sortedIssues[tierEnd].priority_rank) === topRank) {
		tierEnd++;
	}

	const k = Math.max(0, Math.min(topK, tierEnd));
	if (k < 2) return sortedIssues; // nothing to shuffle: <2 candidates in the randomized head

	const head = shuffleInPlace(sortedIssues.slice(0, k), rng);
	const rest = sortedIssues.slice(k);
	return [...head, ...rest];
}

function groupBy(items, keyFn) {
	const grouped = new Map();
	for (const item of items || []) {
		const key = keyFn(item);
		if (!grouped.has(key)) grouped.set(key, []);
		grouped.get(key).push(item);
	}
	return grouped;
}

/**
 * Compute readiness for a whole board, resolving each dependency's status from the issue set.
 * @param {object} input { issues[], dependencies[], conflicts[], claims[], gates[], policyDisabledIds[], now, actor,
 *   topK, rng }. `topK` (default {@link DEFAULT_TOP_K_READY_PICK}) and `rng` (default `Math.random`, injectable for
 *   deterministic tests) control the BETA top-K randomized ready pick (kernel 369c43d7): only the top-K of the
 *   single highest-priority ready tier is shuffled; priority ordering otherwise stays the primary sort.
 * @returns {{readinessById: object, readyQueue: string[], blocked: string[]}} readyQueue is ranked by the single
 *   numeric rank, with the top-K of its leading priority tier randomized.
 */
function buildReadinessIndex(input = {}) {
	const issues = input.issues || [];
	const statusById = new Map(issues.map(issue => [issue.id, issue.status]));
	const typeById = new Map(issues.map(issue => [issue.id, issue.type]));

	const dependencyStatusesByIssue = new Map();
	for (const dependency of input.dependencies || []) {
		if (!dependencyStatusesByIssue.has(dependency.issue_id)) {
			dependencyStatusesByIssue.set(dependency.issue_id, []);
		}
		dependencyStatusesByIssue.get(dependency.issue_id).push({
			id: dependency.blocks_issue_id,
			status: statusById.get(dependency.blocks_issue_id),
			type: typeById.get(dependency.blocks_issue_id),
			dependency_type: dependency.dependency_type,
		});
	}

	const conflictsByIssue = groupBy(input.conflicts, conflict => conflict.entity_id);
	const claimsByIssue = groupBy(input.claims, claim => claim.issue_id);
	const gatesByIssue = groupBy(input.gates, gate => gate.issue_id);
	const policyDisabledIds = new Set(input.policyDisabledIds || []);

	// Null-prototype map: issue ids are unconstrained external strings, so a literal `{}`
	// keyed by them would be a prototype-pollution vector (e.g. an id of `__proto__`).
	const readinessById = Object.create(null);
	for (const issue of issues) {
		readinessById[issue.id] = deriveReadiness(issue, {
			now: input.now,
			actor: input.actor,
			dependencyStatuses: dependencyStatusesByIssue.get(issue.id) || [],
			conflicts: conflictsByIssue.get(issue.id) || [],
			claims: claimsByIssue.get(issue.id) || [],
			gates: gatesByIssue.get(issue.id) || [],
			policyDisabled: policyDisabledIds.has(issue.id),
			contractPolicy: input.contractPolicy,
			dependencyIds: (dependencyStatusesByIssue.get(issue.id) || []).map(dependency => dependency.id),
			isTrustedAdoption: input.isTrustedAdoption,
		});
	}

	const readyIssues = issues.filter(issue => readinessById[issue.id].ready);
	readyIssues.sort((left, right) => (
		(normalizeRank(left.priority_rank) - normalizeRank(right.priority_rank))
		|| String(left.id).localeCompare(String(right.id))
	));
	const pickedReadyIssues = applyTopKRandomizedPick(readyIssues, { topK: input.topK, rng: input.rng });

	return {
		readinessById,
		readyQueue: pickedReadyIssues.map(issue => issue.id),
		blocked: issues.filter(issue => readinessById[issue.id].blocked).map(issue => issue.id),
	};
}

module.exports = {
	READINESS_REASONS,
	READINESS_STATES,
	DEFAULT_TOP_K_READY_PICK,
	buildReadinessIndex,
	deriveReadiness,
	evaluateIssueContract,
	isWorkableStatus,
};
