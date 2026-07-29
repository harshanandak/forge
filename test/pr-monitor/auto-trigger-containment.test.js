'use strict';

const { describe, test, expect } = require('bun:test');
const { fireAndForget } = require('../../lib/pr-monitor/reconcile-executor');

describe('automatic singleton trigger containment', () => {
	test.each([
		['CI', { env: { CI: '1' } }],
		['test', { env: { NODE_ENV: 'test' } }],
		['dry-run', { env: {}, dryRun: true }],
		['uninitialized', { env: {}, initialized: false }],
		['operator disabled', { env: { FORGE_SHEPHERD_DISABLE: '1' } }],
		['rail disabled', { env: {}, rail: false }],
	])('%s context is inert before lease/process work', (_name, scenario) => {
		let acquired = false;
		fireAndForget({
			projectRoot: '/repo',
			gitCommonDir: '/repo/.git',
			env: scenario.env,
			dryRun: scenario.dryRun,
			kernelInitialized: () => scenario.initialized !== false,
			railEnabled: () => scenario.rail !== false,
			acquire: () => { acquired = true; return { ok: true, token: 't' }; },
			tick: ({ enumerate, execute }) => { enumerate(); execute(); },
		});
		expect(acquired).toBe(false);
	});
});
