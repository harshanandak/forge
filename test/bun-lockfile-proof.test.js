'use strict';

const { describe, expect, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  parseBunVersion,
  resolveContainedPath,
  verifyBunLockfileRegeneration,
} = require('../lib/bun-lockfile-proof');

const HOOK_PATH = path.resolve(__dirname, '../scripts/protected-state-check.js');
const tempDirs = [];
const RUNTIME_BUN_VERSION = readRuntimeBunVersion();
const RUNTIME_PACKAGE_MANAGER = `bun@${RUNTIME_BUN_VERSION}`;
const MISMATCH_BUN_VERSION = incrementPatchVersion(RUNTIME_BUN_VERSION);

function readRuntimeBunVersion() {
	const result = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 5_000 });
	if (result.status !== 0) throw new Error('Focused lock proof tests require Bun');
	parseBunVersion(result.stdout);
	return result.stdout.trim();
}

function incrementPatchVersion(version) {
	const parsed = parseBunVersion(version);
	return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bun-lock-proof-'));
  tempDirs.push(root);
  run('git', ['init', '--quiet'], root);
  run('git', ['config', 'user.email', 'proof@example.invalid'], root);
  run('git', ['config', 'user.name', 'Lock Proof'], root);
  return root;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result;
}

function commitBase(root, packageJson = { name: 'fixture', version: '1.0.0' }) {
	packageJson.packageManager ||= RUNTIME_PACKAGE_MANAGER;
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'bun.lock'), 'base-lock\n');
  run('git', ['add', 'package.json', 'bun.lock'], root);
  run('git', ['commit', '--quiet', '-m', 'base'], root);
}

