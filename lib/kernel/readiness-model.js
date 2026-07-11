'use strict';

const { getTypeBehavior, isTerminalStatus, normalizeRank, toEpochMillis } = require('./taxonomy-validator');

// Readiness is a DERIVED read model (D18). `ready`/`blocked` are computed on demand
// from dependencies, claims, quarantine/conflicts, gates, defer windows, and policy —
// they are NEVER stored as issue status values.
const READINESS_REASONS = Object.freeze({
	DEPENDENCY: 'dependency',
	QUARANTINE: 'quarantine',
	CONFLICT: 'conflict',
	GATE: 'gate',
	CLAIM: 'claimed',
	DEFERRED: 'deferred',
	POLICY: 'policy_disabled',
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

function findConflictingClaim(issueId, claims, actor, now) {
	const nowMillis = toEpochMillis(now);
	for (const claim of claims || []) {
		if (claim.issue_id !== issueId) continue;
		if ((claim.state || 'active') !== 'active') continue;
		if (actor && claim.actor === actor) continue; // the requesting actor's own claim does not block them
		// An active row whose lease has elapsed is dead (validateClaim agrees) — it must not
		// keep the issue out of the ready queue for other actors. If `now` is unknown we cannot
		// confirm expiry, so the claim still blocks (conservative).
		const expiresMillis = toEpochMillis(claim.expires_at);
		if (expiresMillis !== null && nowMillis !== null && expiresMillis <= nowMillis) continue;
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
		const reason = { code: READINESS_REASONS.DEPENDENCY, issue_id: dependency.id, status: dependency.status };
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

	const reasons = [];
	const blockedBy = [];

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

	const conflictingClaim = findConflictingClaim(id, context.claims, context.actor, context.now);
	if (conflictingClaim) {
		reasons.push({ code: READINESS_REASONS.CLAIM, actor: conflictingClaim.actor });
	}

	const blocked = blockedBy.length > 0 || hasConflict;
	const ready = !blocked
		&& !hasGate
		&& !deferred
		&& !policyDisabled
		&& !conflictingClaim
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

	return { id, status, ready, blocked, blocked_by: blockedBy, reasons, state };
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
	isWorkableStatus,
};
