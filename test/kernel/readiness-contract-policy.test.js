'use strict';

const { describe, expect, test } = require('bun:test');

const {
	evaluateIssueContract,
	buildReadinessIndex,
} = require('../../lib/kernel/readiness-model');

const POLICY = Object.freeze({
	enabled: true,
	workClasses: ['task', 'bug'],
});

function contractMetadata(contractOverrides = {}, metadataOverrides = {}) {
	return JSON.stringify({
		'forge.contract': {
			version: 1,
			risk: 'authority',
			dependencies: [],
			out_of_scope: 'Do not prescribe implementation reasoning.',
			...contractOverrides,
		},
		...metadataOverrides,
	});
}

function completeIssue(overrides = {}, contractOverrides = {}, metadataOverrides = {}) {
	return {
		id: 'work-1',
		revision: 7,
		type: 'task',
		status: 'open',
		body: 'Make readiness select only executable work.',
		acceptance_criteria: 'Given a complete contract, the issue appears in ready output.',
		metadata: contractMetadata(contractOverrides, metadataOverrides),
		...overrides,
	};
}

describe('issue-contract readiness policy', () => {
	test('policy disabled preserves legacy readiness byte-for-byte', () => {
		const issue = { id: 'legacy', type: 'task', status: 'open', priority_rank: 0 };
		const legacy = buildReadinessIndex({ issues: [issue], topK: 1 });
		const disabled = buildReadinessIndex({
			issues: [issue],
			contractPolicy: { enabled: false, workClasses: ['task'] },
			topK: 1,
		});

		expect(disabled).toEqual(legacy);
	});

	test('reports every missing contract field without prescribing prose', () => {
		const result = evaluateIssueContract(
			{ id: 'incomplete', type: 'task', status: 'open', body: '   ', acceptance_criteria: null },
			POLICY,
		);

		expect(result.valid).toBe(false);
		expect(result.reasons).toEqual([
			{ code: 'contract_missing', field: 'purpose' },
			{ code: 'contract_missing', field: 'acceptance_criteria' },
			{ code: 'contract_missing', field: 'risk' },
			{ code: 'contract_missing', field: 'dependencies' },
			{ code: 'contract_missing', field: 'out_of_scope' },
			{ code: 'contract_invalid', field: 'version', expected: 1, actual: null },
		]);
	});

	test('complete contract is outcome-shaped but leaves reasoning and prose free', () => {
		const result = evaluateIssueContract(completeIssue(), POLICY);

		expect(result).toEqual({ applicable: true, valid: true, reasons: [] });
	});

	test('epics and decisions remain governed by their existing non-claimable behavior', () => {
		for (const type of ['epic', 'decision']) {
			const result = evaluateIssueContract(
				{ id: type, type, status: 'open' },
				POLICY,
			);
			expect(result).toEqual({ applicable: false, valid: true, reasons: [] });
		}
	});

	test('contract reasons compose with dependency and claim reasons', () => {
		const issues = [
			{ id: 'blocker', type: 'task', status: 'open', priority_rank: 0 },
			{ id: 'dependent', type: 'task', status: 'open', priority_rank: 1 },
		];
		const index = buildReadinessIndex({
			issues,
			dependencies: [{ issue_id: 'dependent', blocks_issue_id: 'blocker' }],
			claims: [{ issue_id: 'dependent', actor: 'other', state: 'active' }],
			actor: 'me',
			contractPolicy: POLICY,
			topK: 1,
		});

		expect(index.readyQueue).toEqual([]);
		expect(index.readinessById.dependent.reasons.map(reason => reason.code)).toEqual(
			expect.arrayContaining(['dependency', 'claimed', 'contract_missing']),
		);
	});

	test('trusted maintainer adoption lets imported and fork work use an explicit contract', () => {
		for (const origin of ['import', 'fork_pr']) {
			const issue = completeIssue(
				{},
				{
					risk: 'compatibility',
					out_of_scope: 'No upstream history rewrite.',
					adopted_by: 'maintainer@example.test',
				},
				{ origin },
			);
			const result = evaluateIssueContract(issue, POLICY, {
				isTrustedAdoption: evidence => evidence.actor === 'maintainer@example.test'
					&& evidence.issue_id === 'work-1'
					&& evidence.revision === 7
					&& evidence.metadata['forge.contract'].version === 1,
			});

			expect(result).toEqual({ applicable: true, valid: true, reasons: [] });
		}
	});

	test('imported and fork work never infer adoption from prose', () => {
		for (const origin of ['import', 'fork_pr']) {
			const result = evaluateIssueContract(completeIssue({}, {}, { origin }), POLICY);
			expect(result.valid).toBe(false);
			expect(result.reasons).toContainEqual({ code: 'contract_adoption_required' });
		}
	});

	test('an untrusted adopter string cannot authorize imported or fork work', () => {
		const issue = completeIssue(
			{},
			{ adopted_by: 'attacker@example.test' },
			{ origin: 'import' },
		);
		const result = evaluateIssueContract(issue, {
			...POLICY,
			trustedAdopters: ['attacker@example.test'],
		});

		expect(result.valid).toBe(false);
		expect(result.reasons).toContainEqual({
			code: 'contract_adoption_unverified',
			adopter: 'attacker@example.test',
		});
	});

	test('an injected authority predicate receives actor, issue id, revision, and metadata', () => {
		const issue = completeIssue(
			{},
			{ adopted_by: 'team-maintainer' },
			{ origin: 'fork_pr' },
		);
		let observed;
		const result = evaluateIssueContract(
			issue,
			{ enabled: true, workClasses: ['task'] },
			{
				isTrustedAdoption: evidence => {
					observed = evidence;
					return evidence.actor === 'team-maintainer'
						&& evidence.issue_id === 'work-1'
						&& evidence.revision === 7;
				},
			},
		);

		expect(result).toEqual({ applicable: true, valid: true, reasons: [] });
		expect(observed).toMatchObject({
			actor: 'team-maintainer',
			issue_id: 'work-1',
			revision: 7,
			metadata: { 'forge.contract': { version: 1 } },
		});
	});

	test('rejects inherited and accessor-backed metadata contract authority', () => {
		const inherited = Object.create({
			'forge.contract': {
				version: 1,
				risk: 'authority',
				dependencies: [],
				out_of_scope: 'Inherited data must not count.',
			},
		});
		const accessor = {};
		Object.defineProperty(accessor, 'forge.contract', {
			enumerable: true,
			get: () => JSON.parse(contractMetadata())['forge.contract'],
		});

		for (const metadata of [inherited, accessor]) {
			const result = evaluateIssueContract(completeIssue({ metadata }), POLICY);
			expect(result.valid).toBe(false);
			expect(result.reasons).toContainEqual({
				code: 'contract_invalid', field: 'version', expected: 1, actual: null,
			});
		}
	});

	test('rejects inherited contract fields and ignores inherited origin markers', () => {
		const inheritedFields = Object.create({
			version: 1,
			risk: 'authority',
			dependencies: [],
			out_of_scope: 'Inherited contract fields.',
		});
		const metadata = { 'forge.contract': inheritedFields };
		const invalid = evaluateIssueContract(completeIssue({ metadata }), POLICY);
		expect(invalid.valid).toBe(false);

		const accessorOrigin = {
			'forge.contract': JSON.parse(contractMetadata())['forge.contract'],
		};
		Object.defineProperty(accessorOrigin, 'origin', {
			enumerable: true,
			get: () => 'import',
		});
		const native = evaluateIssueContract(completeIssue({ metadata: accessorOrigin }), POLICY);
		expect(native).toEqual({ applicable: true, valid: true, reasons: [] });
	});

	test('top-level issue.contract cannot bypass versioned metadata authority', () => {
		const issue = completeIssue({
			metadata: null,
			contract: {
				version: 1,
				risk: 'authority',
				dependencies: [],
				out_of_scope: 'Bypass attempt.',
			},
		});
		const result = evaluateIssueContract(issue, POLICY);

		expect(result.valid).toBe(false);
		expect(result.reasons).toContainEqual({
			code: 'contract_invalid', field: 'version', expected: 1, actual: null,
		});
		expect(result.reasons).toContainEqual({ code: 'contract_missing', field: 'risk' });
	});

	test('unknown metadata contract versions fail closed', () => {
		const result = evaluateIssueContract(completeIssue({}, { version: 2 }), POLICY);
		expect(result.valid).toBe(false);
		expect(result.reasons).toContainEqual({
			code: 'contract_invalid', field: 'version', expected: 1, actual: 2,
		});
	});

	test('reads the versioned forge.contract object from existing metadata JSON', () => {
		const issue = completeIssue({}, { out_of_scope: 'No model-specific prose rules.' });

		expect(evaluateIssueContract(issue, POLICY)).toEqual({
			applicable: true,
			valid: true,
			reasons: [],
		});
	});

	test('declared dependencies must agree with authority edges', () => {
		const result = evaluateIssueContract(
			completeIssue({}, { out_of_scope: 'No extras.' }),
			POLICY,
			{ dependencyIds: ['blocker'] },
		);

		expect(result.valid).toBe(false);
		expect(result.reasons).toContainEqual({
			code: 'contract_mismatch',
			field: 'dependencies',
			expected: ['blocker'],
			declared: [],
		});
	});

	test('invalid contract keeps stored status open while deriving backlog with reasons', () => {
		const issue = { id: 'incomplete', type: 'task', status: 'open', priority_rank: 0 };
		const index = buildReadinessIndex({ issues: [issue], contractPolicy: POLICY, topK: 1 });

		expect(index.readyQueue).toEqual([]);
		expect(index.readinessById.incomplete.status).toBe('open');
		expect(index.readinessById.incomplete.state).toBe('backlog');
		expect(index.readinessById.incomplete.reasons).toContainEqual({
			code: 'contract_missing', field: 'purpose',
		});
	});

	test('a parked backlog item still reports incomplete contract reasons', () => {
		const issue = { id: 'parked', type: 'task', status: 'backlog', priority_rank: 0 };
		const index = buildReadinessIndex({ issues: [issue], contractPolicy: POLICY, topK: 1 });

		expect(index.readinessById.parked.state).toBe('backlog');
		expect(index.readinessById.parked.contract_applicable).toBe(true);
		expect(index.readinessById.parked.reasons).toContainEqual({
			code: 'contract_missing', field: 'purpose',
		});
	});
});
