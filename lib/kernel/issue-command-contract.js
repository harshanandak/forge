'use strict';

const ISSUE_COMMAND_SCHEMA_VERSION = 'forge.issue.v1';
const ISSUE_COMMAND_ERROR_SCHEMA_VERSION = 'forge.issue.error.v1';

const ISSUE_COMMAND_EXIT_CODES = Object.freeze({
	success: 0,
	internal: 1,
	usage: 2,
	notFound: 3,
	conflict: 4,
	unavailable: 5,
	validation: 6,
});

// Canonical D18 taxonomy. Types and statuses are enforced at the validation layer
// (see taxonomy-validator), not as DB constraints, so label-based extensibility and
// derived readiness (ready/blocked) stay outside the stored status set.
const ISSUE_TYPES = Object.freeze(['epic', 'task', 'bug', 'decision']);
const ISSUE_STATUSES = Object.freeze(['open', 'in_progress', 'review', 'done', 'cancelled']);

function deepFreeze(value) {
	if (!value || typeof value !== 'object') return value;
	Object.freeze(value);
	for (const nestedValue of Object.values(value)) {
		deepFreeze(nestedValue);
	}
	return value;
}

const ISSUE_SUMMARY_SCHEMA = {
	type: 'object',
	required: ['id', 'title', 'type', 'status', 'revision'],
	properties: {
		id: { type: 'string' },
		title: { type: 'string' },
		body: { type: ['string', 'null'] },
		type: { enum: [...ISSUE_TYPES] },
		status: { enum: [...ISSUE_STATUSES] },
		priority: { type: 'string' },
		rank: { type: 'number' },
		revision: { type: 'integer', minimum: 0 },
		blocked: { type: 'boolean' },
		claimed_by: { type: ['string', 'null'] },
		// KAP-2: stored-but-previously-unprojected fields, surfaced for agents.
		parent_id: { type: ['string', 'null'] },
		labels: { type: 'array', items: { type: 'string' } },
		dependencies: { type: 'array', items: { type: 'string' } },
		created_at: { type: 'string' },
		updated_at: { type: 'string' },
	},
};

const NEXT_COMMANDS_SCHEMA = {
	type: 'array',
	items: { type: 'string' },
};

const ISSUE_COMMAND_RESPONSE_SCHEMAS = deepFreeze({
	issue: {
		type: 'object',
		required: ['ok', 'schema_version', 'command', 'data', 'next_commands'],
		properties: {
			ok: { const: true },
			schema_version: { const: ISSUE_COMMAND_SCHEMA_VERSION },
			command: { type: 'string' },
			data: ISSUE_SUMMARY_SCHEMA,
			next_commands: NEXT_COMMANDS_SCHEMA,
		},
	},
	issueList: {
		type: 'object',
		required: ['ok', 'schema_version', 'command', 'data', 'next_commands'],
		properties: {
			ok: { const: true },
			schema_version: { const: ISSUE_COMMAND_SCHEMA_VERSION },
			command: { type: 'string' },
			data: {
				type: 'object',
				required: ['issues'],
				properties: {
					issues: {
						type: 'array',
						items: ISSUE_SUMMARY_SCHEMA,
					},
					count: { type: 'integer', minimum: 0 },
					truncated: { type: 'boolean' },
				},
			},
			next_commands: NEXT_COMMANDS_SCHEMA,
		},
	},
	stats: {
		type: 'object',
		required: ['ok', 'schema_version', 'command', 'data', 'next_commands'],
		properties: {
			ok: { const: true },
			schema_version: { const: ISSUE_COMMAND_SCHEMA_VERSION },
			command: { type: 'string' },
			data: {
				type: 'object',
				required: ['counts'],
				properties: {
					counts: { type: 'object' },
					ready_count: { type: 'integer', minimum: 0 },
					blocked_count: { type: 'integer', minimum: 0 },
					active_claims: { type: 'integer', minimum: 0 },
				},
			},
			next_commands: NEXT_COMMANDS_SCHEMA,
		},
	},
	mutation: {
		type: 'object',
		required: ['ok', 'schema_version', 'command', 'data', 'next_commands'],
		properties: {
			ok: { const: true },
			schema_version: { const: ISSUE_COMMAND_SCHEMA_VERSION },
			command: { type: 'string' },
			data: {
				type: 'object',
				required: ['id', 'revision'],
				properties: {
					id: { type: 'string' },
					revision: { type: 'integer', minimum: 0 },
					issue: ISSUE_SUMMARY_SCHEMA,
					comment_id: { type: 'string' },
					dependency_id: { type: 'string' },
					claim_id: { type: 'string' },
					projection: {
						type: 'object',
						properties: {
							status: { type: 'string' },
							targets: { type: 'array', items: { type: 'string' } },
						},
					},
				},
			},
			next_commands: NEXT_COMMANDS_SCHEMA,
		},
	},
});

const ISSUE_COMMAND_ERROR_SCHEMA = deepFreeze({
	type: 'object',
	required: ['ok', 'schema_version', 'command', 'error', 'next_commands'],
	properties: {
		ok: { const: false },
		schema_version: { const: ISSUE_COMMAND_ERROR_SCHEMA_VERSION },
		command: { type: 'string' },
		error: {
			type: 'object',
			required: ['code', 'message', 'exit_code', 'retryable'],
			properties: {
				code: { type: 'string' },
				message: { type: 'string' },
				exit_code: { type: 'integer' },
				retryable: { type: 'boolean' },
				details: { type: 'object' },
			},
		},
		next_commands: NEXT_COMMANDS_SCHEMA,
	},
});

