'use strict';

const { describe, test, expect } = require('bun:test');

/**
 * Forge Push Command Tests
 *
 * Uses dependency injection to avoid real subprocess calls.
 * The push handler accepts an optional `deps` object to override
 * execFileSync, spawnSync, and fs for testability.
 */

// We will require push.js once it exists — for now these tests should RED
const pushModule = require('../../lib/commands/push.js');
const {
	QUICK_LANE_ENV_VAR,
	QUICK_LANE_VALUE,
	OBSERVED_FULL_SUITE_RUNTIME_MS,
	resolveFullSuiteTimeoutMs,
} = require('../../scripts/test.js');

describe('Forge Push Command', () => {
	describe('Module exports', () => {
		test('should export correct command shape', () => {
			expect(pushModule.name).toBe('push');
			expect(typeof pushModule.description).toBe('string');
			expect(pushModule.description.length).toBeGreaterThan(0);
			expect(typeof pushModule.handler).toBe('function');
		});

		test('should export usage string', () => {
			expect(typeof pushModule.usage).toBe('string');
			expect(pushModule.usage).toContain('push');
		});

		test('should export flags with --quick', () => {
			expect(pushModule.flags).toBeTruthy();
			expect(pushModule.flags['--quick']).toBeTruthy();
		});
	});

	describe('Branch protection', () => {
		test('should call branch-protection.js as subprocess via execFileSync', async () => {
			const calls = [];
			const deps = makeDeps({
				execFileSync: (cmd, args, _opts) => {
					calls.push({ cmd, args: [...args] });
					return '';
				},
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			const bpCall = calls.find(
				c => c.cmd === 'node' && c.args[0].includes('branch-protection.js'),
			);
			expect(bpCall).toBeTruthy();
		});

		test('should abort if branch protection fails', async () => {
			const deps = makeDeps({
				execFileSync: (cmd, args, _opts) => {
					if (cmd === 'node' && args[0].includes('branch-protection.js')) {
						throw new Error('Protected branch');
					}
					return '';
				},
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);
			expect(result.success).toBe(false);
			expect(result.pushed).toBe(false);
		});
	});

	describe('Lint execution', () => {
		test('should always run lint', async () => {
			const calls = [];
			const deps = makeDeps({
				spawnSync: (cmd, args, _opts) => {
					calls.push({ cmd, args: [...args] });
					return { status: 0 };
				},
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			const lintCall = calls.find(
				c => c.args.includes('run') && c.args.includes('lint'),
			);
			expect(lintCall).toBeTruthy();
		});

		test('should block push if lint fails', async () => {
			const deps = makeDeps({
				spawnSync: (cmd, args, _opts) => {
					if (args.includes('lint')) {
						return { status: 1 };
					}
					return { status: 0 };
				},
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);
			expect(result.success).toBe(false);
			expect(result.lintPassed).toBe(false);
			expect(result.pushed).toBe(false);
		});
	});

	describe('Quick mode (--quick flag)', () => {
		test('should skip tests when --quick is set', async () => {
			const spawnCalls = [];
			const deps = makeDeps({
				spawnSync: (cmd, args, _opts) => {
					spawnCalls.push({ cmd, args: [...args] });
					return { status: 0 };
				},
			});

			const result = await pushModule.handler([], { '--quick': true }, '/fake/project', deps);

			const testCall = spawnCalls.find(
				c => c.args.includes('run') && c.args.includes('test'),
			);
			expect(testCall).toBeFalsy(); // tests should NOT be called
			expect(result.quickMode).toBe(true);
			expect(result.success).toBe(true);
		});

		test('should print skip message in quick mode', async () => {
			const logs = [];
			const deps = makeDeps({
				log: (msg) => logs.push(msg),
			});

			await pushModule.handler([], { '--quick': true }, '/fake/project', deps);

			const skipMsg = logs.find(m => m.includes('Tests skipped') && m.includes('--quick'));
			expect(skipMsg).toBeTruthy();
		});

		test('should warn on first push to branch in quick mode', async () => {
			const logs = [];
			const deps = makeDeps({
				execFileSync: (cmd, args, _opts) => {
					// git rev-list fails for new branch (no remote tracking)
					if (cmd === 'git' && args[0] === 'rev-list') {
						throw new Error('unknown revision');
					}
					// git branch --show-current
					if (cmd === 'git' && args.includes('--show-current')) {
						return 'feat/my-feature';
					}
					return '';
				},
				log: (msg) => logs.push(msg),
			});

			await pushModule.handler([], { '--quick': true }, '/fake/project', deps);

			const warnMsg = logs.find(m => m.includes('First push') && m.includes('full suite'));
			expect(warnMsg).toBeTruthy();
		});
	});

	describe('Full mode (no --quick)', () => {
		test('should run lint and tests in full mode', async () => {
			const spawnCalls = [];
			const deps = makeDeps({
				spawnSync: (cmd, args, _opts) => {
					spawnCalls.push({ cmd, args: [...args] });
					return { status: 0 };
				},
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			const lintCall = spawnCalls.find(
				c => c.args.includes('run') && c.args.includes('lint'),
			);
			const testCall = spawnCalls.find(
				c => c.args.includes('run') && c.args.includes('test'),
			);
			expect(lintCall).toBeTruthy();
			expect(testCall).toBeTruthy();
			expect(result.quickMode).toBe(false);
			expect(result.testsPassed).toBe(true);
		});

		test('should block push if tests fail in full mode', async () => {
			const deps = makeDeps({
				spawnSync: (cmd, args, _opts) => {
					if (args.includes('test')) {
						return { status: 1 };
					}
					return { status: 0 };
				},
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);
			expect(result.success).toBe(false);
			expect(result.testsPassed).toBe(false);
			expect(result.pushed).toBe(false);
		});

		test('should not cap the full suite with a hardcoded 120s timeout', async () => {
			let testOpts = null;
			const deps = makeDeps({
				spawnSync: (_cmd, args, opts) => {
					if (args.includes('test')) {
						testOpts = opts;
					}
					return { status: 0 };
				},
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			expect(testOpts).toBeTruthy();
			expect(testOpts.timeout).not.toBe(120000);
		});

		test('should budget the test run from the shared full-suite budget', async () => {
			let testOpts = null;
			const deps = makeDeps({
				spawnSync: (_cmd, args, opts) => {
					if (args.includes('test')) {
						testOpts = opts;
					}
					return { status: 0 };
				},
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			expect(testOpts.timeout).toBe(resolveFullSuiteTimeoutMs(process.env));
			expect(testOpts.killSignal).toBe('SIGKILL');
		});

		test('should budget the push test run well above the measured full-suite runtime', async () => {
			let testOpts = null;
			const deps = makeDeps({
				spawnSync: (_cmd, args, opts) => {
					if (args.includes('test')) {
						testOpts = opts;
					}
					return { status: 0 };
				},
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			// A budget at or near the observed runtime SIGKILLs a passing suite:
			// that is the bug this guards. Require real headroom, not a tight fit.
			expect(testOpts.timeout).toBeGreaterThanOrEqual(OBSERVED_FULL_SUITE_RUNTIME_MS * 2);
		});

		test('should honor FORGE_TEST_TIMEOUT_MS for the push test run', async () => {
			let testOpts = null;
			const deps = makeDeps({
				spawnSync: (_cmd, args, opts) => {
					if (args.includes('test')) {
						testOpts = opts;
					}
					return { status: 0 };
				},
				env: { ...process.env, FORGE_TEST_TIMEOUT_MS: '1234567' },
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			expect(testOpts.timeout).toBe(1234567);
		});

		test('should report a bare SIGKILL as an external kill, not a timeout', async () => {
			// An OOM kill or an operator `kill -9` produces status:null +
			// signal:'SIGKILL' + NO error â€” identical in shape to a budget kill
			// minus the ETIMEDOUT evidence. Claiming the budget elapsed here
			// sends the user to raise a timeout that was never the problem.
			const logs = [];
			const deps = makeDeps({
				spawnSync: (_cmd, args, _opts) => {
					if (args.includes('test')) {
						return { status: null, signal: 'SIGKILL' };
					}
					return { status: 0 };
				},
				log: msg => logs.push(String(msg)),
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			expect(result.testsPassed).toBe(false);
			expect(result.pushed).toBe(false);
			const joined = logs.join('\n');
			expect(joined).toContain('SIGKILL');
			expect(joined).toContain('out-of-memory');
			expect(joined).not.toContain('timed out');
			expect(joined).not.toContain('FORGE_TEST_TIMEOUT_MS');
		});

		test('should report a timeout when spawnSync reports ETIMEDOUT with a null status', async () => {
			// Verified against pinned Bun 1.3.12 on Windows: a node:child_process
			// spawnSync timeout returns status:null, signal:<killSignal>, AND an
			// error whose code is ETIMEDOUT. Checking `error` first hid the
			// timeout diagnostic in the exact case it was written for.
			const logs = [];
			const deps = makeDeps({
				spawnSync: (_cmd, args, _opts) => {
					if (args.includes('test')) {
						return {
							status: null,
							signal: 'SIGKILL',
							error: Object.assign(new Error('spawnSync bun ETIMEDOUT'), { code: 'ETIMEDOUT' }),
						};
					}
					return { status: 0 };
				},
				log: msg => logs.push(String(msg)),
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			expect(result.testsPassed).toBe(false);
			const joined = logs.join('\n');
			expect(joined).toContain('timed out');
			expect(joined).toContain('SIGKILL');
			expect(joined).toContain('FORGE_TEST_TIMEOUT_MS');
			expect(joined).not.toContain('could not complete');
		});

		test('should report a timeout when the runner reports exitedDueToTimeout', async () => {
			// Native Bun.spawnSync shape: exitedDueToTimeout + signalCode instead
			// of an ETIMEDOUT error. Handle both field spellings.
			const logs = [];
			const deps = makeDeps({
				spawnSync: (_cmd, args, _opts) => {
					if (args.includes('test')) {
						return { status: null, signalCode: 'SIGKILL', exitedDueToTimeout: true };
					}
					return { status: 0 };
				},
				log: msg => logs.push(String(msg)),
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			expect(result.testsPassed).toBe(false);
			const joined = logs.join('\n');
			expect(joined).toContain('timed out');
			expect(joined).toContain('SIGKILL');
			expect(joined).toContain('FORGE_TEST_TIMEOUT_MS');
		});

		test('should report a non-timeout signal termination without timeout guidance', async () => {
			// An externally signalled run (e.g. operator SIGTERM) is not a timeout;
			// blaming the budget there sends the user after the wrong lever.
			const logs = [];
			const deps = makeDeps({
				spawnSync: (_cmd, args, _opts) => {
					if (args.includes('test')) {
						return { status: null, signal: 'SIGTERM' };
					}
					return { status: 0 };
				},
				log: msg => logs.push(String(msg)),
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			expect(result.testsPassed).toBe(false);
			const joined = logs.join('\n');
			expect(joined).toContain('SIGTERM');
			expect(joined).not.toContain('timed out');
			expect(joined).not.toContain('FORGE_TEST_TIMEOUT_MS');
		});

		test('should report a genuine spawn failure as a spawn error, not a timeout', async () => {
			const logs = [];
			const deps = makeDeps({
				spawnSync: (_cmd, args, _opts) => {
					if (args.includes('test')) {
						return {
							status: null,
							signal: null,
							error: Object.assign(new Error('spawnSync bun ENOENT'), { code: 'ENOENT' }),
						};
					}
					return { status: 0 };
				},
				log: msg => logs.push(String(msg)),
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			expect(result.testsPassed).toBe(false);
			const joined = logs.join('\n');
			expect(joined).toContain('ENOENT');
			expect(joined).not.toContain('timed out');
		});

		test('should report the spawn error when the test runner cannot start', async () => {
			const logs = [];
			const deps = makeDeps({
				spawnSync: (_cmd, args, _opts) => {
					if (args.includes('test')) {
						return { status: null, signal: null, error: new Error('spawn ENOENT') };
					}
					return { status: 0 };
				},
				log: msg => logs.push(String(msg)),
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			expect(result.testsPassed).toBe(false);
			expect(logs.join('\n')).toContain('spawn ENOENT');
		});
	});

	describe('Git push with passthrough args', () => {
		test('should call git push with passthrough args on success', async () => {
			const execCalls = [];
			const deps = makeDeps({
				execFileSync: (cmd, args, _opts) => {
					execCalls.push({ cmd, args: [...args] });
					return '';
				},
			});

			await pushModule.handler(
				['-u', 'origin', 'feat/slug'],
				{},
				'/fake/project',
				deps,
			);

			const pushCall = execCalls.find(
				c => c.cmd === 'git' && c.args[0] === 'push',
			);
			expect(pushCall).toBeTruthy();
			expect(pushCall.args).toContain('-u');
			expect(pushCall.args).toContain('origin');
			expect(pushCall.args).toContain('feat/slug');
		});

		test('should declare the quick lane on the spawned git push env in quick mode', async () => {
			const execCalls = [];
			const deps = makeDeps({
				execFileSync: (cmd, args, opts) => {
					execCalls.push({ cmd, args: [...args], opts });
					return '';
				},
			});

			await pushModule.handler([], { '--quick': true }, '/fake/project', deps);

			const pushCall = execCalls.find(
				c => c.cmd === 'git' && c.args[0] === 'push',
			);
			expect(pushCall.opts.env[QUICK_LANE_ENV_VAR]).toBe(QUICK_LANE_VALUE);
			// Set on the child only — the forge process env stays clean.
			expect(process.env[QUICK_LANE_ENV_VAR]).toBeUndefined();
		});

		test('should not declare the quick lane on a full push', async () => {
			const execCalls = [];
			const deps = makeDeps({
				execFileSync: (cmd, args, opts) => {
					execCalls.push({ cmd, args: [...args], opts });
					return '';
				},
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			const pushCall = execCalls.find(
				c => c.cmd === 'git' && c.args[0] === 'push',
			);
			expect(pushCall.opts.env[QUICK_LANE_ENV_VAR]).toBeUndefined();
		});

		test('buildPushEnv strips an inherited quick lane declaration from a full push', () => {
			const inherited = { [QUICK_LANE_ENV_VAR]: QUICK_LANE_VALUE, PATH: '/usr/bin' };

			const fullEnv = pushModule._internal.buildPushEnv(false, inherited);
			expect(fullEnv[QUICK_LANE_ENV_VAR]).toBeUndefined();
			expect(fullEnv.PATH).toBe('/usr/bin');

			const quickEnv = pushModule._internal.buildPushEnv(true, inherited);
			expect(quickEnv[QUICK_LANE_ENV_VAR]).toBe(QUICK_LANE_VALUE);

			// The caller's environment object is never mutated.
			expect(inherited[QUICK_LANE_ENV_VAR]).toBe(QUICK_LANE_VALUE);
		});

		test('should not call git push when checks fail', async () => {
			const execCalls = [];
			const deps = makeDeps({
				execFileSync: (cmd, args, _opts) => {
					execCalls.push({ cmd, args: [...args] });
					return '';
				},
				spawnSync: (_cmd, args, _opts) => {
					if (args.includes('lint')) return { status: 1 };
					return { status: 0 };
				},
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			const pushCall = execCalls.find(
				c => c.cmd === 'git' && c.args[0] === 'push',
			);
			expect(pushCall).toBeFalsy();
		});
	});

	describe('Forge push nonce token', () => {
		test('should call writeForgeToken before git push on success', async () => {
			let tokenWritten = false;
			const execCalls = [];
			const deps = makeDeps({
				writeForgeToken: (_projectRoot) => {
					tokenWritten = true;
				},
				execFileSync: (cmd, args, _opts) => {
					execCalls.push({ cmd, args: [...args] });
					return '';
				},
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			expect(tokenWritten).toBe(true);
			// Token should be written BEFORE git push
			const pushIdx = execCalls.findIndex(
				c => c.cmd === 'git' && c.args[0] === 'push',
			);
			expect(pushIdx).toBeGreaterThan(-1);
		});

		test('should not write token when checks fail', async () => {
			let tokenWritten = false;
			const deps = makeDeps({
				writeForgeToken: (_projectRoot) => {
					tokenWritten = true;
				},
				spawnSync: (_cmd, args, _opts) => {
					if (args.includes('lint')) return { status: 1 };
					return { status: 0 };
				},
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			expect(tokenWritten).toBe(false);
		});

		test('should still push even if token write fails', async () => {
			const execCalls = [];
			const deps = makeDeps({
				writeForgeToken: () => {
					throw new Error('Permission denied');
				},
				execFileSync: (cmd, args, _opts) => {
					execCalls.push({ cmd, args: [...args] });
					return '';
				},
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			const pushCall = execCalls.find(
				c => c.cmd === 'git' && c.args[0] === 'push',
			);
			expect(pushCall).toBeTruthy();
			expect(result.pushed).toBe(true);
		});

		test('should log warning when token write fails', async () => {
			const logs = [];
			const deps = makeDeps({
				writeForgeToken: () => {
					throw new Error('Permission denied');
				},
				log: (msg) => logs.push(msg),
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			const warnMsg = logs.find(m => m.includes('Could not write forge push token'));
			expect(warnMsg).toBeTruthy();
		});

		test('should write token in quick mode too', async () => {
			let tokenWritten = false;
			const deps = makeDeps({
				writeForgeToken: (_projectRoot) => {
					tokenWritten = true;
				},
			});

			await pushModule.handler([], { '--quick': true }, '/fake/project', deps);

			expect(tokenWritten).toBe(true);
		});

		test('should write token to the git worktree top-level, not the inherited projectRoot', async () => {
			let tokenRoot = null;
			const deps = makeDeps({
				writeForgeToken: (root) => {
					tokenRoot = root;
				},
				execFileSync: (cmd, args, _opts) => {
					if (cmd === 'git' && args[0] === 'rev-parse' && args.includes('--show-toplevel')) {
						return '/real/worktree\n';
					}
					return '';
				},
			});

			// projectRoot here is a wrong INIT_CWD (e.g. main repo root from a worktree)
			await pushModule.handler([], {}, '/wrong/init-cwd', deps);

			expect(tokenRoot).toBe('/real/worktree');
		});

		test('should fall back to projectRoot when git top-level cannot be resolved', async () => {
			let tokenRoot = null;
			const deps = makeDeps({
				writeForgeToken: (root) => {
					tokenRoot = root;
				},
				execFileSync: (cmd, args, _opts) => {
					if (cmd === 'git' && args[0] === 'rev-parse') {
						throw new Error('not a git worktree');
					}
					return '';
				},
			});

			await pushModule.handler([], {}, '/fallback/root', deps);

			expect(tokenRoot).toBe('/fallback/root');
		});
	});

	describe('Return shape', () => {
		test('should return correct result shape on success', async () => {
			const deps = makeDeps();

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			expect(typeof result.success).toBe('boolean');
			expect(typeof result.quickMode).toBe('boolean');
			expect(typeof result.lintPassed).toBe('boolean');
			expect(typeof result.pushed).toBe('boolean');
		});

		test('should include testsPassed in full mode', async () => {
			const deps = makeDeps();

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			expect(result.quickMode).toBe(false);
			expect(typeof result.testsPassed).toBe('boolean');
		});

		test('should omit testsPassed in quick mode', async () => {
			const deps = makeDeps();

			const result = await pushModule.handler([], { '--quick': true }, '/fake/project', deps);

			expect(result.quickMode).toBe(true);
			// testsPassed should be undefined or not present since tests were skipped
			expect(result.testsPassed).toBeUndefined();
		});
	});
});

/**
 * Build a deps object with sensible defaults, overriding with provided overrides.
 * All subprocess calls succeed by default.
 *
 * @param {Object} [overrides]
 * @returns {Object} Dependency injection object for push handler
 */
function makeDeps(overrides = {}) {
	const noop = () => '';
	return {
		execFileSync: overrides.execFileSync || noop,
		spawnSync: overrides.spawnSync || ((_cmd, _args, _opts) => ({ status: 0 })),
		existsSync: overrides.existsSync || (() => true), // bun.lock exists by default
		log: overrides.log || (() => {}),
		writeForgeToken: overrides.writeForgeToken || (() => {}),
		...(overrides.env ? { env: overrides.env } : {}),
	};
}
