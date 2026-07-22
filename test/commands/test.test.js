'use strict';

/**
 * Tests for forge test command — smart test runner.
 *
 * Uses dependency injection for testability: the handler accepts
 * injected deps (fs, execFileSync, spawnSync) so we never touch
 * the real filesystem or spawn real processes in unit tests.
 */

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');

let testCommand;
try {
	testCommand = require('../../lib/commands/test.js');
} catch (_e) {
	// Will fail in RED phase — expected
}

// ---------------------------------------------------------------------------
// Helpers — build injectable stubs
// ---------------------------------------------------------------------------

/**
 * Create a mock fs module with configurable lockfile existence.
 * @param {Object} opts
 * @param {string} [opts.lockfile] - Which lockfile exists (e.g. 'bun.lockb')
 * @param {string} [opts.packageJson] - JSON string for package.json readFileSync
 * @returns {Object} Stubbed fs
 */
function makeFsStub({ lockfile = null, packageJson = '{}', existingPaths = [] } = {}) {
	const normalize = (value) => String(value).replace(/\\/g, '/');
	const knownPaths = new Set(existingPaths.map(normalize));
	return {
		existsSync: (p) => {
			const normalized = normalize(p);
			if (lockfile && normalized.endsWith(lockfile)) return true;
			if (normalized.endsWith('package.json') && packageJson) return true;
			if (knownPaths.has(normalized)) return true;
			return false;
		},
		readFileSync: (p, _enc) => {
			if (String(p).endsWith('package.json')) return packageJson;
			return '';
		},
	};
}

/**
 * Create a mock execFileSync that optionally throws for 'bd'.
 * @param {Object} opts
 * @param {boolean} [opts.bdFails=false] - Whether bd command should throw
 * @param {string} [opts.gitDiffOutput=''] - Output for git diff commands
 * @param {string} [opts.mergeBaseOutput='abc123'] - Output for merge-base
 * @param {boolean} [opts.mergeBaseFails=false] - Whether merge-base throws
 * @returns {Function}
 */
function makeExecFileSync({
	bdFails = false,
	gitDiffOutput = '',
	mergeBaseOutput = 'abc123',
	mergeBaseFails = false,
} = {}) {
	return (cmd, args, _opts) => {
		if (cmd === 'bd') {
			if (bdFails) throw new Error('bd not available');
			return '';
		}
		if (cmd === 'git') {
			if (args && args[0] === 'merge-base') {
				if (mergeBaseFails) throw new Error('merge-base failed');
				return mergeBaseOutput;
			}
			if (args && args[0] === 'diff') {
				return gitDiffOutput;
			}
		}
		return '';
	};
}

/**
 * Create a mock spawnSync.
 * @param {Object} opts
 * @param {number} [opts.exitCode=0] - Process exit code
 * @returns {Function} spy that records calls and returns mock result
 */
