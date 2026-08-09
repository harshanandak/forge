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
	test('isolates every proof Git command from inherited repository-local Git environment', () => {
		const primaryRoot = tempRepo();
		commitBase(primaryRoot);
		const linkedRoot = `${primaryRoot}-linked`;
		tempDirs.push(linkedRoot);
		run('git', ['worktree', 'add', '--quiet', '--detach', linkedRoot, 'HEAD'], primaryRoot);
		const proposed = 'generated:2.0.0\n';
		stageProof(linkedRoot, { name: 'fixture', version: '2.0.0', packageManager: RUNTIME_PACKAGE_MANAGER }, proposed);

		const gitDir = run('git', ['rev-parse', '--absolute-git-dir'], linkedRoot).stdout.trim();
		const commonDir = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], linkedRoot).stdout.trim();
		const sharedConfig = path.join(commonDir, 'config');
		const configBefore = fs.readFileSync(sharedConfig);
		const bareBefore = run('git', ['config', '--bool', '--get', 'core.bare'], linkedRoot).stdout.trim();
		const helperPath = path.resolve(__dirname, '../lib/bun-lockfile-proof.js');
		const verifierScript = `
			const fs = require('node:fs');
			const path = require('node:path');
			const childProcess = require('node:child_process');
			const mode = process.argv[1] || 'success';
			childProcess.spawnSync = (_command, args, options) => {
				if (args[0] === '--version') return { status: 0, stdout: ${JSON.stringify(`${RUNTIME_BUN_VERSION}\n`)}, stderr: '' };
				if (mode === 'failed') return { status: 1, stdout: '', stderr: 'failed' };
				if (mode === 'timed-out') return { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } };
				fs.writeFileSync(path.join(options.cwd, 'bun.lock'), ${JSON.stringify(proposed)});
				return { status: 0, stdout: '', stderr: '' };
			};
			const { verifyBunLockfileRegeneration } = require(${JSON.stringify(helperPath)});
			process.stdout.write(JSON.stringify(verifyBunLockfileRegeneration(${JSON.stringify(linkedRoot)})));
		`;
		const runVerifier = (inheritedGitEnvironment, mode = 'success') => {
			const verification = spawnSync('node', ['-e', verifierScript, mode], {
				cwd: linkedRoot,
				encoding: 'utf8',
				timeout: 30_000,
				env: { ...process.env, ...inheritedGitEnvironment },
			});
			expect(verification.status).toBe(0);
			return JSON.parse(verification.stdout);
		};

		const result = runVerifier({ GIT_DIR: gitDir, GIT_WORK_TREE: linkedRoot });

		expect(fs.readFileSync(sharedConfig)).toEqual(configBefore);
		expect(run('git', ['config', '--bool', '--get', 'core.bare'], linkedRoot).stdout.trim()).toBe(bareBefore);
		expect(result).toMatchObject({ allowed: true });

		const localVariables = run('git', ['rev-parse', '--local-env-vars'], linkedRoot).stdout.trim().split(/\r?\n/);
		const allLocalGitEnvironment = {
			GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(commonDir, 'objects'),
			GIT_CONFIG: sharedConfig,
			GIT_CONFIG_PARAMETERS: "'core.bare=false'",
			GIT_CONFIG_COUNT: '1',
			GIT_CONFIG_KEY_0: 'core.bare',
			GIT_CONFIG_VALUE_0: 'false',
			GIT_OBJECT_DIRECTORY: path.join(commonDir, 'objects'),
			GIT_DIR: gitDir,
			GIT_WORK_TREE: linkedRoot,
			GIT_IMPLICIT_WORK_TREE: '1',
			GIT_GRAFT_FILE: path.join(commonDir, 'info', 'grafts'),
			GIT_INDEX_FILE: path.join(gitDir, 'redirected-index'),
			GIT_NO_REPLACE_OBJECTS: '1',
			GIT_REPLACE_REF_BASE: 'refs/replace/',
			GIT_PREFIX: 'nested/',
			GIT_SHALLOW_FILE: path.join(gitDir, 'shallow'),
			GIT_COMMON_DIR: commonDir,
		};
		expect(Object.keys(allLocalGitEnvironment)).toEqual(expect.arrayContaining(localVariables));
		expect(runVerifier(allLocalGitEnvironment)).toMatchObject({ allowed: true });
		expect(fs.readFileSync(sharedConfig)).toEqual(configBefore);
		expect(run('git', ['config', '--bool', '--get', 'core.bare'], linkedRoot).stdout.trim()).toBe(bareBefore);

		for (const mode of ['failed', 'timed-out']) {
			expect(runVerifier(allLocalGitEnvironment, mode)).toMatchObject({
				allowed: false,
				reason: 'Bun lockfile regeneration failed',
			});
			expect(fs.readFileSync(sharedConfig)).toEqual(configBefore);
			expect(run('git', ['config', '--bool', '--get', 'core.bare'], linkedRoot).stdout.trim()).toBe(bareBefore);
		}
	}, 120_000);

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
		fs.mkdirSync(path.join(root, 'packages', 'child'), { recursive: true });
		fs.writeFileSync(path.join(root, 'packages', 'child', '.npmrc'), 'registry=https://example.invalid\n');
		run('git', ['add', 'packages/child/.npmrc'], root);
		expect(verifyBunLockfileRegeneration(root, { spawnSync: spawn })).toMatchObject({
			allowed: false,
			reason: 'Tracked .npmrc is outside the deterministic proof contract',
		});
		run('git', ['rm', '--cached', '--quiet', 'packages/child/.npmrc'], root);
		fs.rmSync(path.join(root, 'packages'), { recursive: true, force: true });

		let installCalls = 0;
		const racingSpawn = (_command, args, options) => {
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

	test('allows a clean staged rename while parsing porcelain v1 -z source records', () => {
		const root = tempRepo();
		commitBase(root);
		fs.writeFileSync(path.join(root, 'before.txt'), 'tracked\n');
		run('git', ['add', 'before.txt'], root);
		run('git', ['commit', '--quiet', '-m', 'tracked rename source'], root);
		run('git', ['mv', 'before.txt', 'after.txt'], root);
		const proposed = 'generated:2.0.0\n';
		stageProof(root, { name: 'fixture', version: '2.0.0', packageManager: RUNTIME_PACKAGE_MANAGER }, proposed);
		expect(verifyBunLockfileRegeneration(root, {
			spawnSync: fakeBun(() => proposed),
		})).toMatchObject({ allowed: true });
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
		const racingSpawn = (_command, args, options) => {
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

	test('passes the isolated proof root explicitly to Bun install', () => {
		const root = tempRepo();
		commitBase(root);
		const proposed = 'generated:2.0.0\n';
		stageProof(root, { name: 'fixture', version: '2.0.0', packageManager: RUNTIME_PACKAGE_MANAGER }, proposed);
		let installArguments;
		const spawn = (_command, args, options) => {
			if (args[0] === '--version') return { status: 0, stdout: `${RUNTIME_BUN_VERSION}\n`, stderr: '' };
			installArguments = args;
			expect(args).toContain(`--cwd=${options.cwd}`);
			fs.writeFileSync(path.join(options.cwd, 'bun.lock'), proposed);
			return { status: 0, stdout: '', stderr: '' };
		};

		expect(verifyBunLockfileRegeneration(root, { spawnSync: spawn })).toMatchObject({ allowed: true });
		expect(installArguments?.filter(argument => argument.startsWith('--cwd='))).toHaveLength(1);
	});

	test('canonicalizes an 8.3 TEMP alias before accepting a byte-identical lock', () => {
		const root = tempRepo();
		commitBase(root);
		const proposed = Buffer.from('generated:2.0.0\n');
		stageProof(root, { name: 'fixture', version: '2.0.0', packageManager: RUNTIME_PACKAGE_MANAGER }, proposed);
		let proofRoot;
		let nativeProofRoot;
		const spawn = (_command, args, options) => {
			if (args[0] === '--version') return { status: 0, stdout: `${RUNTIME_BUN_VERSION}\n`, stderr: '' };
			proofRoot = options.cwd;
			nativeProofRoot = fs.realpathSync.native(options.cwd);
			fs.writeFileSync(path.join(options.cwd, 'bun.lock'), proposed);
			return { status: 0, stdout: '', stderr: '' };
		};

		expect(verifyBunLockfileRegeneration(root, { spawnSync: spawn })).toMatchObject({ allowed: true });
		expect(proofRoot).toBe(nativeProofRoot);
		expect(Buffer.from('generated:2.0.0\n')).toEqual(proposed);
	});

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
