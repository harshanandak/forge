const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
	detectStage,
	analyzeBranch,
	analyzeFiles,
	analyzePR,
	analyzeChecks,
	analyzeBeads,
	detectRepoContext,
	formatStatus,
	resolveWorkflowState,
	extractDesignSlugs,
} = require('../../lib/commands/status.js');

function createTempRepo(options = {}) {
	const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-context-'));
	fs.writeFileSync(path.join(repoRoot, 'README.md'), '# temp repo\n', 'utf8');
	require('child_process').execFileSync('git', ['init'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
	require('child_process').execFileSync('git', ['config', 'user.email', 'harshanandak@users.noreply.github.com'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
	require('child_process').execFileSync('git', ['config', 'user.name', 'Harsha Nanda'], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
	if (options.branch) {
		require('child_process').execFileSync('git', ['checkout', '-b', options.branch], { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
	}
	if (options.dirty) {
		fs.writeFileSync(path.join(repoRoot, 'dirty.txt'), 'dirty\n', 'utf8');
	}
	return repoRoot;
}

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
				plan: 'docs/plans/feature.md',
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
				plan: 'docs/plans/feature.md',
				tests: ['test/feature.test.js'],
				testsPass: false,
				pr: null,
				beadsIssue: { status: 'in_progress' },
			};

			const result = detectStage(context);
			expect(result.stage).toBe(5);
			expect(result.nextCommand).toMatch(/validate/i);
		});

		test('should detect stage 6 (ready to ship)', () => {
			const context = {
				branch: 'feat/feature-name',
				researchDoc: 'docs/research/feature.md',
				plan: 'docs/plans/feature.md',
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
				plan: 'docs/plans/feature.md',
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
				plan: 'docs/plans/feature.md',
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
				plan: 'docs/plans/feature.md',
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
				plan: 'docs/plans/feature.md', // But plan exists
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
				plan: 'docs/plans/feature.md',
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

		test('detectRepoContext returns branch and working tree summary for zero-arg status', () => {
			const repoRoot = createTempRepo({ branch: 'feat/context-check', dirty: true });
			const context = detectRepoContext(repoRoot);
			expect(context.branch).toBe('feat/context-check');
			expect(typeof context.inWorktree).toBe('boolean');
			expect(context.workingTree.clean).toBe(false);
			expect(context.workingTree.summary).toMatch(/uncommitted change/);
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

	describe('resolveWorkflowState with state-manager', () => {
		function makeTmpStateDir(stateObj) {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-status-test-'));
			fs.writeFileSync(
				path.join(tmpDir, '.forge-state.json'),
				JSON.stringify(stateObj, null, 2),
				'utf8',
			);
			return tmpDir;
		}

		test('resolveWorkflowState reads from .forge-state.json when present', () => {
			const tmpDir = makeTmpStateDir({
				schemaVersion: 2,
				currentStage: 'dev',
				completedStages: ['plan'],
				skippedStages: [],
				workflowDecisions: {
					classification: 'standard',
					reason: 'test',
					userOverride: false,
					overrides: [],
				},
				parallelTracks: [],
			});

			try {
				const { workflowState, fallbackReason } = resolveWorkflowState({
					projectRoot: tmpDir,
				});

				expect(fallbackReason).toBeNull();
				expect(workflowState).not.toBeNull();
				expect(workflowState.currentStage).toBe('dev');
				expect(workflowState.completedStages).toContain('plan');
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test('file state takes priority over Beads comments', () => {
			const tmpDir = makeTmpStateDir({
				schemaVersion: 2,
				currentStage: 'validate',
				completedStages: ['plan', 'dev'],
				skippedStages: [],
				workflowDecisions: {
					classification: 'standard',
					reason: 'test',
					userOverride: false,
					overrides: [],
				},
				parallelTracks: [],
			});

			const beadsComments = [
				'WorkflowState: {"schemaVersion":2,"currentStage":"plan","completedStages":[],"skippedStages":[],"workflowDecisions":{"classification":"standard","reason":"test","userOverride":false,"overrides":[]},"parallelTracks":[]}',
			].join('\n');

			try {
				const { workflowState, fallbackReason } = resolveWorkflowState({
					projectRoot: tmpDir,
					bdComments: beadsComments,
				});

				expect(fallbackReason).toBeNull();
				expect(workflowState).not.toBeNull();
				// File says validate, comments say plan — file wins
				expect(workflowState.currentStage).toBe('validate');
				expect(workflowState.completedStages).toContain('dev');
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe('extractDesignSlugs', () => {
		test('extracts slugs from legacy docs/plans paths', () => {
			const slugs = extractDesignSlugs('Design: docs/plans/2026-05-05-user-auth-design.md');
			expect(slugs).toEqual(['user-auth']);
		});

		test('extracts slugs from docs/work paths', () => {
			const slugs = extractDesignSlugs('Design: docs/work/2026-05-05-user-auth/design.md');
			expect(slugs).toEqual(['user-auth']);
		});

		test('deduplicates slugs across design, tasks, and decisions paths', () => {
			const slugs = extractDesignSlugs([
				'docs/work/2026-05-05-user-auth/design.md',
				'docs/work/2026-05-05-user-auth/tasks.md',
				'docs/plans/2026-05-05-api-v2-decisions.md',
			].join('\n'));

			expect(slugs).toEqual(['user-auth', 'api-v2']);
		});
	});
});
