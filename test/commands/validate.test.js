const { describe, test, expect, setDefaultTimeout } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
	runTypeCheck,
	runLint,
	runSecurityScan,
	runAllTests,
	scanForConflictMarkers,
	executeValidate,
	executeDebugMode,
} = require('../../lib/commands/validate.js');

setDefaultTimeout(15000);

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
			// Should skip or return a boolean success value
			expect(typeof result.success).toBe('boolean');
		});
	});

	describe('Linting', () => {
		test.skip('should run ESLint successfully', async () => {
			const result = await runLint();
			expect(result.success !== undefined).toBeTruthy();
			expect(result.warnings !== undefined || result.errors !== undefined).toBeTruthy();
		});

		test('should handle ESLint errors', async () => {
			const result = await runLint();
			expect(typeof result.success).toBe('boolean');
			if (!result.success) {
				expect(result.errors > 0 || typeof result.message === 'string').toBe(true);
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
		test('should fail fast when conflict markers are present', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-conflicts-'));
			try {
				fs.writeFileSync(
					path.join(tmpDir, 'broken.js'),
					'<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> branch\n',
				);

				const result = await executeValidate({
					rootDir: tmpDir,
					skip: ['typeCheck', 'lint', 'security', 'tests'],
				});

				expect(result.success).toBe(false);
				expect(result.failedChecks).toContain('conflictMarkers');
				expect(result.checks.conflictMarkers.files).toEqual([
					expect.objectContaining({ path: 'broken.js' }),
				]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test('should ignore standalone separator lines that are not full conflict blocks', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-separators-'));
			try {
				fs.writeFileSync(
					path.join(tmpDir, 'notes.md'),
					'Heading\n=======\nBody copy\n',
				);

				const result = await executeValidate({
					rootDir: tmpDir,
					skip: ['typeCheck', 'lint', 'security', 'tests'],
				});

				expect(result.success).toBe(true);
				expect(result.checks.conflictMarkers.files).toEqual([]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test('should skip hidden directories that are not explicitly allowlisted while scanning tracked dotdirs', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-dotdirs-'));
			try {
				fs.mkdirSync(path.join(tmpDir, '.hidden'), { recursive: true });
				fs.mkdirSync(path.join(tmpDir, '.forge'), { recursive: true });
				fs.mkdirSync(path.join(tmpDir, '.github'), { recursive: true });
				fs.writeFileSync(
					path.join(tmpDir, '.hidden', 'ignored.js'),
					'<<<<<<< HEAD\nignore me\n=======\nignore me too\n>>>>>>> branch\n',
				);
				fs.writeFileSync(
					path.join(tmpDir, '.forge', 'tracked.md'),
					'<<<<<<< HEAD\ntracked dotdir\n=======\ntracked dotdir updated\n>>>>>>> branch\n',
				);
				fs.writeFileSync(
					path.join(tmpDir, '.github', 'workflow.yml'),
					'<<<<<<< HEAD\nscan me\n=======\nscan me too\n>>>>>>> branch\n',
				);

				const result = await executeValidate({
					rootDir: tmpDir,
					skip: ['typeCheck', 'lint', 'security', 'tests'],
				});

				expect(result.success).toBe(false);
				expect(result.checks.conflictMarkers.files).toEqual([
					expect.objectContaining({ path: path.join('.forge', 'tracked.md') }),
					expect.objectContaining({ path: path.join('.github', 'workflow.yml') }),
				]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test('should flag unterminated conflict marker blocks', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-partial-conflicts-'));
			try {
				fs.writeFileSync(
					path.join(tmpDir, 'partial.js'),
					'<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n',
				);

				const result = await executeValidate({
					rootDir: tmpDir,
					skip: ['typeCheck', 'lint', 'security', 'tests'],
				});

				expect(result.success).toBe(false);
				expect(result.checks.conflictMarkers.files).toEqual([
					expect.objectContaining({ path: 'partial.js', line: 1 }),
				]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test('should flag orphaned closing conflict markers', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-orphaned-closing-'));
			try {
				fs.writeFileSync(
					path.join(tmpDir, 'orphaned.md'),
					'Normal content\n>>>>>>> feature-branch\nMore content\n',
				);

				const result = await executeValidate({
					rootDir: tmpDir,
					skip: ['typeCheck', 'lint', 'security', 'tests'],
				});

				expect(result.success).toBe(false);
				expect(result.checks.conflictMarkers.files).toEqual([
					expect.objectContaining({ path: 'orphaned.md', line: 2 }),
				]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test('should run all checks in sequence', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-sequence-'));
			try {
				// Skip heavy checks (lint/security/tests call real CLI tools).
				// Use an empty temp root so conflict-marker scanning stays deterministic and fast.
				const result = await executeValidate({ rootDir: tmpDir, skip: ['lint', 'security', 'tests'] });
				expect(typeof result.success).toBe('boolean');
				expect(result.checks).toBeTruthy();
				expect('conflictMarkers' in result.checks).toBeTruthy();
				expect('typeCheck' in result.checks).toBeTruthy();
				expect(typeof result.summary).toBe('string');
				expect(typeof result.duration).toBe('number');
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test('should return summary of all checks', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-summary-'));
			try {
				const result = await executeValidate({ rootDir: tmpDir, skip: ['lint', 'security', 'tests'] });
				expect(result.summary).toBeTruthy();
				expect(typeof result.summary).toBe('string');
				expect(result.summary.length > 0).toBeTruthy();
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test('should fail if any critical check fails', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-critical-'));
			try {
				const result = await executeValidate({ rootDir: tmpDir, skip: ['lint', 'security', 'tests'] });
				if (!result.success) {
					expect(Array.isArray(result.failedChecks)).toBeTruthy();
					expect(result.failedChecks.length > 0).toBeTruthy();
				} else {
					expect(result.success).toBe(true);
					expect(!result.failedChecks || result.failedChecks.length === 0).toBeTruthy();
				}
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
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

		test.skip('should handle custom skip list', async () => {
			const result = await executeValidate({ skip: ['typeCheck'] });
			expect(result.checks).toBeTruthy();
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

		test('should export scanForConflictMarkers function', () => {
			expect(typeof scanForConflictMarkers).toBe('function');
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
			const result = executeDebugMode({ fixAttempts: 0 });
			expect(result).toEqual({ escalate: false, phase: 'D1' });
		});

		test('should escalate when 3+ fix attempts', () => {
			const result = executeDebugMode({ fixAttempts: 3 });
			expect(result.escalate).toBe(true);
			expect(result.message).toEqual(expect.stringContaining('STOP'));
		});

		test('should reject completion claim without fresh evidence', () => {
			const result = executeDebugMode({ fixAttempts: 1, claim: 'looks good to me' });
			expect(result.valid).toBe(false);
			expect(result.reason).toEqual(expect.stringContaining('fresh'));
		});

		test('should escalate when both fixAttempts>=3 and claim is weak (escalation takes priority)', () => {
			const result = executeDebugMode({ fixAttempts: 3, claim: 'looks good probably' });
			expect(result.escalate).toBe(true);
			expect(result.message).toEqual(expect.stringContaining('STOP'));
		});
	});
});
