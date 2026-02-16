/**
 * Check Command - Validation Orchestration
 * Runs all validation checks (type/lint/security/tests) in sequence
 *
 * Security: Uses execFileSync for command execution to prevent injection
 * Validation: Orchestrates multiple check types with configurable options
 *
 * @module commands/check
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
		execFileSync('tsc', ['--noEmit'], {
			encoding: 'utf8',
			cwd: process.cwd(),
		});

		return {
			success: true,
			duration: Date.now() - startTime,
			errors: 0,
			message: 'Type checking passed',
		};
	} catch (error) {
		// tsc not found or type errors
		const tscNotFound = error.message.includes('ENOENT') || error.message.includes('not found');

		if (tscNotFound) {
			return {
				success: true,
				skipped: true,
				duration: Date.now() - startTime,
				message: 'TypeScript compiler not found (skipping type check)',
			};
		}

		// Parse error output for error count
		const errorMatch = error.stdout?.match(/Found (\d+) error/);
		const errors = errorMatch ? parseInt(errorMatch[1], 10) : 1;

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
		execFileSync('eslint', ['.'], {
			encoding: 'utf8',
			cwd: process.cwd(),
		});

		return {
			success: true,
			duration: Date.now() - startTime,
			warnings: 0,
			errors: 0,
			message: 'Linting passed (no errors)',
		};
	} catch (error) {
		// eslint not found or lint errors
		const eslintNotFound = error.message.includes('ENOENT') || error.message.includes('not found');

		if (eslintNotFound) {
			return {
				success: false,
				duration: Date.now() - startTime,
				message: 'ESLint not found. Install with: bun add -D eslint',
			};
		}

		// Parse eslint output for warnings/errors
		const output = error.stdout || error.message;
		const problemsMatch = output.match(/(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/);

		let errors = 0;
		let warnings = 0;

		if (problemsMatch) {
			errors = parseInt(problemsMatch[2], 10);
			warnings = parseInt(problemsMatch[3], 10);
		}

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
async function runSecurityScan() {
	const startTime = Date.now();

	try {
		// Try bun audit first (faster and works without package-lock.json)
		const result = execFileSync('bun', ['audit'], {
			encoding: 'utf8',
			cwd: process.cwd(),
		});

		// Parse bun audit output
		const criticalMatch = result.match(/(\d+) critical/i);
		const highMatch = result.match(/(\d+) high/i);
		const moderateMatch = result.match(/(\d+) moderate/i);
		const lowMatch = result.match(/(\d+) low/i);

		const vulnerabilities = {
			critical: criticalMatch ? parseInt(criticalMatch[1], 10) : 0,
			high: highMatch ? parseInt(highMatch[1], 10) : 0,
			moderate: moderateMatch ? parseInt(moderateMatch[1], 10) : 0,
			low: lowMatch ? parseInt(lowMatch[1], 10) : 0,
		};

		const totalVulns = vulnerabilities.critical + vulnerabilities.high + vulnerabilities.moderate + vulnerabilities.low;
		const hasCritical = vulnerabilities.critical > 0 || vulnerabilities.high > 0;

		return {
			success: !hasCritical, // Fail only on critical/high
			duration: Date.now() - startTime,
			vulnerabilities,
			message: totalVulns === 0
				? 'No vulnerabilities found'
				: `Found ${totalVulns} vulnerabilit${totalVulns === 1 ? 'y' : 'ies'} (${vulnerabilities.critical} critical, ${vulnerabilities.high} high)`,
		};
	} catch (error) {
		// bun audit failed, try npm audit
		try {
			const result = execFileSync('npm', ['audit', '--production'], {
				encoding: 'utf8',
				cwd: process.cwd(),
			});

			// If npm audit succeeds, parse output
			return {
				success: true,
				duration: Date.now() - startTime,
				vulnerabilities: { critical: 0, high: 0, moderate: 0, low: 0 },
				message: 'No vulnerabilities found (npm audit)',
			};
		} catch (npmError) {
			// Both failed - check if it's because tools aren't available
			const bunNotFound = error.message.includes('ENOENT');
			const noLockFile = npmError.message?.includes('requires an existing') || npmError.message?.includes('package-lock');

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
				message: 'Security audit failed. Run: bun audit',
				output: error.message,
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
		const result = execFileSync('bun', ['test'], {
			encoding: 'utf8',
			cwd: process.cwd(),
		});

		// Parse bun test output
		const passMatch = result.match(/(\d+) pass/);
		const failMatch = result.match(/(\d+) fail/);
		const totalMatch = result.match(/Ran (\d+) tests/);

		const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
		const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
		const total = totalMatch ? parseInt(totalMatch[1], 10) : passed + failed;

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
		// Test execution failed
		const bunNotFound = error.message.includes('ENOENT') || error.message.includes('not found');

		if (bunNotFound) {
			return {
				success: false,
				duration: Date.now() - startTime,
				passed: 0,
				failed: 0,
				total: 0,
				message: 'Bun not found. Tests cannot be executed.',
			};
		}

		// Parse test failures from output
		const output = error.stdout || error.message;
		const passMatch = output.match(/(\d+) pass/);
		const failMatch = output.match(/(\d+) fail/);

		const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
		const failed = failMatch ? parseInt(failMatch[1], 10) : 1;
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
async function executeCheck(options = {}) {
	const { skip = [], verbose = false, continueOnError = true } = options || {};

	const checks = {};
	const failedChecks = [];
	const errors = [];
	const startTime = Date.now();

	// 1. Type checking
	if (!skip.includes('typeCheck')) {
		try {
			checks.typeCheck = await runTypeCheck();
			if (!checks.typeCheck.success && !checks.typeCheck.skipped) {
				failedChecks.push('typeCheck');
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
	if (!skip.includes('lint')) {
		try {
			checks.lint = await runLint();
			if (!checks.lint.success) {
				failedChecks.push('lint');
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
	if (!skip.includes('security')) {
		try {
			checks.security = await runSecurityScan();
			if (!checks.security.success && !checks.security.skipped) {
				failedChecks.push('security');
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
	if (!skip.includes('tests')) {
		try {
			checks.tests = await runAllTests();
			if (!checks.tests.success) {
				failedChecks.push('tests');
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

	// Build summary
	const checkResults = [];
	if (checks.typeCheck) {
		const status = checks.typeCheck.skipped ? 'SKIPPED' : (checks.typeCheck.success ? 'PASS' : 'FAIL');
		checkResults.push(`Type: ${status}`);
	}
	if (checks.lint) {
		const status = checks.lint.success ? 'PASS' : 'FAIL';
		checkResults.push(`Lint: ${status}`);
	}
	if (checks.security) {
		const status = checks.security.skipped ? 'SKIPPED' : (checks.security.success ? 'PASS' : 'FAIL');
		checkResults.push(`Security: ${status}`);
	}
	if (checks.tests) {
		const status = checks.tests.success ? 'PASS' : 'FAIL';
		checkResults.push(`Tests: ${status}`);
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
