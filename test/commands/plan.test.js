const { describe, test, expect } = require('bun:test');
const {
	readResearchDoc,
	detectScope,
	createBeadsIssue,
	createKernelIssue,
	createFeatureBranch,
	extractDesignDecisions,
	extractTasksFromResearch,
	executePlan,
} = require('../../lib/commands/plan.js');

const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { execFileSync: nodeExecFileSync } = require('node:child_process');

describe('Plan Command - Beads Integration', () => {
	describe('Research document analysis', () => {
		test.skip('should read research document from path', () => {
			const featureSlug = 'test-feature';

			const research = readResearchDoc(featureSlug);
			expect(research.content).toBeTruthy();
			expect(research.path).toBe('docs/research/test-feature.md');
		});

		test('should handle missing research document', () => {
			const featureSlug = 'nonexistent-feature';

			const result = readResearchDoc(featureSlug);
			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
		});
	});

	describe('Scope detection', () => {
		test('should detect tactical scope (quick fix, <1 day)', () => {
			const researchContent = `
# Test Feature Research

## Scope Assessment
**Complexity**: Low
**Timeline**: 2-3 hours
**Strategic/Tactical**: Tactical
`;

			const scope = detectScope(researchContent);
			expect(scope.type).toBe('tactical');
			expect(scope.requiresDesignDoc).toBe(false);
		});

		test('should detect strategic scope (architecture change)', () => {
			const researchContent = `
# Payment Integration Research

## Scope Assessment
**Complexity**: High
**Timeline**: 3-4 days
**Strategic/Tactical**: Strategic (architecture change)
`;

			const scope = detectScope(researchContent);
			expect(scope.type).toBe('strategic');
			expect(scope.requiresDesignDoc).toBe(true);
		});

		test('should detect strategic scope based on keywords', () => {
			const researchContent = `
# Database Migration Research

This requires changes to the database schema and API endpoints.
Major architectural impact.
`;

			const scope = detectScope(researchContent);
			expect(scope.type).toBe('strategic');
			expect(scope.reason).toBeTruthy();
		});
	});

	describe('Beads issue creation', () => {
		test.skip('should create Beads issue for tactical scope', () => {
			const featureName = 'fix-validation-bug';
			const researchPath = 'docs/research/fix-validation-bug.md';

			const result = createBeadsIssue(featureName, researchPath, 'tactical');
			expect(result.issueId).toBeTruthy();
			expect(result.issueId).toMatch(/^forge-[a-z0-9]+$/);
			expect(result.success).toBe(true);
		});

		test.skip('should create Beads issue with design doc link for strategic (requires Beads CLI — PR #64)', () => {
			const featureName = 'payment-integration';
			const researchPath = 'docs/research/payment-integration.md';

			const result = createBeadsIssue(featureName, researchPath, 'strategic');
			expect(result.issueId).toBeTruthy();
			expect(result.description.includes('docs/work')).toBeTruthy();
			expect(result.description.endsWith('/design.md')).toBeTruthy();
		});

		test.skip('should handle Beads command failures (requires Beads CLI — PR #64)', () => {
			const featureName = 'test-feature';

			// Mock bd command to fail
			const result = createBeadsIssue(featureName, 'path', 'tactical');
			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
		});
	});

	describe('Branch creation', () => {
		test.skip('should create feature branch with correct naming', () => {
			const featureSlug = 'payment-integration';

			const result = createFeatureBranch(featureSlug);
			expect(result.branchName).toBe('feat/payment-integration');
			expect(result.success).toBe(true);
		});

		test.skip('should handle existing branch gracefully', () => {
			const featureSlug = 'existing-feature';

			// Mock git to show branch exists
			const result = createFeatureBranch(featureSlug);
			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
		});
	});

	describe('Design document creation', () => {
		test('should extract decisions from research for design.md', () => {
			const researchContent = `
## Key Decisions
### Decision 1: Use Stripe SDK v4
**Reasoning**: Better retry logic
`;

			const design = extractDesignDecisions(researchContent);
			expect(design.decisions.length > 0).toBeTruthy();
			expect(design.decisions[0].includes('Stripe SDK v4')).toBeTruthy();
		});

		test('should create TDD-ordered tasks from research scenarios', () => {
			const researchContent = `
## TDD Test Scenarios
### Scenario 1: Validate payment input
### Scenario 2: Process payment
`;

			const tasks = extractTasksFromResearch(researchContent);
			expect(tasks.length > 0).toBeTruthy();
			expect(tasks[0].phase).toBeTruthy(); // RED, GREEN, or REFACTOR
		});
	});

	describe('Command execution', () => {
		test.skip('should execute tactical workflow (no design doc) (requires Beads CLI — PR #64)', async () => {
			const featureName = 'fix-validation';

			const result = await executePlan(featureName);
			expect(result.success).toBe(true);
			expect(result.scope).toBe('tactical');
			expect(result.beadsIssueId).toBeTruthy();
			expect(result.branchName).toBeTruthy();
		});

		test.skip('should execute strategic workflow (with design doc) (requires Beads CLI — PR #64)', async () => {
			const featureName = 'payment-integration';

			const result = await executePlan(featureName);
			expect(result.success).toBe(true);
			expect(result.scope).toBe('strategic');
			expect(result.beadsIssueId).toBeTruthy();
			expect(result.branchName).toBeTruthy();
		});

		test.skip('should return actionable output', async () => {
			const featureName = 'test-feature';

			const result = await executePlan(featureName);
			expect(result.summary).toBeTruthy();
			expect(result.nextCommand).toBeTruthy();
			expect(result.nextCommand === '/dev' || result.nextCommand === 'wait').toBeTruthy();
		});
	});

	describe('Kernel-native issue creation', () => {
		test('createKernelIssue routes through the kernel broker (never bd) and returns the created id', async () => {
			const calls = [];
			const fakeRun = async (operation, args, projectRoot, deps) => {
				calls.push({ operation, args, projectRoot, deps });
				return {
					ok: true,
					schema_version: 'forge.issue.v1',
					command: 'issue.create',
					data: { id: 'k-abc123', revision: 0, priority: 'P2' },
					next_commands: [],
				};
			};

			const result = await createKernelIssue(
				'Payment Integration',
				'docs/research/payment-integration.md',
				'tactical',
				{ projectRoot: '/tmp/repo', runIssueOperation: fakeRun },
			);

			expect(result.success).toBe(true);
			expect(result.issueId).toBe('k-abc123');
			expect(calls).toHaveLength(1);
			expect(calls[0].operation).toBe('create');
			expect(calls[0].projectRoot).toBe('/tmp/repo');
			// Kernel-native: deps must route to the kernel broker, not bd.
			expect(calls[0].deps.issueBackend).toBe('kernel');
			expect(calls[0].deps.useKernelBroker).toBe(true);
			expect(calls[0].args).toContain('--type=feature');
			expect(calls[0].args.some(a => a.startsWith('--title='))).toBe(true);
			expect(calls[0].args.some(a => a.startsWith('--description='))).toBe(true);
		});

		test('createKernelIssue surfaces a kernel failure result', async () => {
			const fakeRun = async () => ({ ok: false, error: 'kernel exploded' });

			const result = await createKernelIssue(
				'Feature X',
				'docs/research/feature-x.md',
				'tactical',
				{ projectRoot: '/tmp/repo', runIssueOperation: fakeRun },
			);

			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
		});

		test('executePlan creates its issue via the kernel (no bd) when the kernel backend is active', async () => {
			const repo = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'forge-plan-kernel-'));
			const gitEnv = {
				...process.env,
				GIT_AUTHOR_NAME: 'test',
				GIT_AUTHOR_EMAIL: 'test@example.com',
				GIT_COMMITTER_NAME: 'test',
				GIT_COMMITTER_EMAIL: 'test@example.com',
			};
			nodeExecFileSync('git', ['init', '-q'], { cwd: repo });
			nodeExecFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo, env: gitEnv });
			nodeFs.mkdirSync(nodePath.join(repo, 'docs', 'research'), { recursive: true });
			nodeFs.writeFileSync(
				nodePath.join(repo, 'docs', 'research', 'kernel-plan-demo.md'),
				'# Kernel Plan Demo\n\n**Timeline**: 2 hours\n**Strategic/Tactical**: Tactical\n',
			);

			const prevCwd = process.cwd();
			const prevEnv = process.env.FORGE_ISSUE_BACKEND;
			delete process.env.FORGE_ISSUE_BACKEND; // no signal → resolver defaults to kernel
			process.chdir(repo);
			try {
				let kernelRunnerCalled = false;
				const fakeRun = async () => {
					kernelRunnerCalled = true;
					return { ok: true, command: 'issue.create', data: { id: 'kernel-xyz' }, next_commands: [] };
				};

				const result = await executePlan('kernel plan demo', {
					projectRoot: repo,
					runIssueOperation: fakeRun,
				});

				expect(result.success).toBe(true);
				expect(kernelRunnerCalled).toBe(true);
				expect(result.beadsIssueId).toBe('kernel-xyz');
			} finally {
				process.chdir(prevCwd);
				if (prevEnv === undefined) delete process.env.FORGE_ISSUE_BACKEND;
				else process.env.FORGE_ISSUE_BACKEND = prevEnv;
				nodeFs.rmSync(repo, { recursive: true, force: true });
			}
		});
	});
});
