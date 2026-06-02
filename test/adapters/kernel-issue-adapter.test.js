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
		const {
			KERNEL_ISSUE_OPERATIONS,
			KernelIssueAdapter,
		} = require('../../lib/adapters/kernel-issue-adapter');
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
		const scenarios = [
			['list', ['--json']],
			['ready', []],
			['read', ['forge-1']],
			['update', ['forge-1', '--status', 'in_progress']],
			['claim', ['forge-1']],
			['close', ['forge-1']],
			['comment', ['forge-1', 'handoff']],
		];

		for (const [methodName, args] of scenarios) {
			await expect(adapter[methodName](args, context))
				.resolves.toMatchObject({ operation: KERNEL_ISSUE_OPERATIONS[methodName] });
		}

		expect(calls.map(call => [call.operation, call.args]))
			.toEqual(scenarios.map(([methodName, args]) => [KERNEL_ISSUE_OPERATIONS[methodName], args]));
		expect(calls[0].context).toBe(context);
	});
});
