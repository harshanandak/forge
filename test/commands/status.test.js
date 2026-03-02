const { describe, test, expect } = require('bun:test');
const {
	detectStage,
	analyzeBranch,
	analyzeFiles,
	analyzePR,
	analyzeChecks,
	analyzeBeads,
	formatStatus,
} = require('../../lib/commands/status.js');

describe('Status Command - Stage Detection', () => {
	describe('detectStage', () => {
		test('should detect stage 1 (fresh project)', () => {
			const context = {
				branch: 'master',
				researchDoc: null,
				plan: null,
				tests: [],
				pr: null,
				beadsIssue: null,
			};

			const result = detectStage(context);
			expect(result.stage).toBe(1);
			expect(result.confidence).toBe('high');
			expect(result.nextCommand).toMatch(/research/i);
		});

		test('should detect stage 2 (research in progress)', () => {
			const context = {
				branch: 'master',
				researchDoc: null,
				plan: null,
				tests: [],
				pr: null,
				beadsIssue: { status: 'in_progress', type: 'research' },
			};

			const result = detectStage(context);
			expect(result.stage).toBe(2);
			expect(result.confidence).toBe('medium');
		});

		test('should detect stage 3 (research exists, no plan)', () => {
			const context = {
				branch: 'master',
				researchDoc: 'docs/research/feature.md',
				plan: null,
				tests: [],
				pr: null,
				beadsIssue: null,
			};

			const result = detectStage(context);
			expect(result.stage).toBe(3);
			expect(result.confidence).toBe('medium');
			expect(result.nextCommand).toMatch(/plan/i);
		});

		test('should detect stage 4 (plan exists, no dev)', () => {
			const context = {
				branch: 'feat/feature-name',
				researchDoc: 'docs/research/feature.md',
				plan: '.claude/plans/feature.md',
				tests: [],
				pr: null,
				beadsIssue: { status: 'in_progress' },
			};

			const result = detectStage(context);
			expect(result.stage).toBe(4);
			expect(result.nextCommand).toMatch(/dev/i);
		});

		test('should detect stage 5 (dev in progress, tests failing)', () => {
			const context = {
				branch: 'feat/feature-name',
				researchDoc: 'docs/research/feature.md',
				plan: '.claude/plans/feature.md',
				tests: ['test/feature.test.js'],
				testsPass: false,
				pr: null,
				beadsIssue: { status: 'in_progress' },
			};

			const result = detectStage(context);
			expect(result.stage).toBe(5);
			expect(result.nextCommand).toMatch(/check/i);
		});

		test('should detect stage 6 (ready to ship)', () => {
			const context = {
				branch: 'feat/feature-name',
				researchDoc: 'docs/research/feature.md',
				plan: '.claude/plans/feature.md',
				tests: ['test/feature.test.js'],
				testsPass: true,
				checksPass: true,
				pr: null,
				beadsIssue: { status: 'in_progress' },
			};

			const result = detectStage(context);
			expect(result.stage).toBe(6);
			expect(result.confidence).toBe('high');
			expect(result.nextCommand).toMatch(/ship/i);
		});

		test('should detect stage 7 (PR open, awaiting review)', () => {
			const context = {
				branch: 'feat/feature-name',
				researchDoc: 'docs/research/feature.md',
				plan: '.claude/plans/feature.md',
				tests: ['test/feature.test.js'],
				testsPass: true,
				pr: { number: 123, state: 'open', reviews: [] },
				beadsIssue: { status: 'in_progress' },
			};

			const result = detectStage(context);
			expect(result.stage).toBe(7);
			expect(result.nextCommand).toMatch(/review/i);
		});

		test('should detect stage 8 (PR approved, ready to merge)', () => {
			const context = {
				branch: 'feat/feature-name',
				researchDoc: 'docs/research/feature.md',
				plan: '.claude/plans/feature.md',
				tests: ['test/feature.test.js'],
				testsPass: true,
				checksPass: true,
				pr: { number: 123, state: 'open', approved: true },
				beadsIssue: { status: 'in_progress' },
			};

			const result = detectStage(context);
			expect(result.stage).toBe(8);
			expect(result.nextCommand).toMatch(/merge/i);
		});

		test('should detect stage 9 (PR merged, verify docs)', () => {
			const context = {
				branch: 'master',
				researchDoc: 'docs/research/feature.md',
				plan: '.claude/plans/feature.md',
				tests: ['test/feature.test.js'],
				pr: { number: 123, state: 'merged' },
				beadsIssue: { status: 'closed' },
			};

			const result = detectStage(context);
			expect(result.stage).toBe(9);
			expect(result.nextCommand).toMatch(/verify/i);
		});
	});

	describe('Confidence scoring', () => {
		test('should return high confidence (90-100%) for clear signals', () => {
			const context = {
				branch: 'master',
				researchDoc: null,
				plan: null,
				tests: [],
				pr: null,
				beadsIssue: null,
			};

			const result = detectStage(context);
			expect(result.confidence).toBe('high');
			expect(result.confidenceScore >= 90).toBeTruthy();
		});

		test('should return low confidence (<70%) for mixed signals', () => {
			const context = {
				branch: 'feat/feature-name',
				researchDoc: null, // Missing research doc
				plan: '.claude/plans/feature.md', // But plan exists
				tests: [],
				pr: null,
				beadsIssue: null,
			};

			const result = detectStage(context);
			expect(result.confidence).toBe('low');
			expect(result.confidenceScore < 70).toBeTruthy();
		});

		test('should return low confidence (<70%) for conflicting signals', () => {
			const context = {
				branch: 'feat/feature-name',
				researchDoc: 'docs/research/feature.md',
				plan: null,
				tests: ['test/feature.test.js'], // Tests exist but no plan?
				pr: { number: 123, state: 'open' },
				beadsIssue: null,
			};

			const result = detectStage(context);
			expect(result.confidence).toBe('low');
			expect(result.confidenceScore < 70).toBeTruthy();
		});
	});

	describe('Multi-factor analysis', () => {
		test('should analyze branch state', () => {
			const factors = analyzeBranch('feat/feature-name');
			expect(factors.onFeatureBranch).toBe(true);
			expect(factors.featureSlug).toBe('feature-name');
		});

		test('should analyze file existence', () => {
			const factors = analyzeFiles({
				researchDoc: 'docs/research/feature.md',
				plan: '.claude/plans/feature.md',
			});
			expect(factors.hasResearch).toBe(true);
			expect(factors.hasPlan).toBe(true);
		});

		test('should analyze PR state', () => {
			const factors = analyzePR({ number: 123, state: 'open', approved: true });
			expect(factors.hasPR).toBe(true);
			expect(factors.prApproved).toBe(true);
		});

		test('should analyze check results', () => {
			const factors = analyzeChecks({ testsPass: true, lintPass: true, checksPass: true });
			expect(factors.allChecksPass).toBe(true);
		});

		test('should analyze Beads issue state', () => {
			const factors = analyzeBeads({ status: 'in_progress', type: 'feature' });
			expect(factors.hasActiveIssue).toBe(true);
			expect(factors.issueStatus).toBe('in_progress');
		});
	});

	describe('Output formatting', () => {
		test('should format status output with stage and confidence', () => {
			const output = formatStatus({
				stage: 6,
				stageName: 'Shipping',
				confidence: 'high',
				confidenceScore: 95,
				nextCommand: 'ship',
				factors: {
					files: { hasResearch: true, hasPlan: true, testsPass: true },
					branch: {},
					pr: {},
					checks: {},
					beads: {},
				},
			});
			expect(output).toMatch(/6/);
			expect(output).toMatch(/high/i);
			expect(output).toMatch(/ship/i);
		});

		test('should include completed checks in output', () => {
			const output = formatStatus({
				stage: 6,
				stageName: 'Shipping',
				confidence: 'high',
				confidenceScore: 95,
				nextCommand: 'ship',
				factors: {
					files: { hasResearch: true, hasPlan: true, testsPass: true },
					branch: {},
					pr: {},
					checks: { allChecksPass: true },
					beads: {},
				},
			});
			expect(output).toMatch(/research doc exists/i);
			expect(output).toMatch(/plan created/i);
			expect(output).toMatch(/tests passing/i);
		});

		test('should suggest manual verification for low confidence', () => {
			const output = formatStatus({
				stage: 4,
				stageName: 'Development',
				confidence: 'low',
				confidenceScore: 65,
				nextCommand: 'dev',
				factors: {
					files: {},
					branch: {},
					pr: {},
					checks: {},
					beads: {},
				},
			});
			expect(output).toMatch(/manual verification suggested/i);
			expect(output).toMatch(/conflicting signals/i);
		});
	});
});
