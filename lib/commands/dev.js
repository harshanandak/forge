/**
 * Dev Command - TDD Cycle Management
 * Guides developers through RED-GREEN-REFACTOR cycles
 *
 * Security: Uses execFileSync for test execution to prevent command injection
 * TDD Discipline: Enforces test-first development and validates phase transitions
 *
 * @module commands/dev
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Constants for security
const EXEC_OPTIONS = {
	encoding: 'utf8',
	cwd: process.cwd(),
	timeout: 120000, // 2 minutes max per command
};

/**
 * Detect current TDD phase based on project context
 *
 * Detection logic:
 * - RED: Tests exist, no implementation OR implementation exists but tests failing
 * - GREEN: Implementation exists, tests failing
 * - REFACTOR: Implementation exists, tests passing
 *
 * @param {{sourceFiles: string[], testFiles: string[], testsPassing?: boolean}} context - Project context
 * @returns {'RED'|'GREEN'|'REFACTOR'} Current TDD phase
 * @example
 * const phase = detectTDDPhase({ sourceFiles: ['lib/feature.js'], testFiles: ['test/feature.test.js'], testsPassing: true });
 * console.log(phase); // 'REFACTOR'
 */
function detectTDDPhase(context) {
	const { sourceFiles = [], testFiles = [], testsPassing } = context;

	const hasTests = testFiles.length > 0;
	const hasImplementation = sourceFiles.length > 0;

	// RED: Tests exist but no implementation, or tests are failing
	if (hasTests && !hasImplementation) {
		return 'RED';
	}

	// GREEN: Tests failing with implementation
	if (hasTests && hasImplementation && testsPassing === false) {
		return 'GREEN';
	}

	// REFACTOR: Tests passing
	if (hasTests && hasImplementation && testsPassing === true) {
		return 'REFACTOR';
	}

	// Default to RED (write tests first)
	return 'RED';
}

/**
 * Identify source and test file pairs
 * Maps source files to their corresponding test files
 *
 * Conventions:
 * - lib/commands/feature.js → test/commands/feature.test.js
 * - src/utils/helper.js → test/utils/helper.test.js
 *
 * @param {string[]} files - List of file paths
 * @returns {{length: number, pairs?: Array<{source: string, test: string}>, orphanedTests?: string[], orphanedSources?: string[]}} File pair analysis
 * @example
 * const result = identifyFilePairs(['lib/feature.js', 'test/feature.test.js']);
 * console.log(result.pairs); // [{ source: 'lib/feature.js', test: 'test/feature.test.js' }]
 */
