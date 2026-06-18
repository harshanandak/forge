const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const { getKernelSchema, KERNEL_TABLES } = require('../../lib/kernel/schema');
const { buildSchemaMigration } = require('../../lib/kernel/migrations');
const {
	ISSUE_TYPES,
	ISSUE_STATUSES,
} = require('../../lib/kernel/issue-command-contract');
const {
	TERMINAL_STATUSES,
	TYPE_BEHAVIORS,
	STATUS_TRANSITIONS,
	TaxonomyValidationError,
	isValidIssueType,
	isValidIssueStatus,
	getTypeBehavior,
	isClaimableType,
	isTerminalStatus,
	isValidStatusTransition,
	validateStatusTransition,
	validateIssueTaxonomy,
	findDependencyCycles,
	assertAcyclicDependencies,
	validateParentChild,
	findParentCycle,
	validateClaim,
	validateActiveClaimUniqueness,
	rankForPriorityLabel,
	priorityLabelForRank,
	normalizeRank,
} = require('../../lib/kernel/taxonomy-validator');

describe('D18 issue schema taxonomy extensions', () => {
	test('extends the issues table with planning and execution columns', () => {
		const issues = getKernelSchema().tables.find(table => table.name === 'issues');
		const fieldNames = issues.fields.map(field => field.name);

		for (const column of [
			'parent_id',
			'sprint_id',
			'release_id',
			'stage_state',
			'labels',
			'acceptance_criteria',
			'estimate',
		]) {
			expect(fieldNames).toContain(column);
		}
	});

	test('keeps stored issue columns separate from derived readiness', () => {
		const fieldNames = KERNEL_TABLES.issues.fields.map(field => field.name);
		// ready/blocked are derived read-model facts, never stored columns (D18).
		expect(fieldNames).not.toContain('ready');
		expect(fieldNames).not.toContain('blocked');
	});

	test('parent_id self-references the issues table and stays nullable', () => {
		const parent = KERNEL_TABLES.issues.fields.find(field => field.name === 'parent_id');
		expect(parent.references).toBe('issues.id');
		expect(parent.notNull).toBe(false);
	});

	test('renders valid DDL for the extended issues table', () => {
		const migration = buildSchemaMigration(getKernelSchema());
		const sql = migration.apply.join('\n');
		expect(sql).toContain('CREATE TABLE IF NOT EXISTS kernel_issues');
		expect(sql).toContain('parent_id TEXT REFERENCES kernel_issues(id)');
		expect(sql).toContain('CREATE INDEX IF NOT EXISTS idx_kernel_issues_parent');
	});
});

describe('canonical issue enums', () => {
	test('exposes the 4-type and 5-status taxonomy from the contract', () => {
		expect(ISSUE_TYPES).toEqual(['epic', 'task', 'bug', 'decision']);
		expect(ISSUE_STATUSES).toEqual(['open', 'in_progress', 'review', 'done', 'cancelled']);
		expect(TERMINAL_STATUSES).toEqual(['done', 'cancelled']);
	});

	test('validates membership without DB constraints', () => {
		expect(isValidIssueType('task')).toBe(true);
		expect(isValidIssueType('feature')).toBe(false); // feature is a label, not a type
		expect(isValidIssueType('story')).toBe(false);
		expect(isValidIssueStatus('review')).toBe(true);
		expect(isValidIssueStatus('ready')).toBe(false); // ready is derived, not a status
		expect(isValidIssueStatus('blocked')).toBe(false);
	});
});

describe('type to behavior mapping', () => {
	test('every type maps to a distinct Kernel behavior', () => {
		for (const type of ISSUE_TYPES) {
			expect(TYPE_BEHAVIORS[type]).toBeDefined();
			expect(getTypeBehavior(type)).toBe(TYPE_BEHAVIORS[type]);
		}
		// epic is the only container that can parent and roll up children.
		expect(TYPE_BEHAVIORS.epic.canParent).toBe(true);
		expect(TYPE_BEHAVIORS.task.canParent).toBe(false);
		expect(TYPE_BEHAVIORS.bug.canParent).toBe(false);
		// decisions block dependents; epics/decisions are not directly claimable.
		expect(TYPE_BEHAVIORS.decision.blocksOthers).toBe(true);
		expect(isClaimableType('task')).toBe(true);
		expect(isClaimableType('bug')).toBe(true);
		expect(isClaimableType('epic')).toBe(false);
		expect(isClaimableType('decision')).toBe(false);
	});

	test('unknown type has no behavior', () => {
		expect(getTypeBehavior('feature')).toBeNull();
	});
});

