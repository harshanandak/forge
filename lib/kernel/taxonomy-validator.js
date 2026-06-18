'use strict';

const { ISSUE_TYPES, ISSUE_STATUSES } = require('./issue-command-contract');

// done/cancelled are terminal: no transitions leave them, and the readiness model
// reports them as `closed` rather than ready/blocked.
const TERMINAL_STATUSES = Object.freeze(['done', 'cancelled']);

// A type only earns existence if it changes Kernel behavior (routing, gates, board
// grouping, rollup) — D18. `feature`/`story`/`chore`/`spike` are labels, not types.
const TYPE_BEHAVIORS = Object.freeze({
	epic: Object.freeze({ container: true, canParent: true, claimable: false, rollup: true, blocksOthers: false, board: 'roadmap' }),
	task: Object.freeze({ container: false, canParent: false, claimable: true, rollup: false, blocksOthers: false, board: 'backlog' }),
	bug: Object.freeze({ container: false, canParent: false, claimable: true, rollup: false, blocksOthers: false, board: 'backlog' }),
	decision: Object.freeze({ container: false, canParent: false, claimable: false, rollup: false, blocksOthers: true, board: 'decisions' }),
});

// Stored status lifecycle. Forward path plus rework (backward) and cancellation.
// ready/blocked are NEVER here — they are derived facts (see readiness-model).
const STATUS_TRANSITIONS = Object.freeze({
	open: Object.freeze(['in_progress', 'cancelled']),
	in_progress: Object.freeze(['review', 'open', 'cancelled']),
	review: Object.freeze(['done', 'in_progress', 'cancelled']),
	done: Object.freeze([]),
	cancelled: Object.freeze([]),
});

const CLAIM_STATES = Object.freeze(['active', 'released', 'expired']);

const DEFAULT_PRIORITY_RANK = 2;
const MAX_DISPLAY_PRIORITY_RANK = 4;

class TaxonomyValidationError extends Error {
	constructor(message, details = {}) {
		super(message);
		this.name = 'TaxonomyValidationError';
		this.code = details.code || 'taxonomy_validation_error';
		this.field = details.field;
	}
}

/** @returns {boolean} true if `type` is one of the four canonical issue types. */
function isValidIssueType(type) {
	return ISSUE_TYPES.includes(type);
}

/** @returns {boolean} true if `status` is one of the five stored statuses (ready/blocked are derived, not stored). */
function isValidIssueStatus(status) {
	return ISSUE_STATUSES.includes(status);
}

/** @returns {boolean} true if `status` is terminal (done/cancelled). */
function isTerminalStatus(status) {
	return TERMINAL_STATUSES.includes(status);
}

/** @returns {object|null} the behavior mapping for `type`, or null for unknown types. */
function getTypeBehavior(type) {
	return Object.hasOwn(TYPE_BEHAVIORS, type) ? TYPE_BEHAVIORS[type] : null;
}

/** @returns {boolean} true if issues of `type` may carry an active claim (task/bug). */
function isClaimableType(type) {
	const behavior = getTypeBehavior(type);
	return Boolean(behavior?.claimable);
}

