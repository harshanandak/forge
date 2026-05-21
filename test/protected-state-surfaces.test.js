const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
	PROTECTED_SURFACES,
	classifyProtectedPath,
	assertProtectedWriteAllowed,
	writeProtectedFile,
	buildProtectedStateAuditEvent,
	recordProtectedStateAuditEvent,
} = require('../lib/protected-state-surfaces');

function createTempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-protected-state-'));
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
		expect(decision.repairHint).toContain('bd');
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

	test('records protected edit attempts through the existing Beads audit model when available', () => {
		const calls = [];
		const decision = assertProtectedWriteAllowed('.forge/config.yaml', {
			actor: 'codex',
			operation: 'staged_edit',
		});

		const result = recordProtectedStateAuditEvent(decision, {
			cwd: 'C:/repo',
			runCommand: (cmd, args, options) => {
				calls.push({ cmd, args, options });
				return JSON.stringify({ id: 'int-protected' });
			},
		});

		expect(result.success).toBe(true);
		expect(calls[0].cmd).toBe('bd');
		expect(calls[0].args).toContain('protected_state_write');
		expect(calls[0].args).toContain('--meta-json');
		const meta = JSON.parse(calls[0].args[calls[0].args.indexOf('--meta-json') + 1]);
		expect(meta).toMatchObject({
			actor: 'codex',
			path: '.forge/config.yaml',
			decision: 'blocked',
			requiredSurface: 'forge_config',
		});
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
		expect(output).toContain('bd');
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
});