function identifyFilePairs(files) {
	const testFiles = files.filter(f => f.includes('test') && f.endsWith('.test.js'));
	const sourceFiles = files.filter(f => !f.includes('test') && f.endsWith('.js'));

	const pairs = [];
	const orphanedTests = [];
	const orphanedSources = [];

	// Match test files to source files
	testFiles.forEach(testFile => {
		// Convert test/commands/feature.test.js → lib/commands/feature.js
		const sourceFile = testFile
			.replace(/^test\//, 'lib/')
			.replace(/\.test\.js$/, '.js');

		if (sourceFiles.includes(sourceFile)) {
			pairs.push({ source: sourceFile, test: testFile });
		} else {
			orphanedTests.push(testFile);
		}
	});

	// Find source files without tests
	sourceFiles.forEach(sourceFile => {
		const testFile = sourceFile
			.replace(/^(lib|src)\//, 'test/')
			.replace(/\.js$/, '.test.js');

		if (!testFiles.includes(testFile)) {
			orphanedSources.push(sourceFile);
		}
	});

	return {
		length: pairs.length,
		pairs: pairs.length > 0 ? pairs : undefined,
		orphanedTests: orphanedTests.length > 0 ? orphanedTests : undefined,
		orphanedSources: orphanedSources.length > 0 ? orphanedSources : undefined,
	};
}

/**
 * Run tests using bun test
 * Executes specified test file or all tests
 *
 * @param {string} [testFile] - Optional specific test file to run
 * @returns {Promise<{success: boolean, passed?: number, failed?: number, duration?: number, totalTests?: number, error?: string}>} Test execution result
 * @example
 * const result = await runTests('test/commands/feature.test.js');
 * console.log(`${result.passed}/${result.passed + result.failed} tests passed`);
 */
async function runTests(testFile) {
	try {
		const args = ['test'];
		if (testFile) {
			// Check if test file exists
			if (!fs.existsSync(testFile)) {
				return {
					success: false,
					error: `Test file not found: ${testFile}\n\nEnsure the file exists and path is correct.`,
				};
			}
			args.push(testFile);
		}

		const startTime = Date.now();
		const result = execFileSync('bun', args, EXEC_OPTIONS);
		const duration = Date.now() - startTime;

		// Parse bun test output
		// Format: "X pass\nY fail\nRan Z tests"
		const passMatch = result.match(/(\d+) pass/);
		const failMatch = result.match(/(\d+) fail/);
		const totalMatch = result.match(/Ran (\d+) tests/);

		const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
		const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
		const totalTests = totalMatch ? parseInt(totalMatch[1], 10) : passed + failed;

		return {
			success: true,
			passed,
			failed,
			totalTests,
			duration,
		};
	} catch (error) {
		// Check for timeout
		if (error.killed && error.signal === 'SIGTERM') {
			return {
				success: false,
				error: 'Test execution timed out after 2 minutes',
			};
		}

		// Test execution failed (either command failed or tests failed)
		const bunNotFound = error.message.includes('ENOENT') || error.message.includes('not found');
		const errorMsg = bunNotFound
			? 'bun command not found. Ensure bun is installed and in PATH'
			: `Test execution failed: ${error.message}`;

		return {
			success: false,
			error: errorMsg,
		};
	}
}

/**
 * Get phase-specific TDD guidance
 * Provides actionable guidance for each TDD phase
 *
 * @param {'RED'|'GREEN'|'REFACTOR'} phase - Current TDD phase
 * @returns {string} Phase-specific guidance
 * @example
 * const guidance = getTDDGuidance('RED');
 * console.log(guidance); // "RED Phase: Write a failing test..."
 */
function getTDDGuidance(phase) {
	const guidance = {
		RED: `RED Phase: Write a failing test

1. Write test BEFORE implementation
2. Test should fail (red)
3. Verify test fails for the right reason
4. Commit with "test: ..." message

Next: GREEN phase (implement to make test pass)`,

		GREEN: `GREEN Phase: Make the test pass

1. Write MINIMAL code to pass the test
2. Don't worry about perfection
3. Focus on making tests green
4. Commit with "feat: ..." or "implement: ..." message

Next: REFACTOR phase (improve code quality)`,

		REFACTOR: `REFACTOR Phase: Improve code quality

1. Maintain passing tests throughout refactoring
2. Extract duplicates, improve names, add docs
3. Run tests frequently while refactoring
4. Commit with "refactor: ..." message

Next: RED phase (next feature) or done`,
	};

	return guidance[phase] || 'Unknown phase';
}

/**
 * Generate commit message for TDD phase
 * Creates standardized commit messages for each phase
 *
 * @param {{phase: 'RED'|'GREEN'|'REFACTOR', files: string[], testCount?: number, feature?: string, improvements?: string[]}} context - Commit context
 * @returns {string} Generated commit message
 * @example
 * const message = generateCommitMessage({ phase: 'RED', files: ['test/feature.test.js'], testCount: 15 });
 * console.log(message); // "test: add feature tests (RED)\n\n15 tests written"
 */
function generateCommitMessage(context) {
	const { phase, files, testCount, feature, improvements } = context;

	if (phase === 'RED') {
		const fileNames = files.map(f => path.basename(f)).join(', ');
		return `test: add ${feature || 'feature'} tests (RED)

${testCount || files.length} tests written
Files: ${fileNames}

Tests are failing as expected (RED phase)`;
	}

	if (phase === 'GREEN') {
		const fileNames = files.map(f => path.basename(f)).join(', ');
		return `feat: implement ${feature || 'feature'} (GREEN)

Implementation complete, tests passing
Files: ${fileNames}

GREEN phase complete`;
	}

	if (phase === 'REFACTOR') {
		const improvementList = improvements && improvements.length > 0
			? '\n\n' + improvements.map(i => `- ${i}`).join('\n')
			: '';
		return `refactor: improve ${feature || 'code'} (REFACTOR)${improvementList}

Code quality improvements while maintaining test coverage
Tests remain green throughout refactoring`;
	}

	return `${phase}: ${feature || 'changes'}`;
}

/**
 * Identify independent features that can be worked on in parallel
 * Analyzes dependencies to find parallelizable work
 *
 * @param {Array<{name: string, files: string[], dependencies: string[]}>} features - Feature list with dependencies
 * @returns {{length: number, includes?: (name: string) => boolean, error?: string} | string[]} Parallel-safe features or error
 * @example
 * const parallel = identifyParallelWork([
 *   { name: 'feature-a', files: ['lib/a.js'], dependencies: [] },
 *   { name: 'feature-b', files: ['lib/b.js'], dependencies: [] }
 * ]);
 * console.log(parallel); // ['feature-a', 'feature-b']
 */
function identifyParallelWork(features) {
	// Check for circular dependencies
	const visited = new Set();
	const recStack = new Set();

	function hasCycle(feature) {
		if (!visited.has(feature.name)) {
			visited.add(feature.name);
			recStack.add(feature.name);

			for (const dep of feature.dependencies) {
				const depFeature = features.find(f => f.name === dep);
				if (depFeature) {
					if (!visited.has(dep) && hasCycle(depFeature)) {
						return true;
					} else if (recStack.has(dep)) {
						return true;
					}
				}
			}
		}
		recStack.delete(feature.name);
		return false;
	}

	// Check for circular dependencies
	for (const feature of features) {
		if (hasCycle(feature)) {
			return {
				error: 'Circular dependency detected in features',
			};
		}
	}

	// Find features with no dependencies
	const parallelFeatures = features
		.filter(f => f.dependencies.length === 0)
		.map(f => f.name);

	return parallelFeatures;
}

/**
 * Execute dev command workflow
 * Main orchestrator for TDD development
 *
 * @param {string} featureName - Feature name
 * @param {{phase?: 'RED'|'GREEN'|'REFACTOR', testsPassing?: boolean}} [options] - Execution options
 * @returns {Promise<{success: boolean, phase?: string, detectedPhase?: string, guidance?: string, testResults?: object, summary?: string, nextPhase?: string, error?: string}>} Execution result
 * @example
 * const result = await executeDev('payment-integration', { phase: 'RED' });
 * console.log(result.guidance);
 */
async function executeDev(featureName, options = {}) {
	if (!featureName || typeof featureName !== 'string') {
		return {
			success: false,
			error: 'Feature name is required and must be a string',
		};
	}

	const { phase, testsPassing } = options;

	try {
		// If no phase specified, auto-detect
		let currentPhase = phase;
		if (!currentPhase) {
			// Analyze project to detect phase
			const sourceFiles = []; // Would scan lib/ directory
			const testFiles = []; // Would scan test/ directory
			currentPhase = detectTDDPhase({ sourceFiles, testFiles, testsPassing });

			return {
				success: true,
				detectedPhase: currentPhase,
				guidance: getTDDGuidance(currentPhase),
				summary: `Auto-detected ${currentPhase} phase`,
			};
		}

		// Validate REFACTOR requires passing tests
		if (phase === 'REFACTOR' && testsPassing === false) {
			return {
				success: false,
				error: 'Cannot proceed to REFACTOR phase: tests are failing. Complete GREEN phase first.',
			};
		}

		// Execute based on phase
		const result = {
			success: true,
			phase: currentPhase,
			guidance: getTDDGuidance(currentPhase),
		};

		if (currentPhase === 'RED') {
			result.nextPhase = 'GREEN';
			result.summary = 'Write failing tests for the feature';
		}

		if (currentPhase === 'GREEN') {
			// Run tests to check status
			const testResults = await runTests();
			result.testResults = testResults;
			result.summary = 'Implement feature to make tests pass';
		}

		if (currentPhase === 'REFACTOR') {
			result.summary = 'Improve code quality while keeping tests green';
		}

		return result;
	} catch (error) {
		return {
			success: false,
			error: `Failed to execute dev command: ${error.message}`,
		};
	}
}

module.exports = {
	detectTDDPhase,
	identifyFilePairs,
	runTests,
	getTDDGuidance,
	generateCommitMessage,
	identifyParallelWork,
	executeDev,
};