function makeSpawnSync({ exitCode = 0 } = {}) {
	const calls = [];
	const fn = (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		return { status: exitCode, signal: null };
	};
	fn.calls = calls;
	return fn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('forge test command', () => {
	describe('module shape', () => {
		test('exports name, description, usage, flags, handler', () => {
			expect(testCommand).toBeDefined();
			expect(testCommand.name).toBe('test');
			expect(typeof testCommand.description).toBe('string');
			expect(typeof testCommand.usage).toBe('string');
			expect(testCommand.flags).toBeDefined();
			expect(testCommand.flags['--affected']).toBeDefined();
			expect(typeof testCommand.handler).toBe('function');
		});
	});

	describe('package manager detection', () => {
		test('detects bun when bun.lockb exists', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub({ lockfile: 'bun.lockb' }),
				execFileSync: makeExecFileSync(),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls.length).toBeGreaterThan(0);
			expect(spawnSpy.calls[0].cmd).toBe('bun');
		});

		test('detects pnpm when pnpm-lock.yaml exists', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub({ lockfile: 'pnpm-lock.yaml' }),
				execFileSync: makeExecFileSync(),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].cmd).toBe('pnpm');
		});

		test('detects yarn when yarn.lock exists', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub({ lockfile: 'yarn.lock' }),
				execFileSync: makeExecFileSync(),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].cmd).toBe('yarn');
		});

		test('defaults to npm when no lockfile found', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub({ lockfile: null }),
				execFileSync: makeExecFileSync(),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].cmd).toBe('npm');
		});
	});

	describe('timeout', () => {
		test('default timeout is 120000ms', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				execFileSync: makeExecFileSync(),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].opts.timeout).toBe(120000);
		});
	});

	describe('Beads connectivity', () => {
		// Isolate from ambient BEADS_SKIP_TESTS. The full suite is run via the
		// outer `forge test`, which sets BEADS_SKIP_TESTS=1 in the child env when
		// Beads/Dolt connectivity is unavailable. That ambient value leaks into
		// this process and is inherited by the handler's `{ ...process.env }`
		// spread, breaking the `toBeUndefined()` assertion below. Saving and
		// restoring keeps both tests deterministic regardless of the ambient value.
		let savedBeadsSkip;
		beforeEach(() => {
			savedBeadsSkip = process.env.BEADS_SKIP_TESTS;
			delete process.env.BEADS_SKIP_TESTS;
		});
		afterEach(() => {
			if (savedBeadsSkip === undefined) {
				delete process.env.BEADS_SKIP_TESTS;
			} else {
				process.env.BEADS_SKIP_TESTS = savedBeadsSkip;
			}
		});

		test('sets BEADS_SKIP_TESTS=1 when bd is unavailable', async () => {
			const spawnSpy = makeSpawnSync();
			const result = await testCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				execFileSync: makeExecFileSync({ bdFails: true }),
				spawnSync: spawnSpy,
			});

			expect(result.beadsSkipped).toBe(true);
			expect(spawnSpy.calls[0].opts.env.BEADS_SKIP_TESTS).toBe('1');
		});

		test('does not set BEADS_SKIP_TESTS when bd is available', async () => {
			const spawnSpy = makeSpawnSync();
			const result = await testCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				execFileSync: makeExecFileSync({ bdFails: false }),
				spawnSync: spawnSpy,
			});

			expect(result.beadsSkipped).toBe(false);
			expect(spawnSpy.calls[0].opts.env.BEADS_SKIP_TESTS).toBeUndefined();
		});
	});

	describe('test execution', () => {
		test('uses ["run", "test"] not ["test"]', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				execFileSync: makeExecFileSync(),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].args).toEqual(['run', 'test']);
		});

		test('passes stdio: inherit', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				execFileSync: makeExecFileSync(),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].opts.stdio).toBe('inherit');
		});
	});

	describe('return value', () => {
		test('returns success: true when exit code is 0', async () => {
			const result = await testCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				execFileSync: makeExecFileSync(),
				spawnSync: makeSpawnSync({ exitCode: 0 }),
			});

			expect(result).toEqual({
				success: true,
				exitCode: 0,
				beadsSkipped: false,
			});
		});

		test('returns success: false when exit code is non-zero', async () => {
			const result = await testCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				execFileSync: makeExecFileSync(),
				spawnSync: makeSpawnSync({ exitCode: 1 }),
			});

			expect(result).toEqual({
				success: false,
				exitCode: 1,
				beadsSkipped: false,
			});
		});
	});

	describe('--affected flag', () => {
		test('maps changed source files to test files', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], { affected: true }, '/fake/root', {
				fs: makeFsStub({
					existingPaths: [
						'/fake/root/test/foo.test.js',
						'/fake/root/test/bar.test.js',
					],
				}),
				execFileSync: makeExecFileSync({
					mergeBaseOutput: 'abc123',
					gitDiffOutput: 'lib/foo.js\nlib/bar.js\n',
				}),
				spawnSync: spawnSpy,
			});

			const call = spawnSpy.calls[0];
			expect(call.args).toContain('test/foo.test.js');
			expect(call.args).toContain('test/bar.test.js');
		});

		test('maps upgrade safety support files to targeted tests', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], { affected: true }, '/fake/root', {
				fs: makeFsStub({
					existingPaths: [
						'/fake/root/test/commands/upgrade.test.js',
						'/fake/root/test/docs-consistency.test.js',
					],
				}),
				execFileSync: makeExecFileSync({
					mergeBaseOutput: 'abc123',
					gitDiffOutput: [
						'docs/INDEX.md',
						'docs/reference/upgrade-safety.md',
						'lib/upgrade-safety.js',
						'lib/commands/upgrade.js',
					].join('\n'),
				}),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].args).toEqual([
				'run',
				'test',
				'test/commands/upgrade.test.js',
				'test/docs-consistency.test.js',
			]);
		});

		test('uses merge-base for diff by default', async () => {
			const execCalls = [];
			const execStub = (cmd, args, _opts) => {
				execCalls.push({ cmd, args });
				if (cmd === 'git' && args[0] === 'merge-base') return 'abc123';
				if (cmd === 'git' && args[0] === 'diff') return 'lib/x.js\n';
				return '';
			};

			await testCommand.handler([], { affected: true }, '/fake/root', {
				fs: makeFsStub(),
				execFileSync: execStub,
				spawnSync: makeSpawnSync(),
			});

			// Should have called merge-base
			const mergeBaseCall = execCalls.find(
				(c) => c.cmd === 'git' && c.args[0] === 'merge-base',
			);
			expect(mergeBaseCall).toBeDefined();

			// Should have called diff with merge-base result
			const diffCall = execCalls.find(
				(c) => c.cmd === 'git' && c.args[0] === 'diff',
			);
			expect(diffCall).toBeDefined();
			expect(diffCall.args).toContain('abc123...HEAD');
		});

		test('falls back to HEAD diff when merge-base fails', async () => {
			const execCalls = [];
			const execStub = (cmd, args, _opts) => {
				execCalls.push({ cmd, args });
				if (cmd === 'git' && args[0] === 'merge-base') {
					throw new Error('merge-base failed');
				}
				if (cmd === 'git' && args[0] === 'diff') return 'lib/z.js\n';
				return '';
			};

			await testCommand.handler([], { affected: true }, '/fake/root', {
				fs: makeFsStub(),
				execFileSync: execStub,
				spawnSync: makeSpawnSync(),
			});

			const diffCall = execCalls.find(
				(c) => c.cmd === 'git' && c.args[0] === 'diff',
			);
			expect(diffCall).toBeDefined();
			expect(diffCall.args).toContain('HEAD');
			expect(diffCall.args).not.toContain('abc123...HEAD');
		});

		test('uses upstream diff when requested for push-hook style runs', async () => {
			const execCalls = [];
			const execStub = (cmd, args, _opts) => {
				execCalls.push({ cmd, args });
				if (cmd === 'git' && args.includes('@{upstream}')) return 'origin/feature-branch';
				if (cmd === 'git' && args[0] === 'diff') return 'lib/x.js\n';
				return '';
			};

			await testCommand.handler([], { affected: true, sinceUpstream: true }, '/fake/root', {
				fs: makeFsStub({
					existingPaths: ['/fake/root/test/x.test.js'],
				}),
				execFileSync: execStub,
				spawnSync: makeSpawnSync(),
			});

			const diffCall = execCalls.find(
				(c) => c.cmd === 'git' && c.args[0] === 'diff',
			);
			expect(diffCall).toBeDefined();
			expect(diffCall.args).toContain('origin/feature-branch...HEAD');
		});

		test('skips non-lib files in affected mapping', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], { affected: true }, '/fake/root', {
				fs: makeFsStub({
					existingPaths: ['/fake/root/test/foo.test.js'],
				}),
				execFileSync: makeExecFileSync({
					gitDiffOutput: 'README.md\nlib/foo.js\ndocs/bar.md\n',
				}),
				spawnSync: spawnSpy,
			});

			const call = spawnSpy.calls[0];
			// Should only include the mapped test file for lib/foo.js
			const testFileArgs = call.args.filter((a) => a.endsWith('.test.js'));
			expect(testFileArgs).toEqual(['test/foo.test.js']);
		});

		test('runs all tests when no affected test files found', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], { affected: true }, '/fake/root', {
				fs: makeFsStub(),
				execFileSync: makeExecFileSync({
					gitDiffOutput: 'README.md\ndocs/bar.md\n',
				}),
				spawnSync: spawnSpy,
			});

			// Falls back to 'run test' (no specific files)
			expect(spawnSpy.calls[0].args).toEqual(['run', 'test']);
		});

		test('runs changed test files directly when they are edited', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], { affected: true }, '/fake/root', {
				fs: makeFsStub({
					existingPaths: ['/fake/root/test/commands/ship.test.js'],
				}),
				execFileSync: makeExecFileSync({
					gitDiffOutput: 'test/commands/ship.test.js\n',
				}),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].args).toEqual(['run', 'test', 'test/commands/ship.test.js']);
		});

		test('maps workflow changes to workflow tests when they exist', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], { affected: true }, '/fake/root', {
				fs: makeFsStub({
					existingPaths: [
						'/fake/root/test/ci-workflow.test.js',
						'/fake/root/test/workflows/size-check.test.js',
					],
				}),
				execFileSync: makeExecFileSync({
					gitDiffOutput: '.github/workflows/size-check.yml\n',
				}),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].args).toEqual([
				'run',
				'test',
				'test/ci-workflow.test.js',
				'test/workflows/size-check.test.js',
			]);
		});

		test('unmapped .claude/commands/ edits fall back to full suite (A0d: commands surface removed)', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], { affected: true }, '/fake/root', {
				fs: makeFsStub({
					existingPaths: [
						'/fake/root/test/structural/skills-sync-drift.test.js',
					],
				}),
				execFileSync: makeExecFileSync({
					gitDiffOutput: '.claude/commands/review.md\n',
				}),
				spawnSync: spawnSpy,
			});

			// .claude/commands/ is no longer a forge-managed surface (removed in A0d).
			// getAffectedTestFiles returns [] → no targeted tests → falls back to full suite.
			expect(spawnSpy.calls[0].args).toEqual(['run', 'test']);
		});

		test('maps mirrored agent assets to sync-oriented tests', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], { affected: true }, '/fake/root', {
				fs: makeFsStub({
					existingPaths: [
						'/fake/root/test/agent-gaps.test.js',
						'/fake/root/test/scripts/check-agents.test.js',
						'/fake/root/test/structural/skills-sync-drift.test.js',
					],
				}),
				execFileSync: makeExecFileSync({
					gitDiffOutput: '.cursor/commands/review.md\n.forge/sync-manifest.json\n',
				}),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].args).toEqual([
				'run',
				'test',
				'test/agent-gaps.test.js',
				'test/scripts/check-agents.test.js',
				'test/structural/skills-sync-drift.test.js',
			]);
		});

		test('maps agentic workflow changes to behavioral sync tests', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], { affected: true }, '/fake/root', {
				fs: makeFsStub({
					existingPaths: [
						'/fake/root/test/scripts/behavioral-judge.test.js',
						'/fake/root/test/structural/agentic-workflow-sync.test.js',
					],
				}),
				execFileSync: makeExecFileSync({
					gitDiffOutput: '.github/agentic-workflows/behavioral-test.md\n',
				}),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].args).toEqual([
				'run',
				'test',
				'test/scripts/behavioral-judge.test.js',
				'test/structural/agentic-workflow-sync.test.js',
			]);
		});
	});
});

