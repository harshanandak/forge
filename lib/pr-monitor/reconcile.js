'use strict';

/**
 * Pure repository reconciler. The daemon lease elects a repository daemon; the
 * Kernel owner row is the only per-PR watcher authority.
 *
 * @module pr-monitor/reconcile
 */

const LIFECYCLE_STATUS = Object.freeze({
	PASS: 'PASS',
	STALE: 'STALE',
	INCOMPLETE: 'INCOMPLETE',
	CONFLICT: 'CONFLICT',
});

const OWNER_PHASES = new Set([
	'starting',
	'running',
	'stop_requested',
	'terminal_pending',
	'complete',
	'blocked',
]);

const DESIRED_PR_FIELDS = [
	'repo', 'number', 'branch', 'headSha', 'issueId', 'worktreeId', 'journalPtr',
];
const OBSERVED_PR_FIELDS = [
	'repo', 'number', 'branch', 'head_sha', 'issue_id', 'worktree_id', 'journal_ptr', 'state',
];

function incompleteLifecycle(reason) {
	return { status: LIFECYCLE_STATUS.INCOMPLETE, reason, actions: [] };
}

function conflictingLifecycle(reason) {
	return { status: LIFECYCLE_STATUS.CONFLICT, reason, actions: [] };
}

function prNumber(value) {
	if (Number.isSafeInteger(value) && value > 0) return value;
	if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function canonicalRepo(value) {
	return typeof value === 'string'
		&& value === value.trim()
		&& value === value.toLowerCase()
		&& /^[^/\s]+\/[^/\s]+$/.test(value);
}

function identityKey(repo, number) {
	return `${repo}\u0000${number}`;
}

function sameFields(left, right, fields) {
	return fields.every(field => (left[field] ?? null) === (right[field] ?? null));
}

function normalizeDesiredPrs(openPrs) {
	const byKey = new Map();
	for (const item of openPrs) {
		const number = prNumber(item?.number);
		if (!item || !canonicalRepo(item.repo) || number == null) {
			return incompleteLifecycle('desired PR identity is incomplete');
		}
		const normalized = { ...item, number };
		const key = identityKey(normalized.repo, number);
		const prior = byKey.get(key);
		if (prior && !sameFields(prior, normalized, DESIRED_PR_FIELDS)) {
			return conflictingLifecycle(`desired PR ${normalized.repo}#${number} has conflicting evidence`);
		}
		if (!prior) byKey.set(key, normalized);
	}
	return { status: LIFECYCLE_STATUS.PASS, values: [...byKey.values()] };
}

function mergeObservedPrRows(left, right, repo, number) {
	const merged = { ...left };
	for (const field of OBSERVED_PR_FIELDS) {
		if (field === 'repo' || field === 'number') continue;
		const leftValue = left[field] ?? null;
		const rightValue = right[field] ?? null;
		if (leftValue != null && rightValue != null && leftValue !== rightValue) {
			return conflictingLifecycle(`observed PR ${repo}#${number} has conflicting rows`);
		}
		if (leftValue == null && rightValue != null) merged[field] = rightValue;
	}
	return { status: LIFECYCLE_STATUS.PASS, value: merged };
}

function normalizePrRows(prRows, desiredRepos) {
	const byKey = new Map();
	const legacyRows = [];
	for (const row of prRows) {
		const number = prNumber(row?.number);
		if (!row || number == null || typeof row.repo !== 'string') {
			return incompleteLifecycle('observed PR row identity is incomplete');
		}
		let repo = canonicalRepo(row.repo) ? row.repo : null;
		if (!repo) {
			const bare = row.repo.trim().toLowerCase();
			const matches = desiredRepos.filter(candidate => candidate.slice(candidate.lastIndexOf('/') + 1) === bare);
			if (matches.length !== 1) {
				return matches.length > 1
					? conflictingLifecycle(`observed PR ${row.repo}#${number} has ambiguous repository linkage`)
					: incompleteLifecycle('observed PR row identity is incomplete');
			}
			repo = matches[0];
			legacyRows.push({ repo: row.repo, number });
		}
		const normalized = { ...row, repo, number };
		const key = identityKey(normalized.repo, number);
		const prior = byKey.get(key);
		if (prior) {
			const merged = mergeObservedPrRows(prior, normalized, repo, number);
			if (merged.status !== LIFECYCLE_STATUS.PASS) return merged;
			byKey.set(key, merged.value);
		} else {
			byKey.set(key, normalized);
		}
	}
	return { status: LIFECYCLE_STATUS.PASS, values: [...byKey.values()], legacyRows };
}

function normalizeOwnerRows(ownerRows) {
	const byKey = new Map();
	for (const row of ownerRows) {
		const number = prNumber(row?.pr);
		if (!row || row.version !== 1 || !canonicalRepo(row.repo) || number == null
			|| typeof row.generation !== 'string' || !row.generation
			|| !OWNER_PHASES.has(row.phase)) {
			return incompleteLifecycle('watch owner row is invalid');
		}
		const normalized = { ...row, pr: number };
		const key = identityKey(normalized.repo, number);
		if (byKey.has(key)) {
			return conflictingLifecycle(`watch owner ${normalized.repo}#${number} is duplicated`);
		}
		byKey.set(key, normalized);
	}
	return { status: LIFECYCLE_STATUS.PASS, values: [...byKey.values()] };
}

function validateLifecycleAuthority(desired, observed) {
	if (!desired || !Array.isArray(desired.openPrs) || !observed
		|| !Array.isArray(observed.prRows) || !Array.isArray(observed.ownerRows)) {
		return incompleteLifecycle('lifecycle collections are incomplete');
	}
	if (desired.listingOk === false || desired.repositoryOk === false) {
		return incompleteLifecycle('desired PR enumeration is incomplete');
	}
	if (observed.ownerRowsOk !== true) {
		return incompleteLifecycle('watch owner enumeration is incomplete');
	}
	if (!observed.migrationGate || observed.migrationGate.state !== 'complete') {
		return incompleteLifecycle('watch owner migration gate is not complete');
	}
	return null;
}

function normalizeLifecycleInputs(desired, observed) {
	const invalid = validateLifecycleAuthority(desired, observed);
	if (invalid) return invalid;
	const desiredPrs = normalizeDesiredPrs(desired.openPrs);
	if (desiredPrs.status !== LIFECYCLE_STATUS.PASS) return desiredPrs;
	const desiredRepos = [...new Set([
		...(canonicalRepo(desired.repo) ? [desired.repo] : []),
		...desiredPrs.values.map(row => row.repo),
	])];
	const prRows = normalizePrRows(observed.prRows, desiredRepos);
	if (prRows.status !== LIFECYCLE_STATUS.PASS) return prRows;
	const ownerRows = normalizeOwnerRows(observed.ownerRows);
	if (ownerRows.status !== LIFECYCLE_STATUS.PASS) return ownerRows;
	return {
		status: LIFECYCLE_STATUS.PASS,
		desired: { ...desired, openPrs: desiredPrs.values },
		observed: {
			...observed,
			prRows: prRows.values,
			legacyPrRows: prRows.legacyRows,
			ownerRows: ownerRows.values,
		},
	};
}

function linkDrifted(pr, row) {
	return (pr.issueId != null && pr.issueId !== row.issue_id)
		|| (pr.worktreeId != null && pr.worktreeId !== row.worktree_id)
		|| (pr.branch != null && pr.branch !== row.branch)
		|| (pr.journalPtr != null && pr.journalPtr !== row.journal_ptr);
}

function buildUpsertActions(openPrs, rowsByKey, gitCommonDir) {
	const actions = [];
	for (const pr of openPrs) {
		const row = rowsByKey.get(identityKey(pr.repo, pr.number));
		if (row && row.head_sha === pr.headSha && !linkDrifted(pr, row)) continue;
		actions.push({
			type: 'upsertPrRow',
			row: {
				git_common_dir: gitCommonDir ?? null,
				repo: pr.repo,
				number: pr.number,
				branch: pr.branch ?? null,
				head_sha: pr.headSha ?? null,
				issue_id: pr.issueId ?? row?.issue_id ?? null,
				worktree_id: pr.worktreeId ?? row?.worktree_id ?? null,
				journal_ptr: pr.journalPtr ?? row?.journal_ptr ?? null,
			},
		});
	}
	return actions;
}

function publicPr(pr) {
	return {
		repo: pr.repo,
		number: pr.number,
		branch: pr.branch ?? null,
		headSha: pr.headSha ?? null,
	};
}

function shouldRecoverStarting(row) {
	return row.phase === 'starting' && row.controllerAlive === false;
}

function shouldRetryStarting(row, controllerPid) {
	return row.phase === 'starting' && row.controllerAlive === true
		&& Number.isSafeInteger(controllerPid) && controllerPid > 0 && row.controllerPid === controllerPid;
}

function activeOwnerActions(pr, row, controllerPid) {
	if (!row) return [{ type: 'reserveWatcher', pr: publicPr(pr) }];
	if (shouldRecoverStarting(row)) {
		return [{ type: 'recoverStarting', owner: row, pr: publicPr(pr) }];
	}
	if (shouldRetryStarting(row, controllerPid)) {
		return [{ type: 'retryStarting', owner: row, pr: publicPr(pr) }];
	}
	if ((row.phase === 'running' || row.phase === 'stop_requested') && row.watcherAlive === false) {
		return [{ type: 'recoverWatcher', owner: row, pr: publicPr(pr), providerState: 'open' }];
	}
	if (row.phase === 'terminal_pending' && row.watcherAlive === false) {
		return [{ type: 'completeTerminal', owner: row }];
	}
	if (row.phase === 'complete') {
		return [{ type: 'reopenWatcher', owner: row, pr: publicPr(pr) }];
	}
	if (row.phase === 'blocked' && row.blockReason === 'legacy_live_pid' && row.watcherAlive === false) {
		return [{ type: 'recheckLegacyBlocked', owner: row, providerState: 'open' }];
	}
	return [];
}

function inactiveOwnerActions(row, controllerPid) {
	if ((row.phase === 'running' || row.phase === 'stop_requested') && row.watcherAlive === false) {
		return [{ type: 'recoverWatcher', owner: row, providerState: 'terminal' }];
	}
	if (shouldRecoverStarting(row)) {
		return [{ type: 'recoverStarting', owner: row, providerState: 'terminal' }];
	}
	if (shouldRetryStarting(row, controllerPid)) {
		return [{ type: 'retryStarting', owner: row, providerState: 'terminal' }];
	}
	if (row.phase === 'terminal_pending' && row.watcherAlive === false) {
		return [{ type: 'completeTerminal', owner: row }];
	}
	if (row.phase === 'blocked' && row.blockReason === 'legacy_live_pid' && row.watcherAlive === false) {
		return [{ type: 'recheckLegacyBlocked', owner: row, providerState: 'terminal' }];
	}
	return [];
}

function buildLifecycleActions(desired, observed) {
	const openPrs = desired.openPrs;
	const prRows = observed.prRows;
	const ownerRows = observed.ownerRows;
	const desiredRepo = desired.repo || openPrs[0]?.repo;
	const desiredKeys = new Set(openPrs.map(pr => identityKey(pr.repo, pr.number)));
	const prRowsByKey = new Map(prRows.map(row => [identityKey(row.repo, row.number), row]));
	const ownerRowsByKey = new Map(ownerRows.map(row => [identityKey(row.repo, row.pr), row]));
	const actions = buildUpsertActions(openPrs, prRowsByKey, desired.gitCommonDir);

	for (const pr of openPrs) {
		actions.push(...activeOwnerActions(pr, ownerRowsByKey.get(identityKey(pr.repo, pr.number)), desired.controllerPid));
	}
	for (const row of ownerRows) {
		if (!desiredRepo || row.repo !== desiredRepo) continue;
		if (!desiredKeys.has(identityKey(row.repo, row.pr))) actions.push(...inactiveOwnerActions(row, desired.controllerPid));
	}
	for (const row of prRows) {
		if (!desiredRepo || row.repo !== desiredRepo) continue;
		if (row.state === 'open' && !desiredKeys.has(identityKey(row.repo, row.number))) {
			actions.push({ type: 'retire', pr: { repo: row.repo, number: row.number } });
		}
	}
	for (const row of observed.legacyPrRows || []) {
		actions.push({ type: 'retire', pr: { repo: row.repo, number: row.number } });
	}
	return actions;
}

function decideLifecycle(desired, observed, _now) {
	const normalized = normalizeLifecycleInputs(desired, observed);
	if (normalized.status !== LIFECYCLE_STATUS.PASS) return normalized;
	return {
		status: LIFECYCLE_STATUS.PASS,
		reason: 'owner-row lifecycle evidence accepted',
		actions: buildLifecycleActions(normalized.desired, normalized.observed),
	};
}

function reconcile(desired, observed, now) {
	return { actions: decideLifecycle(desired, observed, now).actions };
}

module.exports = { reconcile, decideLifecycle, LIFECYCLE_STATUS };
