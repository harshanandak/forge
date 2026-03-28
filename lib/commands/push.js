'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const forgeToken = require('../../scripts/check-forge-token');

const isWindows = process.platform === 'win32';

/**
 * Detect package manager from lock files.
 * Same priority order as scripts/test.js.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {function} [existsSync] - Injected fs.existsSync for testing
 * @returns {string} Package manager command name
 */
function detectPackageManager(projectRoot, existsSync = fs.existsSync) {
	if (existsSync(path.join(projectRoot, 'bun.lockb')) || existsSync(path.join(projectRoot, 'bun.lock'))) return 'bun';
	if (existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
	if (existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
	return 'npm';
}

/**
 * Get the current git branch name.
 *
 * @param {function} execFn - execFileSync or mock
 * @returns {string} Current branch name
 */
function getCurrentBranch(execFn) {
	try {
		return execFn('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
	} catch (_err) { /* intentional: fallback to 'unknown' */
		return 'unknown';
	}
}

/**
 * Check if this is the first push to the current branch.
 * If `git rev-list --count origin/<branch>` throws, the remote tracking
 * branch doesn't exist yet — meaning this is a first push.
 *
 * @param {string} branch - Branch name
 * @param {function} execFn - execFileSync or mock
 * @returns {boolean} True if first push (no remote tracking branch)
 */
function isFirstPush(branch, execFn) {
	try {
		execFn('git', ['rev-list', '--count', 'origin/' + branch], { encoding: 'utf8' });
		return false;
	} catch (_err) { /* intentional: no remote tracking branch means first push */
		return true;
	}
}

/**
 * Run branch protection check as a subprocess.
 * @param {function} execFn - execFileSync or mock
 * @param {string} projectRoot - Absolute path to project root
 * @param {function} log - Logger function
 * @returns {boolean} True if branch protection passed
 */
function runBranchProtection(execFn, projectRoot, log) {
	try {
		execFn('node', [path.join(projectRoot, 'scripts', 'branch-protection.js')]);
		return true;
	} catch (_err) { /* intentional: fallback to failure */
		log('Branch protection check failed — push aborted.');
		return false;
	}
}

/**
 * Run lint via the detected package manager.
 * @param {function} spawnFn - spawnSync or mock
 * @param {string} pkgManager - Package manager command
 * @param {string} projectRoot - Absolute path to project root
 * @returns {boolean} True if lint passed
 */
function runLint(spawnFn, pkgManager, projectRoot) {
	const lintResult = spawnFn(pkgManager, ['run', 'lint'], {
		stdio: 'inherit',
		shell: isWindows,
		cwd: projectRoot,
	});
	return lintResult.status === 0;
}

/**
 * Run tests unless in quick mode, logging warnings for first push.
 * @param {function} spawnFn - spawnSync or mock
 * @param {function} execFn - execFileSync or mock
 * @param {string} pkgManager - Package manager command
 * @param {string} projectRoot - Absolute path to project root
 * @param {boolean} quickMode - Whether to skip tests
 * @param {function} log - Logger function
 * @returns {boolean|undefined} True if tests passed, undefined if skipped
 */
function runTests(spawnFn, execFn, pkgManager, projectRoot, quickMode, log) {
	if (quickMode) {
		log('Tests skipped (--quick) — CI will run full suite on GitHub');
		const branch = getCurrentBranch(execFn);
		if (isFirstPush(branch, execFn)) {
			log('Warning: First push to this branch — consider `forge push` (full suite) before merge');
		}
		return undefined;
	}

	const testResult = spawnFn(pkgManager, ['run', 'test'], {
		stdio: 'inherit',
		shell: isWindows,
		cwd: projectRoot,
		timeout: 120000,
	});
	return testResult.status === 0;
}

module.exports = {
	name: 'push',
	description: 'Push with quality gates (branch protection + lint + tests)',
	usage: 'forge push [--quick] [-- <git-push-args>]',
	flags: {
		'--quick': 'Skip tests (lint-only) for review-cycle pushes',
	},

	/**
	 * Push handler — runs branch protection, lint, optionally tests,
	 * then forwards to git push.
	 *
	 * @param {string[]} args - Passthrough args for git push (e.g. ['-u', 'origin', 'feat/slug'])
	 * @param {Object} flags - Parsed flags (e.g. { '--quick': true })
	 * @param {string} projectRoot - Absolute path to project root
	 * @param {Object} [deps] - Dependency injection for testing
	 * @returns {Promise<{success: boolean, quickMode: boolean, lintPassed: boolean, testsPassed?: boolean, pushed: boolean}>}
	 */
	handler: async (args, flags, projectRoot, deps) => {
		const execFn = deps?.execFileSync || execFileSync;
		const spawnFn = deps?.spawnSync || spawnSync;
		const existsFn = deps?.existsSync || fs.existsSync;
		const log = deps?.log || console.log;
		const tokenWrite = deps?.writeForgeToken || forgeToken.write;

		const quickMode = !!(flags && (flags['--quick'] || flags.quick));
		const pkgManager = detectPackageManager(projectRoot, existsFn);

		// Step 1: Branch protection
		const branchOk = runBranchProtection(execFn, projectRoot, log);
		if (!branchOk) {
			return { success: false, quickMode, lintPassed: false, pushed: false };
		}

		// Step 2: Lint
		const lintPassed = runLint(spawnFn, pkgManager, projectRoot);
		if (!lintPassed) {
			log('Lint failed — push aborted.');
			return { success: false, quickMode, lintPassed: false, pushed: false };
		}

		// Step 3: Tests (skip in quick mode)
		const testsPassed = runTests(spawnFn, execFn, pkgManager, projectRoot, quickMode, log);
		if (!quickMode && !testsPassed) {
			return { success: false, quickMode, lintPassed: true, testsPassed: false, pushed: false };
		}

		// Step 4: Write nonce token so lefthook skips pre-push hooks
		try {
			tokenWrite(projectRoot);
		} catch (_err) { /* intentional: non-fatal, lefthook will re-run hooks */
			log('Warning: Could not write forge push token — lefthook hooks will run again');
		}

		// Step 5: git push with passthrough args
		const gitArgs = args.filter(a => a !== '--quick');
		try {
			execFn('git', ['push', ...gitArgs], { stdio: 'inherit' });
		} catch (_pushErr) {
			log('git push failed.');
			return {
				success: false,
				quickMode,
				lintPassed: true,
				...(quickMode ? {} : { testsPassed: true }),
				pushed: false,
			};
		}

		return {
			success: true,
			quickMode,
			lintPassed: true,
			...(quickMode ? {} : { testsPassed: true }),
			pushed: true,
		};
	},
};
