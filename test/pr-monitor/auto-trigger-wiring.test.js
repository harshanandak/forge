'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { describe, test, expect } = require('bun:test');

const hooks = require('../../lib/commands/hooks');
const push = require('../../lib/commands/push');
const { executeShip, maybeTriggerShepherdAfterShip } = require('../../lib/commands/ship');

function successfulPushDeps(fireAndForget) {
	const spawn = () => {
		const child = new EventEmitter();
		child.pid = 12345;
		child.kill = () => true;
		process.nextTick(() => child.emit('close', 0, null));
		return child;
	};
	const processTree = {
		cleanup: () => ({ killed: [] }),
		envFor: env => env,
		installSignalHandlers: () => () => {},
		registerChild: () => true,
		reserveChild: () => ({ id: 'auto-trigger-fixture' }),
		unregisterChild: () => true,
	};
	return {
		env: { PATH: 'C:/synthetic-tools' },
		execFileSync: () => '',
		spawnSync: () => ({ status: 0 }),
		spawn,
		createProcessTree: () => processTree,
		existsSync: () => true,
		readFileSync: () => JSON.stringify({
			name: 'forge-workflow',
			bin: { forge: 'bin/forge.js' },
			scripts: { 'test:full:parallel': 'node scripts/test-full-suite.js' },
		}),
		log: () => {},
		beginPushProof: () => ({ clean: true }),
		verifyValidationReceipt: () => ({ valid: false, reason: 'missing' }),
		writeForgeToken: () => {},
		consumeForgeToken: () => true,
		fireAndForget,
	};
}

describe('automatic singleton trigger wiring', () => {
	test('successful session-start triggers once', async () => {
		const calls = [];
		const result = await hooks.handler(['session-start', '--harness', 'claude'], {}, '/repo', {
			fireAndForget: (ctx) => calls.push(ctx),
			loadDispatchText: () => 'dispatch',
			fetchNotes: () => [],
			fetchIssues: () => [],
		});
		expect(result.success).toBe(true);
		expect(calls).toEqual([{ projectRoot: '/repo' }]);
	});

	test('successful push triggers once', async () => {
		const calls = [];
		const result = await push.handler([], {}, '/repo', successfulPushDeps((ctx) => calls.push(ctx)));
		expect(result.success).toBe(true);
		expect(calls).toEqual([{ projectRoot: '/repo' }]);
	});

	test('successful non-dry-run ship triggers once', async () => {
		const calls = [];
		const result = await executeShip({
			featureSlug: 'auto-trigger-fixture',
			title: 'feat: auto trigger fixture',
			dryRun: false,
			projectRoot: '/repo',
			fireAndForget: (ctx) => calls.push(ctx),
			createPr: async () => ({
				success: true,
				prUrl: 'https://github.com/owner/repo/pull/42',
				prNumber: 42,
			}),
		});
		expect(result.success).toBe(true);
		expect(calls).toEqual([{ projectRoot: '/repo', dryRun: false }]);
	});

	test('dry-run ship does not trigger', () => {
		let called = false;
		const result = maybeTriggerShepherdAfterShip({
			dryRun: true,
			projectRoot: '/repo',
			fireAndForget: () => { called = true; },
		});
		expect(result.started).toBe(false);
		expect(called).toBe(false);
	});

	test('ordinary hooks and command dispatch have no automatic trigger', async () => {
		let called = false;
		await hooks.handler(['inbox-pickup', '--harness', 'cursor'], {}, '/repo', {
			fireAndForget: () => { called = true; },
		});
		expect(called).toBe(false);

		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'bin', 'forge.js'), 'utf8');
		expect(source).not.toMatch(/fireAndForget\s*\(/);
	});
});
