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

	test('redacts JSON-style secret assignments in free-form strings', () => {
		const payload = buildSubagentAuditPayload({
			command: 'dev',
			role: 'implementer',
			prompt:
				'Payload: {"token":"abc123","password": "hunter2","api_key": "key-123","private_key":"pk-123"} authorization: abc credential=xyz, api key: spaced-api-123 private key spaced-private-123, password=correct horse battery staple',
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
			taskTitle: 'Quality review password is correct horse battery staple',
			prompt: 'review prompt',
			response: 'review response',
			metadata: { rubric: 'quality', token: 'hide-me', 'api key': 'spaced-meta-key' },
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
		expect(JSON.stringify(fallback)).not.toContain('spaced-meta-key');
		expect(JSON.stringify(fallback)).not.toContain('correct horse battery staple');
		expect(fallback.taskTitle).toContain('password is [REDACTED]');
	});

	test('keeps fallback metadata best-effort after Beads recording succeeds', () => {
		const result = recordSubagentAuditEvent({
			command: 'dev',
			role: 'quality_reviewer',
			phase: 'QUALITY',
			prompt: 'review prompt',
			response: 'review response',
			metadata: { files: ['test/audit-evidence.test.js'] },
		}, {
			cwd: 'C:/repo',
			fs: {
				mkdirSync: () => {
					throw new Error('disk unavailable');
				},
				appendFileSync: () => {
					throw new Error('should not write');
				},
			},
			runCommand: () => JSON.stringify({ id: 'int-test123', kind: 'llm_call', schema_version: 1 }),
			metaJsonSupported: false,
		});

		expect(result.success).toBe(true);
		expect(result.entryId).toBe('int-test123');
		expect(result.fallback.skipped).toBe(true);
		expect(result.fallback.error).toBe('disk unavailable');
	});

	test('requires JSON ids from bd audit record output', () => {
		const result = recordSubagentAuditEvent({
			command: 'dev',
			role: 'implementer',
			prompt: 'prompt',
			response: 'response',
		}, {
			runCommand: () => 'help text with int-fallback',
			metaJsonSupported: true,
		});

		expect(result.success).toBe(false);
		expect(result.entryId).toBe(null);
		expect(result.fallback).toBe(null);
	});

	test('normalizes malformed metadata before audit recording', () => {
		const commands = [];
		const result = recordSubagentAuditEvent({
			command: 'dev',
			role: 'implementer',
			prompt: 'prompt',
			response: 'response',
			metadata: 'token=should-not-be-meta-json',
		}, {
			runCommand: (cmd, args) => {
				commands.push({ cmd, args });
				return JSON.stringify({ id: 'int-record' });
			},
			metaJsonSupported: true,
		});

		expect(result.success).toBe(true);
		expect(result.payload.metadata).toEqual({});
		expect(commands[0].args).not.toContain('--meta-json');
	});

	test('skips fallback metadata when upstream meta-json support is present', () => {
		const commands = [];
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
			runCommand: (cmd, args) => {
				commands.push({ cmd, args });
				return JSON.stringify({ id: 'int-meta' });
			},
			metaJsonSupported: true,
		});

		expect(result.entryId).toBe('int-meta');
		expect(commands[0].args).toContain('--meta-json');
		const metaIndex = commands[0].args.indexOf('--meta-json');
		expect(JSON.parse(commands[0].args[metaIndex + 1])).toEqual({
			files: ['test/audit-evidence.test.js'],
		});
		expect(fsDouble.writes.length).toBe(0);
	});

	test('labels reviewer PASS and FAIL verdicts as good and bad', () => {
		const commands = [];
		const runCommand = (cmd, args) => {
			commands.push({ cmd, args });
			return JSON.stringify({ id: args[2] });
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
		expect(pass.success).toBe(true);
		expect(pass.entryId).toBe('int-pass');
		expect(fail.label).toBe('bad');
		expect(fail.success).toBe(true);
		expect(fail.entryId).toBe('int-fail');
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

	test('reports label failures when bd output is invalid or the command fails', () => {
		const invalid = labelSubagentAuditEvent('int-pass', {
			role: 'spec_reviewer',
			verdict: 'PASS',
		}, {
			runCommand: () => 'help text with int-pass',
		});
		const thrown = labelSubagentAuditEvent('int-fail', {
			role: 'quality_reviewer',
			verdict: 'FAIL',
		}, {
			runCommand: () => {
				throw new Error('bd label failed');
			},
		});

		expect(invalid.success).toBe(false);
		expect(invalid.entryId).toBe(null);
		expect(thrown.success).toBe(false);
		expect(thrown.error).toBe('bd label failed');
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
				return JSON.stringify({ id: 'int-record' });
			},
			metaJsonSupported: true,
		});

		expect(result.record.entryId).toBe('int-record');
		expect(result.label.label).toBe('good');
		expect(result.label.success).toBe(true);
		expect(commands.length).toBe(2);
	});

	test('detects whether bd audit record exposes meta-json support', () => {
		expect(hasAuditMetaJsonSupport(() => 'Usage: bd audit record --meta-json string')).toBe(true);
		expect(hasAuditMetaJsonSupport(() => 'Usage: bd audit record --prompt string')).toBe(false);
		expect(() => hasAuditMetaJsonSupport(() => { throw new Error('missing bd'); })).toThrow('missing bd');
	});

	test('exports verdict label map', () => {
		expect(VERDICT_LABELS.PASS).toBe('good');
		expect(VERDICT_LABELS.FAIL).toBe('bad');
	});
});
