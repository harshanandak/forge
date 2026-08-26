const { describe, test, expect, setDefaultTimeout } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
	runTypeCheck,
	runLint,
	runSecurityScan,
	runAllTests,
	parseTestCounts,
	scanForConflictMarkers,
	executeValidate,
	executeDebugMode,
} = require('../../lib/commands/validate.js');

setDefaultTimeout(30000);

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
			let invocations = 0;
			const result = await runLint(() => {
				invocations += 1;
				const error = new Error('ESLint failed');
				error.stdout = '2 problems (2 errors, 0 warnings)';
				throw error;
			});

			expect(invocations).toBe(1);
			expect(result).toMatchObject({ success: false, errors: 2, warnings: 0 });
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

		test('uses a long enough subprocess timeout for the full local suite', () => {
			const source = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'commands', 'validate.js'), 'utf8');
			expect(source).toMatch(/VALIDATION_COMMAND_TIMEOUT_MS\s*=\s*600000/);
			expect(source).toMatch(/timeout:\s*VALIDATION_COMMAND_TIMEOUT_MS/);
			// External repositories retain the raw Bun fallback and its per-test timeout.
			expect(source).toMatch(/\[\s*'test'\s*,\s*'--timeout'\s*,\s*'30000'\s*\]/);
			expect(source).not.toContain('timed out after 2 minutes');
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

		test('should skip ignored directories and non-allowlisted dotdirs when scanning Git-listed files', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-git-fast-path-'));
			try {
				execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
				execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: tmpDir, stdio: 'ignore' });
				execFileSync('git', ['config', 'user.email', 'forge@example.com'], { cwd: tmpDir, stdio: 'ignore' });
				fs.mkdirSync(path.join(tmpDir, '.beads'), { recursive: true });
				fs.mkdirSync(path.join(tmpDir, '.hidden'), { recursive: true });
				fs.mkdirSync(path.join(tmpDir, '.forge'), { recursive: true });
				fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true });
				fs.writeFileSync(
					path.join(tmpDir, '.beads', 'metadata.json'),
					'<<<<<<< HEAD\nbeads\n=======\nbeads\n>>>>>>> branch\n',
				);
				fs.writeFileSync(
					path.join(tmpDir, '.hidden', 'ignored.js'),
					'<<<<<<< HEAD\nhidden\n=======\nhidden\n>>>>>>> branch\n',
				);
				fs.writeFileSync(
					path.join(tmpDir, '.forge', 'tracked.md'),
					'<<<<<<< HEAD\ntracked dotdir\n=======\ntracked dotdir updated\n>>>>>>> branch\n',
				);
				fs.writeFileSync(
					path.join(tmpDir, 'dist', 'bundle.js'),
					'<<<<<<< HEAD\ndist\n=======\ndist\n>>>>>>> branch\n',
				);
				execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
				execFileSync('git', ['commit', '-m', 'seed tracked files'], { cwd: tmpDir, stdio: 'ignore' });

				const result = await executeValidate({
					rootDir: tmpDir,
					skip: ['typeCheck', 'lint', 'security', 'tests'],
				});

				expect(result.success).toBe(false);
				expect(result.checks.conflictMarkers.files).toEqual([
					expect.objectContaining({ path: path.join('.forge', 'tracked.md') }),
				]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test('should preserve leading whitespace in Git-indexed file paths', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-whitespace-paths-'));
			try {
				const spacedFile = ' leadingspace.js';
				execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
				fs.writeFileSync(
					path.join(tmpDir, spacedFile),
					'<<<<<<< HEAD\nwhitespace path\n=======\nwhitespace path updated\n>>>>>>> branch\n',
				);
				execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });

				const result = await executeValidate({
					rootDir: tmpDir,
					skip: ['typeCheck', 'lint', 'security', 'tests'],
				});

				expect(result.success).toBe(false);
				expect(result.checks.conflictMarkers.files).toEqual([
					expect.objectContaining({ path: spacedFile }),
				]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		test('should handle large Git-indexed file lists without overflowing the default exec buffer', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-large-git-index-'));
			try {
				const totalFiles = 5000;
				const longNameSuffix = 'a'.repeat(150);
				execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });

				for (let index = 0; index < totalFiles; index += 1) {
					const fileName = `${String(index).padStart(5, '0')}-${longNameSuffix}.js`;
					fs.writeFileSync(path.join(tmpDir, fileName), 'console.log("safe");\n');
				}

				execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });

				const result = await executeValidate({
					rootDir: tmpDir,
					skip: ['typeCheck', 'lint', 'security', 'tests'],
				});

				expect(result.success).toBe(true);
				expect(result.checks.conflictMarkers.files).toEqual([]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		}, 60000 /* extend timeout: staging 5 000 files can be slow on CI */);

		test('should skip tracked symlinks in Git-indexed scans', async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-symlink-paths-'));
			const outsideTargetPath = path.join(os.tmpdir(), `forge-validate-symlink-target-${Date.now()}.txt`);
			try {
				execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
				fs.writeFileSync(
					path.join(tmpDir, 'tracked.js'),
					'console.log("safe");\n',
				);
				fs.writeFileSync(
					outsideTargetPath,
					'<<<<<<< HEAD\noutside\n=======\noutside\n>>>>>>> branch\n',
				);

				try {
					fs.symlinkSync(
						outsideTargetPath,
						path.join(tmpDir, 'linked.txt'),
					);
				} catch (error) {
					if (error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN')) {
						return;
					}
					throw error;
				}

				execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });

				const result = await executeValidate({
					rootDir: tmpDir,
					skip: ['typeCheck', 'lint', 'security', 'tests'],
				});

				expect(result.success).toBe(true);
				expect(result.checks.conflictMarkers.files).toEqual([]);
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
				fs.rmSync(outsideTargetPath, { force: true });
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

	// B2 (N1): a green Tests result must mean tests actually ran and passed.
	describe('runAllTests — never false-green on 0 tests (B2)', () => {
		const fakeExec = (out) => () => out;

		test('bun ran but executed 0 tests => explicit SKIP, never PASS', async () => {
			const result = await runAllTests(fakeExec('0 pass\n0 fail\nRan 0 tests across 0 files. [1.00ms]'));
			expect(result.skipped).toBe(true);
			expect(result.testsFound).toBe(false);
			expect(result.total).toBe(0);
			// The status label must not read PASS when nothing ran.
			expect(getCheckStatus(result)).toBe('SKIPPED');
			expect(result.message).toMatch(/no tests|0 tests/i);
		});

		test('real passing run => success and testsFound true', async () => {
			const result = await runAllTests(fakeExec('5 pass\n0 fail\nRan 5 tests across 2 files. [1.00s]'));
			expect(result.success).toBe(true);
			expect(result.testsFound).toBe(true);
			expect(result.total).toBe(5);
			expect(getCheckStatus(result)).toBe('PASS');
		});

		test('failing run => success false with failed count', async () => {
			const exec = () => {
				const e = new Error('bun test failed');
				e.stdout = '3 pass\n2 fail\nRan 5 tests across 2 files.';
				throw e;
			};
			const result = await runAllTests(exec);
			expect(result.success).toBe(false);
			expect(result.failed).toBe(2);
		});

		test('bun not found => explicit SKIP, not silent PASS', async () => {
			const exec = () => { const e = new Error('spawn bun ENOENT'); e.code = 'ENOENT'; throw e; };
			const result = await runAllTests(exec);
			expect(result.skipped).toBe(true);
			expect(getCheckStatus(result)).toBe('SKIPPED');
			expect(result.message).toMatch(/bun|test runner/i);
		});

		test('uses the repository full-suite runner and its final aggregate', async () => {
			const rootDir = path.resolve(__dirname, '..', '..');
			const calls = [];
			const result = await runAllTests((...args) => {
				calls.push(args);
				return [
					'Full suite aggregate: status=FAIL tests=2 assertions=2 passed=1 failed=1 errors=0 skipped=0',
					'Full suite aggregate: status=PASS tests=7 assertions=9 passed=6 failed=0 errors=0 skipped=1',
				].join('\n');
			}, rootDir);

			expect(calls).toHaveLength(1);
			expect(calls[0][0]).toBe('node');
			expect(calls[0][1]).toEqual(['scripts/test-full-suite.js']);
			expect(calls[0][2].cwd).toBe(rootDir);
			expect(result).toMatchObject({ success: true, passed: 6, failed: 0, skipped: 1, total: 7 });
		});

		test('falls back to raw Bun outside Forge even when the script path exists', async () => {
			const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-bun-fallback-'));
			try {
				fs.mkdirSync(path.join(rootDir, 'scripts'));
				fs.writeFileSync(path.join(rootDir, 'scripts', 'test-full-suite.js'), '');
				const calls = [];
				await runAllTests((...args) => {
					calls.push(args);
					return '1 pass\n0 fail\nRan 1 tests across 1 file.';
				}, rootDir);

				expect(calls[0][0]).toBe('bun');
				expect(calls[0][1]).toEqual(['test', '--timeout', '30000']);
				expect(calls[0][2].cwd).toBe(rootDir);
			} finally {
				fs.rmSync(rootDir, { recursive: true, force: true });
			}
		});

		test('keeps a non-zero full-suite exit failed when the aggregate reports zero failures', async () => {
			const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-full-suite-exit-'));
			try {
				fs.mkdirSync(path.join(rootDir, 'scripts'));
				fs.writeFileSync(path.join(rootDir, 'scripts', 'test-full-suite.js'), '');
				const exec = () => {
					const error = new Error('full suite exited 1');
					error.stdout = 'Full suite aggregate: status=FAIL tests=10 assertions=12 passed=10 failed=0 errors=0 skipped=0';
					throw error;
				};

				const result = await runAllTests(exec, rootDir);
				expect(result).toMatchObject({ success: false, testsFound: true, passed: 10, failed: 1, total: 10 });
			} finally {
				fs.rmSync(rootDir, { recursive: true, force: true });
			}
		});

		test('parses the final full-suite aggregate before Bun shard summaries', () => {
			const result = parseTestCounts([
				'99 pass',
				'Full suite aggregate: status=FAIL tests=4 assertions=5 passed=3 failed=1 errors=0 skipped=0',
				'Full suite aggregate: status=PASS tests=8 assertions=10 passed=7 failed=0 errors=0 skipped=1',
			].join('\n'));
			expect(result).toMatchObject({ status: 'PASS', passed: 7, failed: 0, errors: 0, skipped: 1, total: 8 });
		});

		test('treats an INCOMPLETE full-suite aggregate as a failed run', async () => {
			const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-incomplete-'));
			try {
				fs.mkdirSync(path.join(rootDir, 'scripts'));
				fs.writeFileSync(path.join(rootDir, 'scripts', 'test-full-suite.js'), '');
				const result = await runAllTests(
					() => '99 pass\nFull suite aggregate: status=INCOMPLETE tests=8 assertions=10 passed=7 failed=0 errors=0 skipped=1',
					rootDir,
				);
				expect(result).toMatchObject({ success: false, testsFound: true, passed: 7, failed: 0, total: 8 });
			} finally {
				fs.rmSync(rootDir, { recursive: true, force: true });
			}
		});

		test('executeValidate forwards rootDir to the test runner', async () => {
			const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-validate-root-'));
			try {
				fs.writeFileSync(
					path.join(rootDir, 'root-dir.test.js'),
					"import { expect, test } from 'bun:test'; test('rootDir', () => { console.log('1 pass\\n0 fail\\nRan 1 tests across 1 file.'); expect(true).toBe(true); });\n",
				);
				const result = await executeValidate({
					rootDir,
					skip: ['conflictMarkers', 'typeCheck', 'lint', 'security'],
				});
				expect(result.success).toBe(true);
				expect(result.checks.tests).toMatchObject({ testsFound: true, passed: 1, total: 1 });
			} finally {
				fs.rmSync(rootDir, { recursive: true, force: true });
			}
		});
	});
});

// getCheckStatus is internal; re-derive the same rule the summary uses for the
// assertions above (skipped => SKIPPED, else PASS/FAIL).
function getCheckStatus(check) {
	if (!check) return null;
	if (check.skipped) return 'SKIPPED';
	return check.success ? 'PASS' : 'FAIL';
}