describe('status lifecycle rules', () => {
	test('allows the forward lifecycle and cancellation', () => {
		expect(isValidStatusTransition('open', 'in_progress')).toBe(true);
		expect(isValidStatusTransition('in_progress', 'review')).toBe(true);
		expect(isValidStatusTransition('review', 'done')).toBe(true);
		expect(isValidStatusTransition('open', 'cancelled')).toBe(true);
		expect(isValidStatusTransition('review', 'cancelled')).toBe(true);
	});

	test('allows rework transitions backward but not out of terminal states', () => {
		expect(isValidStatusTransition('review', 'in_progress')).toBe(true);
		expect(isValidStatusTransition('in_progress', 'open')).toBe(true);
		expect(isValidStatusTransition('done', 'in_progress')).toBe(false);
		expect(isValidStatusTransition('cancelled', 'open')).toBe(false);
		expect(STATUS_TRANSITIONS.done).toEqual([]);
		expect(STATUS_TRANSITIONS.cancelled).toEqual([]);
	});

	test('treats a same-status transition as an idempotent no-op', () => {
		expect(isValidStatusTransition('open', 'open')).toBe(true);
	});

	test('rejects illegal transitions and unknown statuses by throwing', () => {
		expect(isValidStatusTransition('open', 'done')).toBe(false);
		expect(() => validateStatusTransition('open', 'done')).toThrow(TaxonomyValidationError);
		expect(() => validateStatusTransition('open', 'flying')).toThrow(/unknown/i);
	});
});

