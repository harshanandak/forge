'use strict';

const { describe, expect, test } = require('bun:test');

describe('KernelIssueAdapter', () => {
	test('implements the IssueAdapter contract over a Kernel broker', () => {
		const { validateIssueAdapter } = require('../../lib/issue-adapter');
		const { KernelIssueAdapter } = require('../../lib/adapters/kernel-issue-adapter');

		const adapter = new KernelIssueAdapter({
			broker: {
				async runIssueOperation() {
					return { success: true };
				},
			},
		});

		expect(adapter.id).toBe('kernel-local');
		expect(adapter.kind).toBe('issue');
		expect(validateIssueAdapter(adapter)).toEqual({ valid: true, errors: [] });
	});

	test('delegates representative command API operations to the broker boundary', async () => {
		const { KernelIssueAdapter } = require('../../lib/adapters/kernel-issue-adapter');
		const calls = [];
		const adapter = new KernelIssueAdapter({
			broker: {
				async runIssueOperation(operation, args, context) {
					calls.push({ operation, args, context });
					return { success: true, operation, output: `${operation}:ok` };
				},
			},
		});
		const context = { projectRoot: '/repo', deps: { source: 'test' } };

		await expect(adapter.list(['--json'], context)).resolves.toMatchObject({ operation: 'list' });
		await expect(adapter.ready([], context)).resolves.toMatchObject({ operation: 'ready' });
		await expect(adapter.read(['forge-1'], context)).resolves.toMatchObject({ operation: 'show' });
		await expect(adapter.update(['forge-1', '--status', 'in_progress'], context)).resolves.toMatchObject({ operation: 'update' });
		await expect(adapter.claim(['forge-1'], context)).resolves.toMatchObject({ operation: 'claim' });
		await expect(adapter.close(['forge-1'], context)).resolves.toMatchObject({ operation: 'close' });
		await expect(adapter.comment(['forge-1', 'handoff'], context)).resolves.toMatchObject({ operation: 'comment' });

		expect(calls.map(call => [call.operation, call.args])).toEqual([
			['list', ['--json']],
			['ready', []],
			['show', ['forge-1']],
			['update', ['forge-1', '--status', 'in_progress']],
			['claim', ['forge-1']],
			['close', ['forge-1']],
			['comment', ['forge-1', 'handoff']],
		]);
		expect(calls[0].context).toBe(context);
	});
});
