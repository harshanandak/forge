'use strict';

const { normalizePayload } = require('./evaluators');

// Default lease TTL (kernel d71a824b): how long a claim lease stays live before it
// is eligible for expiry-reclaim, when the caller does not pin an explicit
// expires_at (--expires). This is the ONE place the lease duration lives, reused by
// the CLI boundary (lib/forge-issues.js) to stamp a real expires_at so the dashboard's
// liveness layer has something to compute against. 8 hours: long enough to outlast a
// normal agent work session (no heartbeat/renewal exists yet, so a shorter window
// would risk expiring mid-work and letting another agent reclaim → silent double-work),
// short enough that a dead agent's lease frees within a working day. Callers that
// bypass the boundary (broker-direct, tests) carry no ttl and keep the historical
// null default (never expires).
const DEFAULT_LEASE_TTL_MS = 8 * 60 * 60 * 1000;

// Compute a lease expires_at from claimed_at (`now`) + a TTL in milliseconds. Returns
// null (never expires) for an absent/non-positive/non-finite ttl or an unparseable
// `now`, so a missing ttl is byte-identical to the historical null default. The result
// is always the canonical Date#toISOString form isValidExpiresAt requires (…mmmZ), so
// lexicographic comparison in isLeaseExpired stays chronological.
function computeLeaseExpiry(now, ttlMs) {
	if (ttlMs === null || ttlMs === undefined) return null;
	const ttl = Number(ttlMs);
	if (!Number.isFinite(ttl) || ttl <= 0) return null;
	const base = Date.parse(now);
	if (Number.isNaN(base)) return null;
	return new Date(base + ttl).toISOString();
}

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
//
// Claim scope/row/conflict all read from the SAME normalizePayload the evaluator
// uses to persist the event, so the lease can never describe a different issue
// than the accepted event/outbox.

// A claim lease's expires_at, if present, must be a UTC ISO-8601 timestamp with a
// trailing 'Z' AND a real calendar date — otherwise lexicographic comparison in
// isLeaseExpired is meaningless (e.g. 'zzz' sorts after any timestamp and would
// never expire; other junk sorts before and would look already expired). A
// null/absent value is valid and means "never expires". The broker quarantines
// any claim.create whose expires_at fails this check.
function isValidExpiresAt(value) {
	if (value === null || value === undefined) return true;
	if (typeof value !== 'string') return false;
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) return false;
	// Require the EXACT canonical Date#toISOString form (YYYY-MM-DDTHH:MM:SS.mmmZ):
	// isLeaseExpired compares lexicographically, so a non-canonical spelling like
	// '...00Z' would sort after the equal instant '...00.000Z' (Z > .) and a reclaim
	// at the expiry instant would wrongly look live. The round-trip also rejects
	// rollover dates Date.parse silently normalises (e.g. 2026-02-31 -> 2026-03-03).
	return new Date(timestamp).toISOString() === value;
}

// A lease with no expires_at never expires. Timestamps are validated UTC ISO-8601
// with a trailing 'Z' (see isValidExpiresAt), so lexicographic comparison equals
// chronological comparison.
function isLeaseExpired(claim, now) {
	if (!claim?.expires_at) return false;
	return claim.expires_at <= now;
}

function buildClaimRow(event, now) {
	const payload = normalizePayload(event);
	return {
		id: event.entity_id,
		issue_id: payload.issue_id,
		actor: event.actor,
		state: 'active',
		session_id: event.session_id ?? null,
		worktree_id: event.worktree_id ?? null,
		claimed_at: now,
		// An explicit expires_at (from --expires) wins; otherwise derive from the event's
		// lease_ttl_ms + claimed_at so the CLI boundary can stamp a real expiry. No ttl on
		// the event → null (never expires), preserving the historical broker-direct default.
		expires_at: payload.expires_at ?? computeLeaseExpiry(now, event.lease_ttl_ms),
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
function buildClaimConflict(event, activeClaim, reason = 'claim_conflict') {
	const payload = normalizePayload(event);
	return {
		entity_type: event.entity_type,
		entity_id: event.entity_id,
		expected_revision: 0,
		actual_revision: 0,
		status: 'quarantined',
		reason,
		payload_json: JSON.stringify({
			reason,
			issue_id: payload.issue_id ?? null,
			attempted_by: event.actor,
			current_owner: activeClaim ? activeClaim.actor : null,
			current_claim_id: activeClaim ? activeClaim.id : null,
		}),
		created_at: event.created_at,
	};
}

module.exports = {
	DEFAULT_LEASE_TTL_MS,
	buildClaimConflict,
	buildClaimRow,
	computeLeaseExpiry,
	isLeaseExpired,
	isValidExpiresAt,
	planClaimAcquisition,
};