/** @returns {boolean} true if `from`->`to` is a legal status move (same status is an idempotent no-op). */
function isValidStatusTransition(from, to) {
	if (!isValidIssueStatus(from) || !isValidIssueStatus(to)) {
		return false;
	}
	if (from === to) {
		return true; // idempotent no-op
	}
	return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Assert a status transition is legal.
 * @throws {TaxonomyValidationError} on an unknown status or an illegal move.
 * @returns {true} when the transition is allowed.
 */
function validateStatusTransition(from, to) {
	if (!isValidIssueStatus(from)) {
		throw new TaxonomyValidationError(`Unknown source status: ${from}`, { code: 'unknown_status', field: 'status' });
	}
	if (!isValidIssueStatus(to)) {
		throw new TaxonomyValidationError(`Unknown target status: ${to}`, { code: 'unknown_status', field: 'status' });
	}
	if (!isValidStatusTransition(from, to)) {
		throw new TaxonomyValidationError(`Illegal status transition: ${from} -> ${to}`, {
			code: 'illegal_transition',
			field: 'status',
		});
	}
	return true;
}

function isSelfParent(issue) {
	return Boolean(issue.parent_id) && issue.parent_id === issue.id;
}

function selfParentError() {
	return { code: 'self_parent', field: 'parent_id', message: 'An issue cannot be its own parent' };
}

/**
 * Validate an issue's type/status enums and self-parent rule.
 * @returns {{valid: boolean, errors: Array<{code: string, field: string, message: string}>}}
 */
function validateIssueTaxonomy(issue = {}) {
	const errors = [];
	if (!isValidIssueType(issue.type)) {
		errors.push({ code: 'invalid_type', field: 'type', message: `Unknown issue type: ${issue.type}` });
	}
	if (!isValidIssueStatus(issue.status)) {
		errors.push({ code: 'invalid_status', field: 'status', message: `Unknown issue status: ${issue.status}` });
	}
	if (isSelfParent(issue)) {
		errors.push(selfParentError());
	}
	return { valid: errors.length === 0, errors };
}

function isBlockingDependency(dependency) {
	const type = dependency.dependency_type || dependency.type || 'blocks';
	return type === 'blocks';
}

function buildDependencyAdjacency(dependencies) {
	const adjacency = new Map();
	for (const dependency of dependencies || []) {
		if (!isBlockingDependency(dependency)) continue;
		const from = dependency.issue_id;
		const to = dependency.blocks_issue_id;
		if (!from || !to) continue;
		if (!adjacency.has(from)) adjacency.set(from, []);
		adjacency.get(from).push(to);
	}
	return adjacency;
}

// Rotate a cycle so its smallest member leads: a deterministic, entry-point
// independent representation used for both deduplication and the returned cycle.
function canonicalRotation(cycle) {
	let minIndex = 0;
	for (let i = 1; i < cycle.length; i += 1) {
		if (cycle[i] < cycle[minIndex]) minIndex = i;
	}
	return [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
}

// Iterative (explicit-stack) DFS with white/gray/black coloring. Iterative — not
// recursive — so a deep dependency chain (thousands of nodes, or a crafted import)
// cannot overflow the call stack while computing the readiness/validation read model.
const NODE_WHITE = 0;
const NODE_GRAY = 1;
const NODE_BLACK = 2;

function recordBackEdgeCycle(path, reentryNode, accumulator) {
	const startIndex = path.indexOf(reentryNode);
	if (startIndex < 0) return;
	const cycle = canonicalRotation(path.slice(startIndex));
	const key = cycle.join(' ');
	if (accumulator.seen.has(key)) return;
	accumulator.seen.add(key);
	accumulator.cycles.push(cycle);
}

function exploreFromRoot(root, adjacency, color, accumulator) {
	const path = [root];
	const frames = [{ node: root, neighborIndex: 0 }];
	color.set(root, NODE_GRAY);

	while (frames.length > 0) {
		const frame = frames.at(-1);
		const neighbors = adjacency.get(frame.node) || [];
		if (frame.neighborIndex >= neighbors.length) {
			color.set(frame.node, NODE_BLACK);
			frames.pop();
			path.pop();
			continue;
		}
		const next = neighbors[frame.neighborIndex];
		frame.neighborIndex += 1;
		const nextColor = color.get(next) || NODE_WHITE;
		if (nextColor === NODE_GRAY) {
			recordBackEdgeCycle(path, next, accumulator);
		} else if (nextColor === NODE_WHITE) {
			color.set(next, NODE_GRAY);
			path.push(next);
			frames.push({ node: next, neighborIndex: 0 });
		}
	}
}

/**
 * Find dependency cycles among `blocks` edges using an iterative (stack-safe) DFS.
 * @param {Array<{issue_id: string, blocks_issue_id: string, dependency_type?: string}>} dependencies
 * @returns {string[][]} each detected cycle, canonically rotated (smallest id first), deduplicated.
 */
function findDependencyCycles(dependencies) {
	const adjacency = buildDependencyAdjacency(dependencies);
	const color = new Map();
	const accumulator = { cycles: [], seen: new Set() };
	for (const root of adjacency.keys()) {
		if ((color.get(root) || NODE_WHITE) === NODE_WHITE) {
			exploreFromRoot(root, adjacency, color, accumulator);
		}
	}
	return accumulator.cycles;
}

/**
 * Assert the dependency graph is acyclic.
 * @throws {TaxonomyValidationError} with the first detected cycle.
 * @returns {true} when no cycle exists.
 */
function assertAcyclicDependencies(dependencies) {
	const cycles = findDependencyCycles(dependencies);
	if (cycles.length > 0) {
		throw new TaxonomyValidationError(`Dependency cycle detected: ${cycles[0].join(' -> ')}`, {
			code: 'dependency_cycle',
			field: 'dependencies',
		});
	}
	return true;
}

/**
 * Validate a child issue against its resolved parent (existence, container type, no self-parent).
 * @returns {{valid: boolean, errors: Array<{code: string, field: string, message: string}>}}
 */
function validateParentChild(issue = {}, parent = null) {
	const errors = [];
	if (!issue.parent_id) {
		return { valid: true, errors };
	}
	if (isSelfParent(issue)) {
		errors.push(selfParentError());
		return { valid: false, errors };
	}
	if (!parent) {
		errors.push({ code: 'missing_parent', field: 'parent_id', message: `Parent ${issue.parent_id} not found` });
		return { valid: false, errors };
	}
	const behavior = getTypeBehavior(parent.type);
	if (!behavior?.canParent) {
		errors.push({
			code: 'invalid_parent_type',
			field: 'parent_id',
			message: `Type ${parent.type} cannot contain children`,
		});
	}
	return { valid: errors.length === 0, errors };
}

/**
 * Walk the parent_id chain from `startId`, detecting a cycle.
 * @returns {string[]} the cycle path if one exists, otherwise an empty array.
 */
function findParentCycle(issuesById, startId) {
	const nodes = issuesById || {};
	const visited = [];
	const seen = new Set();
	let current = startId;
	while (current && nodes[current]) {
		if (seen.has(current)) {
			return visited.slice(visited.indexOf(current));
		}
		seen.add(current);
		visited.push(current);
		current = nodes[current].parent_id;
	}
	return [];
}

/** @returns {number|null} epoch millis for a date-ish value, or null if absent/unparseable. */
function toEpochMillis(value) {
	if (value === null || value === undefined) return null;
	const millis = new Date(value).getTime();
	return Number.isFinite(millis) ? millis : null;
}

/**
 * Validate claim-lease invariants (actor, state, claimable type, lease expiry). Fails closed on
 * an unparseable expiry. Complements — does not replace — broker/DB lease enforcement.
 * @returns {{valid: boolean, errors: Array<{code: string, field: string, message: string}>}}
 */
function validateClaim(claim = {}, options = {}) {
	const errors = [];
	if (!claim.actor || String(claim.actor).trim() === '') {
		errors.push({ code: 'missing_actor', field: 'actor', message: 'Claim requires an actor' });
	}
	const state = claim.state || 'active';
	if (!CLAIM_STATES.includes(state)) {
		errors.push({ code: 'invalid_claim_state', field: 'state', message: `Unknown claim state: ${state}` });
	}
	if (options.issueType && !isClaimableType(options.issueType)) {
		errors.push({ code: 'unclaimable_type', field: 'issue_type', message: `Type ${options.issueType} is not claimable` });
	}
	const expiresMillis = toEpochMillis(claim.expires_at);
	const hasExpiry = claim.expires_at !== null && claim.expires_at !== undefined;
	if (hasExpiry && expiresMillis === null) {
		// Fail closed: a lease invariant cannot accept an unparseable expiry date.
		errors.push({ code: 'invalid_lease_date', field: 'expires_at', message: `Unparseable lease expiry: ${claim.expires_at}` });
	}
	const nowMillis = toEpochMillis(options.now);
	if (state === 'active' && nowMillis !== null && expiresMillis !== null && expiresMillis <= nowMillis) {
		// Inclusive boundary: a lease whose expiry instant has arrived is expired, so the
		// issue is released to others rather than held by a just-elapsed lease.
		errors.push({ code: 'lease_expired', field: 'expires_at', message: 'Active claim lease has expired' });
	}
	return { valid: errors.length === 0, errors };
}

/**
 * Check that no issue has more than one active claim.
 * @returns {{valid: boolean, errors: object[], conflictingIssueIds: string[]}}
 */
function validateActiveClaimUniqueness(claims = []) {
	const activeByIssue = new Map();
	for (const claim of claims) {
		if ((claim.state || 'active') !== 'active') continue;
		activeByIssue.set(claim.issue_id, (activeByIssue.get(claim.issue_id) || 0) + 1);
	}
	const conflictingIssueIds = [];
	for (const [issueId, count] of activeByIssue) {
		if (count > 1) conflictingIssueIds.push(issueId);
	}
	const errors = conflictingIssueIds.map(issueId => ({
		code: 'multiple_active_claims',
		field: 'issue_id',
		message: `Issue ${issueId} has more than one active claim`,
	}));
	return { valid: conflictingIssueIds.length === 0, errors, conflictingIssueIds };
}

/** @returns {number} `value` coerced to a non-negative integer rank (0 for non-numeric). */
function normalizeRank(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return 0;
	return Math.max(0, Math.trunc(numeric));
}

/** @returns {number} the authoritative numeric rank for a priority label/number (default rank for unknown labels). */
function rankForPriorityLabel(label) {
	if (typeof label === 'number' && Number.isFinite(label)) {
		return normalizeRank(label);
	}
	const raw = String(label ?? '').trim().toUpperCase();
	const match = /^P?(\d+)$/.exec(raw);
	if (!match) return DEFAULT_PRIORITY_RANK;
	return normalizeRank(match[1]);
}

/** @returns {string} the P0-P4 display label projected from a numeric rank (clamped for display). */
function priorityLabelForRank(rank) {
	const clamped = Math.min(normalizeRank(rank), MAX_DISPLAY_PRIORITY_RANK);
	return `P${clamped}`;
}

module.exports = {
	CLAIM_STATES,
	STATUS_TRANSITIONS,
	TERMINAL_STATUSES,
	TYPE_BEHAVIORS,
	TaxonomyValidationError,
	ISSUE_STATUSES,
	ISSUE_TYPES,
	assertAcyclicDependencies,
	findDependencyCycles,
	findParentCycle,
	getTypeBehavior,
	isClaimableType,
	isTerminalStatus,
	isValidIssueStatus,
	isValidIssueType,
	isValidStatusTransition,
	normalizeRank,
	priorityLabelForRank,
	rankForPriorityLabel,
	toEpochMillis,
	validateActiveClaimUniqueness,
	validateClaim,
	validateIssueTaxonomy,
	validateParentChild,
	validateStatusTransition,
};
