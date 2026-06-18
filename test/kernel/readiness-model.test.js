const { describe, expect, test } = require('bun:test');

const {
	READINESS_REASONS,
	READINESS_STATES,
	isWorkableStatus,
	deriveReadiness,
	buildReadinessIndex,
} = require('../../lib/kernel/readiness-model');

const NOW = '2026-06-17T00:00:00.000Z';

describe('readiness reason and state vocabularies', () => {
	test('exposes stable reason codes', () => {
		expect(READINESS_REASONS.DEPENDENCY).toBe('dependency');
		expect(READINESS_REASONS.CLAIM).toBe('claimed');
		expect(READINESS_REASONS.QUARANTINE).toBe('quarantine');
		expect(READINESS_REASONS.GATE).toBe('gate');
		expect(READINESS_REASONS.DEFERRED).toBe('deferred');
		expect(READINESS_REASONS.POLICY).toBe('policy_disabled');
	});

	test('exposes the derived state vocabulary including ready and blocked', () => {
		expect(READINESS_STATES).toContain('ready');
		expect(READINESS_STATES).toContain('blocked');
		expect(READINESS_STATES).toContain('closed');
	});

	test('classifies workable statuses', () => {
		expect(isWorkableStatus('open')).toBe(true);
		expect(isWorkableStatus('in_progress')).toBe(true);
		expect(isWorkableStatus('done')).toBe(false);
		expect(isWorkableStatus('cancelled')).toBe(false);
	});
});

describe('deriveReadiness — derived facts, never stored', () => {
	test('an open issue with no blockers is ready', () => {
		const result = deriveReadiness({ id: 'a', status: 'open' }, { now: NOW });
		expect(result.ready).toBe(true);
		expect(result.blocked).toBe(false);
		expect(result.blocked_by).toEqual([]);
		expect(result.state).toBe('ready');
		// derived output must not leak back as a stored status field
		expect(result.status).toBe('open');
	});

	test('an unmet dependency blocks the issue', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, dependencyStatuses: [{ id: 'b', status: 'in_progress' }] },
		);
		expect(result.ready).toBe(false);
		expect(result.blocked).toBe(true);
		expect(result.blocked_by).toContain('b');
		expect(result.state).toBe('blocked');
		expect(result.reasons.map(reason => reason.code)).toContain('dependency');
	});

	test('a satisfied (done) dependency does not block', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, dependencyStatuses: [{ id: 'b', status: 'done' }] },
		);
		expect(result.ready).toBe(true);
		expect(result.blocked).toBe(false);
	});

	test('non-blocking dependency types are ignored', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, dependencyStatuses: [{ id: 'b', status: 'open', dependency_type: 'related' }] },
		);
		expect(result.blocked).toBe(false);
	});

	test('an unresolved decision dependency blocks the issue', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, dependencyStatuses: [{ id: 'd', status: 'open', type: 'decision' }] },
		);
		expect(result.blocked).toBe(true);
		expect(result.blocked_by).toContain('d');
	});

	test('a quarantine/conflict marks the issue blocked', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, conflicts: [{ entity_id: 'a', status: 'quarantined' }] },
		);
		expect(result.blocked).toBe(true);
		expect(result.reasons.map(reason => reason.code)).toContain('quarantine');
	});

	test('an unsatisfied required gate makes the issue not ready (gated)', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, gates: [{ name: 'design_approved', satisfied: false }] },
		);
		expect(result.ready).toBe(false);
		expect(result.state).toBe('gated');
		expect(result.reasons.map(reason => reason.code)).toContain('gate');
	});

	test('an active claim by another actor makes the issue not ready (claimed)', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, claims: [{ issue_id: 'a', actor: 'other', state: 'active' }], actor: 'me' },
		);
		expect(result.ready).toBe(false);
		expect(result.blocked).toBe(false);
		expect(result.state).toBe('claimed');
		expect(result.reasons.map(reason => reason.code)).toContain('claimed');
	});

	test('an issue claimed by the requesting actor is still ready for that actor', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, claims: [{ issue_id: 'a', actor: 'me', state: 'active' }], actor: 'me' },
		);
		expect(result.ready).toBe(true);
	});

	test('a future defer window makes the issue not ready (deferred)', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open', defer_until: '2026-12-01T00:00:00.000Z' },
			{ now: NOW },
		);
		expect(result.ready).toBe(false);
		expect(result.state).toBe('deferred');
		expect(result.reasons.map(reason => reason.code)).toContain('deferred');
	});

	test('a past defer window is no longer deferring', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open', defer_until: '2026-01-01T00:00:00.000Z' },
			{ now: NOW },
		);
		expect(result.ready).toBe(true);
	});

	test('a policy-disabled issue is not ready', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, policyDisabled: true },
		);
		expect(result.ready).toBe(false);
		expect(result.state).toBe('disabled');
	});

	test('a terminal issue is closed, neither ready nor blocked', () => {
		const done = deriveReadiness({ id: 'a', status: 'done' }, { now: NOW });
		expect(done.ready).toBe(false);
		expect(done.blocked).toBe(false);
		expect(done.state).toBe('closed');

		const cancelled = deriveReadiness({ id: 'a', status: 'cancelled' }, { now: NOW });
		expect(cancelled.state).toBe('closed');
	});

	test('blocked takes precedence over claimed in the summary state', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{
				now: NOW,
				dependencyStatuses: [{ id: 'b', status: 'open' }],
				claims: [{ issue_id: 'a', actor: 'other', state: 'active' }],
				actor: 'me',
			},
		);
		expect(result.blocked).toBe(true);
		expect(result.state).toBe('blocked');
	});

	test('never mutates the input issue', () => {
		const issue = { id: 'a', status: 'open' };
		const frozen = Object.freeze({ ...issue });
		expect(() => deriveReadiness(frozen, { now: NOW })).not.toThrow();
	});
});

