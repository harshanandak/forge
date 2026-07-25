const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
	PROTECTED_SURFACES,
	PROTECTED_STATE_AUDIT_LOG,
	PROTECTED_STATE_AUDIT_MAX_RECORDS,
	classifyProtectedPath,
	assertProtectedWriteAllowed,
	writeProtectedFile,
	buildProtectedStateAuditEvent,
	recordProtectedStateAuditEvent,
	appendCappedJsonlRecord,
} = require('../lib/protected-state-surfaces');

function readJsonlFile(logPath) {
	return fs
		.readFileSync(logPath, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

function readAuditLog(root) {
	return readJsonlFile(path.join(root, PROTECTED_STATE_AUDIT_LOG));
}

function createTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-protected-state-'));
}

function seedJsonl(logPath, count) {
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const seeded = Array.from({ length: count }, (_, index) => JSON.stringify({ seq: index }));
	fs.writeFileSync(logPath, `${seeded.join('\n')}\n`, 'utf8');
}

const APPEND_WORKER = `
const { appendCappedJsonlRecord } = require(process.argv[2]);
const [logPath, writer, count, maxRecords] = process.argv.slice(3);
for (let index = 0; index < Number(count); index += 1) {
	appendCappedJsonlRecord(logPath, { writer, index }, Number(maxRecords));
}
`;

/**
 * Two real processes appending to one log — the interleaving a pre-commit hook
 * actually hits when parallel agents commit at the same moment.
 */
function runConcurrentWriters(root, { count, maxRecords }) {
	const workerPath = path.join(root, 'append-worker.js');
	fs.writeFileSync(workerPath, APPEND_WORKER, 'utf8');
	const modulePath = require.resolve('../lib/protected-state-surfaces');
	const logPath = path.join(root, PROTECTED_STATE_AUDIT_LOG);

	return Promise.all(
		['alpha', 'beta'].map(
			writer =>
				new Promise((resolve, reject) => {
					const child = spawn(
						process.execPath,
						[workerPath, modulePath, logPath, writer, String(count), String(maxRecords)],
						{ stdio: 'ignore' },
					);
					child.on('error', reject);
					child.on('exit', code =>
						code === 0 ? resolve() : reject(new Error(`writer ${writer} exited with ${code}`)),
					);
				}),
		),
	).then(() => logPath);
}

describe('protected state surfaces', () => {
	test('classifies the locked protected path categories', () => {
		expect(classifyProtectedPath('.beads/issues.jsonl').surface).toBe('beads_state');
		expect(classifyProtectedPath('.forge/config.yaml').surface).toBe('forge_config');
		expect(classifyProtectedPath('.forge/log.jsonl').surface).toBe('append_only_logs');
		expect(classifyProtectedPath('docs/sessions/2026-05-21.md').surface).toBe('memory_projection');
		expect(classifyProtectedPath('.github/workflows/ci.yml').surface).toBe('workflows');
		expect(classifyProtectedPath('bun.lock').surface).toBe('lockfiles');
		expect(classifyProtectedPath('.forge/extensions/example/manifest.json').surface).toBe('extension_manifests');
		expect(classifyProtectedPath('.env.local').surface).toBe('secrets');
		expect(classifyProtectedPath('apps/api/.env').surface).toBe('secrets');
		expect(classifyProtectedPath('.git/config').surface).toBe('immutable');
		expect(classifyProtectedPath('lib/file-utils.js')).toBe(null);
		expect(PROTECTED_SURFACES.map(surface => surface.id)).toContain('generated_harness');
	});

	test('blocks direct writes with surface-specific repair hints', () => {
		const decision = assertProtectedWriteAllowed('.beads/issues.jsonl', {
			actor: 'codex',
			operation: 'write',
		});

		expect(decision.allowed).toBe(false);
		expect(decision.decision).toBe('blocked');
		expect(decision.requiredSurface).toBe('beads_state');
		expect(decision.repairHint).toContain('forge migrate --from beads');
		expect(decision.reason).toContain('Direct edits');
	});

	test('allows declared Forge API writes for the matching required surface', () => {
		const decision = assertProtectedWriteAllowed('.beads/config.yaml', {
			actor: 'forge',
			operation: 'write',
			viaForgeApi: true,
			surface: 'beads_state',
		});

		expect(decision.allowed).toBe(true);
		expect(decision.decision).toBe('allowed');
		expect(decision.requiredSurface).toBe('beads_state');
	});

	test('writes protected files only through the declared Forge API surface', () => {
		const root = createTempDir();
		try {
			const result = writeProtectedFile(root, '.forge/config.yaml', 'version: 1\n', {
				actor: 'forge',
				surface: 'forge_config',
				viaForgeApi: true,
			});

			expect(result.allowed).toBe(true);
			expect(fs.readFileSync(path.join(root, '.forge/config.yaml'), 'utf8')).toBe('version: 1\n');

			const blocked = writeProtectedFile(root, '.forge/config.yaml', 'bad: true\n', {
				actor: 'codex',
			});
			expect(blocked.allowed).toBe(false);
			expect(fs.readFileSync(path.join(root, '.forge/config.yaml'), 'utf8')).toBe('version: 1\n');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('canonicalizes absolute and dot-segment paths before protected write decisions', () => {
		const root = createTempDir();
		try {
			const absoluteConfig = path.join(root, '.forge', 'config.yaml');
			const absoluteDecision = writeProtectedFile(root, absoluteConfig, 'bad: true\n', {
				actor: 'codex',
			});
			expect(absoluteDecision.allowed).toBe(false);
			expect(absoluteDecision.path).toBe('.forge/config.yaml');
			expect(absoluteDecision.requiredSurface).toBe('forge_config');

			const dotSegmentDecision = writeProtectedFile(root, '.forge/../.forge/config.yaml', 'bad: true\n', {
				actor: 'codex',
			});
			expect(dotSegmentDecision.allowed).toBe(false);
			expect(dotSegmentDecision.path).toBe('.forge/config.yaml');
			expect(dotSegmentDecision.requiredSurface).toBe('forge_config');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('blocks symlink targets before writing protected files', () => {
		if (process.platform === 'win32') {
			return;
		}

		const root = createTempDir();
		const outside = createTempDir();
		try {
			fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
			fs.symlinkSync(path.join(outside, 'config.yaml'), path.join(root, '.forge', 'config.yaml'));

			const result = writeProtectedFile(root, '.forge/config.yaml', 'bad: true\n', {
				actor: 'forge',
				surface: 'forge_config',
				viaForgeApi: true,
			});

			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('symlink');
			expect(fs.existsSync(path.join(outside, 'config.yaml'))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('blocks symlink ancestors before creating parent directories', () => {
		if (process.platform === 'win32') {
			return;
		}

		const root = createTempDir();
		const outside = createTempDir();
		try {
			fs.symlinkSync(outside, path.join(root, '.forge'));

			const result = writeProtectedFile(root, '.forge/config.yaml', 'bad: true\n', {
				actor: 'forge',
				surface: 'forge_config',
				viaForgeApi: true,
			});

			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('ancestor');
			expect(fs.existsSync(path.join(outside, 'config.yaml'))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('blocks dangling symlink ancestors before creating parent directories', () => {
		if (process.platform === 'win32') {
			return;
		}

		const root = createTempDir();
		const outside = createTempDir();
		const missingOutsideTarget = path.join(outside, 'missing');
		try {
			fs.symlinkSync(missingOutsideTarget, path.join(root, '.forge'));

			const result = writeProtectedFile(root, '.forge/config.yaml', 'bad: true\n', {
				actor: 'forge',
				surface: 'forge_config',
				viaForgeApi: true,
			});

			expect(result.allowed).toBe(false);
			expect(result.reason).toContain('ancestor');
			expect(fs.existsSync(missingOutsideTarget)).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('builds complete audit payloads for protected edit attempts', () => {
		const decision = assertProtectedWriteAllowed('.forge/log.jsonl', {
			actor: 'codex',
			operation: 'append',
		});
		const event = buildProtectedStateAuditEvent(decision);

		expect(event.kind).toBe('protected_state_write');
		expect(event.actor).toBe('codex');
		expect(event.path).toBe('.forge/log.jsonl');
		expect(event.decision).toBe('blocked');
		expect(event.requiredSurface).toBe('append_only_logs');
		expect(event.repairHint).toContain('append-only');
		expect(event.metadata).toMatchObject({
			operation: 'append',
			requiredSurface: 'append_only_logs',
			decision: 'blocked',
		});
	});

	test('records protected edit attempts to the local audit log', () => {
		const root = createTempDir();
		try {
			const decision = assertProtectedWriteAllowed('.forge/config.yaml', {
				actor: 'codex',
				operation: 'staged_edit',
			});

			const result = recordProtectedStateAuditEvent(decision, { cwd: root });

			expect(result.success).toBe(true);
			expect(result.logPath).toBe(path.join(root, PROTECTED_STATE_AUDIT_LOG));

			const records = readAuditLog(root);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				kind: 'protected_state_write',
				actor: 'codex',
				path: '.forge/config.yaml',
				operation: 'staged_edit',
				requiredSurface: 'forge_config',
				declaredSurface: null,
				decision: 'blocked',
			});
			expect(records[0].reason).toBeTruthy();
			expect(records[0].repairHint).toBeTruthy();
			expect(records[0].recordedAt).toBeTruthy();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('caps the audit log so a blocked-commit loop cannot grow it without bound', () => {
		const root = createTempDir();
		try {
			const logPath = path.join(root, PROTECTED_STATE_AUDIT_LOG);
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			const seeded = Array.from(
				{ length: PROTECTED_STATE_AUDIT_MAX_RECORDS + 5 },
				(_, index) => JSON.stringify({ seq: index }),
			);
			fs.writeFileSync(logPath, `${seeded.join('\n')}\n`, 'utf8');

			const decision = assertProtectedWriteAllowed('.forge/config.yaml', { actor: 'codex' });
			expect(recordProtectedStateAuditEvent(decision, { cwd: root }).success).toBe(true);

			const records = readAuditLog(root);
			expect(records).toHaveLength(PROTECTED_STATE_AUDIT_MAX_RECORDS);
			// Oldest trimmed, newest kept.
			expect(records[0].seq).toBe(6);
			expect(records[records.length - 1].kind).toBe('protected_state_write');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('concurrent writers do not lose each other appended records', async () => {
		const root = createTempDir();
		try {
			const logPath = await runConcurrentWriters(root, { count: 60, maxRecords: 10000 });

			const records = readJsonlFile(logPath);
			expect(records).toHaveLength(120);
			expect(records.filter(record => record.writer === 'alpha')).toHaveLength(60);
			expect(records.filter(record => record.writer === 'beta')).toHaveLength(60);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('a contended trim leaves valid JSONL and still converges to the cap', async () => {
		const root = createTempDir();
		try {
			const logPath = await runConcurrentWriters(root, { count: 60, maxRecords: 25 });

			// Every surviving line parses: the trim rewrites through a temp file and
			// renames, so no writer can observe or leave a half-written log.
			expect(() => readJsonlFile(logPath)).not.toThrow();

			// A writer that loses the lock race skips its trim, so the log can sit
			// above the cap until the next uncontended write brings it back down.
			appendCappedJsonlRecord(logPath, { writer: 'final' }, 25);
			expect(readJsonlFile(logPath)).toHaveLength(25);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('skips the trim instead of blocking while another writer holds the lock', () => {
		const root = createTempDir();
		try {
			const logPath = path.join(root, PROTECTED_STATE_AUDIT_LOG);
			seedJsonl(logPath, 12);
			fs.writeFileSync(`${logPath}.lock`, '', 'utf8');

			// The record is still appended — only the trim is deferred.
			expect(appendCappedJsonlRecord(logPath, { seq: 'held' }, 10)).toBe(13);
			expect(readJsonlFile(logPath)).toHaveLength(13);

			fs.unlinkSync(`${logPath}.lock`);
			expect(appendCappedJsonlRecord(logPath, { seq: 'free' }, 10)).toBe(10);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('reclaims a trim lock left behind by a crashed writer', () => {
		const root = createTempDir();
		try {
			const logPath = path.join(root, PROTECTED_STATE_AUDIT_LOG);
			const lockPath = `${logPath}.lock`;
			seedJsonl(logPath, 12);
			fs.writeFileSync(lockPath, '', 'utf8');
			const longAgo = new Date(Date.now() - 60 * 60 * 1000);
			fs.utimesSync(lockPath, longAgo, longAgo);

			expect(appendCappedJsonlRecord(logPath, { seq: 'stale' }, 10)).toBe(10);
			expect(fs.existsSync(lockPath)).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('reports a failing audit sink instead of throwing', () => {
		const decision = assertProtectedWriteAllowed('.forge/config.yaml', { actor: 'codex' });

		const result = recordProtectedStateAuditEvent(decision, {
			cwd: 'C:/repo',
			appendRecord: () => {
				throw new Error('disk on fire');
			},
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain('disk on fire');
		// The event is still returned so the caller can surface it another way.
		expect(result.event.requiredSurface).toBe('forge_config');
	});
});

describe('scripts/protected-state-check.js', () => {
	const scriptPath = path.join(__dirname, '..', 'scripts', 'protected-state-check.js');

	test('fails staged direct edits to protected state with repair hints', () => {
		const result = spawnSync('node', [scriptPath], {
			cwd: path.join(__dirname, '..'),
			stdio: 'pipe',
			env: {
				...process.env,
				FORGE_PROTECTED_STATE_STAGED_FILES: '.beads/issues.jsonl\nlib/safe.js',
				FORGE_PROTECTED_STATE_ACTOR: 'codex-test',
			},
		});

		expect(result.status).toBe(1);
		const output = `${result.stdout}${result.stderr}`;
		expect(output).toContain('.beads/issues.jsonl');
		expect(output).toContain('beads_state');
		expect(output).toContain('Repair:');
	});

	test('writes the blocked decision to the audit log without warning about a missing CLI', () => {
		const root = createTempDir();
		try {
			const result = spawnSync('node', [scriptPath], {
				cwd: root,
				stdio: 'pipe',
				env: {
					...process.env,
					FORGE_PROTECTED_STATE_STAGED_FILES: '.forge/config.yaml',
					FORGE_PROTECTED_STATE_ACTOR: 'codex-test',
				},
			});

			expect(result.status).toBe(1);
			const output = `${result.stdout}${result.stderr}`;
			// The retired bd CLI used to fail here and dump its usage text as a WARN.
			expect(output).not.toContain('WARN: Failed to record protected-state audit');
			expect(output).not.toMatch(/\bbd\b/);

			const records = readAuditLog(root);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({
				actor: 'codex-test',
				path: '.forge/config.yaml',
				operation: 'staged_edit',
				requiredSurface: 'forge_config',
				decision: 'blocked',
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('passes when staged edits do not touch protected state', () => {
		const result = spawnSync('node', [scriptPath], {
			cwd: path.join(__dirname, '..'),
			stdio: 'pipe',
			env: {
				...process.env,
				FORGE_PROTECTED_STATE_STAGED_FILES: 'lib/safe.js\ntest/safe.test.js',
			},
		});

		expect(result.status).toBe(0);
		expect(result.stdout.toString()).toContain('No protected state edits detected');
	});

	test('allows sanctioned protected surfaces when Forge command context declares them', () => {
		const result = spawnSync('node', [scriptPath], {
			cwd: path.join(__dirname, '..'),
			stdio: 'pipe',
			env: {
				...process.env,
				FORGE_PROTECTED_STATE_STAGED_FILES: 'bun.lock',
				FORGE_PROTECTED_STATE_ALLOWED_SURFACES: 'lockfiles',
			},
		});

		expect(result.status).toBe(0);
		expect(result.stdout.toString()).toContain('No protected state edits detected');
	});

	test('includes deletions in the staged protected-state query', () => {
		const content = fs.readFileSync(scriptPath, 'utf8');
		expect(content).toContain('--diff-filter=ACMRDT');
	});

	test('checks both source and destination paths for staged renames and copies', () => {
		const result = spawnSync('node', [scriptPath], {
			cwd: path.join(__dirname, '..'),
			stdio: 'pipe',
			env: {
				...process.env,
				FORGE_PROTECTED_STATE_STAGED_NAME_STATUS: 'R100\t.beads/issues.jsonl\tdocs/issues.jsonl',
			},
		});

		expect(result.status).toBe(1);
		const output = `${result.stdout}${result.stderr}`;
		expect(output).toContain('.beads/issues.jsonl');
		expect(output).toContain('beads_state');
	});
});
