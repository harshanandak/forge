const { describe, test, expect } = require('bun:test');
const {
	readResearchDoc,
	detectScope,
	createBeadsIssue,
	createFeatureBranch,
	extractDesignDecisions,
	extractTasksFromResearch,
	executePlan,
} = require('../../lib/commands/plan.js');

describe('Plan Command - OpenSpec & Beads Integration', () => {
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
			expect(scope.requiresOpenSpec).toBe(false);
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
			expect(scope.requiresOpenSpec).toBe(true);
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

		test.skip('should create Beads issue with OpenSpec link for strategic', () => {
			const featureName = 'payment-integration';
			const researchPath = 'docs/research/payment-integration.md';

			const result = createBeadsIssue(featureName, researchPath, 'strategic');
			expect(result.issueId).toBeTruthy();
			expect(result.description.includes('openspec/changes')).toBeTruthy();
		});

		test.skip('should handle Beads command failures', () => {
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

	describe('OpenSpec proposal creation', () => {
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
		test.skip('should execute tactical workflow (no OpenSpec)', async () => {
			const featureName = 'fix-validation';

			const result = await executePlan(featureName);
			expect(result.success).toBe(true);
			expect(result.scope).toBe('tactical');
			expect(result.beadsIssueId).toBeTruthy();
			expect(result.branchName).toBeTruthy();
			expect(result.openSpecCreated).toBe(false);
		});

		test.skip('should execute strategic workflow (with OpenSpec)', async () => {
			const featureName = 'payment-integration';

			const result = await executePlan(featureName);
			expect(result.success).toBe(true);
			expect(result.scope).toBe('strategic');
			expect(result.beadsIssueId).toBeTruthy();
			expect(result.branchName).toBeTruthy();
			expect(result.openSpecCreated).toBe(true);
			expect(result.proposalPR).toBeTruthy();
		});

		test.skip('should return actionable output', async () => {
			const featureName = 'test-feature';

			const result = await executePlan(featureName);
			expect(result.summary).toBeTruthy();
			expect(result.nextCommand).toBeTruthy();
			expect(result.nextCommand === '/dev' || result.nextCommand === 'wait').toBeTruthy();
		});
	});
});
