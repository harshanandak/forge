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
			['search', ['kernel contract']],
			['stats', ['--json']],
			['blocked', []],
			['stale', ['--days', '7']],
			['orphans', []],
			['read', ['forge-1']],
			['update', ['forge-1', '--status', 'in_progress']],
			['claim', ['forge-1']],
			['release', ['forge-1']],
			['close', ['forge-1']],
			['comment', ['forge-1', 'handoff']],
			['depAdd', ['forge-1', 'forge-2']],
			['depRemove', ['forge-1', 'forge-2']],
		];

		for (const [methodName, args] of scenarios) {
			await expect(adapter[methodName](args, context))
				.resolves.toMatchObject({ operation: KERNEL_ISSUE_OPERATIONS[methodName] });
		}

		expect(calls.map(call => [call.operation, call.args]))
			.toEqual(scenarios.map(([methodName, args]) => [KERNEL_ISSUE_OPERATIONS[methodName], args]));
		expect(calls[0].context).toBe(context);
	});

	test('exposes a dep operation that dispatches add/remove by the leading action', async () => {
		// The CLI surface is `forge issue dep <add|remove> <ids...>`, so the adapter
		// exposes a single `dep` operation that routes the leading action to the
		// broker's dep.add / dep.remove. This keeps the de-beaded _issue.js dep
		// subcommand routable through one runIssueOperation('dep', ...) call.
		const { KernelIssueAdapter } = require('../../lib/adapters/kernel-issue-adapter');
		const calls = [];
		const adapter = new KernelIssueAdapter({
			broker: {
				async runIssueOperation(operation, args, context) {
					calls.push({ operation, args, context });
					return { success: true, operation };
				},
			},
		});
		const context = { projectRoot: '/repo' };

		await expect(adapter.dep(['add', 'forge-1', 'forge-2'], context))
			.resolves.toMatchObject({ operation: 'dep.add' });
		await expect(adapter.dep(['remove', 'forge-1', 'forge-2'], context))
			.resolves.toMatchObject({ operation: 'dep.remove' });

		expect(calls.map(call => [call.operation, call.args])).toEqual([
			['dep.add', ['forge-1', 'forge-2']],
			['dep.remove', ['forge-1', 'forge-2']],
		]);
	});

	test('dep rejects an unknown leading action without hitting the broker', async () => {
		const { KernelIssueAdapter } = require('../../lib/adapters/kernel-issue-adapter');
		let brokerCalls = 0;
		const adapter = new KernelIssueAdapter({
			broker: {
				async runIssueOperation() {
					brokerCalls += 1;
					return { success: true };
				},
			},
		});

		const result = await adapter.dep(['bogus', 'forge-1', 'forge-2'], {});
		expect(result.success).toBe(false);
		expect(result.error).toContain('bogus');
		expect(brokerCalls).toBe(0);
	});
});
