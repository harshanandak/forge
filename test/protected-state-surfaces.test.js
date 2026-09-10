const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getCurrentHead } = require('../scripts/protected-state-check');

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

function runGitCapture(root, args) {
	const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

function stageLocalLockFixture(root, tampered = false) {
	root = fs.realpathSync.native(root);
	runGit(root, ['init', '--quiet']);
	runGit(root, ['config', 'user.email', 'proof@example.invalid']);
	runGit(root, ['config', 'user.name', 'Lock Proof']);
	const manifest = {
		name: 'fixture',
		private: true,
		packageManager: require('../package.json').packageManager,
		workspaces: ['packages/*'],
		dependencies: { 'fixture-child': 'workspace:*' },
	};
	fs.mkdirSync(path.join(root, 'packages', 'child'), { recursive: true });
	fs.writeFileSync(path.join(root, 'packages', 'child', 'package.json'), JSON.stringify({ name: 'fixture-child', version: '1.0.0' }));
	const generate = () => {
		fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
		const result = spawnSync('bun', ['install', `--cwd=${root}`, '--lockfile-only', '--ignore-scripts'], { cwd: root, encoding: 'utf8', timeout: 15_000 });
		if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	};
	generate();
	runGit(root, ['add', 'package.json', 'packages/child/package.json', 'bun.lock']);
	runGit(root, ['commit', '--quiet', '-m', 'base lock']);
	manifest.name = 'refreshed-fixture';
	fs.rmSync(path.join(root, 'bun.lock'));
	generate();
	if (tampered) fs.writeFileSync(path.join(root, 'bun.lock'), 'attacker-controlled\n');
	runGit(root, ['add', 'package.json', 'bun.lock']);
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

	test('blocks an injected parent-boundary swap before atomic replacement', () => {
		const root = createTempDir();
		const outside = createTempDir();
		const parent = path.join(root, '.forge');
		const movedParent = path.join(root, '.forge-original');
		let swapped = false;
		try {
			fs.mkdirSync(parent, { recursive: true });
			const result = writeProtectedFile(root, '.forge/config.yaml', 'version: 2\n', {
				actor: 'forge',
				surface: 'forge_config',
				viaForgeApi: true,
				beforeAtomicCommit: () => {
					fs.renameSync(parent, movedParent);
					fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
					swapped = true;
				},
			});

			expect(swapped).toBe(true);
			expect(result).toMatchObject({ allowed: false, decision: 'blocked' });
			expect(result.reason).toContain('boundary changed');
			expect(fs.existsSync(path.join(outside, 'config.yaml'))).toBe(false);
			expect(fs.existsSync(path.join(movedParent, 'config.yaml'))).toBe(false);
		} finally {
			try {
				if (fs.lstatSync(parent).isSymbolicLink()) fs.unlinkSync(parent);
			} catch {}
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

	test('distinguishes a verified unborn branch from HEAD lookup failures', () => {
		const headError = Object.assign(new Error('injected HEAD lookup failure'), { status: 128 });
		const unbornGit = (_command, args) => {
			if (args[0] === 'rev-parse') throw headError;
			if (args[0] === 'symbolic-ref') return 'refs/heads/main\n';
			throw Object.assign(new Error('missing branch ref'), { status: 1 });
		};
		expect(getCurrentHead(unbornGit)).toBe(null);

		const existingRefGit = (_command, args) => {
			if (args[0] === 'rev-parse') throw headError;
			if (args[0] === 'symbolic-ref') return 'refs/heads/main\n';
			return '';
		};
		expect(() => getCurrentHead(existingRefGit)).toThrow('injected HEAD lookup failure');
		expect(() => getCurrentHead(() => 'not-a-full-object-id\n')).toThrow('full Git object id');
	});

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
			runGit(root, ['init', '--quiet']);
			runGit(root, ['config', 'user.email', 'forge-test@example.invalid']);
			runGit(root, ['config', 'user.name', 'Forge Test']);
			runGit(root, ['commit', '--allow-empty', '-m', 'base']);
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

	test('passes safe staged edits alongside an independently reproducible lock', () => {
		const root = createTempDir();
		try {
			stageLocalLockFixture(root);
			const result = spawnSync('node', [scriptPath], {
				cwd: root,
				stdio: 'pipe',
				env: {
					...process.env,
					FORGE_PROTECTED_STATE_STAGED_FILES: 'lib/safe.js\ntest/safe.test.js',
				},
			});
			expect(result.stderr.toString()).toBe('');
			expect(result.status).toBe(0);
			expect(result.stdout.toString()).toContain('No protected state edits detected');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 15_000);

	test('does not allow a surface-only environment declaration without content-bound evidence', () => {
		const root = createTempDir();
		try {
			stageLocalLockFixture(root, true);
			const result = spawnSync('node', [scriptPath], {
				cwd: root,
				stdio: 'pipe',
				env: {
					...process.env,
					FORGE_PROTECTED_STATE_STAGED_FILES: 'bun.lock',
					FORGE_PROTECTED_STATE_ALLOWED_SURFACES: 'lockfiles',
				},
			});
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain('bun.lock');
			expect(result.stderr.toString()).toContain('Regenerated bun.lock does not match the staged content');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
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

describe('scripts/protected-state-check.js merge awareness', () => {
	const scriptPath = path.join(__dirname, '..', 'scripts', 'protected-state-check.js');
	const WORKFLOW = '.github/workflows/test.yml';

	function writeRepoFile(root, relPath, content) {
		fs.mkdirSync(path.join(root, path.dirname(relPath)), { recursive: true });
		fs.writeFileSync(path.join(root, relPath), content);
	}

	// A repo with a real origin and a recorded default branch, so the canonical
	// upstream ref resolves the way a clone's would.
	function initRepo(root) {
		const remote = path.join(root, 'remote.git');
		const work = path.join(root, 'work');
		runGit(root, ['init', '--bare', '--quiet', '--initial-branch=master', remote]);
		runGit(root, ['init', '--quiet', '--initial-branch=master', work]);
		runGit(work, ['config', 'user.email', 'test@example.com']);
		runGit(work, ['config', 'user.name', 'Test']);
		runGit(work, ['config', 'commit.gpgsign', 'false']);
		runGit(work, ['remote', 'add', 'origin', remote]);
		writeRepoFile(work, WORKFLOW, 'name: base\n');
		writeRepoFile(work, 'lib/safe.js', 'module.exports = 1;\n');
		runGit(work, ['add', '.']);
		runGit(work, ['commit', '--quiet', '-m', 'base']);
		runGit(work, ['push', '--quiet', '-u', 'origin', 'master']);
		runGit(work, ['remote', 'set-head', 'origin', 'master']);
		return work;
	}

	// Commit a workflow change on `branch`, optionally publish it to the canonical
	// upstream (origin/master), then merge it into a feature branch without committing.
	function startMerge(work, { branch, publish }) {
		runGit(work, ['checkout', '--quiet', '-b', 'feature']);
		runGit(work, ['checkout', '--quiet', '-B', branch, 'master']);
		writeRepoFile(work, WORKFLOW, 'name: base\njobs: {}\n');
		runGit(work, ['add', WORKFLOW]);
		runGit(work, ['commit', '--quiet', '-m', 'workflow change']);
		if (publish) {
			runGit(work, ['push', '--quiet', 'origin', `${branch}:master`]);
			runGit(work, ['fetch', '--quiet', 'origin']);
		}
		runGit(work, ['checkout', '--quiet', 'feature']);
		writeRepoFile(work, 'lib/safe.js', 'module.exports = 2;\n');
		runGit(work, ['add', 'lib/safe.js']);
		runGit(work, ['commit', '--quiet', '-m', 'feature change']);
		runGit(work, ['merge', '--no-commit', '--no-ff', '--quiet', branch]);
	}

	function runCheck(work, extraEnv = {}) {
		return spawnSync('node', [scriptPath], {
			cwd: work,
			stdio: 'pipe',
			env: { ...process.env, FORGE_PROTECTED_STATE_ACTOR: 'merge-test', ...extraEnv },
		});
	}

	test('allows a merge whose protected blob matches a MERGE_HEAD in the canonical upstream', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			startMerge(work, { branch: 'upstream-work', publish: true });
			const result = runCheck(work);
			expect(`${result.stdout}${result.stderr}`).not.toContain('Protected state edit detected');
			expect(result.status).toBe(0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks protected content from an old upstream commit after the current upstream reverted it', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			runGit(work, ['checkout', '--quiet', '-b', 'feature']);
			runGit(work, ['checkout', '--quiet', '-B', 'upstream-work', 'master']);
			writeRepoFile(work, WORKFLOW, 'name: stale-upstream\njobs: {}\n');
			runGit(work, ['add', WORKFLOW]);
			runGit(work, ['commit', '--quiet', '-m', 'change workflow']);
			const staleUpstream = runGitCapture(work, ['rev-parse', 'HEAD']);
			runGit(work, ['revert', '--quiet', '--no-edit', 'HEAD']);
			runGit(work, ['push', '--quiet', 'origin', 'upstream-work:master']);
			runGit(work, ['fetch', '--quiet', 'origin']);
			runGit(work, ['checkout', '--quiet', 'feature']);
			writeRepoFile(work, 'lib/safe.js', 'module.exports = 2;\n');
			runGit(work, ['add', 'lib/safe.js']);
			runGit(work, ['commit', '--quiet', '-m', 'feature change']);
			runGit(work, ['merge', '--no-commit', '--no-ff', '--quiet', staleUpstream]);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks a deletion from an old upstream commit after the current upstream restored the path', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			runGit(work, ['checkout', '--quiet', '-b', 'feature']);
			runGit(work, ['checkout', '--quiet', '-B', 'upstream-work', 'master']);
			runGit(work, ['rm', '--quiet', WORKFLOW]);
			runGit(work, ['commit', '--quiet', '-m', 'delete workflow']);
			const staleUpstream = runGitCapture(work, ['rev-parse', 'HEAD']);
			runGit(work, ['revert', '--quiet', '--no-edit', 'HEAD']);
			runGit(work, ['push', '--quiet', 'origin', 'upstream-work:master']);
			runGit(work, ['fetch', '--quiet', 'origin']);
			runGit(work, ['checkout', '--quiet', 'feature']);
			writeRepoFile(work, 'lib/safe.js', 'module.exports = 2;\n');
			runGit(work, ['add', 'lib/safe.js']);
			runGit(work, ['commit', '--quiet', '-m', 'feature change']);
			runGit(work, ['merge', '--no-commit', '--no-ff', '--quiet', staleUpstream]);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks a merge when the local upstream ref is stale', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			const remote = runGitCapture(work, ['remote', 'get-url', 'origin']);
			runGit(work, ['checkout', '--quiet', '-b', 'feature']);
			runGit(work, ['checkout', '--quiet', '-B', 'upstream-work', 'master']);
			writeRepoFile(work, WORKFLOW, 'name: stale-upstream\njobs: {}\n');
			runGit(work, ['add', WORKFLOW]);
			runGit(work, ['commit', '--quiet', '-m', 'change workflow']);
			const staleUpstream = runGitCapture(work, ['rev-parse', 'HEAD']);
			runGit(work, ['push', '--quiet', 'origin', 'upstream-work:master']);
			runGit(work, ['fetch', '--quiet', 'origin']);

			const publisher = path.join(root, 'publisher');
			runGit(root, ['clone', '--quiet', remote, publisher]);
			runGit(publisher, ['config', 'user.email', 'publisher@example.com']);
			runGit(publisher, ['config', 'user.name', 'Publisher']);
			runGit(publisher, ['revert', '--quiet', '--no-edit', 'HEAD']);
			runGit(publisher, ['push', '--quiet', 'origin', 'master']);
			expect(runGitCapture(work, ['rev-parse', 'refs/remotes/origin/master'])).toBe(staleUpstream);

			runGit(work, ['checkout', '--quiet', 'feature']);
			writeRepoFile(work, 'lib/safe.js', 'module.exports = 2;\n');
			runGit(work, ['add', 'lib/safe.js']);
			runGit(work, ['commit', '--quiet', '-m', 'feature change']);
			runGit(work, ['merge', '--no-commit', '--no-ff', '--quiet', staleUpstream]);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks a merge when local and advertised remote HEAD disagree', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			runGit(work, ['checkout', '--quiet', '-b', 'feature']);
			runGit(work, ['checkout', '--quiet', '-B', 'wrong-default', 'master']);
			writeRepoFile(work, WORKFLOW, 'name: wrong-default\njobs: {}\n');
			runGit(work, ['add', WORKFLOW]);
			runGit(work, ['commit', '--quiet', '-m', 'change workflow']);
			runGit(work, ['push', '--quiet', 'origin', 'wrong-default:main']);
			runGit(work, ['fetch', '--quiet', 'origin']);
			runGit(work, ['remote', 'set-head', 'origin', 'main']);
			expect(runGitCapture(work, ['symbolic-ref', 'refs/remotes/origin/HEAD'])).toBe('refs/remotes/origin/main');
			expect(runGitCapture(work, ['ls-remote', '--symref', 'origin', 'HEAD'])).toContain('ref: refs/heads/master\tHEAD');

			runGit(work, ['checkout', '--quiet', 'feature']);
			writeRepoFile(work, 'lib/safe.js', 'module.exports = 2;\n');
			runGit(work, ['add', 'lib/safe.js']);
			runGit(work, ['commit', '--quiet', '-m', 'feature change']);
			runGit(work, ['merge', '--no-commit', '--no-ff', '--quiet', 'wrong-default']);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks a trusted merge-side exemption when the upstream is unreachable', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			startMerge(work, { branch: 'upstream-work', publish: true });
			runGit(work, ['remote', 'set-url', 'origin', path.join(root, 'missing.git')]);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks a merge whose protected blob is only reachable from a hand-created remote-tracking ref', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			runGit(work, ['checkout', '--quiet', '-b', 'feature']);
			runGit(work, ['checkout', '--quiet', '-B', 'attacker-branch', 'master']);
			writeRepoFile(work, WORKFLOW, 'name: base\njobs: {}\n');
			runGit(work, ['add', WORKFLOW]);
			runGit(work, ['commit', '--quiet', '-m', 'workflow change']);
			// Locally forged "published" provenance: a refs/remotes ref nobody fetched.
			runGit(work, ['update-ref', 'refs/remotes/attacker/x', 'attacker-branch']);
			runGit(work, ['checkout', '--quiet', 'feature']);
			writeRepoFile(work, 'lib/safe.js', 'module.exports = 2;\n');
			runGit(work, ['add', 'lib/safe.js']);
			runGit(work, ['commit', '--quiet', '-m', 'feature change']);
			runGit(work, ['merge', '--no-commit', '--no-ff', '--quiet', 'attacker-branch']);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks a merge from a local-only branch that modified a protected path', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			startMerge(work, { branch: 'local-only', publish: false });
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('still blocks a merge-in-progress protected path edited beyond the merge content', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			startMerge(work, { branch: 'upstream-work', publish: true });
			writeRepoFile(work, WORKFLOW, 'name: base\njobs: {}\n# hand edit\n');
			runGit(work, ['add', WORKFLOW]);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('still requires the bun.lock regeneration proof for a lockfile carried in by a merge', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			runGit(work, ['checkout', '--quiet', '-b', 'feature']);
			runGit(work, ['checkout', '--quiet', '-B', 'upstream-work', 'master']);
			writeRepoFile(work, 'bun.lock', '{"lockfileVersion": 1}\n');
			runGit(work, ['add', 'bun.lock']);
			runGit(work, ['commit', '--quiet', '-m', 'lockfile change']);
			runGit(work, ['push', '--quiet', 'origin', 'upstream-work:master']);
			runGit(work, ['fetch', '--quiet', 'origin']);
			runGit(work, ['checkout', '--quiet', 'feature']);
			writeRepoFile(work, 'lib/safe.js', 'module.exports = 2;\n');
			runGit(work, ['add', 'lib/safe.js']);
			runGit(work, ['commit', '--quiet', '-m', 'feature change']);
			runGit(work, ['merge', '--no-commit', '--no-ff', '--quiet', 'upstream-work']);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain('bun.lock');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);

	test('blocks a mode-only change to a protected path carried in by a merge', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			startMerge(work, { branch: 'upstream-work', publish: true });
			// Same blob as the trusted merge side, different mode.
			runGit(work, ['update-index', '--chmod=+x', WORKFLOW]);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('grants no exemption when HEAD cannot be resolved during a merge', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			startMerge(work, { branch: 'upstream-work', publish: true });
			// Same staged bytes as the allowed case, but HEAD no longer resolves.
			runGit(work, ['symbolic-ref', 'HEAD', 'refs/heads/gone']);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('still blocks a staged protected path when no merge is in progress', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			writeRepoFile(work, WORKFLOW, 'name: base\njobs: {}\n');
			runGit(work, ['add', WORKFLOW]);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks a hand-edited protected path during a merge under inherited GIT_LITERAL_PATHSPECS', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			startMerge(work, { branch: 'upstream-work', publish: true });
			writeRepoFile(work, WORKFLOW, 'name: base\njobs: {}\n# hand edit\n');
			runGit(work, ['add', WORKFLOW]);
			// Forced literal-pathspec mode would make `:(literal)<file>` probes match
			// nothing, so absent would compare equal to absent and exempt everything.
			const result = runCheck(work, { GIT_LITERAL_PATHSPECS: '1' });
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('still allows a genuine upstream merge carry-over under inherited GIT_LITERAL_PATHSPECS', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			startMerge(work, { branch: 'upstream-work', publish: true });
			const result = runCheck(work, { GIT_LITERAL_PATHSPECS: '1' });
			expect(`${result.stdout}${result.stderr}`).not.toContain('Protected state edit detected');
			expect(result.status).toBe(0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks a staged non-deletion protected path whose index probe finds nothing', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			startMerge(work, { branch: 'upstream-work', publish: true });
			// Reported as staged-modified, but absent from the index: the probe and the
			// revision lookup both come back empty, which must never read as equal.
			const result = runCheck(work, {
				FORGE_PROTECTED_STATE_STAGED_NAME_STATUS: 'M\t.github/workflows/ghost.yml',
			});
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain('.github/workflows/ghost.yml');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('allows a protected path deleted by a merge from the canonical upstream', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			runGit(work, ['checkout', '--quiet', '-b', 'feature']);
			runGit(work, ['checkout', '--quiet', '-B', 'upstream-work', 'master']);
			runGit(work, ['rm', '--quiet', WORKFLOW]);
			runGit(work, ['commit', '--quiet', '-m', 'delete workflow']);
			runGit(work, ['push', '--quiet', 'origin', 'upstream-work:master']);
			runGit(work, ['fetch', '--quiet', 'origin']);
			runGit(work, ['checkout', '--quiet', 'feature']);
			writeRepoFile(work, 'lib/safe.js', 'module.exports = 2;\n');
			runGit(work, ['add', 'lib/safe.js']);
			runGit(work, ['commit', '--quiet', '-m', 'feature change']);
			runGit(work, ['merge', '--no-commit', '--no-ff', '--quiet', 'upstream-work']);
			const result = runCheck(work);
			expect(`${result.stdout}${result.stderr}`).not.toContain('Protected state edit detected');
			expect(result.status).toBe(0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks a manual deletion of a HEAD-only protected path during an upstream merge', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			const featureOnly = '.github/workflows/feature-only.yml';
			runGit(work, ['checkout', '--quiet', '-b', 'feature']);
			// Exists only on the branch being committed onto; the upstream never had it.
			writeRepoFile(work, featureOnly, 'name: feature-only\n');
			runGit(work, ['add', featureOnly]);
			runGit(work, ['commit', '--quiet', '-m', 'feature-only workflow']);
			runGit(work, ['checkout', '--quiet', '-B', 'upstream-work', 'master']);
			writeRepoFile(work, 'lib/safe.js', 'module.exports = 2;\n');
			runGit(work, ['add', 'lib/safe.js']);
			runGit(work, ['commit', '--quiet', '-m', 'upstream change']);
			runGit(work, ['push', '--quiet', 'origin', 'upstream-work:master']);
			runGit(work, ['fetch', '--quiet', 'origin']);
			runGit(work, ['checkout', '--quiet', 'feature']);
			runGit(work, ['merge', '--no-commit', '--no-ff', '--quiet', 'upstream-work']);
			// The merge left the path alone; this deletion is the committer's own edit.
			runGit(work, ['rm', '--quiet', featureOnly]);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(featureOnly);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks a staged protected deletion when the merge base cannot be resolved', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			// An unrelated-history upstream: absent there, but no merge base can prove
			// the side ever deleted anything.
			runGit(work, ['checkout', '--quiet', '--orphan', 'orphan']);
			runGit(work, ['rm', '-r', '-f', '--quiet', '.']);
			writeRepoFile(work, 'lib/other.js', 'module.exports = 3;\n');
			runGit(work, ['add', 'lib/other.js']);
			runGit(work, ['commit', '--quiet', '-m', 'unrelated root']);
			runGit(work, ['push', '--quiet', '--force', 'origin', 'orphan:master']);
			runGit(work, ['fetch', '--quiet', 'origin']);
			runGit(work, ['checkout', '--quiet', '-b', 'feature', 'master']);
			runGit(work, ['merge', '--no-commit', '--no-ff', '--quiet', '--allow-unrelated-histories', 'orphan']);
			runGit(work, ['rm', '--quiet', WORKFLOW]);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	// A fork-style checkout: `origin` is the contributor-owned fork the feature
	// branch tracks, `upstream` is the official repository the PR merges into.
	// Provenance must be resolved against `upstream`, never the tracking remote.
	function initForkRepo(root) {
		const upstreamRemote = path.join(root, 'upstream.git');
		const forkRemote = path.join(root, 'fork.git');
		const work = path.join(root, 'work');
		runGit(root, ['init', '--bare', '--quiet', '--initial-branch=master', upstreamRemote]);
		runGit(root, ['init', '--bare', '--quiet', '--initial-branch=master', forkRemote]);
		runGit(root, ['init', '--quiet', '--initial-branch=master', work]);
		runGit(work, ['config', 'user.email', 'test@example.com']);
		runGit(work, ['config', 'user.name', 'Test']);
		runGit(work, ['config', 'commit.gpgsign', 'false']);
		runGit(work, ['remote', 'add', 'origin', forkRemote]);
		runGit(work, ['remote', 'add', 'upstream', upstreamRemote]);
		writeRepoFile(work, WORKFLOW, 'name: base\n');
		writeRepoFile(work, 'lib/safe.js', 'module.exports = 1;\n');
		runGit(work, ['add', '.']);
		runGit(work, ['commit', '--quiet', '-m', 'base']);
		runGit(work, ['push', '--quiet', 'upstream', 'master']);
		runGit(work, ['push', '--quiet', 'origin', 'master']);
		runGit(work, ['remote', 'set-head', 'origin', 'master']);
		runGit(work, ['remote', 'set-head', 'upstream', 'master']);
		return work;
	}

	// Change a protected path on `fork-work`, publish it to the fork's default
	// branch, optionally publish it to the official repo too, then merge it into a
	// feature branch that tracks the fork.
	function startForkMerge(work, { publishUpstream }) {
		runGit(work, ['checkout', '--quiet', '-B', 'fork-work', 'master']);
		writeRepoFile(work, WORKFLOW, 'name: base\njobs: {}\n');
		runGit(work, ['add', WORKFLOW]);
		runGit(work, ['commit', '--quiet', '-m', 'workflow change']);
		runGit(work, ['push', '--quiet', 'origin', 'fork-work:master']);
		if (publishUpstream) {
			runGit(work, ['push', '--quiet', 'upstream', 'fork-work:master']);
		}
		runGit(work, ['fetch', '--quiet', '--all']);
		runGit(work, ['checkout', '--quiet', '-b', 'feature', 'master']);
		// The feature branch tracks the contributor's fork, not the official repo.
		runGit(work, ['push', '--quiet', '-u', 'origin', 'feature']);
		writeRepoFile(work, 'lib/safe.js', 'module.exports = 2;\n');
		runGit(work, ['add', 'lib/safe.js']);
		runGit(work, ['commit', '--quiet', '-m', 'feature change']);
		runGit(work, ['merge', '--no-commit', '--no-ff', '--quiet', 'fork-work']);
	}

	test('blocks a fork-published protected change absent from the upstream base remote', () => {
		const root = createTempDir();
		try {
			const work = initForkRepo(root);
			startForkMerge(work, { publishUpstream: false });
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('allows the same fork merge once the change is published to the upstream base remote', () => {
		const root = createTempDir();
		try {
			const work = initForkRepo(root);
			startForkMerge(work, { publishUpstream: true });
			const result = runCheck(work);
			expect(`${result.stdout}${result.stderr}`).not.toContain('Protected state edit detected');
			expect(result.status).toBe(0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks a fork-only merge when upstream is configured but has no fetched tracking refs', () => {
		const root = createTempDir();
		try {
			const work = initForkRepo(root);
			startForkMerge(work, { publishUpstream: false });
			// Simulate an unfetched official remote: upstream exists but has no
			// tracking refs, so falling through to origin would change trust domains.
			runGit(work, ['remote', 'set-head', 'upstream', '-d']);
			runGit(work, ['update-ref', '-d', 'refs/remotes/upstream/master']);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	test('blocks a merge carry-over when the upstream base branch is ambiguous', () => {
		const root = createTempDir();
		try {
			const work = initRepo(root);
			// Both conventional defaults exist with no authoritative HEAD, so
			// candidate-order trust would pick main even when master is real.
			runGit(work, ['checkout', '--quiet', '-B', 'main', 'master']);
			runGit(work, ['push', '--quiet', 'origin', 'main']);
			runGit(work, ['fetch', '--quiet', 'origin']);
			runGit(work, ['remote', 'set-head', 'origin', '-d']);
			// Protected change published only to main (the candidate-order pick).
			runGit(work, ['checkout', '--quiet', '-b', 'feature']);
			runGit(work, ['checkout', '--quiet', '-B', 'ambiguous-work', 'master']);
			writeRepoFile(work, WORKFLOW, 'name: base\njobs: {}\n');
			runGit(work, ['add', WORKFLOW]);
			runGit(work, ['commit', '--quiet', '-m', 'workflow change']);
			runGit(work, ['push', '--quiet', 'origin', 'ambiguous-work:main']);
			runGit(work, ['fetch', '--quiet', 'origin']);
			// Delete HEAD after the final fetch: fetch recreates the tracking
			// HEAD, so remove it again to keep the base genuinely ambiguous.
			runGit(work, ['remote', 'set-head', 'origin', '-d']);
			runGit(work, ['checkout', '--quiet', 'feature']);
			writeRepoFile(work, 'lib/safe.js', 'module.exports = 2;\n');
			runGit(work, ['add', 'lib/safe.js']);
			runGit(work, ['commit', '--quiet', '-m', 'feature change']);
			runGit(work, ['merge', '--no-commit', '--no-ff', '--quiet', 'ambiguous-work']);
			const result = runCheck(work);
			expect(result.status).toBe(1);
			expect(`${result.stdout}${result.stderr}`).toContain(WORKFLOW);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);
});