function stageProof(root, packageJson, lockContent) {
	fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`);
	fs.writeFileSync(path.join(root, 'bun.lock'), lockContent);
	run('git', ['add', 'package.json', 'bun.lock'], root);
}

function fakeBun(lockFactory, overrides = {}) {
  return (_command, args, options) => {
    if (args[0] === '--version') {
      return overrides.versionResult || { status: 0, stdout: `${RUNTIME_BUN_VERSION}\n`, stderr: '' };
    }
		if (overrides.installResult) return overrides.installResult;
		const projectRoot = bunProjectRoot(args, options);
		const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
		fs.writeFileSync(path.join(projectRoot, 'bun.lock'), lockFactory(manifest, { ...options, projectRoot }));
    return { status: 0, stdout: '', stderr: '' };
  };
}

function bunProjectRoot(args, options) {
	const cwdArgument = args.find(argument => argument.startsWith('--cwd='));
	if (cwdArgument) return path.resolve(options.cwd, cwdArgument.slice('--cwd='.length));
	const cwdIndex = args.indexOf('--cwd');
	return cwdIndex === -1 ? options.cwd : path.resolve(options.cwd, args[cwdIndex + 1]);
}

describe('deterministic Bun lockfile transition proof', () => {
	test('accepts a byte-identical transition from the committed lock and indexed manifests', () => {
		const root = tempRepo();
		commitBase(root);
		fs.writeFileSync(path.join(root, 'bunfig.toml'), '[install]\nregistry = "https://invalid.example"\n');
		run('git', ['add', 'bunfig.toml'], root);
		const proposed = Buffer.from('generated:2.0.0\n');
		stageProof(root, { name: 'fixture', version: '2.0.0', packageManager: RUNTIME_PACKAGE_MANAGER }, proposed);
		const result = verifyBunLockfileRegeneration(root, {
			spawnSync: fakeBun((manifest, options) => {
				expect(fs.existsSync(path.join(options.projectRoot, 'bunfig.toml'))).toBe(false);
				return `generated:${manifest.version}\n`;
			}),
		});

    expect(result).toMatchObject({ allowed: true, decision: 'allowed', requiredSurface: 'lockfiles' });
  });

	test('rejects tampering and staged or unstaged manifest mismatches', () => {
		const root = tempRepo();
		commitBase(root);
		const spawn = fakeBun(manifest => `generated:${manifest.version}\n`);

		stageProof(root, { name: 'fixture', version: '2.0.0', packageManager: RUNTIME_PACKAGE_MANAGER }, 'tampered\n');
		expect(verifyBunLockfileRegeneration(root, { spawnSync: spawn }).allowed).toBe(false);

		fs.writeFileSync(
			path.join(root, 'package.json'),
			`${JSON.stringify({ name: 'fixture', version: 'dirty', packageManager: RUNTIME_PACKAGE_MANAGER })}\n`,
		);
		expect(verifyBunLockfileRegeneration(root, { spawnSync: spawn }).allowed).toBe(false);
	});

	test('never seeds regeneration from an arbitrary proposed lock', () => {
		const root = tempRepo();
		commitBase(root);
		stageProof(root, { name: 'fixture', version: '2.0.0', packageManager: RUNTIME_PACKAGE_MANAGER }, 'attacker-controlled\n');
		let seed;
		const result = verifyBunLockfileRegeneration(root, {
			spawnSync: fakeBun((_manifest, options) => {
				seed = fs.readFileSync(path.join(options.projectRoot, 'bun.lock'), 'utf8');
				return 'generated:2.0.0\n';
			}),
		});
		expect(seed).toBe('base-lock\n');
		expect(result).toMatchObject({ allowed: false, reason: 'Regenerated bun.lock does not match the staged content' });
	});

	test('fails closed for missing, failed, or timed-out Bun processes', () => {
		const root = tempRepo();
		commitBase(root);
		stageProof(root, { name: 'fixture', version: '1.0.0', packageManager: RUNTIME_PACKAGE_MANAGER }, 'generated:1.0.0\n');
		const missing = () => ({ status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) });
		const failed = fakeBun(() => 'generated:1.0.0\n', { installResult: { status: 1, stderr: 'resolution failed' } });
		const timedOut = fakeBun(() => 'generated:1.0.0\n', {
			installResult: { status: null, signal: 'SIGTERM', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
		});

		for (const candidate of [missing, failed, timedOut]) {
			expect(verifyBunLockfileRegeneration(root, { spawnSync: candidate }).allowed).toBe(false);
		}
	});

	test('fails closed when the exact packageManager pin differs from the Bun runtime', () => {
		const root = tempRepo();
		commitBase(root);
		stageProof(root, { name: 'fixture', version: '1.0.0', packageManager: RUNTIME_PACKAGE_MANAGER }, 'generated:1.0.0\n');
		const wrongRuntime = fakeBun(() => 'generated:1.0.0\n', {
			versionResult: { status: 0, stdout: `${MISMATCH_BUN_VERSION}\n`, stderr: '' },
		});
		expect(verifyBunLockfileRegeneration(root, { spawnSync: wrongRuntime })).toMatchObject({
			allowed: false,
			reason: 'Installed Bun does not match root packageManager',
		});
	});

	test('rejects ambiguous pins, workspace escapes, symlinks, and index races', () => {
		const root = tempRepo();
		commitBase(root);
		const generated = 'generated:1.0.0\n';
		const spawn = fakeBun(() => generated);

		stageProof(root, { name: 'fixture', version: '1.0.0', packageManager: `bun@^${RUNTIME_BUN_VERSION}` }, generated);
		expect(verifyBunLockfileRegeneration(root, { spawnSync: spawn }).allowed).toBe(false);

		stageProof(root, { name: 'fixture', version: '1.0.0', packageManager: RUNTIME_PACKAGE_MANAGER, workspaces: ['../outside'] }, generated);
		expect(verifyBunLockfileRegeneration(root, { spawnSync: spawn }).allowed).toBe(false);

		stageProof(root, { name: 'fixture', version: '1.0.0', packageManager: RUNTIME_PACKAGE_MANAGER }, generated);
		const hash = run('git', ['hash-object', 'package.json'], root).stdout.trim();
		run('git', ['update-index', '--add', '--cacheinfo', `120000,${hash},packages/link/package.json`], root);
		expect(verifyBunLockfileRegeneration(root, { spawnSync: spawn }).allowed).toBe(false);
		run('git', ['update-index', '--force-remove', 'packages/link/package.json'], root);

		fs.writeFileSync(path.join(root, '.npmrc'), 'registry=https://example.invalid\n');
		run('git', ['add', '.npmrc'], root);
		expect(verifyBunLockfileRegeneration(root, { spawnSync: spawn }).allowed).toBe(false);
		run('git', ['rm', '--cached', '--quiet', '.npmrc'], root);
		fs.rmSync(path.join(root, '.npmrc'));

		let installCalls = 0;
		const racingSpawn = (command, args, options) => {
			if (args[0] === '--version') return { status: 0, stdout: `${RUNTIME_BUN_VERSION}\n`, stderr: '' };
			installCalls += 1;
			const projectRoot = bunProjectRoot(args, options);
			fs.writeFileSync(path.join(projectRoot, 'bun.lock'), generated);
			fs.writeFileSync(path.join(root, 'race.txt'), 'changed\n');
			run('git', ['add', 'race.txt'], root);
			return { status: 0, stdout: '', stderr: '' };
		};
		expect(verifyBunLockfileRegeneration(root, { spawnSync: racingSpawn }).allowed).toBe(false);
		expect(installCalls).toBe(1);
	});

	test('rejects path escapes and unsupported Bun versions', () => {
		const root = tempRepo();
		expect(require('../package.json').packageManager).toBe('bun@1.3.12');
		expect(() => resolveContainedPath(root, '../package.json')).toThrow(/escape/i);
		expect(() => resolveContainedPath(root, 'C:\\outside\\package.json')).toThrow(/escape/i);
		expect(() => resolveContainedPath(root, 'C:/outside/package.json')).toThrow(/escape/i);
		expect(() => resolveContainedPath(root, '\\\\server\\share\\package.json')).toThrow(/escape/i);
    expect(parseBunVersion('1.3.6\n')).toEqual({ major: 1, minor: 3, patch: 6 });
		expect(parseBunVersion('2.0.0\n')).toEqual({ major: 2, minor: 0, patch: 0 });
		expect(() => parseBunVersion('not bun\n')).toThrow(/version/i);
	});

	test('rejects portable absolute and brace-traversal package paths', () => {
		const root = tempRepo();
		commitBase(root);
		const generated = 'generated:1.0.0\n';
		const spawn = fakeBun(() => generated);
		for (const workspace of ['C:\\outside\\*', 'C:/outside/*', '\\\\server\\share\\*', '{packages,../outside}/*']) {
			stageProof(root, { name: 'fixture', version: '1.0.0', packageManager: RUNTIME_PACKAGE_MANAGER, workspaces: [workspace] }, generated);
			expect(verifyBunLockfileRegeneration(root, { spawnSync: spawn }).allowed).toBe(false);
		}
		stageProof(root, {
			name: 'fixture',
			version: '1.0.0',
			packageManager: RUNTIME_PACKAGE_MANAGER,
			dependencies: { escaped: 'file:C:\\outside\\package' },
		}, generated);
		expect(verifyBunLockfileRegeneration(root, { spawnSync: spawn }).allowed).toBe(false);
	});

	test('rejects a committed HEAD change during regeneration', () => {
		const root = tempRepo();
		commitBase(root);
		const generated = 'generated:2.0.0\n';
		stageProof(root, { name: 'fixture', version: '2.0.0', packageManager: RUNTIME_PACKAGE_MANAGER }, generated);
		const racingSpawn = (command, args, options) => {
			if (args[0] === '--version') return { status: 0, stdout: `${RUNTIME_BUN_VERSION}\n`, stderr: '' };
			const projectRoot = bunProjectRoot(args, options);
			fs.writeFileSync(path.join(projectRoot, 'bun.lock'), generated);
			run('git', ['commit', '--quiet', '-m', 'racing head'], root);
			return { status: 0, stdout: '', stderr: '' };
		};
		expect(verifyBunLockfileRegeneration(root, { spawnSync: racingSpawn })).toMatchObject({
			allowed: false,
			reason: 'Committed HEAD changed during Bun lockfile proof',
		});
	});

	test('the protected-state hook accepts a real pinned transition from the committed lock', () => {
		const root = tempRepo();
		fs.writeFileSync(
			path.join(root, 'package.json'),
			`${JSON.stringify({
				name: 'fixture',
				version: '1.0.0',
				private: true,
				packageManager: RUNTIME_PACKAGE_MANAGER,
				dependencies: { 'is-number': '6.0.0' },
			})}\n`,
		);
		run('bun', ['install', '--lockfile-only', '--ignore-scripts'], root);
		run('git', ['add', 'package.json', 'bun.lock'], root);
		run('git', ['commit', '--quiet', '-m', 'base lock'], root);
		fs.writeFileSync(
			path.join(root, 'package.json'),
			`${JSON.stringify({
				name: 'fixture',
				version: '1.0.0',
				private: true,
				packageManager: RUNTIME_PACKAGE_MANAGER,
				dependencies: { 'is-number': '7.0.0' },
			})}\n`,
		);
		run('bun', ['install', '--lockfile-only', '--ignore-scripts'], root);
		run('git', ['add', 'package.json', 'bun.lock'], root);
		let independentlyGenerated;
		let installEvidence;
		const proof = verifyBunLockfileRegeneration(root, {
			spawnSync: (command, args, options) => {
				const result = spawnSync(command, args, options);
				if (args.includes('install')) installEvidence = result;
				if (args.includes('install') && result.status === 0) {
					const projectRoot = bunProjectRoot(args, options);
					independentlyGenerated = fs.readFileSync(path.join(projectRoot, 'bun.lock'));
				}
				return result;
			},
		});
		expect(installEvidence?.status).toBe(0);
		expect(proof).toMatchObject({ allowed: true });
		expect(independentlyGenerated.toString('utf8')).toBe(fs.readFileSync(path.join(root, 'bun.lock'), 'utf8'));

		const result = spawnSync('node', [HOOK_PATH], {
			cwd: root,
			encoding: 'utf8',
			timeout: 20_000,
			env: { ...process.env, FORGE_PROTECTED_STATE_STAGED_CONTENTS_JSON: '{"bun.lock":"tampered"}' },
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('No protected state edits detected');
		expect(`${result.stdout}${result.stderr}`).not.toMatch(/(?:^|\n)(?:error:|ERROR:)|\b(?:failed|failure)\b/i);
	}, 30_000);

	test('the hook cannot hide a real staged bun.lock behind environment seams', () => {
		const root = tempRepo();
		fs.writeFileSync(
			path.join(root, 'package.json'),
			`${JSON.stringify({
				name: 'fixture',
				version: '1.0.0',
				private: true,
				packageManager: RUNTIME_PACKAGE_MANAGER,
				dependencies: { 'is-number': '7.0.0' },
			})}\n`,
		);
		run('bun', ['install', '--lockfile-only', '--ignore-scripts'], root);
		run('git', ['add', 'package.json', 'bun.lock'], root);
		run('git', ['commit', '--quiet', '-m', 'base lock'], root);
		fs.writeFileSync(path.join(root, 'bun.lock'), 'attacker-controlled\n');
		run('git', ['add', 'bun.lock'], root);

		const result = spawnSync('node', [HOOK_PATH], {
			cwd: root,
			encoding: 'utf8',
			timeout: 20_000,
			env: {
				...process.env,
				FORGE_PROTECTED_STATE_STAGED_FILES: 'lib/safe.js',
				FORGE_PROTECTED_STATE_STAGED_CONTENTS_JSON: '{"lib/safe.js":"benign"}',
			},
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Regenerated bun.lock does not match the staged content');
	}, 30_000);
});

process.on('exit', () => {
  for (const root of tempDirs) fs.rmSync(root, { recursive: true, force: true });
});
