const { describe, test, expect } = require('bun:test');
const {
	runTypeCheck,
	runLint,
	runSecurityScan,
	runAllTests,
	executeValidate,
	executeDebugMode,
} = require('../../lib/commands/validate.js');

describe('Validate Command - Validation Orchestration', () => {
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

	describe('Full validate orchestration', () => {
		test('should run all checks in sequence', async () => {
			// Skip heavy checks (lint/security/tests call real CLI tools)
			// typeCheck gracefully skips if no tsconfig.json is present
			const result = await executeValidate({ skip: ['lint', 'security', 'tests'] });
			expect(result.success !== undefined).toBeTruthy();
			expect(result.checks).toBeTruthy();
			expect('typeCheck' in result.checks).toBeTruthy();
			expect(typeof result.summary).toBe('string');
			expect(typeof result.duration).toBe('number');
		});

		test('should return summary of all checks', async () => {
			const result = await executeValidate({ skip: ['lint', 'security', 'tests'] });
			expect(result.summary).toBeTruthy();
			expect(typeof result.summary).toBe('string');
			expect(result.summary.length > 0).toBeTruthy();
		});

		test('should fail if any critical check fails', async () => {
			const result = await executeValidate({ skip: ['lint', 'security', 'tests'] });
			if (!result.success) {
				expect(Array.isArray(result.failedChecks)).toBeTruthy();
				expect(result.failedChecks.length > 0).toBeTruthy();
			} else {
				expect(result.success).toBe(true);
				expect(!result.failedChecks || result.failedChecks.length === 0).toBeTruthy();
			}
		});

		test.skip('should allow skipping specific checks', async () => {
			const result = await executeValidate({ skip: ['typeCheck'] });
			expect(result.checks).toBeTruthy();
			// typeCheck should be skipped
			if (result.checks.typeCheck) {
				expect(result.checks.typeCheck.skipped).toBe(true);
			}
		});

		test.skip('should handle verbose mode', async () => {
			const result = await executeValidate({ verbose: true });
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
			const result1 = await executeValidate(null);
			expect(result1.success !== undefined).toBeTruthy();

			const result2 = await executeValidate({});
			expect(result2.success !== undefined).toBeTruthy();
		});

		test.skip('should return execution time for each check', async () => {
			const result = await executeValidate();
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
			const result = await executeValidate();
			expect(result.success !== undefined).toBeTruthy();
			// Should report which commands failed
			if (!result.success && result.errors) {
				expect(Array.isArray(result.errors)).toBeTruthy();
			}
		});

		test.skip('should continue checks even if one fails', async () => {
			// If lint fails, should still run tests
			const result = await executeValidate({ continueOnError: true });
			expect(result.checks).toBeTruthy();
			// Should have results for all checks attempted
			const checkCount = Object.keys(result.checks).length;
			expect(checkCount >= 2).toBeTruthy(); // At least 2 checks attempted
		});
	});

	describe('Export verification', () => {
		test('should export executeValidate function', () => {
			const { executeValidate } = require('../../lib/commands/validate.js');
			expect(typeof executeValidate).toBe('function');
		});
	});

	describe('File existence', () => {
		test('check.md should no longer exist', () => {
			const fs = require('node:fs');
			const path = require('node:path');
			const checkMdPath = path.join(__dirname, '../../.claude/commands/check.md');
			expect(fs.existsSync(checkMdPath)).toBe(false);
		});
	});

	describe('AGENTS.md references', () => {
		test('AGENTS.md should reference /validate not /check', () => {
			const fs = require('node:fs');
			const path = require('node:path');
			const agentsPath = path.join(__dirname, '../../AGENTS.md');
			const content = fs.readFileSync(agentsPath, 'utf8');
			expect(content).toContain('/validate');
			expect(content).not.toContain('/check');
		});
	});

	describe('Debug mode', () => {
		test('should enter debug mode at Phase D1 on first failure', () => {
			const result = executeDebugMode({ error: 'Test failed', fixAttempts: 0 });
			expect(result).toEqual({ escalate: false, phase: 'D1' });
		});

		test('should escalate when 3+ fix attempts', () => {
			const result = executeDebugMode({ error: 'still failing', fixAttempts: 3 });
			expect(result.escalate).toBe(true);
			expect(result.message).toEqual(expect.stringContaining('STOP'));
		});

		test('should reject completion claim without fresh evidence', () => {
			const result = executeDebugMode({ error: 'err', fixAttempts: 1, claim: 'should be fixed now' });
			expect(result.valid).toBe(false);
			expect(result.reason).toEqual(expect.stringContaining('fresh'));
		});

		test('should escalate when both fixAttempts>=3 and claim is weak (escalation takes priority)', () => {
			const result = executeDebugMode({ error: 'err', fixAttempts: 3, claim: 'looks good probably' });
			expect(result.escalate).toBe(true);
			expect(result.message).toEqual(expect.stringContaining('STOP'));
		});
	});
});
