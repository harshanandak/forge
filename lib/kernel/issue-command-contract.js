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
// Canonical priority labels P0..P4. The bare integers 0..4 are also accepted on input
// (the CLI documents `--priority 1`; normalizePriority maps ranks 0..4) — see
// isValidIssuePriority. P5+ / non-numeric labels are rejected at the validation layer,
// matching MAX_DISPLAY_PRIORITY_RANK in taxonomy-validator.
const ISSUE_PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3', 'P4']);

// True when `priority` is a canonical P0..P4 label (case-insensitive) or a bare
// integer 0..4. Used by the create/update validation gate to reject junk priorities
// (P9, BOGUS, -1) instead of persisting them verbatim — Beads rejected them too.
function isValidIssuePriority(priority) {
	if (typeof priority === 'number') {
		return Number.isInteger(priority) && priority >= 0 && priority <= 4;
	}
	if (typeof priority !== 'string') return false;
	const raw = priority.trim().toUpperCase();
	const match = /^P?([0-9]+)$/.exec(raw);
	if (!match) return false;
	const rank = Number(match[1]);
	return rank >= 0 && rank <= 4;
}

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
		// Epic/reverse-dependency exposure: `dependents` are the ids that depend on this
		// issue (inverse of `dependencies`); `blocked_by` is the readiness model's live
		// blocker subset. Additive superset on every read op (schema is permissive —
		// no additionalProperties:false — so older consumers still validate).
		dependents: { type: 'array', items: { type: 'string' } },
		blocked_by: { type: 'array', items: { type: 'string' } },
		created_at: { type: 'string' },
		updated_at: { type: 'string' },
		// KAP-10 (acceptance_criteria/design/notes) + KAP-11 (assignee): nullable
		// content fields and a persistent assignee. Optional (NOT required) so summaries
		// that omit them still validate.
		acceptance_criteria: { type: ['string', 'null'] },
		design: { type: ['string', 'null'] },
		notes: { type: ['string', 'null'] },
		assignee: { type: ['string', 'null'] },
		// KAP-3: `show` attaches the issue's comments; other reads (list/ready/search/
		// stats) omit the key. Optional (NOT in required) so comment-less summaries still
		// validate. Each item carries id/body/actor/created_at (body may be null).
		comments: {
			type: 'array',
			items: {
				type: 'object',
				required: ['id', 'body', 'actor', 'created_at'],
				properties: {
					id: { type: 'string' },
					body: { type: ['string', 'null'] },
					actor: { type: 'string' },
					created_at: { type: 'string' },
				},
			},
		},
		// KAP-12: `lint` attaches a content-validation result to each FAILING issue;
		// other reads (list/ready/search/...) omit the key. Optional (NOT in required)
		// so validation-less summaries still validate. rules_failed names the broken
		// content rules (e.g. 'missing_acceptance_criteria').
		validation: {
			type: 'object',
			required: ['rules_failed'],
			properties: {
				rules_failed: { type: 'array', items: { type: 'string' } },
			},
		},
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
	// KAP-7: derived read responses. `blocked` and `orphans` reuse the issueList
	// shape above (an array of ISSUE_SUMMARY_SCHEMA + count). `stale` reuses that
	// shape and additionally carries the threshold_days (in days) the staleness
	// window was computed against.
	staleList: {
		type: 'object',
		required: ['ok', 'schema_version', 'command', 'data', 'next_commands'],
		properties: {
			ok: { const: true },
			schema_version: { const: ISSUE_COMMAND_SCHEMA_VERSION },
			command: { type: 'string' },
			data: {
				type: 'object',
				required: ['issues', 'count', 'threshold_days'],
				properties: {
					issues: {
						type: 'array',
						items: ISSUE_SUMMARY_SCHEMA,
					},
					count: { type: 'integer', minimum: 0 },
					threshold_days: { type: 'integer' },
				},
			},
			next_commands: NEXT_COMMANDS_SCHEMA,
		},
	},
	// Epic support: `children` returns the epic header, its DIRECT children (each a full
	// ISSUE_SUMMARY_SCHEMA), and a kernel-computed rollup. The rollup owns the status
	// vocabulary so consumers never hard-code status names; `percentage` is done-only.
	children: {
		type: 'object',
		required: ['ok', 'schema_version', 'command', 'data', 'next_commands'],
		properties: {
			ok: { const: true },
			schema_version: { const: ISSUE_COMMAND_SCHEMA_VERSION },
			command: { type: 'string' },
			data: {
				type: 'object',
				required: ['epic', 'children', 'rollup', 'count'],
				properties: {
					epic: {
						type: 'object',
						required: ['id', 'title', 'type', 'status'],
						properties: {
							id: { type: 'string' },
							title: { type: 'string' },
							type: { enum: [...ISSUE_TYPES] },
							status: { enum: [...ISSUE_STATUSES] },
						},
					},
					children: {
						type: 'array',
						items: ISSUE_SUMMARY_SCHEMA,
					},
					rollup: {
						type: 'object',
						required: ['total', 'done', 'percentage', 'by_status'],
						properties: {
							total: { type: 'integer', minimum: 0 },
							done: { type: 'integer', minimum: 0 },
							in_progress: { type: 'integer', minimum: 0 },
							open: { type: 'integer', minimum: 0 },
							review: { type: 'integer', minimum: 0 },
							cancelled: { type: 'integer', minimum: 0 },
							blocked: { type: 'integer', minimum: 0 },
							percentage: { type: 'integer', minimum: 0 },
							by_status: { type: 'object' },
						},
					},
					count: { type: 'integer', minimum: 0 },
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
					// KAP-8: close only — ids that became ready now the issue is done.
					// OPTIONAL (not in `required`) so every other mutation still validates.
					newly_unblocked: { type: 'array', items: { type: 'string' } },
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
	// Multi-id close (`forge issue close <a> <b> ...`). The kernel close op closes a
	// SINGLE id, so the CLI fans out one mutation per id and aggregates the outcomes
	// into ONE envelope (never a bare array — that broke envelope parity). `ok` is a
	// plain boolean here (true only when EVERY id closed); per-id outcomes live in
	// `data.results`, and `data.closed` lists the ids that reached terminal state.
	// Each result echoes the single-close mutation fields (revision/newly_unblocked)
	// on success or the forge.issue.error.v1 `error` object on failure.
	mutationBatch: {
		type: 'object',
		required: ['ok', 'schema_version', 'command', 'data', 'next_commands'],
		properties: {
			ok: { type: 'boolean' },
			schema_version: { const: ISSUE_COMMAND_SCHEMA_VERSION },
			command: { type: 'string' },
			data: {
				type: 'object',
				required: ['results', 'count', 'closed'],
				properties: {
					results: {
						type: 'array',
						items: {
							type: 'object',
							required: ['id', 'ok'],
							properties: {
								id: { type: 'string' },
								ok: { type: 'boolean' },
								revision: { type: 'integer', minimum: 0 },
								newly_unblocked: { type: 'array', items: { type: 'string' } },
								error: { type: 'object' },
							},
						},
					},
					count: { type: 'integer', minimum: 0 },
					closed: { type: 'array', items: { type: 'string' } },
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
	command('issue.blocked', 'forge blocked --json', 'blocked', 'read', ISSUE_COMMAND_RESPONSE_SCHEMAS.issueList, [
		'forge issue show <id> --json',
		'forge issue ready --json',
	]),
	command('issue.stale', 'forge stale --json', 'stale', 'read', ISSUE_COMMAND_RESPONSE_SCHEMAS.staleList, [
		'forge issue show <id> --json',
		'forge issue update <id>',
	]),
	command('issue.orphans', 'forge orphans --json', 'orphans', 'read', ISSUE_COMMAND_RESPONSE_SCHEMAS.issueList, [
		'forge issue show <id> --json',
		'forge issue dep add <issue-id> <blocks-issue-id>',
	]),
	command('issue.lint', 'forge lint --json', 'lint', 'read', ISSUE_COMMAND_RESPONSE_SCHEMAS.issueList, [
		'forge issue show <id> --json',
		'forge issue update <id> --acceptance "<criteria>"',
	]),
	command('issue.children', 'forge issue children <id> --json', 'children', 'read', ISSUE_COMMAND_RESPONSE_SCHEMAS.children, [
		'forge issue show <id> --json',
		'forge claim <id>',
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

// Resolve the catalog next_commands for a command, substituting the concrete issue
// id into the `<id>` placeholder when the response carries a single id (show and the
// mutation responses). Multi-issue responses (list/ready/blocked/...) keep the
// `<id>` template since there is no single id to bind. Unknown commands → [].
function resolveNextCommands(commandId, data = {}) {
	const contract = COMMAND_BY_ID.get(commandId);
	const templates = contract ? contract.nextCommands : [];
	// Most single-id responses store the id at `data.id`; `issue.children` instead
	// anchors on the epic, so fall back to `data.epic.id` — otherwise its
	// next_commands would emit literal `<id>` placeholders.
	const id = data && typeof data.id === 'string'
		? data.id
		: (data && data.epic && typeof data.epic.id === 'string' ? data.epic.id : null);
	return id ? templates.map(entry => entry.replace(/<id>/g, id)) : [...templates];
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
	ISSUE_PRIORITIES,
	ISSUE_STATUSES,
	ISSUE_TYPES,
	formatIssueCommandError,
	getIssueCommandContract,
	isValidIssuePriority,
	resolveNextCommands,
};
