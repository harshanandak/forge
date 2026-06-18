const { describe, expect, test } = require('bun:test');

const {
	isLeaseExpired,
	isValidExpiresAt,
	planClaimAcquisition,
	buildClaimConflict,
} = require('../../lib/kernel/lease-enforcer');

const NOW = '2026-06-18T00:00:00.000Z';

function claimEvent(overrides = {}) {
	return {
		entity_type: 'claim',
		entity_id: 'claim-issue-1-A',
		event_type: 'claim.create',
		idempotency_key: 'claim:issue-1:A',
		actor: 'agent-A',
		payload: { issue_id: 'issue-1', expires_at: '2026-06-18T01:00:00.000Z' },
		created_at: NOW,
		...overrides,
	};
}

function activeClaim(overrides = {}) {
	return {
		id: 'claim-issue-1-B',
		issue_id: 'issue-1',
		actor: 'agent-B',
		state: 'active',
		claimed_at: '2026-06-17T00:00:00.000Z',
		expires_at: '2026-06-18T01:00:00.000Z',
		...overrides,
	};
}

describe('lease-enforcer isLeaseExpired', () => {
	test('returns true when expires_at is at or before now', () => {
		expect(isLeaseExpired({ expires_at: '2026-06-17T23:59:59.000Z' }, NOW)).toBe(true);
		expect(isLeaseExpired({ expires_at: NOW }, NOW)).toBe(true);
	});

	test('returns false when expires_at is after now', () => {
		expect(isLeaseExpired({ expires_at: '2026-06-18T00:00:01.000Z' }, NOW)).toBe(false);
	});

	test('treats a null/absent expires_at as never expiring', () => {
		expect(isLeaseExpired({ expires_at: null }, NOW)).toBe(false);
		expect(isLeaseExpired({}, NOW)).toBe(false);
	});
});

describe('lease-enforcer isValidExpiresAt', () => {
	test('accepts a null/absent expires_at (non-expiring lease)', () => {
		expect(isValidExpiresAt(null)).toBe(true);
		expect(isValidExpiresAt(undefined)).toBe(true);
	});

	test('accepts a UTC ISO-8601 timestamp with a trailing Z', () => {
		expect(isValidExpiresAt('2026-06-18T01:00:00.000Z')).toBe(true);
		expect(isValidExpiresAt('2026-06-18T01:00:00Z')).toBe(true);
	});

	test('rejects junk, non-Z, impossible-date, and non-string values', () => {
		expect(isValidExpiresAt('zzz')).toBe(false);
		expect(isValidExpiresAt('2026-06-18T01:00:00')).toBe(false);
		expect(isValidExpiresAt('2026-99-99T00:00:00.000Z')).toBe(false);
		expect(isValidExpiresAt(1750000000000)).toBe(false);
	});
});