describe('issue taxonomy validation', () => {
	test('accepts a well-formed issue', () => {
		const result = validateIssueTaxonomy({
			id: 'forge-1',
			type: 'task',
			status: 'open',
			priority: 'P2',
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test('reports invalid type and status with field-scoped error codes', () => {
		const result = validateIssueTaxonomy({ id: 'forge-1', type: 'feature', status: 'ready' });
		expect(result.valid).toBe(false);
		const codes = result.errors.map(error => error.code);
		expect(codes).toContain('invalid_type');
		expect(codes).toContain('invalid_status');
	});

	test('rejects an issue that is its own parent', () => {
		const result = validateIssueTaxonomy({ id: 'forge-1', type: 'task', status: 'open', parent_id: 'forge-1' });
		expect(result.valid).toBe(false);
		expect(result.errors.map(error => error.code)).toContain('self_parent');
	});
});

describe('dependency cycle detection', () => {
	test('returns no cycles for an acyclic graph', () => {
		const deps = [
			{ issue_id: 'a', blocks_issue_id: 'b' },
			{ issue_id: 'b', blocks_issue_id: 'c' },
		];
		expect(findDependencyCycles(deps)).toEqual([]);
		expect(() => assertAcyclicDependencies(deps)).not.toThrow();
	});

	test('detects a direct cycle', () => {
		const deps = [
			{ issue_id: 'a', blocks_issue_id: 'b' },
			{ issue_id: 'b', blocks_issue_id: 'a' },
		];
		const cycles = findDependencyCycles(deps);
		expect(cycles.length).toBeGreaterThan(0);
		expect(cycles[0]).toContain('a');
		expect(cycles[0]).toContain('b');
		expect(() => assertAcyclicDependencies(deps)).toThrow(TaxonomyValidationError);
	});

	test('ignores non-blocking dependency types', () => {
		const deps = [
			{ issue_id: 'a', blocks_issue_id: 'b', dependency_type: 'related' },
			{ issue_id: 'b', blocks_issue_id: 'a', dependency_type: 'related' },
		];
		expect(findDependencyCycles(deps)).toEqual([]);
	});
});

describe('dependency cycle detection — robustness', () => {
	test('detects an indirect 3-node cycle and returns it canonically (smallest id first)', () => {
		const cycles = findDependencyCycles([
			{ issue_id: 'b', blocks_issue_id: 'c' },
			{ issue_id: 'c', blocks_issue_id: 'a' },
			{ issue_id: 'a', blocks_issue_id: 'b' },
		]);
		expect(cycles).toEqual([['a', 'b', 'c']]);
	});

	test('reports a shared cycle once regardless of entry point (dedup)', () => {
		const cycles = findDependencyCycles([
			{ issue_id: 'a', blocks_issue_id: 'b' },
			{ issue_id: 'b', blocks_issue_id: 'a' },
			{ issue_id: 'x', blocks_issue_id: 'a' }, // extra entry edge into the same cycle
		]);
		expect(cycles).toEqual([['a', 'b']]);
	});

	test('does not overflow the stack on a deep acyclic chain', () => {
		const deep = [];
		for (let i = 0; i < 20000; i += 1) {
			deep.push({ issue_id: `n${i}`, blocks_issue_id: `n${i + 1}` });
		}
		expect(findDependencyCycles(deep)).toEqual([]);
		expect(() => assertAcyclicDependencies(deep)).not.toThrow();
	});
});

describe('parent-child consistency', () => {
	test('accepts a task parented under an epic', () => {
		const result = validateParentChild(
			{ id: 'child', type: 'task', parent_id: 'epic-1' },
			{ id: 'epic-1', type: 'epic' },
		);
		expect(result.valid).toBe(true);
	});

	test('rejects a parent whose type cannot contain children', () => {
		const result = validateParentChild(
			{ id: 'child', type: 'task', parent_id: 'task-1' },
			{ id: 'task-1', type: 'task' },
		);
		expect(result.valid).toBe(false);
		expect(result.errors.map(error => error.code)).toContain('invalid_parent_type');
	});

	test('rejects a missing parent referenced by parent_id', () => {
		const result = validateParentChild({ id: 'child', type: 'task', parent_id: 'epic-1' }, null);
		expect(result.valid).toBe(false);
		expect(result.errors.map(error => error.code)).toContain('missing_parent');
	});

	test('detects a parent chain cycle', () => {
		const byId = {
			a: { id: 'a', parent_id: 'b' },
			b: { id: 'b', parent_id: 'a' },
		};
		expect(findParentCycle(byId, 'a')).toContain('a');
	});
});

describe('parent cycle detection — non-cycle paths', () => {
	test('returns empty for an acyclic parent chain', () => {
		const byId = {
			a: { id: 'a', parent_id: 'b' },
			b: { id: 'b', parent_id: 'c' },
			c: { id: 'c' },
		};
		expect(findParentCycle(byId, 'a')).toEqual([]);
	});

	test('returns empty for an unknown start id', () => {
		expect(findParentCycle({}, 'missing')).toEqual([]);
	});
});

describe('parent-child validator — extra branches', () => {
	test('a root issue with no parent is trivially valid', () => {
		const result = validateParentChild({ id: 'a', type: 'task' });
		expect(result.valid).toBe(true);
	});

	test('rejects an issue that is its own parent', () => {
		const result = validateParentChild({ id: 'a', type: 'task', parent_id: 'a' });
		expect(result.valid).toBe(false);
		expect(result.errors.map(error => error.code)).toContain('self_parent');
	});
});

describe('claim-lease invariants (validation layer)', () => {
	const now = '2026-06-17T00:00:00.000Z';

	test('accepts an active unexpired claim on a claimable issue', () => {
		const result = validateClaim(
			{ issue_id: 'forge-1', actor: 'agent-a', state: 'active', claimed_at: now, expires_at: '2026-06-17T01:00:00.000Z' },
			{ now, issueType: 'task' },
		);
		expect(result.valid).toBe(true);
	});

	test('flags an active claim whose lease already expired', () => {
		const result = validateClaim(
			{ issue_id: 'forge-1', actor: 'agent-a', state: 'active', claimed_at: now, expires_at: '2026-06-16T00:00:00.000Z' },
			{ now, issueType: 'task' },
		);
		expect(result.valid).toBe(false);
		expect(result.errors.map(error => error.code)).toContain('lease_expired');
	});

	test('rejects a claim with no actor', () => {
		const result = validateClaim({ issue_id: 'forge-1', actor: '', state: 'active', claimed_at: now }, { now });
		expect(result.valid).toBe(false);
		expect(result.errors.map(error => error.code)).toContain('missing_actor');
	});

	test('rejects claiming an unclaimable issue type', () => {
		const result = validateClaim(
			{ issue_id: 'epic-1', actor: 'agent-a', state: 'active', claimed_at: now },
			{ now, issueType: 'epic' },
		);
		expect(result.valid).toBe(false);
		expect(result.errors.map(error => error.code)).toContain('unclaimable_type');
	});

	test('detects more than one active claim per issue', () => {
		const result = validateActiveClaimUniqueness([
			{ issue_id: 'forge-1', actor: 'a', state: 'active' },
			{ issue_id: 'forge-1', actor: 'b', state: 'active' },
			{ issue_id: 'forge-2', actor: 'c', state: 'active' },
		]);
		expect(result.valid).toBe(false);
		expect(result.conflictingIssueIds).toContain('forge-1');
		expect(result.conflictingIssueIds).not.toContain('forge-2');
	});
});

describe('claim validator — extra branches', () => {
	const now = '2026-06-17T00:00:00.000Z';

	test('rejects an unknown claim state', () => {
		const result = validateClaim({ issue_id: 'forge-1', actor: 'a', state: 'paused' }, { now });
		expect(result.valid).toBe(false);
		expect(result.errors.map(error => error.code)).toContain('invalid_claim_state');
	});

	test('fails closed on an unparseable expiry date', () => {
		const result = validateClaim(
			{ issue_id: 'forge-1', actor: 'a', state: 'active', expires_at: 'not-a-date' },
			{ now, issueType: 'task' },
		);
		expect(result.valid).toBe(false);
		expect(result.errors.map(error => error.code)).toContain('invalid_lease_date');
	});

	test('does not count released claims toward active-claim conflicts', () => {
		const result = validateActiveClaimUniqueness([
			{ issue_id: 'forge-1', actor: 'a', state: 'active' },
			{ issue_id: 'forge-1', actor: 'b', state: 'released' },
		]);
		expect(result.valid).toBe(true);
		expect(result.conflictingIssueIds).toEqual([]);
	});
});

describe('priority rank projection', () => {
	test('treats numeric rank as authoritative and P0-P4 as a display projection', () => {
		expect(rankForPriorityLabel('P0')).toBe(0);
		expect(rankForPriorityLabel('P3')).toBe(3);
		expect(rankForPriorityLabel('p2')).toBe(2);
		expect(rankForPriorityLabel(4)).toBe(4);
		expect(rankForPriorityLabel('high')).toBe(2); // unknown label falls back to default rank
	});

	test('projects rank back to a clamped display label', () => {
		expect(priorityLabelForRank(0)).toBe('P0');
		expect(priorityLabelForRank(4)).toBe('P4');
		expect(priorityLabelForRank(9)).toBe('P4'); // display clamps to P4
		expect(priorityLabelForRank(-1)).toBe('P0');
	});

	test('normalizes ranks to non-negative integers', () => {
		expect(normalizeRank(2.9)).toBe(2);
		expect(normalizeRank(-5)).toBe(0);
		expect(normalizeRank('3')).toBe(3);
		expect(normalizeRank(undefined)).toBe(0);
	});
});

describe('terminal status predicate', () => {
	test('identifies terminal statuses directly', () => {
		expect(isTerminalStatus('done')).toBe(true);
		expect(isTerminalStatus('cancelled')).toBe(true);
		expect(isTerminalStatus('open')).toBe(false);
		expect(isTerminalStatus('review')).toBe(false);
	});
});

describe('status transition validator (throwing wrapper)', () => {
	test('returns true for a legal transition', () => {
		expect(validateStatusTransition('open', 'in_progress')).toBe(true);
	});

	test('throws on an unknown source status', () => {
		expect(() => validateStatusTransition('flying', 'open')).toThrow(/unknown/i);
	});
});

describe('taxonomy documentation', () => {
	test('documents backlog vs sprint vs task vs stage and derived readiness', () => {
		const doc = fs.readFileSync(
			path.join(__dirname, '..', '..', 'docs', 'reference', 'KERNEL_TAXONOMY_VALIDATION.md'),
			'utf8',
		);
		expect(doc).toContain('D18');
		expect(doc).toMatch(/backlog/i);
		expect(doc).toMatch(/sprint/i);
		expect(doc).toMatch(/stage/i);
		expect(doc).toMatch(/derived/i);
		expect(doc).toContain('ready');
		expect(doc).toContain('blocked');
	});
});
