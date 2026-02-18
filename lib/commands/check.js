/**
 * Check Command - Validation Orchestration
 * Runs all validation checks (type/lint/security/tests) in sequence
 *
 * Security: Uses execFileSync for command execution to prevent injection
 * Validation: Orchestrates multiple check types with configurable options
 *
 * @module commands/check
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Constants
const CHECK_TYPES = {
	TYPE_CHECK: 'typeCheck',
	LINT: 'lint',
	SECURITY: 'security',
	TESTS: 'tests',
};

function getExecOptions() {
	return { encoding: 'utf8', cwd: process.cwd(), timeout: 120000 };
}

const ERROR_PATTERNS = {
	COMMAND_NOT_FOUND: ['ENOENT', 'not found'],
	NO_LOCK_FILE: ['requires an existing', 'package-lock'],
};

/**
 * Check if error indicates command not found
 * @private
 */
function isCommandNotFound(error) {
	return ERROR_PATTERNS.COMMAND_NOT_FOUND.some(pattern =>
		error.message.includes(pattern),
	);
}

/**
 * Parse number from regex match
 * @private
 */
function parseNumber(match, index = 1, defaultValue = 0) {
	return match ? Number.parseInt(match[index], 10) : defaultValue;
}

/**
 * Get status label for check result
 * @private
 */
function getCheckStatus(check) {
	if (!check) return null;
	if (check.skipped) return 'SKIPPED';
	return check.success ? 'PASS' : 'FAIL';
}

/**
 * Parse vulnerability counts from audit output
 * @private
 */
function parseVulnerabilities(output) {
	return {
		critical: parseNumber(/(\d+) critical/i.exec(output)),  // NOSONAR S5852 - bounded \d+ pattern, no backtracking
		high: parseNumber(/(\d+) high/i.exec(output)),  // NOSONAR S5852 - bounded \d+ pattern, no backtracking
		moderate: parseNumber(/(\d+) moderate/i.exec(output)),  // NOSONAR S5852 - bounded \d+ pattern, no backtracking
		low: parseNumber(/(\d+) low/i.exec(output)),  // NOSONAR S5852 - bounded \d+ pattern, no backtracking
	};
}

/**
 * Run TypeScript type checking
 * Executes tsc --noEmit if TypeScript is configured
 *
 * @returns {Promise<{success: boolean, duration: number, errors?: number, skipped?: boolean, message?: string}>} Type check result
 * @example
 * const result = await runTypeCheck();
 * if (!result.success) console.log(`Type errors: ${result.errors}`);
 */
async function runTypeCheck() {
	const startTime = Date.now();

	// Check if TypeScript is configured
	const tsconfigPath = path.join(process.cwd(), 'tsconfig.json');
	if (!fs.existsSync(tsconfigPath)) {
		return {
			success: true,
			skipped: true,
			duration: Date.now() - startTime,
			message: 'TypeScript not configured (no tsconfig.json)',
		};
	}

	try {
		// Run tsc --noEmit for type checking only
		execFileSync('tsc', ['--noEmit'], getExecOptions());  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context

		return {
			success: true,
			duration: Date.now() - startTime,
			errors: 0,
			message: 'Type checking passed',
		};
	} catch (error) {
		// Check for timeout
		if (error.killed && error.signal === 'SIGTERM') {
			return {
				success: false,
				duration: Date.now() - startTime,
				message: 'Type check timed out after 2 minutes',
			};
		}

		// tsc not found or type errors
		if (isCommandNotFound(error)) {
			return {
				success: true,
				skipped: true,
				duration: Date.now() - startTime,
				message: 'TypeScript compiler not found (skipping type check)',
			};
		}

		// Parse error output for error count
		const errorMatch = /Found (\d+) error/.exec(error.stdout);
		const errors = parseNumber(errorMatch, 1, 1);

		return {
			success: false,
			duration: Date.now() - startTime,
			errors,
			message: `Type checking failed: ${errors} error(s) found`,
			output: error.stdout || error.message,
		};
	}
}

/**
 * Run ESLint
 * Executes eslint . to check code quality
 *
 * @returns {Promise<{success: boolean, duration: number, warnings?: number, errors?: number, message?: string}>} Lint result
 * @example
 * const result = await runLint();
 * console.log(`Warnings: ${result.warnings}, Errors: ${result.errors}`);
 */
