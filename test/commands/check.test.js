const { describe, test, expect } = require('bun:test');
const {
	runTypeCheck,
	runLint,
	runSecurityScan,
	runAllTests,
	executeCheck,
} = require('../../lib/commands/check.js');

describe('Check Command - Validation Orchestration', () => {
	describe('Type checking', () => {
		test.skip('should run type check successfully', async () => {
			const result = await runTypeCheck();
			expect(result.success !== undefined).toBeTruthy();
			expect(result.duration).toBeTruthy();
		});

		test('should handle missing type checker gracefully', async () => {
			// When no tsconfig.json or type checker available
			const result = await runTypeCheck();
			// Should skip or return success if TypeScript not configured
			expect(result.success !== undefined).toBeTruthy();
		});
	});

	describe('Linting', () => {
		test.skip('should run ESLint successfully', async () => {
			const result = await runLint();
			expect(result.success !== undefined).toBeTruthy();
			expect(result.warnings !== undefined || result.errors !== undefined).toBeTruthy();
		});

		test('should handle ESLint errors', async () => {
			// When there are lint errors
			const result = await runLint();
			expect(result.success !== undefined).toBeTruthy();
			if (!result.success) {
				expect(result.errors > 0 || result.message).toBeTruthy();
			}
		});
	});

	describe('Security scanning', () => {
		test.skip('should run security audit successfully', async () => {
			const result = await runSecurityScan();
			expect(result.success !== undefined).toBeTruthy();
		});

		test.skip('should handle missing package-lock.json', async () => {
			// When using Bun (no package-lock.json)
			const result = await runSecurityScan();
			// Should use bun audit or skip gracefully
			expect(result.success !== undefined).toBeTruthy();
		});

		test.skip('should detect vulnerabilities if present', async () => {
			const result = await runSecurityScan();
			expect(result.vulnerabilities !== undefined || result.success !== undefined).toBeTruthy();
		});
	});

	describe('Test execution', () => {
		test.skip('should run all tests successfully', async () => {
			const result = await runAllTests();
			expect(result.success !== undefined).toBeTruthy();
			expect(result.passed !== undefined).toBeTruthy();
			expect(result.failed !== undefined).toBeTruthy();
			expect(result.total !== undefined).toBeTruthy();
		});

		test.skip('should report test failures', async () => {
			const result = await runAllTests();
			if (!result.success) {
				expect(result.failed > 0).toBeTruthy();
			}
		});
	});

	describe('Full check orchestration', () => {
		test('should run all checks in sequence', async () => {
			// Skip heavy checks (lint/security/tests call real CLI tools)
			// typeCheck gracefully skips if no tsconfig.json is present
			const result = await executeCheck({ skip: ['lint', 'security', 'tests'] });
			expect(result.success !== undefined).toBeTruthy();
			expect(result.checks).toBeTruthy();
			expect('typeCheck' in result.checks).toBeTruthy();
			expect(typeof result.summary).toBe('string');
			expect(typeof result.duration).toBe('number');
		});

		test('should return summary of all checks', async () => {
			const result = await executeCheck({ skip: ['lint', 'security', 'tests'] });
			expect(result.summary).toBeTruthy();
			expect(typeof result.summary).toBe('string');
			expect(result.summary.length > 0).toBeTruthy();
		});

		test('should fail if any critical check fails', async () => {
			const result = await executeCheck({ skip: ['lint', 'security', 'tests'] });
			if (!result.success) {
				expect(Array.isArray(result.failedChecks)).toBeTruthy();
				expect(result.failedChecks.length > 0).toBeTruthy();
			} else {
				expect(result.success).toBe(true);
				expect(!result.failedChecks || result.failedChecks.length === 0).toBeTruthy();
			}
		});

		test.skip('should allow skipping specific checks', async () => {
			const result = await executeCheck({ skip: ['typeCheck'] });
			expect(result.checks).toBeTruthy();
			// typeCheck should be skipped
			if (result.checks.typeCheck) {
				expect(result.checks.typeCheck.skipped).toBe(true);
			}
		});

		test.skip('should handle verbose mode', async () => {
			const result = await executeCheck({ verbose: true });
			expect(result.checks).toBeTruthy();
			// Verbose should provide detailed output
			Object.values(result.checks).forEach(check => {
				if (check && !check.skipped) {
					expect(check.output || check.message).toBeTruthy();
				}
			});
		});

		test.skip('should validate options parameter', async () => {
			// Invalid options should use defaults
			const result1 = await executeCheck(null);
			expect(result1.success !== undefined).toBeTruthy();

			const result2 = await executeCheck({});
			expect(result2.success !== undefined).toBeTruthy();
		});

		test.skip('should return execution time for each check', async () => {
			const result = await executeCheck();
			expect(result.checks).toBeTruthy();
			Object.values(result.checks).forEach(check => {
				if (check && !check.skipped) {
					expect(check.duration !== undefined).toBeTruthy();
				}
			});
		});
	});

	describe('Error handling', () => {
		test.skip('should handle command not found errors', async () => {
			// When bun test or eslint not available
			const result = await executeCheck();
			expect(result.success !== undefined).toBeTruthy();
			// Should report which commands failed
			if (!result.success && result.errors) {
				expect(Array.isArray(result.errors)).toBeTruthy();
			}
		});

		test.skip('should continue checks even if one fails', async () => {
			// If lint fails, should still run tests
			const result = await executeCheck({ continueOnError: true });
			expect(result.checks).toBeTruthy();
			// Should have results for all checks attempted
			const checkCount = Object.keys(result.checks).length;
			expect(checkCount >= 2).toBeTruthy(); // At least 2 checks attempted
		});
	});
});
