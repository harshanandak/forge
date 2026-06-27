const { describe, test, expect } = require('bun:test');
const {
	handler,
	detectTDDPhase,
	identifyFilePairs,
	runTests,
	getTDDGuidance,
	generateCommitMessage,
	identifyParallelWork,
	executeDev,
	emitImplementerAuditEvidence,
	emitSpecReviewerAuditEvidence,
	emitQualityReviewerAuditEvidence,
	calculateDecisionRoute,
	DECISION_ROUTES,
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

		test('records audit evidence when enabled during dev execution', async () => {
			const commands = [];
			const runCommand = (cmd, args) => {
				commands.push({ cmd, args });
				return JSON.stringify({ id: 'int-record' });
			};

			const result = await executeDev('audit-feature', {
				phase: 'RED',
				audit: true,
				auditOptions: {
					runCommand,
					metaJsonSupported: true,
				},
			});

			expect(result.success).toBe(true);
			expect(result.auditEvidence.record.entryId).toBe('int-record');
			expect(commands.length).toBe(1);
			expect(commands[0].cmd).toBe('bd');
			expect(commands[0].args).toContain('record');
			expect(commands[0].args).toContain('llm_call');
		});

		test('fails dev execution when audit evidence persistence fails', async () => {
			const result = await executeDev('audit-feature', {
				phase: 'RED',
				audit: true,
				auditOptions: {
					runCommand: () => 'missing-json-id',
					metaJsonSupported: true,
				},
			});

			expect(result.success).toBe(false);
			expect(result.error).toMatch(/Audit evidence persistence failed/);
			expect(result.auditEvidence.record.success).toBe(false);
			expect(result.auditEvidence.record.entryId).toBe(null);
		});

		test('keeps dev execution successful when audit command is unavailable', async () => {
			const missingBd = new Error('bd not found');
			missingBd.code = 'ENOENT';

			const result = await executeDev('audit-feature', {
				phase: 'RED',
				audit: true,
				auditOptions: {
					runCommand: () => {
						throw missingBd;
					},
				},
			});

			expect(result.success).toBe(true);
			expect(result.auditEvidence.success).toBe(false);
			expect(result.auditEvidence.skipped).toBe(true);
			expect(result.auditEvidence.error).toBe('bd not found');
		});

		test('records failed GREEN audit evidence with the concrete error response', async () => {
			const commands = [];
			const runCommand = (cmd, args) => {
				commands.push({ cmd, args });
				return JSON.stringify({ id: 'int-record' });
			};

			const result = await executeDev('audit-feature', {
				phase: 'GREEN',
				audit: true,
				runTests: async () => ({ success: false, error: 'unit tests failed hard' }),
				auditOptions: {
					runCommand,
					metaJsonSupported: true,
				},
			});

			const responseIndex = commands[0].args.indexOf('--response');
			const response = JSON.parse(commands[0].args[responseIndex + 1]);
			expect(result.success).toBe(false);
			expect(response.content).toBe('unit tests failed hard');
		});

		test('handler parses issue-id flags before emitting audit evidence', async () => {
			const commands = [];
			const runCommand = (cmd, args) => {
				commands.push({ cmd, args });
				return JSON.stringify({ id: 'int-record' });
			};

			const result = await handler(['audit-feature', '--issue-id', 'forge-besw.20', 'RED'], {
				auditOptions: {
					runCommand,
					metaJsonSupported: true,
				},
			});

			expect(result.success).toBe(true);
			expect(result.phase).toBe('RED');
			expect(commands[0].args).toContain('--issue-id');
			expect(commands[0].args).toContain('forge-besw.20');
			const promptIndex = commands[0].args.indexOf('--prompt');
			expect(JSON.parse(commands[0].args[promptIndex + 1]).content).toBe('forge dev audit-feature RED');
		});

		test('handler parses issue-id equals flags before emitting audit evidence', async () => {
			const commands = [];
			const runCommand = (cmd, args) => {
				commands.push({ cmd, args });
				return JSON.stringify({ id: 'int-record' });
			};

			const result = await handler(['audit-feature', '--issue-id=forge-besw.20', 'RED'], {
				auditOptions: {
					runCommand,
					metaJsonSupported: true,
				},
			});

			expect(result.success).toBe(true);
			expect(result.phase).toBe('RED');
			expect(commands[0].args).toContain('--issue-id');
			expect(commands[0].args).toContain('forge-besw.20');
			const promptIndex = commands[0].args.indexOf('--prompt');
			expect(JSON.parse(commands[0].args[promptIndex + 1]).content).toBe('forge dev audit-feature RED');
		});

		test('handler rejects missing issue-id and phase flag values', async () => {
			const missingIssueId = await handler(['audit-feature', '--issue-id'], {});
			const missingIssueIdBeforeFlag = await handler(['audit-feature', '--issue-id', '--phase', 'RED'], {});
			const missingIssueIdEquals = await handler(['audit-feature', '--issue-id=', 'RED'], {});
			const missingPhase = await handler(['audit-feature', '--phase'], {});
			const missingPhaseBeforeFlag = await handler(['audit-feature', '--phase', '--issue-id', 'forge-besw.20'], {});
			const missingPhaseEquals = await handler(['audit-feature', '--phase='], {});

			expect(missingIssueId).toEqual({ success: false, error: '--issue-id requires a value' });
			expect(missingIssueIdBeforeFlag).toEqual({ success: false, error: '--issue-id requires a value' });
			expect(missingIssueIdEquals).toEqual({ success: false, error: '--issue-id requires a value' });
			expect(missingPhase).toEqual({ success: false, error: '--phase requires a value' });
			expect(missingPhaseBeforeFlag).toEqual({ success: false, error: '--phase requires a value' });
			expect(missingPhaseEquals).toEqual({ success: false, error: '--phase requires a value' });
		});

		test('should validate tests pass before allowing REFACTOR', async () => {
			const result = await executeDev('feature', { phase: 'REFACTOR', testsPassing: false });
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/tests.*fail/i);
		});

		test('records audit evidence when REFACTOR is blocked by failing tests', async () => {
			const commands = [];
			const result = await executeDev('feature', {
				phase: 'REFACTOR',
				testsPassing: false,
				audit: true,
				auditOptions: {
					runCommand: (cmd, args) => {
						commands.push({ cmd, args });
						return JSON.stringify({ id: 'int-record' });
					},
					metaJsonSupported: true,
				},
			});

			expect(result.success).toBe(false);
			expect(result.auditEvidence.record.entryId).toBe('int-record');
			expect(commands.length).toBe(1);
			expect(commands[0].args).toContain('record');
			const responseIndex = commands[0].args.indexOf('--response');
			const response = JSON.parse(commands[0].args[responseIndex + 1]);
			expect(response.verdict).toBe('FAIL');
			expect(response.content).toMatch(/Cannot proceed to REFACTOR phase/);
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

	describe('dev.md task completion HARD-GATE', () => {
		test('task completion gate should require fresh verification evidence', () => {
			const fs = require('fs');
			const path = require('path');
			const devMdPath = path.join(__dirname, '../../skills/dev/SKILL.md');
			const content = fs.readFileSync(devMdPath, 'utf8');

			// Find the section between <HARD-GATE: task completion> and </HARD-GATE>
			const gateStart = content.indexOf('<HARD-GATE: task completion>');
			const gateEnd = content.indexOf('</HARD-GATE>', gateStart);
			expect(gateStart).not.toBe(-1);
			expect(gateEnd).not.toBe(-1);
			const gateText = content.slice(gateStart, gateEnd + '</HARD-GATE>'.length);

			// Must require fresh verification
			expect(gateText).toMatch(/fresh/i);
			// Must require actual output
			expect(gateText).toMatch(/actual output/i);
			// Must list forbidden phrases
			expect(gateText).toMatch(/should pass/i);
			expect(gateText).toMatch(/looks good/i);
			expect(gateText).toMatch(/seems to work/i);
		});
	});

	describe('Decision gate scoring and routing', () => {
		describe('DECISION_ROUTES constants', () => {
			test('should export PROCEED route constant', () => {
				expect(DECISION_ROUTES).toBeTruthy();
				expect(DECISION_ROUTES.PROCEED).toBe('PROCEED');
			});

			test('should export SPEC_REVIEWER route constant', () => {
				expect(DECISION_ROUTES.SPEC_REVIEWER).toBe('SPEC-REVIEWER');
			});

			test('should export BLOCKED route constant', () => {
				expect(DECISION_ROUTES.BLOCKED).toBe('BLOCKED');
			});
		});

		describe('score-based routing', () => {
			test('score 0 routes to PROCEED', () => {
				const result = calculateDecisionRoute(0, [0, 0, 0, 0, 0, 0, 0]);
				expect(result.route).toBe('PROCEED');
			});

			test('score 1 routes to PROCEED', () => {
				const result = calculateDecisionRoute(1, [1, 0, 0, 0, 0, 0, 0]);
				expect(result.route).toBe('PROCEED');
			});

			test('score 3 routes to PROCEED (upper boundary)', () => {
				const result = calculateDecisionRoute(3, [1, 1, 1, 0, 0, 0, 0]);
				expect(result.route).toBe('PROCEED');
			});

			test('score 4 routes to SPEC-REVIEWER (lower boundary)', () => {
				const result = calculateDecisionRoute(4, [1, 1, 1, 1, 0, 0, 0]);
				expect(result.route).toBe('SPEC-REVIEWER');
			});

			test('score 5 routes to SPEC-REVIEWER', () => {
				const result = calculateDecisionRoute(5, [1, 1, 1, 1, 1, 0, 0]);
				expect(result.route).toBe('SPEC-REVIEWER');
			});

			test('score 7 routes to SPEC-REVIEWER (upper boundary)', () => {
				const result = calculateDecisionRoute(7, [1, 1, 1, 1, 1, 1, 1]);
				expect(result.route).toBe('SPEC-REVIEWER');
			});

			test('score 8 routes to BLOCKED (lower boundary)', () => {
				const result = calculateDecisionRoute(8, [2, 2, 2, 2, 0, 0, 0]);
				expect(result.route).toBe('BLOCKED');
			});

			test('score 14 routes to BLOCKED (maximum score)', () => {
				const result = calculateDecisionRoute(14, [2, 2, 2, 2, 2, 2, 2]);
				expect(result.route).toBe('BLOCKED');
			});
		});

		describe('security dimension mandatory override', () => {
			test('security dimension (6) scored 2 overrides low total to BLOCKED', () => {
				// Total score is 2 (which would normally be PROCEED), but dimension 6 (index 5) = 2
				const result = calculateDecisionRoute(2, [0, 0, 0, 0, 0, 2, 0]);
				expect(result.route).toBe('BLOCKED');
				expect(result.mandatoryOverride).toBe(true);
			});

			test('security dimension (6) scored 2 overrides SPEC-REVIEWER range to BLOCKED', () => {
				// Total score is 6 (SPEC-REVIEWER range), but security dimension = 2
				const result = calculateDecisionRoute(6, [1, 1, 1, 1, 0, 2, 0]);
				expect(result.route).toBe('BLOCKED');
				expect(result.mandatoryOverride).toBe(true);
			});

			test('security dimension scored 0 does not trigger override', () => {
				// Score 2 with security = 0 should PROCEED normally
				const result = calculateDecisionRoute(2, [1, 1, 0, 0, 0, 0, 0]);
				expect(result.route).toBe('PROCEED');
				expect(result.mandatoryOverride).toBeFalsy();
			});

			test('security dimension scored 1 does not trigger override', () => {
				// Score 3 with security = 1 should PROCEED normally (no mandatory override for score 1)
				const result = calculateDecisionRoute(3, [1, 1, 0, 0, 0, 1, 0]);
				expect(result.route).toBe('PROCEED');
				expect(result.mandatoryOverride).toBeFalsy();
			});
		});

		describe('result shape', () => {
			test('PROCEED result includes route and score', () => {
				const result = calculateDecisionRoute(2, [1, 1, 0, 0, 0, 0, 0]);
				expect(result.route).toBe('PROCEED');
				expect(result.score).toBe(2);
			});

			test('BLOCKED result from score includes mandatoryOverride as falsy', () => {
				const result = calculateDecisionRoute(9, [2, 2, 2, 1, 1, 0, 1]);
				expect(result.route).toBe('BLOCKED');
				expect(result.mandatoryOverride).toBeFalsy();
			});

			test('BLOCKED result from security override includes mandatoryOverride true', () => {
				const result = calculateDecisionRoute(2, [0, 0, 0, 0, 0, 2, 0]);
				expect(result.route).toBe('BLOCKED');
				expect(result.mandatoryOverride).toBe(true);
			});
		});
	});

	describe('/dev audit evidence helpers', () => {
		function createRunner() {
			const commands = [];
			return {
				commands,
				runCommand: (cmd, args) => {
					commands.push({ cmd, args });
					return JSON.stringify({ id: commands.length === 1 ? 'int-record' : 'int-label' });
				},
			};
		}

		test('emits implementer evidence through bd audit record', () => {
			const runner = createRunner();
			const result = emitImplementerAuditEvidence({
				issueId: 'forge-besw.20',
				phase: 'GREEN',
				taskId: 'task-1',
				taskTitle: 'Implement audit helper',
				prompt: 'implement prompt',
				response: 'implementation complete',
			}, {
				runCommand: runner.runCommand,
				metaJsonSupported: true,
			});

			expect(result.record.entryId).toBe('int-record');
			expect(result.label.skipped).toBe(true);
			expect(runner.commands.length).toBe(1);
			expect(runner.commands[0].args).toContain('record');
			expect(runner.commands[0].args).toContain('forge-besw.20');
			expect(runner.commands[0].args.join(' ')).toContain('llm_call');
		});

		test('emits implementer evidence with a default event object', () => {
			const runner = createRunner();
			const result = emitImplementerAuditEvidence(undefined, {
				runCommand: runner.runCommand,
				metaJsonSupported: true,
			});

			expect(result.record.entryId).toBe('int-record');
			expect(result.label.skipped).toBe(true);
			expect(runner.commands.length).toBe(1);
			expect(runner.commands[0].args).toContain('record');
		});

		test('emits implementer evidence with a null event object', () => {
			const runner = createRunner();
			const result = emitImplementerAuditEvidence(null, {
				runCommand: runner.runCommand,
				metaJsonSupported: true,
			});

			expect(result.record.entryId).toBe('int-record');
			expect(result.label.skipped).toBe(true);
			expect(runner.commands.length).toBe(1);
			expect(runner.commands[0].args).toContain('record');
		});

		test('emits spec reviewer PASS evidence and labels it good', () => {
			const runner = createRunner();
			const result = emitSpecReviewerAuditEvidence({
				issueId: 'forge-besw.20',
				taskId: 'task-1',
				taskTitle: 'Spec review',
				prompt: 'spec prompt',
				response: 'PASS',
				verdict: 'PASS',
			}, {
				runCommand: runner.runCommand,
				metaJsonSupported: true,
			});

			expect(result.record.entryId).toBe('int-record');
			expect(result.label.label).toBe('good');
			expect(runner.commands[1].args).toEqual([
				'audit',
				'label',
				'int-record',
				'--json',
				'--label',
				'good',
				'--reason',
				'spec_reviewer verdict: PASS',
			]);
		});

		test('keeps reviewer helper phases pinned to reviewer roles', () => {
			const specRunner = createRunner();
			const qualityRunner = createRunner();

			emitSpecReviewerAuditEvidence({
				phase: 'GREEN',
				prompt: 'spec prompt',
				response: 'PASS',
				verdict: 'PASS',
			}, {
				runCommand: specRunner.runCommand,
				metaJsonSupported: true,
			});
			emitQualityReviewerAuditEvidence({
				phase: 'GREEN',
				prompt: 'quality prompt',
				response: 'FAIL',
				verdict: 'FAIL',
			}, {
				runCommand: qualityRunner.runCommand,
				metaJsonSupported: true,
			});

			const specPromptIndex = specRunner.commands[0].args.indexOf('--prompt');
			const qualityPromptIndex = qualityRunner.commands[0].args.indexOf('--prompt');
			expect(JSON.parse(specRunner.commands[0].args[specPromptIndex + 1]).phase).toBe('SPEC');
			expect(JSON.parse(qualityRunner.commands[0].args[qualityPromptIndex + 1]).phase).toBe('QUALITY');
		});

		test('emits quality reviewer FAIL evidence and labels it bad', () => {
			const runner = createRunner();
			const result = emitQualityReviewerAuditEvidence({
				issueId: 'forge-besw.20',
				taskId: 'task-2',
				taskTitle: 'Quality review',
				prompt: 'quality prompt',
				response: 'FAIL',
				verdict: 'FAIL',
			}, {
				runCommand: runner.runCommand,
				metaJsonSupported: true,
			});

			expect(result.record.entryId).toBe('int-record');
			expect(result.label.label).toBe('bad');
			expect(runner.commands[1].args).toContain('bad');
			expect(runner.commands[1].args).toContain('quality_reviewer verdict: FAIL');
		});

		test('does not label reviewer events with unknown verdicts', () => {
			const runner = createRunner();
			const result = emitQualityReviewerAuditEvidence({
				issueId: 'forge-besw.20',
				taskId: 'task-3',
				taskTitle: 'Quality review pending',
				prompt: 'quality prompt',
				response: 'needs more data',
				verdict: 'UNKNOWN',
			}, {
				runCommand: runner.runCommand,
				metaJsonSupported: true,
			});

			expect(result.record.entryId).toBe('int-record');
			expect(result.label.skipped).toBe(true);
			expect(runner.commands.length).toBe(1);
		});
	});
});
