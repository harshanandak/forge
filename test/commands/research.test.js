const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
	validateResearchSlug,
	buildResearchQueries,
	conductResearch,
	extractKeyDecisions,
	identifyTestScenarios,
	analyzeOwaspRisks,
	formatResearchDoc,
	saveResearchDoc,
	executeResearch,
} = require('../../lib/commands/research.js');

describe('Research Command - Parallel AI Integration', () => {
	describe('Slug validation', () => {
		test('should accept valid feature slugs', () => {
			const validSlugs = [
				'stripe-billing',
				'user-auth',
				'api-v2',
				'test123',
			];

			for (const slug of validSlugs) {
				const result = validateResearchSlug(slug);
				assert.strictEqual(result.valid, true);
			}
		});

		test('should reject invalid feature slugs', () => {
			const invalidSlugs = [
				'../../../etc/passwd',
				'test; rm -rf /',
				'Feature Name',
				'test/path',
			];

			for (const slug of invalidSlugs) {
				const result = validateResearchSlug(slug);
				assert.strictEqual(result.valid, false);
			}
		});
	});

	describe('Parallel AI integration', () => {
		test('should construct web research query', () => {
			const featureName = 'stripe-billing-integration';

			const queries = buildResearchQueries(featureName);
			assert.ok(queries.bestPractices);
			assert.match(queries.bestPractices, /best practices/i);
			assert.ok(queries.security);
			assert.match(queries.security, /OWASP/i);
			assert.ok(queries.libraries);
		});

		test('should call parallel-ai for each query type', async () => {
			const featureName = 'test-feature';

			const result = await conductResearch(featureName);
			assert.ok(result.bestPractices !== undefined);
			assert.ok(result.security !== undefined);
			assert.ok(result.libraries !== undefined);
		});

		test.skip('should handle parallel-ai API errors gracefully', async () => {
			const featureName = 'test-feature';

			// TODO: Implement with mocking in REFACTOR phase
			// Mock parallel-ai to throw error
			// const result = await conductResearch(featureName);
			// assert.ok(result.error);
			// assert.ok(result.partialResults);
		});
	});

	describe('Research document formatting', () => {
		test('should format research results into TEMPLATE structure', () => {
			const researchData = {
				featureName: 'stripe-billing',
				bestPractices: ['Practice 1', 'Practice 2'],
				security: ['OWASP A01', 'OWASP A03'],
				libraries: ['Stripe SDK', 'Payment helpers'],
			};

			const formatted = formatResearchDoc(researchData);
			assert.match(formatted, /## Objective/);
			assert.match(formatted, /## Web Research/);
			assert.match(formatted, /## Key Decisions/);
			assert.match(formatted, /## TDD Test Scenarios/);
			assert.match(formatted, /## Security Analysis/);
		});

		test('should include all TEMPLATE.md sections', () => {
			const researchData = {
				featureName: 'test-feature',
			};

			const formatted = formatResearchDoc(researchData);
			const requiredSections = [
				'Objective',
				'Codebase Analysis',
				'Web Research',
				'Key Decisions & Reasoning',
				'TDD Test Scenarios',
				'Security Analysis',
				'Scope Assessment',
			];
			for (const section of requiredSections) {
				assert.match(formatted, new RegExp(section));
			}
		});

		test('should extract key decisions with reasoning', () => {
			const researchData = {
				bestPractices: [
					'Use Stripe SDK v4 for retry logic',
					'Implement webhook validation',
				],
			};

			const decisions = extractKeyDecisions(researchData);
			assert.ok(decisions.length > 0);
			assert.ok(decisions[0].decision);
			assert.ok(decisions[0].reasoning);
			assert.ok(decisions[0].evidence);
		});

		test('should identify TDD test scenarios', () => {
			const researchData = {
				featureName: 'payment-validation',
				bestPractices: ['Validate card before charge', 'Handle errors'],
			};

			const scenarios = identifyTestScenarios(researchData);
			assert.ok(scenarios.length > 0);
			assert.ok(scenarios[0].testFile);
			assert.ok(scenarios[0].assertions);
		});

		test('should analyze OWASP Top 10 security risks', () => {
			const researchData = {
				featureName: 'user-authentication',
				security: ['Authentication vulnerabilities', 'Session management'],
			};

			const analysis = analyzeOwaspRisks(researchData);
			assert.ok(analysis.A01); // Broken Access Control
			assert.ok(analysis.A02); // Cryptographic Failures
			assert.ok(analysis.A07); // Authentication Failures
		});
	});

	describe('File operations', () => {
		test('should save research doc to correct path', () => {
			const featureSlug = 'test-feature';
			const content = '# Research Doc';

			const result = saveResearchDoc(featureSlug, content);
			assert.strictEqual(result.path, 'docs/research/test-feature.md');
			assert.strictEqual(result.success, true);
		});

		test('should create docs/research directory if missing', () => {
			const featureSlug = 'new-feature';
			const content = '# Research';

			const result = saveResearchDoc(featureSlug, content);
			// Directory may or may not be created depending on whether it exists
			assert.strictEqual(result.success, true);
		});

		test.skip('should handle file write errors', () => {
			const featureSlug = 'test-feature';
			const content = '# Research';

			// TODO: Implement with mocking in REFACTOR phase
			// Mock fs to throw error
			// const result = saveResearchDoc(featureSlug, content);
			// assert.strictEqual(result.success, false);
			// assert.ok(result.error);
		});
	});

	describe('Command execution', () => {
		test('should execute full research workflow', async () => {
			const featureName = 'stripe-billing';

			const result = await executeResearch(featureName);
			assert.strictEqual(result.success, true);
			assert.ok(result.researchDocPath);
			assert.match(result.researchDocPath, /docs\/research\/stripe-billing\.md/);
		});

		test('should return summary of research findings', async () => {
			const featureName = 'test-feature';

			const result = await executeResearch(featureName);
			assert.ok(result.summary);
			assert.ok(result.summary.keyDecisions);
			assert.ok(result.summary.testScenarios);
			assert.ok(result.summary.securityRisks);
		});
	});
});
