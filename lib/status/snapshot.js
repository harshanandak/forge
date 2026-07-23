'use strict';

const { resolveIssueBackend } = require('../issue-backend.js');
const { runIssueOperation: defaultRunIssueOperation } = require('../forge-issues.js');
const { getDeveloperIdentity } = require('./identity.js');

// Kernel status vocabulary (taxonomy-validator): 'open', 'in_progress', 'review',
// the parked 'backlog', and the terminal 'done' / 'cancelled'. `ready` / `blocked`
// are DERIVED read-model facts, never stored. An issue is treated as active here when
// it is OPEN and carries a live claim (claimed_by); parked (`backlog`) work is its own
// bucket so it stays visible instead of vanishing between ready and done. These buckets
// are the contract lib/status/presenter.js renders against.
const KERNEL_LIMITS = Object.freeze([
	'Reads Forge Kernel issue authority (ready/blocked/stale/active).',
	'Does not read GitHub review, CI, project, or sync freshness state.',
]);

function parseTimestampOrZero(value) {
	if (!value) {
		return 0;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function sortByUpdatedAtDesc(left, right) {
	return parseTimestampOrZero(right.updated_at) - parseTimestampOrZero(left.updated_at);
}

// The kernel issue record exposes richer fields than the presenter's summary shape,
// which was written for Beads (owner / dependency_count). Map the kernel equivalents
// so `forge status --json` (toIssueSummary) stays informative without the presenter
// needing to know about kernel-specific columns.
function annotateKernelIssue(issue) {
	if (!issue || typeof issue !== 'object') {
		return issue;
	}
	const blockedBy = Array.isArray(issue.blocked_by) ? issue.blocked_by : [];
	return {
		...issue,
		owner: issue.owner || issue.assignee || issue.claimed_by || null,
		dependency_count: Number(issue.dependency_count ?? blockedBy.length ?? 0),
	};
}

// Kernel read operations return the issue contract envelope
// `{ ok, schema_version, command, data: { issues, count }, next_commands }`.
function issuesFromEnvelope(result) {
	if (result && result.ok && result.data && Array.isArray(result.data.issues)) {
		return result.data.issues;
	}
	return [];
}

// Build the set of identities the current developer might be recorded under so
// "active assigned" can match a claim. Kernel claims are keyed by actor id
// (FORGE_ACTOR / FORGE_SESSION_ID), which may differ from the git identity, so match
// claimed_by against any of them.
function buildIdentitySet(developer, env) {
	const ids = new Set();
	const add = (value) => {
		if (typeof value === 'string' && value.trim()) {
			ids.add(value.trim().toLowerCase());
		}
	};
	add(env.FORGE_ACTOR);
	add(env.FORGE_SESSION_ID);
	add(developer && developer.email);
	add(developer && developer.name);
	return ids;
}

function isActiveKernelIssue(issue) {
	return issue.status === 'open' && Boolean(issue.claimed_by);
}

function emptyKernelSnapshot(developer) {
	return {
		developer,
		issues: [],
		active: [],
		activeAssigned: [],
		ready: [],
		blocked: [],
		stale: [],
		parked: [],
		recentCompleted: [],
		limits: KERNEL_LIMITS,
	};
}

/**
 * Build the status snapshot from the Forge Kernel (the default issue authority).
 * Reuses the authoritative kernel read ops (ready/blocked/stale) so the buckets match
 * `forge ready`/`forge issue blocked` exactly, and derives active/in-progress and
 * recent completions from the full issue list. Resilient by contract: any failed read
 * degrades to an empty bucket, and a hard failure returns an empty snapshot — status
 * must never crash.
 *
 * @param {string} projectRoot
 * @param {object} [options]
 * @param {function} [options.runIssueOperation] — injectable kernel read (tests)
 * @param {object} [options.env]
 * @returns {Promise<object>} snapshot in the presenter's bucket contract
 */
async function readKernelSnapshot(projectRoot, options = {}) {
	const runIssueOperation = options.runIssueOperation || defaultRunIssueOperation;
	const env = options.env || process.env;
	const developer = getDeveloperIdentity(projectRoot);

	try {
		const deps = { issueBackend: 'kernel', env };
		const runRead = async (operation) => {
			try {
				return issuesFromEnvelope(await runIssueOperation(operation, [], projectRoot, deps));
			} catch (_error) {
				// One failing bucket must not blank the whole view.
				return [];
			}
		};

		// Sequential (not Promise.all): each op opens its own broker, and the first
		// call lazily runs kernel migrations — serializing avoids a first-use init race.
		const ready = await runRead('ready');
		const blocked = await runRead('blocked');
		const stale = await runRead('stale');
		const all = await runRead('list');

		const identities = buildIdentitySet(developer, env);
		const active = all.filter(isActiveKernelIssue).sort(sortByUpdatedAtDesc);
		const activeAssigned = active.filter(issue => identities.has(String(issue.claimed_by || '').toLowerCase()));
		const recentCompleted = all.filter(issue => issue.status === 'done').sort(sortByUpdatedAtDesc);
		// Parked (`backlog`) work is a first-class lifecycle state that never appears in
		// ready/blocked/active — surface it as its own bucket so it stays visible.
		const parked = all.filter(issue => issue.status === 'backlog').sort(sortByUpdatedAtDesc);

		return {
			developer,
			issues: all.map(annotateKernelIssue),
			active: active.map(annotateKernelIssue),
			activeAssigned: activeAssigned.map(annotateKernelIssue),
			ready: ready.map(annotateKernelIssue),
			blocked: [...blocked].sort(sortByUpdatedAtDesc).map(annotateKernelIssue),
			stale: [...stale].sort(sortByUpdatedAtDesc).map(annotateKernelIssue),
			parked: parked.map(annotateKernelIssue),
			recentCompleted: recentCompleted.map(annotateKernelIssue),
			limits: KERNEL_LIMITS,
		};
	} catch (_error) {
		return emptyKernelSnapshot(developer);
	}
}

/**
 * Read the personal/board status snapshot from the Kernel — the only issue backend.
 *
 * A repo that still carries the retired `issueBackend: beads` signal alongside an
 * unmigrated `.beads/*.jsonl` store now renders the (empty) kernel board rather than
 * the legacy Beads one; `forge upgrade`'s advisory is what points those users at
 * `forge migrate --from beads`.
 *
 * @param {string} projectRoot
 * @param {object} [options] — forwarded to the backend reader; `env` overrides
 *   process.env, `backend` short-circuits resolution entirely.
 * @returns {Promise<object>} snapshot for lib/status/presenter.js
 */
async function readStatusSnapshot(projectRoot, options = {}) {
	const backend = options.backend || resolveIssueBackend({
		env: options.env || process.env,
		projectRoot,
		warn: () => {},
	});

	return readKernelSnapshot(projectRoot, { ...options, backend });
}

module.exports = {
	readStatusSnapshot,
	readKernelSnapshot,
	KERNEL_LIMITS,
};
