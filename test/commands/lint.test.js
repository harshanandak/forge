'use strict';

/**
 * Tests for forge lint command — ESLint runner.
 *
 * Uses dependency injection for testability: the handler accepts
 * injected deps (fs, spawnSync) so we never touch the real filesystem
 * or spawn real processes in unit tests.
 */

const { describe, test, expect } = require('bun:test');

let lintCommand;
try {
	lintCommand = require('../../lib/commands/lint.js');
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
 * @returns {Object} Stubbed fs
 */
function makeFsStub({ lockfile = null } = {}) {
	return {
		existsSync: (p) => {
			if (lockfile && String(p).endsWith(lockfile)) return true;
			return false;
		},
	};
}

/**
 * Create a mock spawnSync.
 * @param {Object} opts
 * @param {number} [opts.exitCode=0] - Process exit code
 * @param {string} [opts.stdout=''] - stdout content
 * @param {string} [opts.stderr=''] - stderr content
 * @returns {Function} spy that records calls and returns mock result
 */
function makeSpawnSync({ exitCode = 0, stdout = '', stderr = '' } = {}) {
	const calls = [];
	const fn = (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		return { status: exitCode, stdout, stderr, signal: null };
	};
	fn.calls = calls;
	return fn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('forge lint command', () => {
	describe('module shape', () => {
		test('exports name, description, usage, flags, handler', () => {
			expect(lintCommand).toBeDefined();
			expect(lintCommand.name).toBe('lint');
			expect(typeof lintCommand.description).toBe('string');
			expect(typeof lintCommand.usage).toBe('string');
			expect(lintCommand.flags).toBeDefined();
			expect(lintCommand.flags['--fix']).toBeDefined();
			expect(typeof lintCommand.handler).toBe('function');
		});
	});

	describe('package manager detection', () => {
		test('detects bun when bun.lockb exists', async () => {
			const spawnSpy = makeSpawnSync();
			await lintCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub({ lockfile: 'bun.lockb' }),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls.length).toBeGreaterThan(0);
			expect(spawnSpy.calls[0].cmd).toBe('bun');
		});

		test('detects pnpm when pnpm-lock.yaml exists', async () => {
			const spawnSpy = makeSpawnSync();
			await lintCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub({ lockfile: 'pnpm-lock.yaml' }),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].cmd).toBe('pnpm');
		});

		test('defaults to npm when no lockfile found', async () => {
			const spawnSpy = makeSpawnSync();
			await lintCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub({ lockfile: null }),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].cmd).toBe('npm');
		});
	});

	describe('lint execution', () => {
		test('runs ["run", "lint"] by default', async () => {
			const spawnSpy = makeSpawnSync();
			await lintCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].args).toEqual(['run', 'lint']);
		});

		test('appends -- --fix when --fix flag is set', async () => {
			const spawnSpy = makeSpawnSync();
			await lintCommand.handler([], { '--fix': true }, '/fake/root', {
				fs: makeFsStub(),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].args).toEqual(['run', 'lint', '--', '--fix']);
		});

		test('appends -- --fix when fix flag is set (without dashes)', async () => {
			const spawnSpy = makeSpawnSync();
			await lintCommand.handler([], { fix: true }, '/fake/root', {
				fs: makeFsStub(),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].args).toEqual(['run', 'lint', '--', '--fix']);
		});

		test('passes stdio: inherit', async () => {
			const spawnSpy = makeSpawnSync();
			await lintCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].opts.stdio).toBe('inherit');
		});

		test('runs from projectRoot (cwd)', async () => {
			const spawnSpy = makeSpawnSync();
			await lintCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				spawnSync: spawnSpy,
			});

			expect(spawnSpy.calls[0].opts.cwd).toBe('/fake/root');
		});
	});

	describe('return value', () => {
		test('returns success: true, errors: 0, warnings: 0 on exit 0', async () => {
			const result = await lintCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				spawnSync: makeSpawnSync({ exitCode: 0 }),
			});

			expect(result).toEqual({
				success: true,
				errors: 0,
				warnings: 0,
			});
		});

		test('returns success: false on non-zero exit code', async () => {
			const result = await lintCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				spawnSync: makeSpawnSync({ exitCode: 1 }),
			});

			expect(result.success).toBe(false);
		});

		test('parses error/warning counts from eslint stdout', async () => {
			const result = await lintCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				spawnSync: makeSpawnSync({
					exitCode: 1,
					stdout: '3 errors and 5 warnings',
				}),
			});

			expect(result.errors).toBe(3);
			expect(result.warnings).toBe(5);
		});

		test('returns errors: 0, warnings: 0 when output has no counts', async () => {
			const result = await lintCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				spawnSync: makeSpawnSync({ exitCode: 1, stdout: '' }),
			});

			expect(result.errors).toBe(0);
			expect(result.warnings).toBe(0);
		});
	});

	describe('error handling', () => {
		test('handles spawnSync returning null status gracefully', async () => {
			const spawnSpy = (_cmd, _args, _opts) => ({
				status: null,
				stdout: '',
				stderr: '',
				signal: 'SIGTERM',
			});

			const result = await lintCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				spawnSync: spawnSpy,
			});

			expect(result.success).toBe(false);
		});

		test('handles spawnSync throwing (missing eslint)', async () => {
			const spawnSpy = () => {
				throw new Error('ENOENT: eslint not found');
			};

			const result = await lintCommand.handler([], {}, '/fake/root', {
				fs: makeFsStub(),
				spawnSync: spawnSpy,
			});

			expect(result.success).toBe(false);
			expect(result.errors).toBe(0);
			expect(result.warnings).toBe(0);
		});
	});
});
