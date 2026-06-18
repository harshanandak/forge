'use strict';

// Pure claim-lease enforcement helpers (task 9.5.10). No I/O — the broker
// performs all reads/writes and the DB partial UNIQUE index
// (idx_kernel_claims_active_lease) is the hard race-safe guarantee. These
// functions are the optimization + clean error path layered on top, mirroring
// the pure style of evaluators.js.
//
// Ownership model (Slice 1, deliberately conservative): a claim lease is a
// kernel_claims row with state='active'. A lease is "live" iff it is active and
// not expired. ANY claim.create against a live lease quarantines as
// 'claim_conflict' — there is NO silent same-owner renewal, because `actor` is
// not yet guaranteed distinct per concurrent agent and a renewal branch could
// let one agent silently steal another's live lease. Legitimate same-key
// retries never reach here: they are collapsed to duplicate replays by the
// idempotency-key path before claim planning runs.

function normalizeClaimPayload(event) {
	if (event && event.payload && typeof event.payload === 'object') {
		return event.payload;
	}
	if (event && typeof event.payload_json === 'string') {
		try {
			return JSON.parse(event.payload_json);
		} catch {
			return {};
		}
	}
	return {};
}

// A lease with no expires_at never expires. Timestamps are UTC ISO-8601 with a
// trailing 'Z', so lexicographic comparison equals chronological comparison.
function isLeaseExpired(claim, now) {
	if (!claim || !claim.expires_at) return false;
	return claim.expires_at <= now;
}

function buildClaimRow(event, now) {
	const payload = normalizeClaimPayload(event);
	return {
		id: event.entity_id,
		issue_id: payload.issue_id,
		actor: event.actor,
		state: 'active',
		session_id: event.session_id ?? null,
		worktree_id: event.worktree_id ?? null,
		claimed_at: now,
		expires_at: payload.expires_at ?? null,
	};
}

// Decide how a claim.create event should be applied against the issue's current
// active claim (if any). Returns one of:
//   { action: 'insert',  claim }                  — no active claim
//   { action: 'reclaim', supersede, claim }       — active claim has expired
//   { action: 'conflict' }                        — a live lease blocks the claim
function planClaimAcquisition({ event, activeClaim, now }) {
	if (!activeClaim) {
		return { action: 'insert', claim: buildClaimRow(event, now) };
	}
	if (isLeaseExpired(activeClaim, now)) {
		return {
			action: 'reclaim',
			supersede: { claimId: activeClaim.id, toState: 'reclaimable' },
			claim: buildClaimRow(event, now),
		};
	}
	return { action: 'conflict' };
}

// Build a conflicts-table row for a quarantined claim conflict. Matches the
// shape produced by evaluators.buildConflict: claims are not revisioned, so the
// NOT NULL expected_revision / actual_revision columns default to 0. The
// human-meaningful detail (who owns the live lease, who attempted) lives in
// payload_json.
function buildClaimConflict(event, activeClaim) {
	const payload = normalizeClaimPayload(event);
	return {
		entity_type: event.entity_type,
		entity_id: event.entity_id,
		expected_revision: 0,
		actual_revision: 0,
		status: 'quarantined',
		reason: 'claim_conflict',
		payload_json: JSON.stringify({
			reason: 'claim_conflict',
			issue_id: payload.issue_id,
			attempted_by: event.actor,
			current_owner: activeClaim ? activeClaim.actor : null,
			current_claim_id: activeClaim ? activeClaim.id : null,
		}),
		created_at: event.created_at,
	};
}

module.exports = {
	buildClaimConflict,
	buildClaimRow,
	isLeaseExpired,
	planClaimAcquisition,
};
