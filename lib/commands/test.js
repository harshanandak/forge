'use strict';

/**
 * Test Command — Smart Test Runner
 *
 * Wraps test execution with smart defaults:
 * - Auto-detects package manager from lockfiles
 * - Checks Beads (Dolt) connectivity, sets BEADS_SKIP_TESTS if unavailable
 * - Supports --affected flag to run only tests for changed files
 *
 * Security: Uses execFileSync for subprocess calls (OWASP A03)
 *
 * @module commands/test
 */

const { execFileSync: defaultExecFileSync, spawnSync: defaultSpawnSync } = require('node:child_process');
const defaultFs = require('node:fs');
const path = require('node:path');

/** @type {Array<[string, string]>} Lockfile → package manager mapping (order matters) */
const LOCKFILE_MAP = [
	['bun.lockb', 'bun'],
	['pnpm-lock.yaml', 'pnpm'],
	['yarn.lock', 'yarn'],
	['package-lock.json', 'npm'],
];

const DEFAULT_TIMEOUT = 120000;
const BEADS_CHECK_TIMEOUT = 3000;

/**
 * Detect the package manager by checking which lockfile exists.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @param {Object} fs - Injected fs module
 * @returns {string} Package manager command ('bun' | 'pnpm' | 'yarn' | 'npm')
 */
function detectPackageManager(projectRoot, fs) {
	for (const [lockfile, manager] of LOCKFILE_MAP) {
		if (fs.existsSync(path.join(projectRoot, lockfile))) {
			return manager;
		}
	}
	return 'npm';
}

/**
 * Check if Beads (bd CLI) is reachable.
 *
 * @param {Function} execFileSync - Injected execFileSync
 * @returns {boolean} true if bd is available
 */
function checkBeadsConnectivity(execFileSync) {
	try {
		execFileSync('bd', ['list', '--limit=1'], { timeout: BEADS_CHECK_TIMEOUT });
		return true;
	} catch (_e) {
		/* intentional: bd not installed or unreachable */
		return false;
	}
}

/**
 * Get changed files relative to main branch, mapped to test file paths.
 *
 * Falls back to `git diff --name-only HEAD` if merge-base fails.
 *
 * @param {string} _projectRoot - Project root (unused, git uses cwd)
 * @param {Function} execFileSync - Injected execFileSync
 * @returns {string[]} Array of test file paths (e.g. ['test/foo.test.js'])
 */
function getAffectedTestFiles(_projectRoot, execFileSync) {
	let diffRef;

	// Detect default branch, then try merge-base
	let baseBranch = 'main';
	try {
		baseBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], {
			encoding: 'utf8', timeout: 3000,
		}).trim().replace('origin/', '');
	} catch (_e) {
		/* intentional: origin/HEAD not set, detect base branch manually */
		for (const name of ['main', 'master']) {
			try {
				execFileSync('git', ['rev-parse', '--verify', name], { stdio: 'pipe', timeout: 3000 });
				baseBranch = name;
				break;
			} catch (_e2) { /* try next */ }
		}
	}

	try {
		const mergeBase = execFileSync('git', ['merge-base', 'HEAD', baseBranch], {
			encoding: 'utf8',
			timeout: 5000,
		}).trim();
		diffRef = `${mergeBase}...HEAD`;
	} catch (_e) {
		// Fallback: diff against HEAD
		diffRef = 'HEAD';
	}

	let output;
	try {
		output = execFileSync('git', ['diff', '--name-only', diffRef], {
			encoding: 'utf8',
			timeout: 5000,
		}).trim();
	} catch (_e) {
		/* intentional: git diff failed, no affected files to report */
		return [];
	}

	if (!output) return [];

	const changedFiles = output.split('\n').filter(Boolean);

	// Map lib/*.js files to test/*.test.js
	const testFiles = [];
	for (const file of changedFiles) {
		if (file.startsWith('lib/') && file.endsWith('.js')) {
			const relative = file.slice('lib/'.length);
			const testFile = `test/${relative.replace(/\.js$/, '.test.js')}`;
			testFiles.push(testFile);
		}
	}

	return testFiles;
}

module.exports = {
	name: 'test',
	description: 'Run tests with smart defaults (timeout, Beads skip, affected-only)',
	usage: 'forge test [--affected]',
	flags: {
		'--affected': 'Run only tests for changed files',
	},

	/**
	 * Run tests with smart defaults.
	 *
	 * @param {string[]} _args - Positional arguments (unused)
	 * @param {Object} flags - Parsed flags ({ affected?: boolean })
	 * @param {string} projectRoot - Absolute path to project root
	 * @param {Object} [deps] - Dependency injection for testability
	 * @param {Object} [deps.fs] - fs module
	 * @param {Function} [deps.execFileSync] - child_process.execFileSync
	 * @param {Function} [deps.spawnSync] - child_process.spawnSync
	 * @returns {Promise<{ success: boolean, exitCode: number, beadsSkipped: boolean }>}
	 */
	async handler(_args, flags, projectRoot, deps = {}) {
		const fs = deps.fs || defaultFs;
		const execFileSync = deps.execFileSync || defaultExecFileSync;
		const spawnSync = deps.spawnSync || defaultSpawnSync;

		// 1. Detect package manager
		const pkgManager = detectPackageManager(projectRoot, fs);

		// 2. Read timeout from package.json or use default
		let timeout = DEFAULT_TIMEOUT;
		try {
			const pkgPath = path.join(projectRoot, 'package.json');
			const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
			const testScript = pkg.scripts?.test || '';
			const timeoutMatch = testScript.match(/--timeout\s+(\d+)/);
			if (timeoutMatch) {
				timeout = Number.parseInt(timeoutMatch[1], 10);
			}
		} catch (_e) { /* use default */ }

		// 3. Check Beads connectivity
		const beadsAvailable = checkBeadsConnectivity(execFileSync);
		const beadsSkipped = !beadsAvailable;

		const extraEnv = {};
		if (beadsSkipped) {
			extraEnv.BEADS_SKIP_TESTS = '1';
		}

		// 4. Build test command args
		let testArgs = ['run', 'test'];

		// 5. --affected flag: find changed test files
		if (flags['--affected'] || flags.affected) {
			const affectedTests = getAffectedTestFiles(projectRoot, execFileSync);
			if (affectedTests.length > 0) {
				testArgs = ['run', 'test', ...affectedTests];
			}
			// If no affected tests found, fall back to running all tests
		}

		// 6. Run tests
		const result = spawnSync(pkgManager, testArgs, {
			env: { ...process.env, ...extraEnv },
			timeout,
			stdio: 'inherit',
			shell: process.platform === 'win32',
		});

		const exitCode = result.status ?? 1;

		return {
			success: exitCode === 0,
			exitCode,
			beadsSkipped,
		};
	},
};
