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
const { executeCommand } = require('../../lib/commands/_registry.js');
const {
	QUICK_LANE_ENV_VAR,
	QUICK_LANE_VALUE,
	OBSERVED_FULL_SUITE_RUNTIME_MS,
	resolveFullSuiteTimeoutMs,
} = require('../../scripts/test.js');

const FORGE_MANIFEST = JSON.stringify({
	name: 'forge-workflow',
	bin: { forge: 'bin/forge.js' },
	scripts: { 'test:full:parallel': 'node scripts/test-full-suite.js' },
});
const PUSH_NONCE_ENV_VAR = 'FORGE_PUSH_NONCE';

function isForgeFullRunnerCall(cmd, args) {
	return cmd === 'node' && args[0] === 'scripts/test-full-suite.js';
}

function isTestRunCall(cmd, args) {
	return isForgeFullRunnerCall(cmd, args)
		|| (args.includes('run') && args.includes('test'));
}

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

			const testCall = spawnCalls.find(call => isTestRunCall(call.cmd, call.args));
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
		test('routes a Forge checkout without a receipt through the supervised full runner', async () => {
			const spawnCalls = [];
			const deps = makeDeps({
				spawnSync: (cmd, args, opts) => {
					spawnCalls.push({ cmd, args: [...args], opts });
					return { status: 0 };
				},
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			const runnerCall = spawnCalls.find(call => isForgeFullRunnerCall(call.cmd, call.args));
			expect(runnerCall).toEqual({
				cmd: 'node',
				args: ['scripts/test-full-suite.js'],
				opts: expect.objectContaining({ cwd: '/fake/project' }),
			});
			expect(runnerCall.opts.env[PUSH_NONCE_ENV_VAR]).toBeUndefined();
			expect(runnerCall.opts.env[QUICK_LANE_ENV_VAR]).toBeUndefined();
			expect(spawnCalls.some(call => call.args.includes('run') && call.args.includes('test'))).toBe(false);
		});

		test('blocks git push when the Forge full runner fails', async () => {
			const execCalls = [];
			const deps = makeDeps({
				execFileSync: (cmd, args) => {
					execCalls.push({ cmd, args: [...args] });
					return '';
				},
				spawnSync: (cmd, args) => isForgeFullRunnerCall(cmd, args)
					? { status: 1 }
					: { status: 0 },
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			expect(result).toMatchObject({ success: false, testsPassed: false, pushed: false });
			expect(execCalls.some(call => call.cmd === 'git' && call.args[0] === 'push')).toBe(false);
		});

		test('keeps a consumer-owned scripts/test.js on its configured package command', async () => {
			const spawnCalls = [];
			const deps = makeDeps({
				existsSync: file => /pnpm-lock\.yaml$/.test(file) || /scripts[\\/]test\.js$/.test(file),
				readFileSync: () => JSON.stringify({
					name: 'consumer-app',
					scripts: { test: 'node scripts/test.js' },
				}),
				spawnSync: (cmd, args) => {
					spawnCalls.push({ cmd, args: [...args] });
					return { status: 0 };
				},
			});

			await pushModule.handler([], {}, '/consumer/project', deps);

			expect(spawnCalls.some(call => isForgeFullRunnerCall(call.cmd, call.args))).toBe(false);
			expect(spawnCalls).toContainEqual({ cmd: 'pnpm', args: ['run', 'test'] });
		});

		test('reuses exact-head validation only for tests while keeping branch protection and lint', async () => {
			const spawnCalls = [];
			const execCalls = [];
			const deps = makeDeps({
				verifyValidationReceipt: () => ({ valid: true }),
				spawnSync: (cmd, args) => {
					spawnCalls.push({ cmd, args: [...args] });
					return { status: 0 };
				},
				execFileSync: (cmd, args) => {
					execCalls.push({ cmd, args: [...args] });
					if (cmd === 'git' && args.includes('--show-toplevel')) return 'C:/worktree path with spaces\n';
					return '';
				},
			});

			const result = await pushModule.handler([], {}, 'C:/wrong/init-cwd', deps);

			expect(spawnCalls.some(call => call.args.includes('lint'))).toBe(true);
			expect(spawnCalls.some(call => isTestRunCall(call.cmd, call.args))).toBe(false);
			expect(execCalls.some(call => call.args.some(arg => arg.includes('branch-protection.js')))).toBe(true);
			expect(execCalls.some(call => call.args[0] === 'push')).toBe(true);
			expect(result).toMatchObject({ success: true, testsPassed: true, validationReused: true });
		});

		test('falls back to the full suite when validation evidence is invalid', async () => {
			const spawnCalls = [];
			const deps = makeDeps({
				verifyValidationReceipt: () => ({ valid: false, reason: 'head-changed' }),
				spawnSync: (cmd, args) => {
					spawnCalls.push({ cmd, args: [...args] });
					return { status: 0 };
				},
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			expect(spawnCalls.some(call => isForgeFullRunnerCall(call.cmd, call.args))).toBe(true);
			expect(result.validationReused).toBe(false);
		});

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
			const testCall = spawnCalls.find(call => isForgeFullRunnerCall(call.cmd, call.args));
			expect(lintCall).toBeTruthy();
			expect(testCall).toBeTruthy();
			expect(result.quickMode).toBe(false);
			expect(result.testsPassed).toBe(true);
		});

		test('should block push if tests fail in full mode', async () => {
			const deps = makeDeps({
				spawnSync: (cmd, args, _opts) => {
					if (isForgeFullRunnerCall(cmd, args)) {
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
					if (isForgeFullRunnerCall('node', args)) {
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
					if (isForgeFullRunnerCall('node', args)) {
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
					if (isForgeFullRunnerCall('node', args)) {
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
					if (isForgeFullRunnerCall('node', args)) {
						testOpts = opts;
					}
					return { status: 0 };
				},
				env: { PATH: 'C:/synthetic-tools', FORGE_TEST_TIMEOUT_MS: '1234567' },
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
					if (isForgeFullRunnerCall('node', args)) {
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
					if (isForgeFullRunnerCall('node', args)) {
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
					if (isForgeFullRunnerCall('node', args)) {
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
					if (isForgeFullRunnerCall('node', args)) {
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
					if (isForgeFullRunnerCall('node', args)) {
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
					if (isForgeFullRunnerCall('node', args)) {
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
		test('forwards real Git arguments when no Forge delimiter is present', async () => {
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
			expect(pushCall.args).toEqual(['push', '-u', 'origin', 'feat/slug']);
		});

		test('consumes the first Forge passthrough delimiter', async () => {
			const execCalls = [];
			const deps = makeDeps({
				execFileSync: (cmd, args) => {
					execCalls.push({ cmd, args: [...args] });
					return '';
				},
			});

			await pushModule.handler(
				['--', '--force-with-lease', '-u', 'origin', 'feat/slug'],
				{},
				'/fake/project',
				deps,
			);

			const pushCall = execCalls.find(call => call.cmd === 'git' && call.args[0] === 'push');
			expect(pushCall.args).toEqual([
				'push',
				'--force-with-lease',
				'-u',
				'origin',
				'feat/slug',
			]);
		});

		test('preserves a later Git delimiter after consuming the Forge delimiter', async () => {
			const execCalls = [];
			const deps = makeDeps({
				execFileSync: (cmd, args) => {
					execCalls.push({ cmd, args: [...args] });
					return '';
				},
			});

			await pushModule.handler(['--', '--', 'origin', 'feat/slug'], {}, '/fake/project', deps);

			const pushCall = execCalls.find(call => call.cmd === 'git' && call.args[0] === 'push');
			expect(pushCall.args).toEqual(['push', '--', 'origin', 'feat/slug']);
		});

		test.each([
			[['-u', 'origin', 'feat/slug'], ['push', '-u', 'origin', 'feat/slug']],
			[[
				'--',
				'--force-with-lease=refs/heads/feat/slug:0123456789abcdef0123456789abcdef01234567',
				'origin',
				'feat/slug',
			], [
				'push',
				'--force-with-lease=refs/heads/feat/slug:0123456789abcdef0123456789abcdef01234567',
				'origin',
				'feat/slug',
			]],
		])('preserves Git argv through registry dispatch without a network push', async (argv, expected) => {
			const execCalls = [];
			const result = await executeCommand(
				new Map([['push', pushModule]]),
				'push',
				argv,
				{},
				'/fake/project',
				{
					skipEnsureHome: true,
					commandOpts: makeDeps({
						execFileSync: (cmd, args) => {
							execCalls.push({ cmd, args: [...args] });
							return '';
						},
					}),
				},
			);

			expect(result.success).toBe(true);
			expect(execCalls.find(call => call.cmd === 'git' && call.args[0] === 'push').args)
				.toEqual(expected);
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
		test.each([
			[false, 'full', ['branch-protection', 'lint', 'tests']],
			[true, 'quick', ['branch-protection', 'lint']],
		])('captures clean state before gates and signs only completed gates (quick=%s)', async (quick, mode, gates) => {
			const order = [];
			let writeOptions;
			const deps = makeDeps({
				beginPushProof: () => { order.push('snapshot'); return { clean: true, branch: 'refs/heads/feature' }; },
				execFileSync: (cmd, args) => {
					if (cmd === 'node' && args[0].includes('branch-protection.js')) order.push('branch');
					return '';
				},
				spawnSync: (_cmd, args) => {
					if (args.includes('lint')) order.push('lint');
					if (isForgeFullRunnerCall('node', args)) order.push('tests');
					return { status: 0 };
				},
				writeForgeToken: (_root, options) => {
					order.push('write');
					writeOptions = options;
					return { nonce: '00000000-0000-4000-8000-000000000000' };
				},
				consumeForgeToken: () => true,
			});

			await pushModule.handler([], quick ? { '--quick': true } : {}, '/fake/project', deps);

			expect(order[0]).toBe('snapshot');
			expect(order.indexOf('write')).toBeGreaterThan(order.indexOf('lint'));
			expect(writeOptions).toMatchObject({ mode, gates });
			expect(writeOptions.snapshot).toEqual({ clean: true, branch: 'refs/heads/feature' });
		});

		test('passes validation receipt identity into the signed invocation proof', async () => {
			let writeOptions;
			await pushModule.handler([], {}, '/fake/project', makeDeps({
				verifyValidationReceipt: () => ({ valid: true, identity: 'receipt-signature-hash' }),
				beginPushProof: () => ({ clean: true }),
				writeForgeToken: (_root, options) => {
					writeOptions = options;
					return { nonce: '00000000-0000-4000-8000-000000000000' };
				},
				consumeForgeToken: () => true,
			}));

			expect(writeOptions.receiptIdentity).toBe('receipt-signature-hash');
		});

		test('puts only the fresh nonce and declared lane in the Git child environment', async () => {
			const parentEnv = {
				PATH: '/tools',
				[PUSH_NONCE_ENV_VAR]: 'stale-parent-nonce',
				[QUICK_LANE_ENV_VAR]: 'stale-parent-lane',
			};
			let childEnv;
			const deps = makeDeps({
				env: parentEnv,
				beginPushProof: () => ({ clean: true }),
				writeForgeToken: () => ({ nonce: '00000000-0000-4000-8000-000000000000' }),
				consumeForgeToken: () => true,
				execFileSync: (cmd, args, options) => {
					if (cmd === 'git' && args[0] === 'push') childEnv = options.env;
					return '';
				},
			});

			await pushModule.handler([], {}, '/fake/project', deps);

			expect(childEnv[PUSH_NONCE_ENV_VAR]).toBe('00000000-0000-4000-8000-000000000000');
			expect(childEnv[QUICK_LANE_ENV_VAR]).toBeUndefined();
			expect(parentEnv).toEqual({
				PATH: '/tools',
				[PUSH_NONCE_ENV_VAR]: 'stale-parent-nonce',
				[QUICK_LANE_ENV_VAR]: 'stale-parent-lane',
			});
		});

		test.each([false, true])('revokes its own proof in finally when Git push fails=%s', async fails => {
			const consumed = [];
			const deps = makeDeps({
				beginPushProof: () => ({ clean: true }),
				writeForgeToken: () => ({ nonce: '00000000-0000-4000-8000-000000000000' }),
				consumeForgeToken: (_root, options) => consumed.push(options.nonce),
				execFileSync: (cmd, args) => {
					if (fails && cmd === 'git' && args[0] === 'push') throw new Error('push failed');
					return '';
				},
			});

			const result = await pushModule.handler([], {}, '/fake/project', deps);

			expect(result.success).toBe(!fails);
			expect(consumed).toEqual(['00000000-0000-4000-8000-000000000000']);
		});

		test('token write failure scrubs inherited authority and falls back to ordinary hooks', async () => {
			let childEnv;
			await pushModule.handler([], {}, '/fake/project', makeDeps({
				env: { [PUSH_NONCE_ENV_VAR]: 'stale' },
				beginPushProof: () => ({ clean: true }),
				writeForgeToken: () => { throw new Error('read-only metadata'); },
				execFileSync: (cmd, args, options) => {
					if (cmd === 'git' && args[0] === 'push') childEnv = options.env;
					return '';
				},
			}));

			expect(childEnv[PUSH_NONCE_ENV_VAR]).toBeUndefined();
		});

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
		env: overrides.env || { PATH: 'C:/synthetic-tools' },
		execFileSync: overrides.execFileSync || noop,
		spawnSync: overrides.spawnSync || ((_cmd, _args, _opts) => ({ status: 0 })),
		existsSync: overrides.existsSync || (() => true), // bun.lock exists by default
		readFileSync: overrides.readFileSync || (() => FORGE_MANIFEST),
		log: overrides.log || (() => {}),
		writeForgeToken: overrides.writeForgeToken || (() => {}),
		consumeForgeToken: overrides.consumeForgeToken || (() => false),
		beginPushProof: overrides.beginPushProof || (() => ({ clean: true })),
		verifyValidationReceipt: overrides.verifyValidationReceipt || (() => ({ valid: false, reason: 'missing' })),
		fireAndForget: () => {},
		_ensureBackingIssue: async () => null,
		_kernelDriver: {},
		_kernelBroker: {},
	};
}