async function runLint() {
	const startTime = Date.now();

	try {
		// Run eslint with no output (exit code determines success)
		execFileSync('eslint', ['.'], getExecOptions());  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context

		return {
			success: true,
			duration: Date.now() - startTime,
			warnings: 0,
			errors: 0,
			message: 'Linting passed (no errors)',
		};
	} catch (error) {
		// Check for timeout
		if (error.killed && error.signal === 'SIGTERM') {
			return {
				success: false,
				duration: Date.now() - startTime,
				message: 'Lint check timed out after 2 minutes',
			};
		}

		// eslint not found - skip gracefully (consistent with tsc behavior)
		if (isCommandNotFound(error)) {
			return {
				success: true,
				skipped: true,
				duration: Date.now() - startTime,
				message: 'ESLint not found (skipping lint check). Install with: bun add -D eslint',
			};
		}

		// Parse eslint output for warnings/errors
		const output = error.stdout || error.message;
		const problemsMatch = /(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(output);  // NOSONAR S5852 - bounded quantifiers, no backtracking

		const errors = parseNumber(problemsMatch, 2, 0);
		const warnings = parseNumber(problemsMatch, 3, 0);

		// Only fail if there are errors (warnings are acceptable)
		const success = errors === 0;

		return {
			success,
			duration: Date.now() - startTime,
			warnings,
			errors,
			message: success
				? `Linting passed with ${warnings} warning(s)`
				: `Linting failed: ${errors} error(s), ${warnings} warning(s)`,
			output,
		};
	}
}

/**
 * Run security audit
 * Executes bun audit or npm audit to check for vulnerabilities
 *
 * @returns {Promise<{success: boolean, duration: number, vulnerabilities?: {critical: number, high: number, moderate: number, low: number}, message?: string}>} Security scan result
 * @example
 * const result = await runSecurityScan();
 * if (result.vulnerabilities.critical > 0) console.log('Critical vulnerabilities found!');
 */
async function runSecurityScan() { // NOSONAR S3776
	const startTime = Date.now();

	try {
		// Try bun audit first (faster and works without package-lock.json)
		const result = execFileSync('bun', ['audit'], getExecOptions());  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context

		// Parse bun audit output
		const vulnerabilities = parseVulnerabilities(result);
		const totalVulns = Object.values(vulnerabilities).reduce((sum, count) => sum + count, 0);
		const hasCritical = vulnerabilities.critical > 0 || vulnerabilities.high > 0;

		return {
			success: !hasCritical, // Fail only on critical/high
			duration: Date.now() - startTime,
			vulnerabilities,
			message: totalVulns === 0
				? 'No vulnerabilities found'
				: `Found ${totalVulns} ${totalVulns === 1 ? 'vulnerability' : 'vulnerabilities'} (${vulnerabilities.critical} critical, ${vulnerabilities.high} high)`,  // NOSONAR S3358 - simple format string
		};
	} catch (error) {
		// Check if bun audit timed out - don't retry with npm audit
		if (error.killed && error.signal === 'SIGTERM') {
			return {
				success: false,
				duration: Date.now() - startTime,
				message: 'Security audit timed out after 2 minutes',
			};
		}
		// bun audit failed, try npm audit
		// Note: npm audit exits non-zero for ANY vulnerability (including low/moderate).
		// Capture stdout from the error object to parse JSON output even on non-zero exit.
		try {
		let npmRawOutput = null;
		try {
			npmRawOutput = execFileSync('npm', ['audit', '--json', '--production'], getExecOptions());  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context
		} catch (npmExitError) {
			if (npmExitError.killed && npmExitError.signal === 'SIGTERM') {
				return {
					success: false,
					duration: Date.now() - startTime,
					message: 'Security audit timed out after 2 minutes',
				};
			}
			// npm audit exits non-zero when it finds any vulnerability - stdout still has JSON
			if (npmExitError.stdout) {
				npmRawOutput = npmExitError.stdout;
			} else {
				throw npmExitError; // Genuine failure (not found, no lock file, etc.)
			}
		}

		if (npmRawOutput !== null) {
			let vulnerabilities;
			try {
				const auditData = JSON.parse(npmRawOutput);
				const meta = auditData.metadata?.vulnerabilities || auditData.vulnerabilities || {};
				vulnerabilities = {
					critical: meta.critical || 0,
					high: meta.high || 0,
					moderate: meta.moderate || 0,
					low: meta.low || 0,
				};
			} catch (error_) { // NOSONAR S2486 - intentional: skip non-JSON output
				void error_;
				// JSON parse failed — npm audit returned plain text
				return {
					success: true,
					skipped: true,
					duration: Date.now() - startTime,
					message: 'Security audit skipped (npm audit returned non-JSON output)',
				};
			}
			const totalVulns = Object.values(vulnerabilities).reduce((sum, n) => sum + n, 0);
			const hasCritical = vulnerabilities.critical > 0 || vulnerabilities.high > 0;
			return {
				success: !hasCritical,
				duration: Date.now() - startTime,
				vulnerabilities,
				message: totalVulns === 0
					? 'No vulnerabilities found (npm audit)'
					: `Found ${totalVulns} vulnerabilit${totalVulns === 1 ? 'y' : 'ies'} (${vulnerabilities.critical} critical, ${vulnerabilities.high} high)`,
			};
		}
		} catch (npmError) {
			// Check for timeout first
			if (npmError.killed && npmError.signal === 'SIGTERM') {
				return {
					success: false,
					duration: Date.now() - startTime,
					message: 'Security audit timed out after 2 minutes',
				};
			}

			// Both failed - check if it's because tools aren't available
			const bunNotFound = error.message.includes(ERROR_PATTERNS.COMMAND_NOT_FOUND[0]);
			const noLockFile = ERROR_PATTERNS.NO_LOCK_FILE.some(pattern =>
				npmError.message?.includes(pattern),
			);

			if (bunNotFound || noLockFile) {
				return {
					success: true,
					skipped: true,
					duration: Date.now() - startTime,
					message: 'Security audit skipped (no package manager audit available)',
				};
			}

			// Audit found issues
			return {
				success: false,
				duration: Date.now() - startTime,
				message: 'Security audit failed. Run: npm audit or bun audit to see details',
				output: npmError.message || error.message,
			};
		}
	}
}

/**
 * Run all tests
 * Executes bun test to run the test suite
 *
 * @returns {Promise<{success: boolean, duration: number, passed: number, failed: number, total: number, message?: string}>} Test execution result
 * @example
 * const result = await runAllTests();
 * console.log(`${result.passed}/${result.total} tests passed`);
 */
async function runAllTests() {
	const startTime = Date.now();

	try {
		const result = execFileSync('bun', ['test'], getExecOptions());  // NOSONAR S4036 - hardcoded CLI command, no user input, developer tool context

		// Parse bun test output
		const passed = parseNumber(/(\d+) pass/.exec(result));  // NOSONAR S5852 - bounded \d+ pattern
		const failed = parseNumber(/(\d+) fail/.exec(result));  // NOSONAR S5852 - bounded \d+ pattern
		const total = parseNumber(/Ran (\d+) tests/.exec(result), 1, passed + failed);

		return {
			success: failed === 0,
			duration: Date.now() - startTime,
			passed,
			failed,
			total,
			message: failed === 0
				? `All ${total} tests passed`
				: `${failed}/${total} tests failed`,
		};
	} catch (error) {
		// Check for timeout
		if (error.killed && error.signal === 'SIGTERM') {
			return {
				success: false,
				duration: Date.now() - startTime,
				passed: 0,
				failed: 0,
				total: 0,
				message: 'Test execution timed out after 2 minutes',
			};
		}

		// Test execution failed
		if (isCommandNotFound(error)) {
			return {
				success: true,
				skipped: true,
				duration: Date.now() - startTime,
				passed: 0,
				failed: 0,
				total: 0,
				message: 'Tests skipped: bun not found.',
			};
		}

		// Parse test failures from output
		const output = error.stdout || error.message;
		const passed = parseNumber(/(\d+) pass/.exec(output));  // NOSONAR S5852 - bounded \d+ pattern
		const failed = parseNumber(/(\d+) fail/.exec(output), 1, 1);  // NOSONAR S5852 - bounded \d+ pattern
		const total = passed + failed;

		return {
			success: false,
			duration: Date.now() - startTime,
			passed,
			failed,
			total,
			message: `${failed}/${total} tests failed`,
			output,
		};
	}
}

/**
 * Execute all checks
 * Orchestrates type checking, linting, security scanning, and tests
 *
 * @param {{skip?: string[], verbose?: boolean, continueOnError?: boolean}} [options] - Execution options
 * @returns {Promise<{
 *   success: boolean,
 *   checks: {
 *     typeCheck?: object,
 *     lint?: object,
 *     security?: object,
 *     tests?: object
 *   },
 *   summary: string,
 *   failedChecks?: string[],
 *   errors?: string[]
 * }>} Execution result
 * @example
 * const result = await executeCheck({ skip: ['typeCheck'], verbose: true });
 * console.log(result.summary);
 */
async function executeCheck(options = {}) { // NOSONAR S3776
	const { skip = [], continueOnError = true } = options || {};

	const checks = {};
	const failedChecks = [];
	const errors = [];
	const startTime = Date.now();

	// 1. Type checking
	if (!skip.includes(CHECK_TYPES.TYPE_CHECK)) {
		try {
			checks.typeCheck = await runTypeCheck();
			if (!checks.typeCheck.success && !checks.typeCheck.skipped) {
				failedChecks.push(CHECK_TYPES.TYPE_CHECK);
				if (!continueOnError) {
					return buildResult(checks, failedChecks, errors, startTime);
				}
			}
		} catch (error) {
			errors.push(`Type check error: ${error.message}`);
			checks.typeCheck = { success: false, message: error.message };
		}
	}

	// 2. Linting
	if (!skip.includes(CHECK_TYPES.LINT)) {
		try {
			checks.lint = await runLint();
			if (!checks.lint.success && !checks.lint.skipped) {
				failedChecks.push(CHECK_TYPES.LINT);
				if (!continueOnError) {
					return buildResult(checks, failedChecks, errors, startTime);
				}
			}
		} catch (error) {
			errors.push(`Lint error: ${error.message}`);
			checks.lint = { success: false, message: error.message };
		}
	}

	// 3. Security scanning
	if (!skip.includes(CHECK_TYPES.SECURITY)) {
		try {
			checks.security = await runSecurityScan();
			if (!checks.security.success && !checks.security.skipped) {
				failedChecks.push(CHECK_TYPES.SECURITY);
				if (!continueOnError) {
					return buildResult(checks, failedChecks, errors, startTime);
				}
			}
		} catch (error) {
			errors.push(`Security scan error: ${error.message}`);
			checks.security = { success: false, message: error.message };
		}
	}

	// 4. Tests
	if (!skip.includes(CHECK_TYPES.TESTS)) {
		try {
			checks.tests = await runAllTests();
			if (!checks.tests.success) {
				failedChecks.push(CHECK_TYPES.TESTS);
			}
		} catch (error) {
			errors.push(`Test execution error: ${error.message}`);
			checks.tests = { success: false, message: error.message };
		}
	}

	return buildResult(checks, failedChecks, errors, startTime);
}

/**
 * Build final result object
 * @private
 */
function buildResult(checks, failedChecks, errors, startTime) {
	const success = failedChecks.length === 0 && errors.length === 0;
	const duration = Date.now() - startTime;

	// Build summary using getCheckStatus helper
	const checkResults = [];
	const checkLabels = {
		typeCheck: 'Type',
		lint: 'Lint',
		security: 'Security',
		tests: 'Tests',
	};

	for (const [key, label] of Object.entries(checkLabels)) {
		const status = getCheckStatus(checks[key]);
		if (status) {
			checkResults.push(`${label}: ${status}`);
		}
	}

	const summary = success
		? `All checks passed (${checkResults.join(', ')})`
		: `Checks failed: ${failedChecks.join(', ')}`;

	const result = {
		success,
		checks,
		summary,
		duration,
	};

	if (failedChecks.length > 0) {
		result.failedChecks = failedChecks;
	}

	if (errors.length > 0) {
		result.errors = errors;
	}

	return result;
}

module.exports = {
	runTypeCheck,
	runLint,
	runSecurityScan,
	runAllTests,
	executeCheck,
};