function command(id, invocation, operation, mode, outputSchema, nextCommands) {
	return {
		id,
		invocation,
		operation,
		mode,
		schemaVersion: ISSUE_COMMAND_SCHEMA_VERSION,
		outputSchema,
		errorShape: ISSUE_COMMAND_ERROR_SCHEMA_VERSION,
		exitCodes: ISSUE_COMMAND_EXIT_CODES,
		nextCommands,
	};
}

const COMMANDS = [
	command('issue.ready', 'forge issue ready --json', 'ready', 'read', ISSUE_COMMAND_RESPONSE_SCHEMAS.issueList, [
		'forge claim <id>',
		'forge issue show <id> --json',
	]),
	command('issue.list', 'forge issue list --json', 'list', 'read', ISSUE_COMMAND_RESPONSE_SCHEMAS.issueList, [
		'forge issue show <id> --json',
		'forge issue search <query> --json',
	]),
	command('issue.show', 'forge issue show <id> --json', 'show', 'read', ISSUE_COMMAND_RESPONSE_SCHEMAS.issue, [
		'forge claim <id>',
		'forge issue comment <id> "<note>"',
	]),
	command('issue.search', 'forge issue search <query> --json', 'search', 'read', ISSUE_COMMAND_RESPONSE_SCHEMAS.issueList, [
		'forge issue show <id> --json',
		'forge claim <id>',
	]),
	command('issue.stats', 'forge issue stats --json', 'stats', 'read', ISSUE_COMMAND_RESPONSE_SCHEMAS.stats, [
		'forge issue ready --json',
		'forge issue list --json',
	]),
	command('issue.create', 'forge issue create', 'create', 'mutation', ISSUE_COMMAND_RESPONSE_SCHEMAS.mutation, [
		'forge issue show <id> --json',
		'forge claim <id>',
	]),
	command('issue.update', 'forge issue update', 'update', 'mutation', ISSUE_COMMAND_RESPONSE_SCHEMAS.mutation, [
		'forge issue show <id> --json',
	]),
	command('issue.close', 'forge issue close', 'close', 'mutation', ISSUE_COMMAND_RESPONSE_SCHEMAS.mutation, [
		'forge issue ready --json',
	]),
	command('issue.comment', 'forge issue comment', 'comment', 'mutation', ISSUE_COMMAND_RESPONSE_SCHEMAS.mutation, [
		'forge issue show <id> --json',
	]),
	command('issue.dep.add', 'forge issue dep add', 'dep.add', 'mutation', ISSUE_COMMAND_RESPONSE_SCHEMAS.mutation, [
		'forge issue show <id> --json',
		'forge issue ready --json',
	]),
	command('issue.dep.remove', 'forge issue dep remove', 'dep.remove', 'mutation', ISSUE_COMMAND_RESPONSE_SCHEMAS.mutation, [
		'forge issue ready --json',
	]),
	command('claim', 'forge claim <id>', 'claim', 'mutation', ISSUE_COMMAND_RESPONSE_SCHEMAS.mutation, [
		'forge issue show <id> --json',
		'forge release <id>',
	]),
	command('release', 'forge release <id>', 'release', 'mutation', ISSUE_COMMAND_RESPONSE_SCHEMAS.mutation, [
		'forge issue ready --json',
	]),
];

const ISSUE_COMMAND_CONTRACT = deepFreeze({
	version: ISSUE_COMMAND_SCHEMA_VERSION,
	errorSchemaVersion: ISSUE_COMMAND_ERROR_SCHEMA_VERSION,
	commands: COMMANDS,
	exitCodes: ISSUE_COMMAND_EXIT_CODES,
});

const COMMAND_BY_ID = new Map(ISSUE_COMMAND_CONTRACT.commands.map(candidate => [candidate.id, candidate]));

function getIssueCommandContract(id) {
	return COMMAND_BY_ID.get(id) || null;
}

function formatIssueCommandError(options = {}) {
	const error = {
		code: options.code || 'FORGE_ISSUE_ERROR',
		message: options.message || 'Forge issue command failed',
		exit_code: Number.isInteger(options.exitCode) ? options.exitCode : ISSUE_COMMAND_EXIT_CODES.internal,
		retryable: Boolean(options.retryable),
	};

	if (options.details && typeof options.details === 'object') {
		error.details = options.details;
	}

	return {
		ok: false,
		schema_version: ISSUE_COMMAND_ERROR_SCHEMA_VERSION,
		command: options.command || 'forge issue',
		error,
		next_commands: Array.isArray(options.nextCommands) ? options.nextCommands : [],
	};
}

module.exports = {
	ISSUE_COMMAND_CONTRACT,
	ISSUE_COMMAND_ERROR_SCHEMA,
	ISSUE_COMMAND_ERROR_SCHEMA_VERSION,
	ISSUE_COMMAND_EXIT_CODES,
	ISSUE_COMMAND_RESPONSE_SCHEMAS,
	ISSUE_COMMAND_SCHEMA_VERSION,
	ISSUE_STATUSES,
	ISSUE_TYPES,
	formatIssueCommandError,
	getIssueCommandContract,
};
