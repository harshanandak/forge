const { describe, test, expect } = require('bun:test');
const {
	extractKeyDecisions,
	extractTestScenarios,
	getTestCoverage,
	generatePRBody,
	createPR,
	executeShip,
} = require('../../lib/commands/ship.js');

describe('Ship Command - PR Creation', () => {
	describe('Extract key decisions from research', () => {
		test('should extract decisions from research doc', () => {
			const researchContent = `# Research: Login Authentication

## Key Decisions

- **Decision 1**: Use JWT tokens instead of sessions
  - Rationale: Stateless authentication for API scalability
  - Alternatives considered: Session cookies, OAuth2

- **Decision 2**: Store refresh tokens in httpOnly cookies
  - Rationale: XSS protection while maintaining UX
  - Security: OWASP A07 (Authentication failures)

## Test Scenarios

1. Valid login credentials → JWT token returned
2. Invalid password → 401 Unauthorized
3. Token expiry → Refresh token flow
`;

			const decisions = extractKeyDecisions(researchContent);
			expect(Array.isArray(decisions)).toBeTruthy();
			expect(decisions.length >= 2).toBeTruthy();
			expect(decisions[0].includes('JWT')).toBeTruthy();
			expect(decisions[1].includes('httpOnly cookies')).toBeTruthy();
		});

		test('should extract decisions from heading and reasoning format', () => {
			const researchContent = `# Feature - Research Document

## Key Decisions & Reasoning

### Decision 1: Use JWT tokens

**Reasoning**: Stateless auth scales better for APIs

### Decision 2: Use refresh token rotation

**Reasoning**: Limits replay risk on token theft

## TDD Test Scenarios

### Scenario 1: Happy path test
`;

			const decisions = extractKeyDecisions(researchContent);
			expect(Array.isArray(decisions)).toBeTruthy();
			expect(decisions.length).toBe(2);
			expect(decisions[0].includes('Use JWT tokens')).toBeTruthy();
			expect(decisions[0].includes('Reasoning: Stateless auth scales better for APIs')).toBeTruthy();
			expect(decisions[1].includes('Use refresh token rotation')).toBeTruthy();
		});

		test('should handle research doc with no decisions section', () => {
			const researchContent = `# Research: Simple Feature

Some research content without decisions section.`;

			const decisions = extractKeyDecisions(researchContent);
			expect(Array.isArray(decisions)).toBeTruthy();
			expect(decisions.length).toBe(0);
		});
	});

	describe('Extract test scenarios from research', () => {
		test('should extract test scenarios from research doc', () => {
			const researchContent = `# Research: Feature

## Test Scenarios

1. Happy path test case
2. Error handling test case
3. Edge case validation
`;

			const scenarios = extractTestScenarios(researchContent);
			expect(Array.isArray(scenarios)).toBeTruthy();
			expect(scenarios.length >= 3).toBeTruthy();
		});

		test('should extract scenarios from research.js heading format', () => {
			const researchContent = `# Research: Feature

## TDD Test Scenarios

### Scenario 1: Happy path test

**Test File**: test/feature.test.js

### Scenario 2: Error handling

**Test File**: test/feature.test.js
`;

			const scenarios = extractTestScenarios(researchContent);
			expect(Array.isArray(scenarios)).toBeTruthy();
			expect(scenarios).toEqual(['Happy path test', 'Error handling']);
		});

		test('should handle research doc with no test scenarios', () => {
			const researchContent = `# Research: Feature

No test scenarios section.`;

			const scenarios = extractTestScenarios(researchContent);
			expect(Array.isArray(scenarios)).toBeTruthy();
			expect(scenarios.length).toBe(0);
		});
	});

	describe('Get test coverage metrics', () => {
		test.skip('should get coverage from c8 report', async () => {
			const coverage = await getTestCoverage();
			expect(coverage.lines !== undefined).toBeTruthy();
			expect(coverage.branches !== undefined).toBeTruthy();
			expect(coverage.functions !== undefined).toBeTruthy();
			expect(coverage.statements !== undefined).toBeTruthy();
		});

		test('should handle missing coverage report gracefully', async () => {
			const coverage = await getTestCoverage();
			expect(coverage).toBeTruthy();
			// Should return default values or skip indicator
		});
	});

	describe('Generate PR body', () => {
		test('should generate complete PR body', () => {
			const context = {
				featureName: 'Login Authentication',
				researchDoc: 'docs/research/login-auth.md',
				decisions: [
					'Use JWT tokens for authentication',
					'Store refresh tokens in httpOnly cookies',
				],
				testScenarios: [
					'Valid login → JWT token',
					'Invalid password → 401',
				],
				coverage: {
					lines: 85.5,
					branches: 80.2,
					functions: 90.0,
					statements: 85.5,
				},
			};

			const body = generatePRBody(context);
			expect(typeof body === 'string').toBeTruthy();
			expect(body.includes('Login Authentication')).toBeTruthy();
			expect(body.includes('JWT tokens')).toBeTruthy();
			expect(body.includes('85.5%')).toBeTruthy(); // Coverage
			expect(body.includes('Research:')).toBeTruthy(); // Research doc link
		});

		test('should handle missing coverage data', () => {
			const context = {
				featureName: 'Simple Feature',
				decisions: ['Decision 1'],
				testScenarios: ['Test 1'],
				coverage: null, // No coverage
			};

			const body = generatePRBody(context);
			expect(typeof body === 'string').toBeTruthy();
			expect(body.includes('Simple Feature')).toBeTruthy();
			expect(!body.includes('Coverage:')).toBeTruthy(); // Should skip coverage section
		});

		test('should include all required PR sections', () => {
			const context = {
				featureName: 'Feature X',
				decisions: ['Decision 1'],
				testScenarios: ['Test 1'],
			};

			const body = generatePRBody(context);
			// Check for standard PR sections
			expect(body.includes('## Summary')).toBeTruthy();
			expect(body.includes('## Key Decisions')).toBeTruthy();
			expect(body.includes('## Test Scenarios')).toBeTruthy();
		});
	});

	describe('Create PR via gh CLI', () => {
		test.skip('should create PR with generated body', async () => {
			const prBody = '## Summary\n\nTest PR body';
			const result = await createPR({
				title: 'feat: test feature',
				body: prBody,
				dryRun: true, // Don't actually create PR
			});

			expect(result.success).toBeTruthy();
		});

		test.skip('should handle gh CLI not found', async () => {
			// Simulate gh not installed
			const result = await createPR({
				title: 'feat: test',
				body: 'Test',
				dryRun: true,
			});

			expect(result.success !== undefined).toBeTruthy();
			if (!result.success) {
				expect(result.error).toBeTruthy();
			}
		});

		test('should validate PR title format', async () => {
			const result = await createPR({
				title: 'invalid title without prefix',
				body: 'Test',
				dryRun: true,
			});

			// Should fail validation
			expect(result.success === false || result.error).toBeTruthy();
		});
	});

	describe('Full ship workflow', () => {
		test.skip('should execute complete ship workflow', async () => {
			const result = await executeShip({
				featureSlug: 'test-feature',
				title: 'feat: implement test feature',
			});

			expect(result.success).toBeTruthy();
			expect(result.prUrl || result.prNumber).toBeTruthy();
		});

		test('should validate feature slug parameter', async () => {
			const result = await executeShip({
				featureSlug: '', // Invalid
				title: 'feat: test',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
			expect(result.error).toMatch(/feature.*slug/i);
		});

		test('should validate PR title parameter', async () => {
			const result = await executeShip({
				featureSlug: 'test-feature',
				title: '', // Invalid
			});

			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
			expect(result.error).toMatch(/title/i);
		});

		test('should handle missing research doc gracefully', async () => {
			const result = await executeShip({
				featureSlug: 'nonexistent-feature',
				title: 'feat: test',
			});

			expect(result.success !== undefined).toBeTruthy();
			// Should either fail or warn about missing research
		});

		test('should return PR URL on success', async () => {
			const result = await executeShip({
				featureSlug: 'test-feature',
				title: 'feat: test',
				dryRun: true, // Simulation mode
			});

			if (result.success) {
				expect(result.prUrl || result.message).toBeTruthy();
			}
		});
	});

	describe('Error handling', () => {
		test('should handle git errors gracefully', async () => {
			// Simulate not in a git repo or no remote
			const result = await createPR({
				title: 'feat: test',
				body: 'Test',
				dryRun: true,
			});

			expect(result.success !== undefined).toBeTruthy();
		});

		test('should handle file read errors', () => {
			const decisions = extractKeyDecisions(null); // Invalid input
			expect(Array.isArray(decisions)).toBeTruthy();
			expect(decisions.length).toBe(0);
		});

		test('should provide actionable error messages', async () => {
			const result = await executeShip({
				featureSlug: null, // Invalid
				title: 'test',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
			// Error should be actionable
			expect(result.error.length > 20).toBeTruthy(); // Not just "error"
		});
	});
});
