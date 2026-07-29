'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, test, expect } = require('bun:test');

const hooks = require('../../lib/commands/hooks');
const push = require('../../lib/commands/push');
const { executeShip, maybeTriggerShepherdAfterShip } = require('../../lib/commands/ship');

function successfulPushDeps(fireAndForget) {
	return {
		execFileSync: () => '',
		spawnSync: () => ({ status: 0 }),
		existsSync: () => true,
		log: () => {},
		writeForgeToken: () => {},
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
