'use strict';

const { describe, expect, test } = require('bun:test');

describe('forge comment command', () => {
	test('exports a top-level comment alias through the shared issue command surface', async () => {
		const comment = require('../../lib/commands/comment');
		const calls = [];

		const result = await comment.handler(['forge-1', 'handoff note'], {}, '/repo', {
			runIssueOperation: async (operation, args, projectRoot) => {
				calls.push({ operation, args, projectRoot });
				return { success: true, operation };
			},
		});

		expect(comment.name).toBe('comment');
		expect(result).toEqual({ success: true, operation: 'comment' });
		expect(calls).toEqual([{
			operation: 'comment',
			args: ['forge-1', 'handoff note'],
			projectRoot: '/repo',
		}]);
	});
});