// bfaa6e2a: getChangedFiles/getAffectedTestFiles caught a failed `git diff` and
// returned [] — indistinguishable from a legitimate "no files changed". On
// preflight's DEFAULT resolver path that surfaced as a green fast-lane pass: a
// real fail-OPEN. Under opt-in strict mode a git-diff FAILURE must throw so the
// caller can fail closed. The default (no-strict) path MUST stay unchanged so
// `forge test --affected` and the pre-push mapping keep falling back to the
// full suite on an empty/failed diff.
describe('getChangedFiles/getAffectedTestFiles — strict distinguishes ERROR from EMPTY (bfaa6e2a)', () => {
	// exec that succeeds for ref resolution but THROWS on the actual `git diff`.
	const gitDiffThrows = (cmd, args) => {
		if (cmd === 'git' && args && args[0] === 'diff') {
			throw new Error('fatal: bad revision');
		}
		return '';
	};

	test('DEFAULT: git diff failure returns [] (preserves forge test / pre-push semantics)', () => {
		expect(testCommand.getChangedFiles(gitDiffThrows)).toEqual([]);
		expect(
			testCommand.getAffectedTestFiles('/fake/root', gitDiffThrows, makeFsStub()),
		).toEqual([]);
	});

	test('STRICT: git diff failure THROWS (fail-closed) instead of masquerading as empty', () => {
		expect(() => testCommand.getChangedFiles(gitDiffThrows, { strict: true })).toThrow();
		expect(() => testCommand.getAffectedTestFiles(
			'/fake/root', gitDiffThrows, makeFsStub(), { strict: true },
		)).toThrow();
	});

	test('STRICT: a genuinely EMPTY diff (git succeeded, no changes) is NOT an error', () => {
		const emptyDiff = makeExecFileSync({ gitDiffOutput: '' });
		expect(testCommand.getChangedFiles(emptyDiff, { strict: true })).toEqual([]);
		expect(testCommand.getAffectedTestFiles(
			'/fake/root', emptyDiff, makeFsStub(), { strict: true },
		)).toEqual([]);
	});
});

