'use strict';

const { describe, test, expect, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const initCommand = require('../../lib/commands/init');
const setupCommand = require('../../lib/commands/setup');
const { checkHookInstallation, checkRuntimeHealth } = require('../../lib/runtime-health');

// Gap 2 coverage: a fresh `forge init` must leave the repo in a state where the
// stage commands can run — i.e. NOT blocked by HOOKS_NOT_ACTIVE. Today init
// scaffolds .forge/ but never installs git hooks, so `forge validate`/`plan`
// immediately hard-stop. init must close that onboarding path by installing the
// hooks (the same lefthook install setup performs).
const tempRoots = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function makeCleanRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-init-hooks-'));
	tempRoots.push(root);
	execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
	return root;
}

// Faithful stand-in for `lefthook install`: writes the pre-commit/pre-push hook
// files lefthook would create so checkHookInstallation classifies them as active.
// Used to keep the onboarding test deterministic (no network `lefthook` fetch).
function writeLefthookHooks(projectRoot) {
	const hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
		cwd: projectRoot,
		encoding: 'utf8',
	}).trim();
	const absHooksDir = path.isAbsolute(hooksDir) ? hooksDir : path.join(projectRoot, hooksDir);
	fs.mkdirSync(absHooksDir, { recursive: true });
	for (const hook of ['pre-commit', 'pre-push']) {
		const file = path.join(absHooksDir, hook);
		fs.writeFileSync(file, `#!/bin/sh\nlefthook run ${hook} "$@"\n`, { mode: 0o755 });
		fs.chmodSync(file, 0o755);
	}
}

function hooksNotActiveDiagnostics(root) {
	return checkRuntimeHealth(root).diagnostics.filter((d) => d.code === 'HOOKS_NOT_ACTIVE');
}

describe('forge init closes the hooks onboarding path', () => {
	test('a bare git repo is HOOKS_NOT_ACTIVE before any init (sanity)', () => {
		const root = makeCleanRepo();
		expect(checkHookInstallation(root).active).toBe(false);
		expect(hooksNotActiveDiagnostics(root).length).toBe(1);
	});

	test('a fresh init installs hooks so stage commands are not HOOKS_NOT_ACTIVE-blocked', async () => {
		const root = makeCleanRepo();
		let installedFor = null;
		const deps = {
			installHooks: (projectRoot) => {
				installedFor = projectRoot;
				writeLefthookHooks(projectRoot);
			},
		};

		const result = await initCommand.handler(['--profile', 'minimal', '--yes'], {}, root, deps);

		expect(result.success).toBe(true);
		expect(installedFor).toBe(root);
		expect(checkHookInstallation(root).active).toBe(true);
		expect(checkHookInstallation(root).state).toBe('active');
		expect(hooksNotActiveDiagnostics(root)).toEqual([]);
	});

	test('init auto-migrates an existing Beads store while onboarding', async () => {
		const root = makeCleanRepo();
		let migratedFor = null;
		const deps = {
			installHooks: () => {},
			autoMigrateBeads: (projectRoot) => {
				migratedFor = projectRoot;
				return { migrated: false, reason: 'stubbed' };
			},
		};

		await initCommand.handler(['--profile', 'minimal', '--yes'], {}, root, deps);
		expect(migratedFor).toBe(root);
	});

	test('init defaults its hook installer to setup.ensureGitHooksInstalled', () => {
		expect(typeof setupCommand.ensureGitHooksInstalled).toBe('function');
	});
});
