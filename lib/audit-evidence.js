const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VERDICT_LABELS = {
	PASS: 'good',
	FAIL: 'bad',
};

const REVIEWER_ROLES = new Set(['spec_reviewer', 'quality_reviewer']);
const SECRET_KEY_PATTERN = /(api(?:[_-]|\s)?key|authorization|credential|password|private(?:[_-]|\s)?key|secret|token)/i;
const SECRET_TEXT_KEY_PATTERN = String.raw`(?:api(?:[_-]|\s)?key|authorization|credential|password|private(?:[_-]|\s)?key|secret|token)`;
const SECRET_TEXT_PATTERNS = [
	{
		pattern: /\bBearer\s+\S+/gi,
		replace: () => 'Bearer [REDACTED]',
	},
	{
		pattern: new RegExp(`(\\b${SECRET_TEXT_KEY_PATTERN}\\b\\s*=\\s*)([^\\s&,]+)`, 'gi'),
		replace: (_match, prefix) => `${prefix}[REDACTED]`,
	},
	{
		pattern: new RegExp(`(\\b${SECRET_TEXT_KEY_PATTERN}\\b\\s+is\\s+)([^&,\r\n]+)`, 'gi'),
		replace: (_match, prefix) => `${prefix}[REDACTED]`,
	},
	{
		pattern: new RegExp(`(\\b${SECRET_TEXT_KEY_PATTERN}\\b\\s+)(?!is\\b)([^\\s]+)`, 'gi'),
		replace: (_match, prefix) => `${prefix}[REDACTED]`,
	},
	{
		pattern: new RegExp(
			`((?:"|')?${SECRET_TEXT_KEY_PATTERN}(?:"|')?\\s*:\\s*)(?:"[^"]*"|'[^']*'|[^,}\\]\r\n]+)`,
			'gi'
		),
		replace: (_match, prefix) => `${prefix}"[REDACTED]"`,
	},
	/\bsk-[A-Za-z0-9_-]{8,}\b/g,
];

function defaultRunCommand(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: options.cwd || process.cwd(),
		encoding: 'utf8',
		input: options.input,
		timeout: options.timeout || 120000,
	});
}

function redactString(value) {
	return SECRET_TEXT_PATTERNS.reduce(
		(current, entry) => {
			if (entry && typeof entry === 'object' && !(entry instanceof RegExp)) {
				return current.replace(entry.pattern, entry.replace);
			}
			return current.replace(entry, () => '[REDACTED]');
		},
		value,
	);
}

function redact(value, key = '') {
	if (SECRET_KEY_PATTERN.test(key)) {
		return '[REDACTED]';
	}

	if (typeof value === 'string') {
		return redactString(value);
	}

	if (Array.isArray(value)) {
		return value.map(item => redact(item));
	}

	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]),
		);
	}

	return value;
}

function asJsonString(value) {
	if (typeof value === 'string') return redactString(value);
	return JSON.stringify(redact(value));
}

function buildSubagentAuditPayload(event) {
	if (!event || typeof event !== 'object') {
		throw new TypeError('Audit event must be an object');
	}
	if (!event.command) {
		throw new TypeError('Audit event command is required');
	}
	if (!event.role) {
		throw new TypeError('Audit event role is required');
	}

	return {
		kind: 'llm_call',
		command: event.command,
		issueId: event.issueId,
		role: event.role,
		phase: event.phase,
		taskId: event.taskId,
		taskTitle: event.taskTitle,
		model: event.model || 'unknown',
		prompt: asJsonString({
			command: event.command,
			role: event.role,
			phase: event.phase,
			taskId: event.taskId,
			taskTitle: event.taskTitle,
			content: event.prompt || '',
		}),
		response: asJsonString({
			command: event.command,
			role: event.role,
			verdict: event.verdict || 'UNKNOWN',
			content: event.response || '',
		}),
		metadata: redact(event.metadata || {}),
		verdict: event.verdict,
	};
}

