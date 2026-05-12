const { describe, test, expect } = require('bun:test');
const {
	buildSubagentAuditPayload,
	recordSubagentAuditEvent,
	labelSubagentAuditEvent,
	recordAndLabelSubagentAuditEvent,
	hasAuditMetaJsonSupport,
	VERDICT_LABELS,
} = require('../lib/audit-evidence');

function createFsDouble() {
	const writes = [];
	const dirs = [];
	return {
		writes,
		dirs,
		mkdirSync: (dir, options) => {
			dirs.push({ dir, options });
		},
		appendFileSync: (file, data) => {
			writes.push({ file, data });
		},
	};
}

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

	test('records subagent calls through bd audit record and writes fallback metadata without replacing Beads', () => {
		const commands = [];
		const fsDouble = createFsDouble();
		const runCommand = (cmd, args) => {
			commands.push({ cmd, args });
			return JSON.stringify({ id: 'int-test123', kind: 'llm_call', schema_version: 1 });
		};

		const result = recordSubagentAuditEvent({
			command: 'dev',
			issueId: 'forge-besw.20',
			role: 'quality_reviewer',
			phase: 'QUALITY',
			taskId: 'task-2',
			taskTitle: 'Quality review',
			prompt: 'review prompt',
			response: 'review response',
			metadata: { rubric: 'quality', token: 'hide-me' },
		}, {
			cwd: 'C:/repo',
			fs: fsDouble,
			runCommand,
			metaJsonSupported: false,
		});

		expect(result.success).toBe(true);
		expect(result.entryId).toBe('int-test123');
		expect(commands[0].cmd).toBe('bd');
		expect(commands[0].args).toEqual([
			'audit',
			'record',
			'--json',
			'--kind',
			'llm_call',
			'--issue-id',
			'forge-besw.20',
			'--model',
			'unknown',
			'--prompt',
			expect.any(String),
			'--response',
			expect.any(String),
		]);
		expect(fsDouble.dirs[0].dir).toBe('C:/repo/.forge');
		expect(fsDouble.writes[0].file).toBe('C:/repo/.forge/log.jsonl');
		const fallback = JSON.parse(fsDouble.writes[0].data);
		expect(fallback.kind).toBe('forge.auditEvidence');
		expect(fallback.sourceOfTruth).toBe('beads');
		expect(fallback.beadsEntryId).toBe('int-test123');
		expect(JSON.stringify(fallback)).not.toContain('hide-me');
	});

	test('skips fallback metadata when upstream meta-json support is present', () => {
		const fsDouble = createFsDouble();
		const result = recordSubagentAuditEvent({
			command: 'dev',
			issueId: 'forge-besw.20',
			role: 'implementer',
			phase: 'RED',
			prompt: 'prompt',
			response: 'response',
			metadata: { files: ['test/audit-evidence.test.js'] },
		}, {
			fs: fsDouble,
			runCommand: () => JSON.stringify({ id: 'int-meta' }),
			metaJsonSupported: true,
		});

		expect(result.entryId).toBe('int-meta');
		expect(fsDouble.writes.length).toBe(0);
	});

	test('labels reviewer PASS and FAIL verdicts as good and bad', () => {
		const commands = [];
		const runCommand = (cmd, args) => {
			commands.push({ cmd, args });
			return JSON.stringify({ id: 'int-label' });
		};

		const pass = labelSubagentAuditEvent('int-pass', {
			role: 'spec_reviewer',
			verdict: 'PASS',
		}, { runCommand });
		const fail = labelSubagentAuditEvent('int-fail', {
			role: 'quality_reviewer',
			verdict: 'FAIL',
		}, { runCommand });

		expect(pass.label).toBe('good');
		expect(fail.label).toBe('bad');
		expect(commands[0].args).toEqual([
			'audit',
			'label',
			'int-pass',
			'--json',
			'--label',
			'good',
			'--reason',
			'spec_reviewer verdict: PASS',
		]);
		expect(commands[1].args).toContain('bad');
	});

	test('does not label implementer or unknown verdict events', () => {
		const commands = [];
		const runCommand = (cmd, args) => {
			commands.push({ cmd, args });
			return '{}';
		};

		const implementer = labelSubagentAuditEvent('int-impl', {
			role: 'implementer',
			verdict: 'PASS',
		}, { runCommand });
		const unknown = labelSubagentAuditEvent('int-unknown', {
			role: 'quality_reviewer',
			verdict: 'UNKNOWN',
		}, { runCommand });

		expect(implementer.skipped).toBe(true);
		expect(unknown.skipped).toBe(true);
		expect(commands.length).toBe(0);
	});

	test('records then labels reviewer events', () => {
		const commands = [];
		const result = recordAndLabelSubagentAuditEvent({
			command: 'dev',
			issueId: 'forge-besw.20',
			role: 'spec_reviewer',
			phase: 'SPEC',
			prompt: 'prompt',
			response: 'response',
			verdict: 'PASS',
		}, {
			runCommand: (cmd, args) => {
				commands.push({ cmd, args });
				return JSON.stringify({ id: commands.length === 1 ? 'int-record' : 'int-label' });
			},
			metaJsonSupported: true,
		});

		expect(result.record.entryId).toBe('int-record');
		expect(result.label.label).toBe('good');
		expect(commands.length).toBe(2);
	});

	test('detects whether bd audit record exposes meta-json support', () => {
		expect(hasAuditMetaJsonSupport(() => 'Usage: bd audit record --meta-json string')).toBe(true);
		expect(hasAuditMetaJsonSupport(() => 'Usage: bd audit record --prompt string')).toBe(false);
		expect(hasAuditMetaJsonSupport(() => { throw new Error('missing bd'); })).toBe(false);
	});

	test('exports verdict label map', () => {
		expect(VERDICT_LABELS.PASS).toBe('good');
		expect(VERDICT_LABELS.FAIL).toBe('bad');
	});
});