describe('lease-enforcer planClaimAcquisition', () => {
	test('derives the claim from payload_json (the persisted payload) when both are present', () => {
		const event = claimEvent({
			payload: { issue_id: 'issue-A', expires_at: null },
			payload_json: JSON.stringify({ issue_id: 'issue-B', expires_at: '2026-06-18T01:00:00.000Z' }),
		});
		const plan = planClaimAcquisition({ event, activeClaim: null, now: NOW });
		expect(plan.claim.issue_id).toBe('issue-B');
		expect(plan.claim.expires_at).toBe('2026-06-18T01:00:00.000Z');
	});

	test('reads issue_id/expires_at from payload_json when no payload object is present', () => {
		const event = claimEvent({
			payload: undefined,
			payload_json: JSON.stringify({ issue_id: 'issue-1', expires_at: '2026-06-18T01:00:00.000Z' }),
		});
		const plan = planClaimAcquisition({ event, activeClaim: null, now: NOW });
		expect(plan.action).toBe('insert');
		expect(plan.claim.issue_id).toBe('issue-1');
		expect(plan.claim.expires_at).toBe('2026-06-18T01:00:00.000Z');
	});

	test('plans a plain insert when no active claim exists', () => {
		const plan = planClaimAcquisition({ event: claimEvent(), activeClaim: null, now: NOW });
		expect(plan.action).toBe('insert');
		expect(plan.supersede).toBeUndefined();
		expect(plan.claim).toMatchObject({
			id: 'claim-issue-1-A',
			issue_id: 'issue-1',
			actor: 'agent-A',
			state: 'active',
			claimed_at: NOW,
			expires_at: '2026-06-18T01:00:00.000Z',
		});
	});

	test('quarantines as a conflict when a live lease is held by anyone (no silent renewal)', () => {
		// Conservative model: a live lease blocks ALL new claims, even the same actor.
		// Same-key retries are collapsed to duplicate replays upstream before this runs.
		const live = activeClaim({ actor: 'agent-B', expires_at: '2026-06-18T00:00:01.000Z' });
		expect(planClaimAcquisition({ event: claimEvent(), activeClaim: live, now: NOW }).action).toBe('conflict');

		const sameActorLive = activeClaim({ actor: 'agent-A', expires_at: '2026-06-18T00:00:01.000Z' });
		expect(planClaimAcquisition({ event: claimEvent(), activeClaim: sameActorLive, now: NOW }).action).toBe('conflict');

		const nonExpiring = activeClaim({ expires_at: null });
		expect(planClaimAcquisition({ event: claimEvent(), activeClaim: nonExpiring, now: NOW }).action).toBe('conflict');
	});

	test('plans a reclaim that supersedes the stale lease before inserting when the active claim has expired', () => {
		const expired = activeClaim({ id: 'claim-stale', expires_at: '2026-06-17T23:00:00.000Z' });
		const plan = planClaimAcquisition({ event: claimEvent(), activeClaim: expired, now: NOW });
		expect(plan.action).toBe('reclaim');
		expect(plan.supersede).toEqual({ claimId: 'claim-stale', toState: 'reclaimable' });
		expect(plan.claim).toMatchObject({ id: 'claim-issue-1-A', issue_id: 'issue-1', state: 'active' });
	});
});

describe('lease-enforcer buildClaimConflict', () => {
	test('falls back to an empty payload when payload_json is malformed (no throw)', () => {
		const event = claimEvent({ payload: undefined, payload_json: '{bad-json' });
		expect(() => buildClaimConflict(event, activeClaim())).not.toThrow();
		const parsed = JSON.parse(buildClaimConflict(event, activeClaim()).payload_json);
		expect(parsed.issue_id).toBeNull();
		expect(parsed.reason).toBe('claim_conflict');
	});

	test('uses a custom reason and null owner fields for a scopeless/malformed claim', () => {
		const event = claimEvent({ payload: {} });
		const conflict = buildClaimConflict(event, null, 'invalid_claim_scope');
		expect(conflict.reason).toBe('invalid_claim_scope');
		const parsed = JSON.parse(conflict.payload_json);
		expect(parsed.reason).toBe('invalid_claim_scope');
		expect(parsed.issue_id).toBeNull();
		expect(parsed.current_owner).toBeNull();
		expect(parsed.current_claim_id).toBeNull();
	});

	test('builds a quarantined conflict row carrying the current owner and attempting actor', () => {
		const conflict = buildClaimConflict(claimEvent(), activeClaim());
		expect(conflict).toMatchObject({
			entity_type: 'claim',
			entity_id: 'claim-issue-1-A',
			expected_revision: 0,
			actual_revision: 0,
			status: 'quarantined',
			reason: 'claim_conflict',
			created_at: NOW,
		});
		const parsed = JSON.parse(conflict.payload_json);
		expect(parsed.reason).toBe('claim_conflict');
		expect(parsed.issue_id).toBe('issue-1');
		expect(parsed.attempted_by).toBe('agent-A');
		expect(parsed.current_owner).toBe('agent-B');
		expect(parsed.current_claim_id).toBe('claim-issue-1-B');
	});
});
