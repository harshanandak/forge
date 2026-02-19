const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
	detectTDDPhase,
	identifyFilePairs,
	runTests,
	getTDDGuidance,
	generateCommitMessage,
	identifyParallelWork,
	executeDev,
} = require('../../lib/commands/dev.js');

describe('Dev Command - TDD Cycle Management', () => {
	describe('TDD phase detection', () => {
		test('should detect RED phase (no implementation, tests exist)', () => {
			const context = {
				sourceFiles: [],
				testFiles: ['test/feature.test.js'],
			};

			const phase = detectTDDPhase(context);
			assert.strictEqual(phase, 'RED');
		});

		test('should detect GREEN phase (tests failing, implementation exists)', () => {
			const context = {
				sourceFiles: ['lib/feature.js'],
				testFiles: ['test/feature.test.js'],
				testsPassing: false,
			};

			const phase = detectTDDPhase(context);
			assert.strictEqual(phase, 'GREEN');
		});

		test('should detect REFACTOR phase (tests passing)', () => {
			const context = {
				sourceFiles: ['lib/feature.js'],
				testFiles: ['test/feature.test.js'],
				testsPassing: true,
			};

			const phase = detectTDDPhase(context);
			assert.strictEqual(phase, 'REFACTOR');
		});
	});

	describe('File analysis', () => {
		test('should identify source and test file pairs', () => {
			const files = [
				'lib/commands/status.js',
				'test/commands/status.test.js',
				'lib/utils/helper.js',
			];

			const pairs = identifyFilePairs(files);
			assert.strictEqual(pairs.length, 1);
			assert.strictEqual(pairs.pairs[0].source, 'lib/commands/status.js');
			assert.strictEqual(pairs.pairs[0].test, 'test/commands/status.test.js');
		});

		test('should detect orphaned test files (no implementation)', () => {
			const files = [
				'test/commands/feature.test.js',
			];

			const result = identifyFilePairs(files);
			assert.ok(result.orphanedTests);
			assert.strictEqual(result.orphanedTests.length, 1);
		});

		test('should detect orphaned source files (no tests)', () => {
			const files = [
				'lib/commands/feature.js',
			];

			const result = identifyFilePairs(files);
			assert.ok(result.orphanedSources);
			assert.strictEqual(result.orphanedSources.length, 1);
		});
	});

	describe('Test execution', () => {
		test.skip('should run tests and return results', async () => {
			const testFile = 'test/commands/status.test.js';

			const result = await runTests(testFile);
			assert.ok(result.passed !== undefined);
			assert.ok(result.failed !== undefined);
			assert.ok(result.duration);
		});

		test('should handle test execution failures', async () => {
			const testFile = 'test/nonexistent.test.js';

			const result = await runTests(testFile);
			assert.strictEqual(result.success, false);
			assert.ok(result.error);
		});

		test.skip('should run all tests when no file specified', async () => {
			const result = await runTests();
			assert.ok(result.totalTests > 0);
			assert.ok(result.passed !== undefined);
		});
	});

	describe('TDD guidance', () => {
		test('should provide RED phase guidance', () => {
			const phase = 'RED';

			const guidance = getTDDGuidance(phase);
			assert.match(guidance, /write.*test/i);
			assert.match(guidance, /fail/i);
		});

		test('should provide GREEN phase guidance', () => {
			const phase = 'GREEN';

			const guidance = getTDDGuidance(phase);
			assert.match(guidance, /implement/i);
			assert.match(guidance, /pass.*test/i);
		});

		test('should provide REFACTOR phase guidance', () => {
			const phase = 'REFACTOR';

			const guidance = getTDDGuidance(phase);
			assert.match(guidance, /improve/i);
			assert.match(guidance, /maintain.*pass/i);
		});
	});

	describe('Commit message generation', () => {
		test('should generate RED phase commit message', () => {
			const context = {
				phase: 'RED',
				files: ['test/commands/feature.test.js'],
				testCount: 15,
			};

			const message = generateCommitMessage(context);
			assert.match(message, /test:/);
			assert.match(message, /RED/i);
			assert.ok(message.includes('15'));
		});

		test('should generate GREEN phase commit message', () => {
			const context = {
				phase: 'GREEN',
				files: ['lib/commands/feature.js'],
				feature: 'Feature Command',
			};

			const message = generateCommitMessage(context);
			assert.match(message, /feat:|implement/i);
			assert.match(message, /GREEN/i);
		});

		test('should generate REFACTOR phase commit message', () => {
			const context = {
				phase: 'REFACTOR',
				files: ['lib/commands/feature.js'],
				improvements: ['Extract helper', 'Add validation'],
			};

			const message = generateCommitMessage(context);
			assert.match(message, /refactor:/i);
			assert.match(message, /REFACTOR/i);
		});
	});

	describe('Command execution', () => {
		test.skip('should execute full RED cycle', async () => {
			const featureName = 'test-feature';

			const result = await executeDev(featureName, { phase: 'RED' });
			assert.strictEqual(result.success, true);
			assert.strictEqual(result.phase, 'RED');
			assert.ok(result.guidance);
			assert.ok(result.nextPhase === 'GREEN');
		});

		test.skip('should execute full GREEN cycle', async () => {
			const featureName = 'test-feature';

			const result = await executeDev(featureName, { phase: 'GREEN' });
			assert.strictEqual(result.success, true);
			assert.strictEqual(result.phase, 'GREEN');
			assert.ok(result.testResults);
		});

		test.skip('should execute full REFACTOR cycle', async () => {
			const featureName = 'test-feature';

			const result = await executeDev(featureName, { phase: 'REFACTOR' });
			assert.strictEqual(result.success, true);
			assert.strictEqual(result.phase, 'REFACTOR');
			assert.ok(result.summary);
		});

		test('should auto-detect phase when not specified', async () => {
			const featureName = 'test-feature';

			const result = await executeDev(featureName);
			assert.ok(result.detectedPhase);
			assert.ok(['RED', 'GREEN', 'REFACTOR'].includes(result.detectedPhase));
		});

		test('should validate tests pass before allowing REFACTOR', async () => {
			const result = await executeDev('feature', { phase: 'REFACTOR', testsPassing: false });
			assert.strictEqual(result.success, false);
			assert.match(result.error, /tests.*fail/i);
		});
	});

	describe('Parallel development support', () => {
		test('should identify independent features for parallel work', () => {
			const features = [
				{ name: 'feature-a', files: ['lib/a.js'], dependencies: [] },
				{ name: 'feature-b', files: ['lib/b.js'], dependencies: [] },
				{ name: 'feature-c', files: ['lib/c.js'], dependencies: ['feature-a'] },
			];

			const parallel = identifyParallelWork(features);
			assert.strictEqual(parallel.length, 2); // a and b can be done in parallel
			assert.ok(parallel.includes('feature-a'));
			assert.ok(parallel.includes('feature-b'));
		});

		test('should handle circular dependencies', () => {
			const features = [
				{ name: 'feature-a', files: ['lib/a.js'], dependencies: ['feature-b'] },
				{ name: 'feature-b', files: ['lib/b.js'], dependencies: ['feature-a'] },
			];

			const result = identifyParallelWork(features);
			assert.ok(result.error);
			assert.match(result.error, /circular/i);
		});
	});
});