// bfaa6e2a wiring: `forge test --affected` must NOT adopt strict mode — a git
// failure there falls back to the full suite (safe), never crashes the command.
describe('forge test --affected — resilient to git failure (bfaa6e2a semantics guard)', () => {
	test('git diff failure falls back to the full suite, does not throw', async () => {
		const spawnSpy = makeSpawnSync();
		const result = await testCommand.handler([], { affected: true }, '/fake/root', {
			fs: makeFsStub(),
			execFileSync: (cmd, args) => {
				if (cmd === 'git' && args && args[0] === 'diff') throw new Error('fatal: bad revision');
				return '';
			},
			spawnSync: spawnSpy,
		});
		expect(result.success).toBe(true);
		expect(spawnSpy.calls[0].args).toEqual(['run', 'test']);
	});
});

// Skill sources (skills/** and their committed .agents/skills/** mirror) must map
// to the skill test suite. Without this they were "unmapped" → the pre-push hook
// fell back to the full ~1500-test suite for every skills-only PR.
describe('skill source → test mapping', () => {
	test('maps skills/ edits to the skill test suite', () => {
		const candidates = testCommand.getTestCandidatesForChangedFile('skills/gates/SKILL.md');
		expect(candidates).toContain('test/skill-coverage.test.js');
		expect(candidates).toContain('test/skill-eval.test.js');
		expect(candidates).toContain('test/skills-structure.test.js');
		expect(candidates).toContain('test/using-forge.test.js');
		expect(candidates).toContain('test/skills/chain-integrity.test.js');
		expect(candidates).toContain('test/structural/skills-sync-drift.test.js');
	});

	test('maps coverage.json / scorecard edits to the skill test suite', () => {
		expect(testCommand.getTestCandidatesForChangedFile('skills/coverage.json'))
			.toContain('test/skill-coverage.test.js');
		expect(testCommand.getTestCandidatesForChangedFile('skills/worktree/evals/scorecard.json'))
			.toContain('test/skill-eval.test.js');
	});

	test('maps lib/skill-eval.js to its own AND the accuracy-lint detector suite', () => {
		// skill-eval hosts auditCommandDocumentation / auditRouterPrecision, so an edit
		// there must run the accuracy-lint detectors, not just test/skill-eval.test.js.
		const candidates = testCommand.getTestCandidatesForChangedFile('lib/skill-eval.js');
		expect(candidates).toContain('test/skill-eval.test.js');
		expect(candidates).toContain('test/skill-accuracy.test.js');
	});

	test('maps the committed .agents/skills/ mirror to the same suite (drift guard included)', () => {
		const candidates = testCommand.getTestCandidatesForChangedFile('.agents/skills/gates/SKILL.md');
		expect(candidates).toContain('test/skill-coverage.test.js');
		expect(candidates).toContain('test/structural/skills-sync-drift.test.js');
	});
});
