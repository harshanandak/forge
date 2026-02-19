const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
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
			assert.strictEqual(result.stage, 1);
			assert.strictEqual(result.confidence, 'high');
			assert.match(result.nextCommand, /research/i);
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
			assert.strictEqual(result.stage, 2);
			assert.strictEqual(result.confidence, 'medium');
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
			assert.strictEqual(result.stage, 3);
			assert.strictEqual(result.confidence, 'medium');
			assert.match(result.nextCommand, /plan/i);
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
			assert.strictEqual(result.stage, 4);
			assert.match(result.nextCommand, /dev/i);
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
			assert.strictEqual(result.stage, 5);
			assert.match(result.nextCommand, /check/i);
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
			assert.strictEqual(result.stage, 6);
			assert.strictEqual(result.confidence, 'high');
			assert.match(result.nextCommand, /ship/i);
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
			assert.strictEqual(result.stage, 7);
			assert.match(result.nextCommand, /review/i);
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
			assert.strictEqual(result.stage, 8);
			assert.match(result.nextCommand, /merge/i);
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
			assert.strictEqual(result.stage, 9);
			assert.match(result.nextCommand, /verify/i);
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
			assert.strictEqual(result.confidence, 'high');
			assert.ok(result.confidenceScore >= 90);
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
			assert.strictEqual(result.confidence, 'low');
			assert.ok(result.confidenceScore < 70);
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
			assert.strictEqual(result.confidence, 'low');
			assert.ok(result.confidenceScore < 70);
		});
	});

	describe('Multi-factor analysis', () => {
		test('should analyze branch state', () => {
			const factors = analyzeBranch('feat/feature-name');
			assert.strictEqual(factors.onFeatureBranch, true);
			assert.strictEqual(factors.featureSlug, 'feature-name');
		});

		test('should analyze file existence', () => {
			const factors = analyzeFiles({
				researchDoc: 'docs/research/feature.md',
				plan: '.claude/plans/feature.md',
			});
			assert.strictEqual(factors.hasResearch, true);
			assert.strictEqual(factors.hasPlan, true);
		});

		test('should analyze PR state', () => {
			const factors = analyzePR({ number: 123, state: 'open', approved: true });
			assert.strictEqual(factors.hasPR, true);
			assert.strictEqual(factors.prApproved, true);
		});

		test('should analyze check results', () => {
			const factors = analyzeChecks({ testsPass: true, lintPass: true, checksPass: true });
			assert.strictEqual(factors.allChecksPass, true);
		});

		test('should analyze Beads issue state', () => {
			const factors = analyzeBeads({ status: 'in_progress', type: 'feature' });
			assert.strictEqual(factors.hasActiveIssue, true);
			assert.strictEqual(factors.issueStatus, 'in_progress');
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
			assert.match(output, /6/);
			assert.match(output, /high/i);
			assert.match(output, /ship/i);
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
			assert.match(output, /research doc exists/i);
			assert.match(output, /plan created/i);
			assert.match(output, /tests passing/i);
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
			assert.match(output, /manual verification suggested/i);
			assert.match(output, /conflicting signals/i);
		});
	});
});
