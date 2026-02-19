const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
	readResearchDoc,
	detectScope,
	createBeadsIssue,
	createFeatureBranch,
	extractDesignDecisions,
	extractTasksFromResearch,
	createOpenSpecProposal,
	formatProposalPRBody,
	createProposalPR,
	executePlan,
} = require('../../lib/commands/plan.js');

describe('Plan Command - OpenSpec & Beads Integration', () => {
	describe('Research document analysis', () => {
		test.skip('should read research document from path', () => {
			const featureSlug = 'test-feature';

			const research = readResearchDoc(featureSlug);
			assert.ok(research.content);
			assert.strictEqual(research.path, 'docs/research/test-feature.md');
		});

		test('should handle missing research document', () => {
			const featureSlug = 'nonexistent-feature';

			const result = readResearchDoc(featureSlug);
			assert.strictEqual(result.success, false);
			assert.ok(result.error);
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
			assert.strictEqual(scope.type, 'tactical');
			assert.strictEqual(scope.requiresOpenSpec, false);
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
			assert.strictEqual(scope.type, 'strategic');
			assert.strictEqual(scope.requiresOpenSpec, true);
		});

		test('should detect strategic scope based on keywords', () => {
			const researchContent = `
# Database Migration Research

This requires changes to the database schema and API endpoints.
Major architectural impact.
`;

			const scope = detectScope(researchContent);
			assert.strictEqual(scope.type, 'strategic');
			assert.ok(scope.reason);
		});
	});

	describe('Beads issue creation', () => {
		test.skip('should create Beads issue for tactical scope', () => {
			const featureName = 'fix-validation-bug';
			const researchPath = 'docs/research/fix-validation-bug.md';

			const result = createBeadsIssue(featureName, researchPath, 'tactical');
			assert.ok(result.issueId);
			assert.match(result.issueId, /^forge-[a-z0-9]+$/);
			assert.strictEqual(result.success, true);
		});

		test.skip('should create Beads issue with OpenSpec link for strategic', () => {
			const featureName = 'payment-integration';
			const researchPath = 'docs/research/payment-integration.md';

			const result = createBeadsIssue(featureName, researchPath, 'strategic');
			assert.ok(result.issueId);
			assert.ok(result.description.includes('openspec/changes'));
		});

		test.skip('should handle Beads command failures', () => {
			const featureName = 'test-feature';

			// Mock bd command to fail
			const result = createBeadsIssue(featureName, 'path', 'tactical');
			assert.strictEqual(result.success, false);
			assert.ok(result.error);
		});
	});

	describe('Branch creation', () => {
		test.skip('should create feature branch with correct naming', () => {
			const featureSlug = 'payment-integration';

			const result = createFeatureBranch(featureSlug);
			assert.strictEqual(result.branchName, 'feat/payment-integration');
			assert.strictEqual(result.success, true);
		});

		test.skip('should handle existing branch gracefully', () => {
			const featureSlug = 'existing-feature';

			// Mock git to show branch exists
			const result = createFeatureBranch(featureSlug);
			assert.strictEqual(result.success, false);
			assert.ok(result.error);
		});
	});

	describe('OpenSpec proposal creation', () => {
		test.skip('should create OpenSpec proposal for strategic scope', () => {
			const featureSlug = 'payment-integration';
			const researchContent = '# Payment Research\n\nKey decisions...';

			const result = createOpenSpecProposal(featureSlug, researchContent);
			assert.ok(result.proposalPath);
			assert.match(result.proposalPath, /openspec\/changes\/payment-integration/);
			assert.strictEqual(result.success, true);
		});

		test.skip('should include proposal structure (proposal.md, tasks.md, design.md)', () => {
			const featureSlug = 'test-feature';
			const researchContent = '# Research';

			const result = createOpenSpecProposal(featureSlug, researchContent);
			assert.ok(result.files.includes('proposal.md'));
			assert.ok(result.files.includes('tasks.md'));
			assert.ok(result.files.includes('design.md'));
		});

		test('should extract decisions from research for design.md', () => {
			const researchContent = `
## Key Decisions
### Decision 1: Use Stripe SDK v4
**Reasoning**: Better retry logic
`;

			const design = extractDesignDecisions(researchContent);
			assert.ok(design.decisions.length > 0);
			assert.ok(design.decisions[0].includes('Stripe SDK v4'));
		});

		test('should create TDD-ordered tasks from research scenarios', () => {
			const researchContent = `
## TDD Test Scenarios
### Scenario 1: Validate payment input
### Scenario 2: Process payment
`;

			const tasks = extractTasksFromResearch(researchContent);
			assert.ok(tasks.length > 0);
			assert.ok(tasks[0].phase); // RED, GREEN, or REFACTOR
		});
	});

	describe('Proposal PR creation', () => {
		test.skip('should create proposal PR for strategic scope', () => {
			const featureName = 'payment-integration';
			const proposalPath = 'openspec/changes/payment-integration';

			const result = createProposalPR(featureName, proposalPath);
			assert.ok(result.prUrl);
			assert.ok(result.prNumber);
			assert.strictEqual(result.success, true);
		});

		test('should format PR body with proposal summary', () => {
			const featureName = 'test-feature';
			const proposalPath = 'openspec/changes/test-feature';

			const body = formatProposalPRBody(featureName, proposalPath);
			assert.match(body, /## Proposal/);
			assert.match(body, /openspec\/changes\/test-feature/);
		});
	});

	describe('Command execution', () => {
		test.skip('should execute tactical workflow (no OpenSpec)', async () => {
			const featureName = 'fix-validation';

			const result = await executePlan(featureName);
			assert.strictEqual(result.success, true);
			assert.strictEqual(result.scope, 'tactical');
			assert.ok(result.beadsIssueId);
			assert.ok(result.branchName);
			assert.strictEqual(result.openSpecCreated, false);
		});

		test.skip('should execute strategic workflow (with OpenSpec)', async () => {
			const featureName = 'payment-integration';

			const result = await executePlan(featureName);
			assert.strictEqual(result.success, true);
			assert.strictEqual(result.scope, 'strategic');
			assert.ok(result.beadsIssueId);
			assert.ok(result.branchName);
			assert.strictEqual(result.openSpecCreated, true);
			assert.ok(result.proposalPR);
		});

		test.skip('should return actionable output', async () => {
			const featureName = 'test-feature';

			const result = await executePlan(featureName);
			assert.ok(result.summary);
			assert.ok(result.nextCommand);
			assert.ok(result.nextCommand === '/dev' || result.nextCommand === 'wait');
		});
	});
});
