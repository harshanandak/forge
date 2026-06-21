'use strict';

const { describe, expect, test } = require('bun:test');

describe('Kernel issue command contract', () => {
	test('exports stable command schemas for issue reads and mutations', () => {
		const {
			ISSUE_COMMAND_CONTRACT,
			ISSUE_COMMAND_RESPONSE_SCHEMAS,
			getIssueCommandContract,
		} = require('../../lib/kernel/issue-command-contract');

		expect(ISSUE_COMMAND_CONTRACT.version).toBe('forge.issue.v1');
		expect(ISSUE_COMMAND_CONTRACT.commands.map(command => command.id)).toEqual([
			'issue.ready',
			'issue.list',
			'issue.show',
			'issue.search',
			'issue.stats',
			'issue.blocked',
			'issue.stale',
			'issue.orphans',
			'issue.lint',
			'issue.create',
			'issue.update',
			'issue.close',
			'issue.comment',
			'issue.dep.add',
			'issue.dep.remove',
			'claim',
			'release',
		]);

		for (const command of ISSUE_COMMAND_CONTRACT.commands) {
			expect(command.schemaVersion).toBe('forge.issue.v1');
			expect(command.outputSchema).toBeDefined();
			expect(command.nextCommands).toBeArray();
			expect(command.exitCodes.success).toBe(0);
			expect(command.errorShape).toBe('forge.issue.error.v1');
		}

		expect(getIssueCommandContract('issue.show')).toMatchObject({
			id: 'issue.show',
			invocation: 'forge issue show <id> --json',
			operation: 'show',
			mode: 'read',
		});
		expect(getIssueCommandContract('release')).toMatchObject({
			id: 'release',
			invocation: 'forge release <id>',
			operation: 'release',
			mode: 'mutation',
		});

		expect(ISSUE_COMMAND_RESPONSE_SCHEMAS.issue.required).toEqual([
			'ok',
			'schema_version',
			'command',
			'data',
			'next_commands',
		]);
		expect(ISSUE_COMMAND_RESPONSE_SCHEMAS.issueList.required).toContain('next_commands');
		expect(ISSUE_COMMAND_RESPONSE_SCHEMAS.mutation.properties.data.required)
			.toContain('revision');

		// KAP-8: close adds an OPTIONAL newly_unblocked string[]; it must be declared in
		// properties but NOT required, so non-close mutation responses still validate.
		expect(ISSUE_COMMAND_RESPONSE_SCHEMAS.mutation.properties.data.properties.newly_unblocked)
			.toEqual({ type: 'array', items: { type: 'string' } });
		expect(ISSUE_COMMAND_RESPONSE_SCHEMAS.mutation.properties.data.required)
			.not.toContain('newly_unblocked');

		// KAP-7: blocked/orphans reuse the issueList shape; stale adds threshold_days.
		expect(ISSUE_COMMAND_RESPONSE_SCHEMAS.staleList.required).toContain('next_commands');
		expect(ISSUE_COMMAND_RESPONSE_SCHEMAS.staleList.properties.data.properties.threshold_days)
			.toEqual({ type: 'integer' });
		expect(ISSUE_COMMAND_RESPONSE_SCHEMAS.staleList.properties.data.properties.issues.items)
			.toBe(ISSUE_COMMAND_RESPONSE_SCHEMAS.issueList.properties.data.properties.issues.items);

		// KAP-12: `lint` reuses the issueList shape (array of ISSUE_SUMMARY_SCHEMA +
		// count). The summary schema declares an OPTIONAL `validation` object so lint
		// items can carry rules_failed without breaking comment-less/validation-less
		// summaries, and it stays OUT of `required`.
		expect(getIssueCommandContract('issue.lint')).toMatchObject({
			id: 'issue.lint',
			operation: 'lint',
			mode: 'read',
			outputSchema: ISSUE_COMMAND_RESPONSE_SCHEMAS.issueList,
		});
		expect(ISSUE_COMMAND_RESPONSE_SCHEMAS.issueList.properties.data.properties.issues.items
			.properties.validation).toBeDefined();
		expect(ISSUE_COMMAND_RESPONSE_SCHEMAS.issueList.required).not.toContain('validation');
	});

	test('KAP-3: issue summary schema declares an optional comments array', () => {
		const { ISSUE_COMMAND_RESPONSE_SCHEMAS } = require('../../lib/kernel/issue-command-contract');
		// The show response's data is the issue summary schema; comments live there.
		const summarySchema = ISSUE_COMMAND_RESPONSE_SCHEMAS.issue.properties.data;
		const comments = summarySchema.properties.comments;

		// Existence first (clean RED — never a TypeError on undefined.type).
		expect(comments).toBeDefined();
		expect(comments.type).toBe('array');
		// Each item exposes id/body/actor/created_at; body may be null.
		expect(comments.items.type).toBe('object');
		expect(comments.items.properties.id).toBeDefined();
		expect(comments.items.properties.body).toBeDefined();
		expect(comments.items.properties.actor).toBeDefined();
		expect(comments.items.properties.created_at).toBeDefined();

		// Optional: comments must NOT be in required, so list/ready summaries (no
		// comments) still validate against the same summary schema.
		expect(summarySchema.required).not.toContain('comments');
	});

	test('defines a stable error envelope and meaningful exit codes', () => {
		const {
			ISSUE_COMMAND_ERROR_SCHEMA,
			ISSUE_COMMAND_EXIT_CODES,
			formatIssueCommandError,
		} = require('../../lib/kernel/issue-command-contract');

		expect(ISSUE_COMMAND_EXIT_CODES).toEqual({
			success: 0,
			internal: 1,
			usage: 2,
			notFound: 3,
			conflict: 4,
			unavailable: 5,
			validation: 6,
		});
		expect(ISSUE_COMMAND_ERROR_SCHEMA.required).toEqual([
			'ok',
			'schema_version',
			'command',
			'error',
			'next_commands',
		]);
		expect(ISSUE_COMMAND_ERROR_SCHEMA.properties.error.required).toEqual([
			'code',
			'message',
			'exit_code',
			'retryable',
		]);

		expect(formatIssueCommandError({
			command: 'forge issue show forge-missing --json',
			code: 'ISSUE_NOT_FOUND',
			message: 'Issue not found: forge-missing',
			exitCode: ISSUE_COMMAND_EXIT_CODES.notFound,
			retryable: false,
			nextCommands: ['forge issue search "forge-missing" --json'],
		})).toEqual({
			ok: false,
			schema_version: 'forge.issue.error.v1',
			command: 'forge issue show forge-missing --json',
			error: {
				code: 'ISSUE_NOT_FOUND',
				message: 'Issue not found: forge-missing',
				exit_code: 3,
				retryable: false,
			},
			next_commands: ['forge issue search "forge-missing" --json'],
		});
	});
});
