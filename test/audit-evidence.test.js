const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, test, expect } = require('bun:test');
const {
	AUDIT_EVIDENCE_LOG,
	AUDIT_EVIDENCE_MAX_RECORDS,
	buildSubagentAuditPayload,
	recordSubagentAuditEvent,
	labelSubagentAuditEvent,
	recordAndLabelSubagentAuditEvent,
	VERDICT_LABELS,
} = require('../lib/audit-evidence');

function createSinkDouble() {
	const appends = [];
	return {
		appends,
		appendRecord: (logPath, record, maxRecords) => {
			appends.push({ logPath, record, maxRecords });
		},
	};
}

function createIdSequence(prefix = 'evi') {
	let next = 0;
	return () => {
		next += 1;
		return `${prefix}-${next}`;
	};
}

const tempRoots = [];

function createTempRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-audit-evidence-'));
	tempRoots.push(root);
	return root;
}

function readLog(root) {
	return fs
		.readFileSync(path.join(root, AUDIT_EVIDENCE_LOG), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

afterEach(() => {
	while (tempRoots.length > 0) {
		fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
	}
});

describe('audit evidence adapter', () => {
	test('builds redaction-safe implementer event payloads', () => {
		const payload = buildSubagentAuditPayload({
			command: 'dev',
			issueId: 'forge-besw.20',
			role: 'implementer',
			phase: 'GREEN',
			taskId: 'task-1',
			taskTitle: 'Wire audit evidence',
			model: 'gpt-test',
			prompt: 'Use token=abc123 and password hunter2',
			response: { status: 'ok', apiKey: 'secret-key', nested: { note: 'done' } },
			metadata: { authorization: 'Bearer secret-token', files: ['lib/audit-evidence.js'] },
		});

		const serialized = JSON.stringify(payload);
		expect(payload.kind).toBe('llm_call');
		expect(payload.command).toBe('dev');
		expect(payload.role).toBe('implementer');
		expect(payload.phase).toBe('GREEN');
		expect(payload.model).toBe('gpt-test');
		expect(serialized).toContain('[REDACTED]');
		expect(serialized).not.toContain('abc123');
		expect(serialized).not.toContain('hunter2');
		expect(serialized).not.toContain('secret-key');
		expect(serialized).not.toContain('secret-token');
	});

	test('redacts JSON-style secret assignments in free-form strings', () => {
		const payload = buildSubagentAuditPayload({
			command: 'dev',
			role: 'implementer',
			prompt:
				'Payload: {"token":"abc123","password": "hunter2","api_key": "key-123","private_key":"pk-123"} authorization: abc credential=xyz, api key: spaced-api-123 private key spaced-private-123, password correct horse battery staple, password=another correct horse battery staple',
			response:
				"Result: {'secret':'value-123'} private-key sk-private authorization bearer-token token is phrase-token-123, password is correct horse battery staple, credential: multi word credential, standalone sk-12345678",
		});

		const serialized = JSON.stringify(payload);
		expect(serialized).toContain('[REDACTED]');
		expect(serialized).toContain('token');
		expect(serialized).toContain('password');
		expect(serialized).toContain('api_key');
		expect(serialized).toContain('private_key');
		expect(serialized).toContain('authorization');
		expect(serialized).toContain('credential');
		expect(serialized).not.toContain('abc123');
		expect(serialized).not.toContain('hunter2');
		expect(serialized).not.toContain('key-123');
		expect(serialized).not.toContain('pk-123');
		expect(serialized).not.toContain('abc');
		expect(serialized).not.toContain('xyz');
		expect(serialized).not.toContain('spaced-api-123');
		expect(serialized).not.toContain('spaced-private-123');
		expect(serialized).not.toContain('correct horse battery staple');
		expect(serialized).not.toContain('another correct horse battery staple');
		expect(serialized).not.toContain('value-123');
		expect(serialized).not.toContain('sk-private');
		expect(serialized).not.toContain('sk-12345678');
		expect(serialized).not.toContain('bearer-token');
		expect(serialized).not.toContain('phrase-token-123');
		expect(serialized).not.toContain('multi word credential');
		expect(serialized).toContain('token is [REDACTED]');
		expect(serialized).toContain('password is [REDACTED]');
		expect(serialized).toMatch(/credential.*REDACTED/);
		expect(serialized).not.toMatch(/\d+=\[REDACTED\]/);
	});

	test('records subagent calls into the capped forge log', () => {
		const sink = createSinkDouble();
		const root = createTempRepo();

		const result = recordSubagentAuditEvent({
			command: 'dev',
			issueId: 'forge-besw.20',
			role: 'quality_reviewer',
			phase: 'QUALITY',
			taskId: 'task-2',
			taskTitle: 'Quality review password is correct horse battery staple',
			prompt: 'review prompt',
			response: 'review response',
			metadata: { rubric: 'quality', token: 'hide-me', 'api key': 'spaced-meta-key' },
		}, {
			cwd: root,
			appendRecord: sink.appendRecord,
			newId: createIdSequence(),
			now: '2026-07-25T00:00:00.000Z',
		});

		expect(result.success).toBe(true);
		expect(result.entryId).toBe('evi-1');
		expect(sink.appends).toHaveLength(1);
		expect(sink.appends[0].logPath).toBe(path.resolve(root, AUDIT_EVIDENCE_LOG));
		expect(sink.appends[0].maxRecords).toBe(AUDIT_EVIDENCE_MAX_RECORDS);

		const record = sink.appends[0].record;
		expect(record.kind).toBe('forge.auditEvidence');
		expect(record.sourceOfTruth).toBe('forge_log');
		expect(record.entryId).toBe('evi-1');
		expect(record.recordedAt).toBe('2026-07-25T00:00:00.000Z');
		expect(record.command).toBe('dev');
		expect(record.issueId).toBe('forge-besw.20');
		expect(record.role).toBe('quality_reviewer');
		expect(record.phase).toBe('QUALITY');
		expect(record.model).toBe('unknown');
		expect(JSON.parse(record.prompt).content).toBe('review prompt');
		expect(JSON.parse(record.response).content).toBe('review response');
		expect(record.metadata.rubric).toBe('quality');

		const serialized = JSON.stringify(record);
		expect(serialized).not.toContain('hide-me');
		expect(serialized).not.toContain('spaced-meta-key');
		expect(serialized).not.toContain('correct horse battery staple');
		expect(record.taskTitle).toContain('password is [REDACTED]');
	});

	test('mints a distinct entry id for every record', () => {
		const sink = createSinkDouble();
		const event = { command: 'dev', role: 'implementer', prompt: 'prompt', response: 'response' };

		const first = recordSubagentAuditEvent(event, { appendRecord: sink.appendRecord });
		const second = recordSubagentAuditEvent(event, { appendRecord: sink.appendRecord });

		expect(first.entryId).toMatch(/^[0-9a-f-]{36}$/);
		expect(second.entryId).not.toBe(first.entryId);
		expect(sink.appends.map(append => append.record.entryId)).toEqual([
			first.entryId,
			second.entryId,
		]);
	});

	test('reports a failed record write instead of throwing', () => {
		const result = recordSubagentAuditEvent({
			command: 'dev',
			role: 'implementer',
			prompt: 'prompt',
			response: 'response',
		}, {
			appendRecord: () => {
				throw new Error('disk unavailable');
			},
		});

		expect(result.success).toBe(false);
		expect(result.entryId).toBe(null);
		expect(result.error).toBe('disk unavailable');
	});

	test('normalizes malformed metadata before recording', () => {
		const sink = createSinkDouble();

		const result = recordSubagentAuditEvent({
			command: 'dev',
			role: 'implementer',
			prompt: 'prompt',
			response: 'response',
			metadata: 'token=should-not-be-meta-json',
		}, { appendRecord: sink.appendRecord });

		expect(result.success).toBe(true);
		expect(result.payload.metadata).toEqual({});
		expect(sink.appends[0].record.metadata).toEqual({});
	});

	test('labels reviewer PASS and FAIL verdicts as good and bad', () => {
		const sink = createSinkDouble();

		const pass = labelSubagentAuditEvent('evi-pass', {
			role: 'spec_reviewer',
			verdict: 'PASS',
		}, { appendRecord: sink.appendRecord, now: '2026-07-25T00:00:00.000Z' });
		const fail = labelSubagentAuditEvent('evi-fail', {
			role: 'quality_reviewer',
			verdict: 'FAIL',
		}, { appendRecord: sink.appendRecord });

		expect(pass.label).toBe('good');
		expect(pass.success).toBe(true);
		expect(pass.entryId).toBe('evi-pass');
		expect(fail.label).toBe('bad');
		expect(fail.success).toBe(true);
		expect(fail.entryId).toBe('evi-fail');
		expect(sink.appends[0].record).toEqual({
			kind: 'forge.auditEvidenceLabel',
			sourceOfTruth: 'forge_log',
			entryId: 'evi-pass',
			recordedAt: '2026-07-25T00:00:00.000Z',
			role: 'spec_reviewer',
			verdict: 'PASS',
			label: 'good',
			reason: 'spec_reviewer verdict: PASS',
		});
		expect(sink.appends[1].record.label).toBe('bad');
		expect(sink.appends[1].record.reason).toBe('quality_reviewer verdict: FAIL');
	});

	test('reports a failed label write instead of throwing', () => {
		const result = labelSubagentAuditEvent('evi-pass', {
			role: 'spec_reviewer',
			verdict: 'PASS',
		}, {
			appendRecord: () => {
				throw new Error('label write failed');
			},
		});

		expect(result.success).toBe(false);
		expect(result.entryId).toBe(null);
		expect(result.label).toBe('good');
		expect(result.error).toBe('label write failed');
	});

	test('does not label implementer or unknown verdict events', () => {
		const sink = createSinkDouble();

		const implementer = labelSubagentAuditEvent('evi-impl', {
			role: 'implementer',
			verdict: 'PASS',
		}, { appendRecord: sink.appendRecord });
		const unknown = labelSubagentAuditEvent('evi-unknown', {
			role: 'quality_reviewer',
			verdict: 'UNKNOWN',
		}, { appendRecord: sink.appendRecord });
		const unrecorded = labelSubagentAuditEvent(null, {
			role: 'spec_reviewer',
			verdict: 'PASS',
		}, { appendRecord: sink.appendRecord });

		expect(implementer.skipped).toBe(true);
		expect(unknown.skipped).toBe(true);
		expect(unrecorded.skipped).toBe(true);
		expect(sink.appends).toHaveLength(0);
	});

	test('records then labels reviewer events', () => {
		const sink = createSinkDouble();

		const result = recordAndLabelSubagentAuditEvent({
			command: 'dev',
			issueId: 'forge-besw.20',
			role: 'spec_reviewer',
			phase: 'SPEC',
			prompt: 'prompt',
			response: 'response',
			verdict: 'PASS',
		}, { appendRecord: sink.appendRecord, newId: createIdSequence() });

		expect(result.record.entryId).toBe('evi-1');
		expect(result.label.label).toBe('good');
		expect(result.label.success).toBe(true);
		expect(sink.appends.map(append => append.record.kind)).toEqual([
			'forge.auditEvidence',
			'forge.auditEvidenceLabel',
		]);
		expect(sink.appends[1].record.entryId).toBe('evi-1');
	});

	test('appends real records to the capped forge log', () => {
		const root = createTempRepo();

		const result = recordAndLabelSubagentAuditEvent({
			command: 'dev',
			role: 'spec_reviewer',
			phase: 'SPEC',
			prompt: 'spec prompt',
			response: 'PASS',
			verdict: 'PASS',
		}, { cwd: root });

		const lines = readLog(root);
		expect(result.record.success).toBe(true);
		expect(result.record.logPath).toBe(path.resolve(root, AUDIT_EVIDENCE_LOG));
		expect(lines.map(line => line.kind)).toEqual([
			'forge.auditEvidence',
			'forge.auditEvidenceLabel',
		]);
		expect(lines.every(line => line.entryId === result.record.entryId)).toBe(true);
	});

	test('caps the forge log so a long run cannot grow it unbounded', () => {
		const root = createTempRepo();
		const event = { command: 'dev', role: 'implementer', prompt: 'prompt', response: 'response' };

		for (let index = 0; index < 6; index += 1) {
			recordSubagentAuditEvent(event, { cwd: root, maxRecords: 3 });
		}

		expect(readLog(root)).toHaveLength(3);
	});

	test('exports verdict label map', () => {
		expect(VERDICT_LABELS.PASS).toBe('good');
		expect(VERDICT_LABELS.FAIL).toBe('bad');
	});
});
