const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
	PROTECTED_SURFACES,
	PROTECTED_STATE_AUDIT_LOG,
	PROTECTED_STATE_AUDIT_MAX_RECORDS,
	assertNoSymlinkEscape,
	classifyProtectedPath,
	assertProtectedWriteAllowed,
	writeProtectedFile,
	createProtectedStateAuditRecord,
	hashProtectedContent,
	buildProtectedStateAuditEvent,
	recordProtectedStateAuditEvent,
} = require('../lib/protected-state-surfaces');

// The sink mechanics these records ride on (cap, trim lock, concurrent appends)
// belong to lib/capped-jsonl-log.js and are covered in its own suite.
function readAuditLog(root) {
	return fs
		.readFileSync(path.join(root, PROTECTED_STATE_AUDIT_LOG), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map(line => JSON.parse(line));
}

function createTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-protected-state-'));
}

function runGit(root, args) {
	const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
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

	test('builds content-bound visibility records without conferring authority', () => {
		const auditRecord = createProtectedStateAuditRecord({
			actor: 'forge-release',
			surface: 'workflows',
			path: '.github/workflows/npm-publish.yml',
			content: 'generated: true\n',
		});

		expect(auditRecord).toMatchObject({
			kind: 'protected_state_write',
			actor: 'forge-release',
			path: '.github/workflows/npm-publish.yml',
			decision: 'allowed',
			requiredSurface: 'workflows',
			declaredSurface: 'workflows',
		});
		expect(auditRecord.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(auditRecord).not.toHaveProperty('capabilityId');
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

	test('allows a missing parent beneath an aliased project root', () => {
		const root = createTempDir();
		const canonicalRoot = path.join(root, 'canonical-root');
		const realpathSync = fs.realpathSync;
		try {
			fs.realpathSync = candidate => (candidate === root ? canonicalRoot : realpathSync(candidate));

			expect(assertNoSymlinkEscape(root, path.join(root, '.claude', 'settings.json'))).toBeNull();
		} finally {
			fs.realpathSync = realpathSync;
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

	test('does not allow a surface-only environment declaration without content-bound evidence', () => {
		const result = spawnSync('node', [scriptPath], {
			cwd: path.join(__dirname, '..'),
			stdio: 'pipe',
			env: {
				...process.env,
				FORGE_PROTECTED_STATE_STAGED_FILES: 'bun.lock',
				FORGE_PROTECTED_STATE_ALLOWED_SURFACES: 'lockfiles',
			},
		});

		expect(result.status).toBe(1);
		expect(`${result.stdout}${result.stderr}`).toContain('bun.lock');
	}, 15_000);

	test('cannot hide an actually staged protected path behind environment file seams', () => {
		const root = createTempDir();
		try {
			runGit(root, ['init', '--quiet']);
			fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
			fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), 'version: 1\n');
			runGit(root, ['add', '.forge/config.yaml']);

			const result = spawnSync('node', [scriptPath], {
				cwd: root,
				stdio: 'pipe',
				env: {
					...process.env,
					FORGE_PROTECTED_STATE_STAGED_FILES: 'lib/safe.js',
					FORGE_PROTECTED_STATE_STAGED_CONTENTS_JSON: '{"lib/safe.js":"benign",".forge/config.yaml":"forged: benign"}',
				},
			});
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain('.forge/config.yaml');
			const decision = readAuditLog(root).find(record => record.path === '.forge/config.yaml');
			expect(decision.contentHash).toBe(hashProtectedContent('version: 1\n'));
			expect(decision.contentHash).not.toBe(hashProtectedContent('forged: benign'));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
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
