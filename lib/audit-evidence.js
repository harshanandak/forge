const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { appendCappedJsonlRecord } = require('./capped-jsonl-log');

/**
 * Subagent evidence lands in the local append-only log D25 specifies, now that
 * the Beads audit CLI is retired along with the rest of the Beads runtime. The
 * log is the only copy of an entry, so a record carries the prompt and response
 * the Beads entry used to hold; it is capped like the protected-state log so a
 * long dev run cannot grow it unbounded.
 */
const AUDIT_EVIDENCE_LOG = '.forge/log.jsonl';
const AUDIT_EVIDENCE_MAX_RECORDS = 500;

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
		pattern: new RegExp(`(\\b${SECRET_TEXT_KEY_PATTERN}\\b\\s*=\\s*)([^&,\r\n]+)`, 'gi'),
		replace: (_match, prefix) => `${prefix}[REDACTED]`,
	},
	{
		pattern: new RegExp(`(\\b${SECRET_TEXT_KEY_PATTERN}\\b\\s+is\\s+)([^&,\r\n]+)`, 'gi'),
		replace: (_match, prefix) => `${prefix}[REDACTED]`,
	},
	{
		pattern: new RegExp(
			`(\\b${SECRET_TEXT_KEY_PATTERN}\\b\\s+)(?!is\\b)([^&,\r\n]*?)(?=\\s+\\b${SECRET_TEXT_KEY_PATTERN}\\b\\s+|[&,\r\n]|$)`,
			'gi'
		),
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

	const metadata =
		event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
			? event.metadata
			: {};

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
		metadata: redact(metadata),
		verdict: event.verdict,
	};
}

/**
 * Best-effort: a failed append is reported back to the caller, never thrown, so
 * losing the evidence can never fail the command that produced it.
 */
function appendAuditRecord(record, options) {
	const logPath = path.resolve(options.cwd || process.cwd(), AUDIT_EVIDENCE_LOG);
	const appendRecord = options.appendRecord || appendCappedJsonlRecord;

	try {
		appendRecord(logPath, record, options.maxRecords || AUDIT_EVIDENCE_MAX_RECORDS);
		return { success: true, logPath };
	} catch (error) {
		return { success: false, logPath, error: error.message };
	}
}

function buildAuditEvidenceRecord(payload, entryId, recordedAt) {
	return {
		kind: 'forge.auditEvidence',
		sourceOfTruth: 'forge_log',
		entryId,
		recordedAt,
		command: redact(payload.command),
		issueId: redact(payload.issueId),
		role: redact(payload.role),
		phase: redact(payload.phase),
		taskId: redact(payload.taskId),
		taskTitle: redact(payload.taskTitle),
		model: redact(payload.model),
		verdict: payload.verdict,
		// Already redacted by buildSubagentAuditPayload.
		prompt: payload.prompt,
		response: payload.response,
		metadata: payload.metadata,
	};
}

function recordSubagentAuditEvent(event, options = {}) {
	const payload = buildSubagentAuditPayload(event);
	const entryId = (options.newId || randomUUID)();
	const record = buildAuditEvidenceRecord(
		payload,
		entryId,
		options.now || new Date().toISOString(),
	);
	const written = appendAuditRecord(record, options);

	const result = {
		success: written.success,
		entryId: written.success ? entryId : null,
		record,
		payload,
		logPath: written.logPath,
	};
	if (!written.success) result.error = written.error;
	return result;
}

function labelSubagentAuditEvent(entryId, event, options = {}) {
	const verdict = String(event?.verdict || '').toUpperCase();
	const role = event?.role;
	const label = VERDICT_LABELS[verdict];

	if (!entryId || !REVIEWER_ROLES.has(role) || !label) {
		return { skipped: true };
	}

	// A label is its own record rather than a rewrite of the recorded entry: the
	// log is append-only, so a verdict is read by joining on entryId.
	const record = {
		kind: 'forge.auditEvidenceLabel',
		sourceOfTruth: 'forge_log',
		entryId,
		recordedAt: options.now || new Date().toISOString(),
		role,
		verdict,
		label,
		reason: `${role} verdict: ${verdict}`,
	};
	const written = appendAuditRecord(record, options);

	const result = {
		success: written.success,
		label,
		entryId: written.success ? entryId : null,
		record,
		logPath: written.logPath,
	};
	if (!written.success) result.error = written.error;
	return result;
}

function recordAndLabelSubagentAuditEvent(event, options = {}) {
	const record = recordSubagentAuditEvent(event, options);
	const label = labelSubagentAuditEvent(record.entryId, event, options);
	return { record, label };
}

module.exports = {
	AUDIT_EVIDENCE_LOG,
	AUDIT_EVIDENCE_MAX_RECORDS,
	VERDICT_LABELS,
	buildSubagentAuditPayload,
	recordSubagentAuditEvent,
	labelSubagentAuditEvent,
	recordAndLabelSubagentAuditEvent,
	redact,
};