function parseRecordId(output) {
	if (!output) return null;
	try {
		const parsed = JSON.parse(output);
		return parsed.id || null;
	} catch (_error) {
		const match = /\bint-[A-Za-z0-9_-]+\b/.exec(String(output));
		return match ? match[0] : null;
	}
}

function hasAuditMetaJsonSupport(runCommand = defaultRunCommand, options = {}) {
	try {
		const output = runCommand('bd', ['audit', 'record', '--help'], options);
		return String(output).includes('--meta-json');
	} catch (_error) {
		return false;
	}
}

function writeFallbackMetadata(payload, entryId, options) {
	if (!entryId || !payload.metadata || Object.keys(payload.metadata).length === 0) {
		return null;
	}

	const cwd = options.cwd || process.cwd();
	const fsImpl = options.fs || fs;
	const forgeDir = path.join(cwd, '.forge').replace(/\\/g, '/');
	const logPath = path.join(forgeDir, 'log.jsonl').replace(/\\/g, '/');
	const line = {
		kind: 'forge.auditEvidence',
		sourceOfTruth: 'beads',
		beadsEntryId: entryId,
		command: redact(payload.command),
		role: redact(payload.role),
		phase: redact(payload.phase),
		taskId: redact(payload.taskId),
		taskTitle: redact(payload.taskTitle),
		metadata: redact(payload.metadata),
	};

	try {
		fsImpl.mkdirSync(forgeDir, { recursive: true });
		fsImpl.appendFileSync(logPath, `${JSON.stringify(line)}\n`);
		return { path: logPath, line };
	} catch (error) {
		return { path: logPath, line, skipped: true, error: error.message };
	}
}

function recordSubagentAuditEvent(event, options = {}) {
	const payload = buildSubagentAuditPayload(event);
	const runCommand = options.runCommand || defaultRunCommand;
	const metaJsonSupported =
		typeof options.metaJsonSupported === 'boolean'
			? options.metaJsonSupported
			: hasAuditMetaJsonSupport(runCommand, { cwd: options.cwd || process.cwd() });
	const args = [
		'audit',
		'record',
		'--json',
		'--kind',
		'llm_call',
	];

	if (payload.issueId) {
		args.push('--issue-id', payload.issueId);
	}

	args.push(
		'--model',
		payload.model,
		'--prompt',
		payload.prompt,
		'--response',
		payload.response,
	);

	if (metaJsonSupported && Object.keys(payload.metadata).length > 0) {
		args.push('--meta-json', JSON.stringify(payload.metadata));
	}

	const output = runCommand('bd', args, { cwd: options.cwd || process.cwd() });
	const entryId = parseRecordId(output);
	const fallback = metaJsonSupported ? null : writeFallbackMetadata(payload, entryId, options);

	return {
		success: Boolean(entryId),
		entryId,
		output,
		payload,
		fallback,
	};
}

function labelSubagentAuditEvent(entryId, event, options = {}) {
	const verdict = String(event?.verdict || '').toUpperCase();
	const role = event?.role;
	const label = VERDICT_LABELS[verdict];

	if (!entryId || !REVIEWER_ROLES.has(role) || !label) {
		return { skipped: true };
	}

	const runCommand = options.runCommand || defaultRunCommand;
	const reason = `${role} verdict: ${verdict}`;
	const output = runCommand('bd', [
		'audit',
		'label',
		entryId,
		'--json',
		'--label',
		label,
		'--reason',
		reason,
	], { cwd: options.cwd || process.cwd() });

	return {
		success: true,
		label,
		output,
	};
}

function recordAndLabelSubagentAuditEvent(event, options = {}) {
	const record = recordSubagentAuditEvent(event, options);
	const label = labelSubagentAuditEvent(record.entryId, event, options);
	return { record, label };
}

module.exports = {
	VERDICT_LABELS,
	buildSubagentAuditPayload,
	recordSubagentAuditEvent,
	labelSubagentAuditEvent,
	recordAndLabelSubagentAuditEvent,
	hasAuditMetaJsonSupport,
	redact,
};
