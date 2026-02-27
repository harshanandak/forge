const { describe, test, expect } = require('bun:test');
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
			expect(phase).toBe('RED');
		});

		test('should detect GREEN phase (tests failing, implementation exists)', () => {
			const context = {
				sourceFiles: ['lib/feature.js'],
				testFiles: ['test/feature.test.js'],
				testsPassing: false,
			};

			const phase = detectTDDPhase(context);
			expect(phase).toBe('GREEN');
		});

		test('should detect REFACTOR phase (tests passing)', () => {
			const context = {
				sourceFiles: ['lib/feature.js'],
				testFiles: ['test/feature.test.js'],
				testsPassing: true,
			};

			const phase = detectTDDPhase(context);
			expect(phase).toBe('REFACTOR');
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
			expect(pairs.length).toBe(1);
			expect(pairs.pairs[0].source).toBe('lib/commands/status.js');
			expect(pairs.pairs[0].test).toBe('test/commands/status.test.js');
		});

		test('should detect orphaned test files (no implementation)', () => {
			const files = [
				'test/commands/feature.test.js',
			];

			const result = identifyFilePairs(files);
			expect(result.orphanedTests).toBeTruthy();
			expect(result.orphanedTests.length).toBe(1);
		});

		test('should detect orphaned source files (no tests)', () => {
			const files = [
				'lib/commands/feature.js',
			];

			const result = identifyFilePairs(files);
			expect(result.orphanedSources).toBeTruthy();
			expect(result.orphanedSources.length).toBe(1);
		});
	});

	describe('Test execution', () => {
		test.skip('should run tests and return results', async () => {
			const testFile = 'test/commands/status.test.js';

			const result = await runTests(testFile);
			expect(result.passed !== undefined).toBeTruthy();
			expect(result.failed !== undefined).toBeTruthy();
			expect(result.duration).toBeTruthy();
		});

		test('should handle test execution failures', async () => {
			const testFile = 'test/nonexistent.test.js';

			const result = await runTests(testFile);
			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
		});

		test.skip('should run all tests when no file specified', async () => {
			const result = await runTests();
			expect(result.totalTests > 0).toBeTruthy();
			expect(result.passed !== undefined).toBeTruthy();
		});
	});

	describe('TDD guidance', () => {
		test('should provide RED phase guidance', () => {
			const phase = 'RED';

			const guidance = getTDDGuidance(phase);
			expect(guidance).toMatch(/write.*test/i);
			expect(guidance).toMatch(/fail/i);
		});

		test('should provide GREEN phase guidance', () => {
			const phase = 'GREEN';

			const guidance = getTDDGuidance(phase);
			expect(guidance).toMatch(/implement/i);
			expect(guidance).toMatch(/pass.*test/i);
		});

		test('should provide REFACTOR phase guidance', () => {
			const phase = 'REFACTOR';

			const guidance = getTDDGuidance(phase);
			expect(guidance).toMatch(/improve/i);
			expect(guidance).toMatch(/maintain.*pass/i);
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
			expect(message).toMatch(/test:/);
			expect(message).toMatch(/RED/i);
			expect(message.includes('15')).toBeTruthy();
		});

		test('should generate GREEN phase commit message', () => {
			const context = {
				phase: 'GREEN',
				files: ['lib/commands/feature.js'],
				feature: 'Feature Command',
			};

			const message = generateCommitMessage(context);
			expect(message).toMatch(/feat:|implement/i);
			expect(message).toMatch(/GREEN/i);
		});

		test('should generate REFACTOR phase commit message', () => {
			const context = {
				phase: 'REFACTOR',
				files: ['lib/commands/feature.js'],
				improvements: ['Extract helper', 'Add validation'],
			};

			const message = generateCommitMessage(context);
			expect(message).toMatch(/refactor:/i);
			expect(message).toMatch(/REFACTOR/i);
		});
	});

	describe('Command execution', () => {
		test.skip('should execute full RED cycle', async () => {
			const featureName = 'test-feature';

			const result = await executeDev(featureName, { phase: 'RED' });
			expect(result.success).toBe(true);
			expect(result.phase).toBe('RED');
			expect(result.guidance).toBeTruthy();
			expect(result.nextPhase === 'GREEN').toBeTruthy();
		});

		test.skip('should execute full GREEN cycle', async () => {
			const featureName = 'test-feature';

			const result = await executeDev(featureName, { phase: 'GREEN' });
			expect(result.success).toBe(true);
			expect(result.phase).toBe('GREEN');
			expect(result.testResults).toBeTruthy();
		});

		test.skip('should execute full REFACTOR cycle', async () => {
			const featureName = 'test-feature';

			const result = await executeDev(featureName, { phase: 'REFACTOR' });
			expect(result.success).toBe(true);
			expect(result.phase).toBe('REFACTOR');
			expect(result.summary).toBeTruthy();
		});

		test('should auto-detect phase when not specified', async () => {
			const featureName = 'test-feature';

			const result = await executeDev(featureName);
			expect(result.detectedPhase).toBeTruthy();
			expect(['RED', 'GREEN', 'REFACTOR'].includes(result.detectedPhase)).toBeTruthy();
		});

		test('should validate tests pass before allowing REFACTOR', async () => {
			const result = await executeDev('feature', { phase: 'REFACTOR', testsPassing: false });
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/tests.*fail/i);
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
			expect(parallel.length).toBe(2); // a and b can be done in parallel
			expect(parallel.includes('feature-a')).toBeTruthy();
			expect(parallel.includes('feature-b')).toBeTruthy();
		});

		test('should handle circular dependencies', () => {
			const features = [
				{ name: 'feature-a', files: ['lib/a.js'], dependencies: ['feature-b'] },
				{ name: 'feature-b', files: ['lib/b.js'], dependencies: ['feature-a'] },
			];

			const result = identifyParallelWork(features);
			expect(result.error).toBeTruthy();
			expect(result.error).toMatch(/circular/i);
		});
	});
});