describe('buildReadinessIndex — board read model', () => {
	test('resolves dependency statuses from the issue set and ranks the ready queue', () => {
		const index = buildReadinessIndex({
			now: NOW,
			issues: [
				{ id: 'a', status: 'open', priority_rank: 2 },
				{ id: 'b', status: 'open', priority_rank: 0 },
				{ id: 'c', status: 'open', priority_rank: 1 },
			],
			dependencies: [
				{ issue_id: 'a', blocks_issue_id: 'b' }, // a depends on b
			],
		});

		// b is unfinished, so a is blocked; b and c are ready, ordered by rank (0 before 1)
		expect(index.readinessById.a.blocked).toBe(true);
		expect(index.blocked).toContain('a');
		expect(index.readyQueue).toEqual(['b', 'c']);
	});

	test('excludes terminal and claimed-by-other issues from the ready queue', () => {
		const index = buildReadinessIndex({
			now: NOW,
			actor: 'me',
			issues: [
				{ id: 'a', status: 'done', priority_rank: 0 },
				{ id: 'b', status: 'open', priority_rank: 1 },
				{ id: 'c', status: 'open', priority_rank: 2 },
			],
			claims: [{ issue_id: 'c', actor: 'other', state: 'active' }],
		});

		expect(index.readyQueue).toEqual(['b']);
		expect(index.readinessById.a.state).toBe('closed');
		expect(index.readinessById.c.state).toBe('claimed');
	});

	test('wires gates, conflicts, and policyDisabledIds into per-issue readiness', () => {
		const index = buildReadinessIndex({
			now: NOW,
			issues: [
				{ id: 'g', status: 'open', priority_rank: 0 },
				{ id: 'q', status: 'open', priority_rank: 1 },
				{ id: 'p', status: 'open', priority_rank: 2 },
				{ id: 'ok', status: 'open', priority_rank: 3 },
			],
			gates: [{ issue_id: 'g', name: 'design_approved', satisfied: false }],
			conflicts: [{ entity_id: 'q', status: 'quarantined' }],
			policyDisabledIds: ['p'],
		});

		expect(index.readinessById.g.state).toBe('gated');
		expect(index.readinessById.q.state).toBe('blocked');
		expect(index.readinessById.p.state).toBe('disabled');
		expect(index.readinessById.ok.ready).toBe(true);
		expect(index.readyQueue).toEqual(['ok']);
		expect(index.blocked).toEqual(['q']);
	});
});

describe('deriveReadiness — additional branches', () => {
	test('a non-workable, non-terminal status with no blockers falls through to backlog', () => {
		const result = deriveReadiness({ id: 'a', status: 'review' }, { now: NOW });
		expect(result.ready).toBe(false);
		expect(result.blocked).toBe(false);
		expect(result.state).toBe('backlog');
	});

	test('a conflict for a different entity does not block this issue', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, conflicts: [{ entity_id: 'other', status: 'quarantined' }] },
		);
		expect(result.blocked).toBe(false);
		expect(result.ready).toBe(true);
	});

	test('a non-active claim by another actor does not make the issue claimed', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, claims: [{ issue_id: 'a', actor: 'other', state: 'released' }], actor: 'me' },
		);
		expect(result.ready).toBe(true);
		expect(result.state).not.toBe('claimed');
	});

	test('a decision blocker carries the decision marker', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, dependencyStatuses: [{ id: 'd', status: 'open', type: 'decision' }] },
		);
		const decisionReason = result.reasons.find(reason => reason.issue_id === 'd');
		expect(decisionReason.decision).toBe(true);
	});

	test('a cancelled dependency is terminal and no longer blocks', () => {
		const result = deriveReadiness(
			{ id: 'a', status: 'open' },
			{ now: NOW, dependencyStatuses: [{ id: 'b', status: 'cancelled' }] },
		);
		expect(result.blocked).toBe(false);
		expect(result.ready).toBe(true);
	});
});
