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
	} catch (_err) { /* intentional: fallback to 'unknown' */ // NOSONAR S2486
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
	} catch (_err) { /* intentional: no remote tracking branch means first push */ // NOSONAR S2486
		return true;
	}
}

/**
 * Resolve the git worktree top-level directory.
 *
 * The pre-push hook checks for the nonce token relative to its own cwd, which
 * git sets to the worktree root during `git push`. The handler's `projectRoot`
 * is derived from INIT_CWD/cwd and can point at the MAIN repo root when forge
 * runs from a linked worktree, so the token must be written to the real git
 * top-level instead — otherwise lefthook never finds it and re-runs the suite.
 *
 * @param {function} execFn - execFileSync or mock
 * @param {string} fallback - projectRoot to use when git resolution fails
 * @returns {string} Absolute worktree top-level path, or the fallback
 */
function resolveGitToplevel(execFn, fallback) {
	try {
		const top = execFn('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
		return top || fallback;
	} catch (_err) { /* intentional: fall back to projectRoot outside a git worktree */ // NOSONAR S2486
		return fallback;
	}
}

/**
 * Auto-file rail: best-effort, NON-BLOCKING ensure that the branch being pushed has a
 * backing Kernel issue (kernel issue a4b8f56f) — so started work that is being pushed
 * never goes unfiled. Idempotent (deduped by branch via ensureBackingIssue); a
 * main/master/detached/ignore branch is skipped, and ANY failure degrades to null and
 * NEVER aborts the push. Injectable via `deps._ensureBackingIssue` for tests.
 *
 * @param {string} projectRoot
 * @param {function} execFn - execFileSync (for branch resolution)
 * @param {object} deps - DI (may inject `_ensureBackingIssue`, `_kernelDriver`, `_kernelBroker`)
 * @returns {Promise<object|null>}
 */
async function autoFileBackingIssueForPush(projectRoot, execFn, deps = {}) {
  try {
    // Lazy require INSIDE the try: a module-load failure must degrade to null and
    // NEVER abort the push (mirrors the worktree helper; CodeRabbit #370).
    const ensure = deps._ensureBackingIssue || require('../kernel/backing-issue').ensureBackingIssue;
    const branch = getCurrentBranch(execFn);
    if (!branch || branch === 'unknown') return null;
    let driver = deps._kernelDriver;
    let broker = deps._kernelBroker;
    if (!driver || !broker) {
      if (!fs.existsSync(path.join(projectRoot, '.git'))) return null;
      const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
      const built = await buildMigratedKernelIssueDeps({ projectRoot });
      driver = driver || built.kernelDriver;
      broker = broker || built.kernelBroker;
    }
    return await ensure({ branch, projectRoot, driver, broker });
  } catch (_err) { /* non-blocking: tracking must never break a push */ // NOSONAR S2486
    return null;
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
	} catch (_err) { /* intentional: fallback to failure */ // NOSONAR S2486
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

		// Auto-file rail (non-blocking): ensure the branch being pushed has a backing
		// Kernel issue so started work never goes unfiled. Never aborts the push.
		await autoFileBackingIssueForPush(projectRoot, execFn, deps || {});

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

		// Step 4: Write nonce token so lefthook skips pre-push hooks.
		// Write to the git worktree top-level (where the hook checks), not the
		// inherited projectRoot, so the skip works from linked worktrees too.
		try {
			tokenWrite(resolveGitToplevel(execFn, projectRoot));
		} catch (_err) { /* intentional: non-fatal, lefthook will re-run hooks */ // NOSONAR S2486
			log('Warning: Could not write forge push token — lefthook hooks will run again');
		}

		// Step 5: git push with passthrough args
		const gitArgs = args.filter(a => a !== '--quick');
		try {
			execFn('git', ['push', ...gitArgs], { stdio: 'inherit' });
		} catch (_pushErr) { // NOSONAR S2486
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

	// Exposed for unit tests; not part of the CLI surface.
	_internal: {
		autoFileBackingIssueForPush,
	},
};
