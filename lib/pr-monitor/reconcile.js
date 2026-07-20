'use strict';

/**
 * The PURE reconcile core of the autonomous shepherd (W-S4 design §1).
 *
 * `reconcile(desired, observed, now)` diffs the three sets that describe a repo's
 * PR world and returns the action set that would converge them. It is a pure
 * function: NO `require` of fs/child_process/gh, no clock read, no spawn. Given
 * identical inputs it returns an identical (deep-equal) action set, so it is
 * unit-testable against fixtures and the executor (W-S4b) is a thin, idempotent,
 * order-free dispatcher over the actions it emits.
 *
 * Inputs (exact shapes in design §1):
 *   desired  = { openPrs: [{repo,number,branch,headSha,issueId,worktreeId,journalPtr}], gitCommonDir }
 *   observed = { lease:{watchers:[{pr,pid,startedAt}]}|null, leaseFresh, prRows:[kernel_pr rows], liveWatcherPids:[{pid,startedAt}] }
 *
 * Actions (discriminated union):
 *   { type:'upsertPrRow', row:{...kernel_pr columns} }
 *   { type:'startWatcher', pr:{repo,number,branch,headSha} }
 *   { type:'stopWatcher',  pr:{number} }
 *   { type:'retire',       pr:{number} }
 *   { type:'reapOrphan',   pid, startedAt }
 *
 * `now` is injected and kept in the signature for forward rules; the current six
 * rules read no clock (freshness is precomputed into `observed.leaseFresh`).
 *
 * @module pr-monitor/reconcile
 */

/**
 * Normalize a lease watcher entry to `{pr, pid, startedAt}`. W-S3 shipped the
 * legacy shape `watchers: [prNumber]`; a bare number is treated as
 * `{pr:n, pid:null, startedAt:null}` so it is tracked for start/stop but is NEVER
 * reaped (a null pid/startedAt cannot be verified against PID reuse — fail-safe).
 */
function normalizeWatcher(entry) {
	if (typeof entry === 'number') return { pr: entry, pid: null, startedAt: null };
	return entry;
}

/** A watcher is "live" iff a probed live pid matches BOTH its pid AND its startedAt (defeats PID reuse). */
function isWatcherLive(watcher, liveWatcherPids) {
	if (watcher.pid == null) return false;
	return liveWatcherPids.some(live => live.pid === watcher.pid && live.startedAt === watcher.startedAt);
}

function reconcile(desired, observed, _now) {
	const openPrs = (desired && Array.isArray(desired.openPrs)) ? desired.openPrs : [];
	const prRows = (observed && Array.isArray(observed.prRows)) ? observed.prRows : [];
	const liveWatcherPids = (observed && Array.isArray(observed.liveWatcherPids)) ? observed.liveWatcherPids : [];
	const rawWatchers = (observed && observed.lease && Array.isArray(observed.lease.watchers)) ? observed.lease.watchers : [];
	const watchers = rawWatchers.map(normalizeWatcher);

	const desiredNumbers = new Set(openPrs.map(p => p.number));
	const kByNumber = new Map(prRows.map(row => [row.number, row]));

	const actions = [];

	// Rule 1 — register/refresh: a desired PR missing from kernel, or in kernel with
	// a drifted head_sha, needs an upsert (carries branch + soft links + journal ptr).
	for (const p of openPrs) {
		const row = kByNumber.get(p.number);
		if (!row || row.head_sha !== p.headSha) {
			actions.push({
				type: 'upsertPrRow',
				row: {
					repo: p.repo,
					number: p.number,
					branch: p.branch ?? null,
					head_sha: p.headSha ?? null,
					issue_id: p.issueId ?? null,
					worktree_id: p.worktreeId ?? null,
					journal_ptr: p.journalPtr ?? null,
				},
			});
		}
	}

	// Rule 2 — start: a desired PR with no live watcher needs one started.
	for (const p of openPrs) {
		const hasLive = watchers.some(w => w.pr === p.number && isWatcherLive(w, liveWatcherPids));
		if (!hasLive) {
			actions.push({ type: 'startWatcher', pr: { repo: p.repo, number: p.number, branch: p.branch ?? null, headSha: p.headSha ?? null } });
		}
	}

	// Rule 3 — stop: a watcher for a PR no longer in the desired open set is stopped
	// (deduped: one stopWatcher per PR number even if several watcher entries linger).
	const stopped = new Set();
	for (const w of watchers) {
		if (!desiredNumbers.has(w.pr) && !stopped.has(w.pr)) {
			stopped.add(w.pr);
			actions.push({ type: 'stopWatcher', pr: { number: w.pr } });
		}
	}

	// Rule 4 — retire: a kernel row still `open` whose PR left the desired set is retired.
	for (const row of prRows) {
		if (row.state === 'open' && !desiredNumbers.has(row.number)) {
			actions.push({ type: 'retire', pr: { number: row.number } });
		}
	}

	// Rule 5 — reap: a still-live watcher pid claiming a PR no longer open is an
	// orphan. startedAt is passed through for the executor's kill-time re-verify.
	for (const w of watchers) {
		if (w.pid == null || desiredNumbers.has(w.pr)) continue;
		if (isWatcherLive(w, liveWatcherPids)) {
			actions.push({ type: 'reapOrphan', pid: w.pid, startedAt: w.startedAt });
		}
	}

	return { actions };
}

module.exports = { reconcile };
