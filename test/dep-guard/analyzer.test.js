const { describe, expect, test } = require('bun:test');

const {
	analyzePhase3Dependencies,
	DETECTOR_KEYS,
	normalizePhase3Input,
} = require('../../lib/dep-guard/analyzer.js');

describe('lib/dep-guard/analyzer.js', () => {
	test('normalizePhase3Input rejects missing issue metadata', () => {
		expect(() => normalizePhase3Input()).toThrow(/current issue/i);
		expect(() => normalizePhase3Input({ currentIssue: {} })).toThrow(/current issue id/i);
	});

	test('analyzePhase3Dependencies returns the stable top-level JSON contract for minimal valid input', async () => {
		const result = await analyzePhase3Dependencies({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [],
			taskFile: 'docs/plans/2026-03-18-logic-level-dependency-detection-tasks.md',
		});

		expect(result).toMatchObject({
			currentIssue: {
				id: 'forge-9zv',
			},
			issues: [],
			scores: {
				importCallChain: 0,
				contractDependencies: 0,
				behavioralDependencies: 0,
				rubric: 0,
			},
			rubric: {
				score: 0,
				summary: 'No detector findings yet.',
				weights: {
					importCallChain: 0,
					contractDependencies: 0,
					behavioralDependencies: 0,
				},
			},
			confidence: {
				score: 1,
				belowThreshold: false,
			},
			proposals: [],
			needsUserDecision: false,
		});
		expect(result.taskContext.taskCount).toBe(8);
		expect(result.detectorConflicts).toEqual([]);
	});

	test('normalizePhase3Input normalizes open issues and repository root overrides', () => {
		const normalized = normalizePhase3Input({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [
				{
					id: 'forge-puh',
					title: 'Multi-developer workflow',
					contracts: ['scripts/dep-guard.sh:checkRipple(modified)'],
				},
			],
			taskContext: {
				path: 'docs/plans/sample-tasks.md',
				taskCount: 0,
				tasks: [],
			},
			repositoryRoot: 'C:\\repo-root',
		});

		expect(normalized.openIssues).toEqual([
			{
				id: 'forge-puh',
				title: 'Multi-developer workflow',
				description: '',
				status: '',
				contracts: ['scripts/dep-guard.sh:checkRipple(modified)'],
			},
		]);
		expect(normalized.repositoryRoot).toBe('C:\\repo-root');
	});

	test('detector sections stay aligned on the same detector keys', async () => {
		const result = await analyzePhase3Dependencies({
			currentIssue: {
				id: 'forge-9zv',
				title: 'Logic-level dependency detection in /plan Phase 3',
			},
			openIssues: [],
			taskFile: 'docs/plans/2026-03-18-logic-level-dependency-detection-tasks.md',
		});

		expect(Object.keys(result.rubric.weights)).toEqual(DETECTOR_KEYS);
		expect(Object.keys(result.detectorEvidence)).toEqual(DETECTOR_KEYS);
		expect(Object.keys(result.scores)).toEqual([...DETECTOR_KEYS, 'rubric']);
	});
});
