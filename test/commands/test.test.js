'use strict';

/**
 * Tests for forge test command — smart test runner.
 *
 * Uses dependency injection for testability: the handler accepts
 * injected deps (fs, execFileSync, spawnSync) so we never touch
 * the real filesystem or spawn real processes in unit tests.
 */

const { describe, test, expect } = require('bun:test');

let testCommand;
try {
	testCommand = require('../lib/commands/test.js');
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
function makeFsStub({ lockfile = null, packageJson = '{}' } = {}) {
	return {
		existsSync: (p) => {
			if (lockfile && String(p).endsWith(lockfile)) return true;
			if (String(p).endsWith('package.json') && packageJson) return true;
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
				fs: makeFsStub(),
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

		test('skips non-lib files in affected mapping', async () => {
			const spawnSpy = makeSpawnSync();
			await testCommand.handler([], { affected: true }, '/fake/root', {
				fs: makeFsStub(),
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
	});
});
