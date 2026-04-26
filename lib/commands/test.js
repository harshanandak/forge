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
	} catch (_e) { // NOSONAR S2486
		/* intentional: bd not installed or unreachable */
		return false;
	}
}

function resolveBaseBranch(execFileSync) {
	let baseBranch = 'main';
	try {
		baseBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], {
			encoding: 'utf8', timeout: 3000,
		}).trim().replace('origin/', '');
	} catch (_e) { // NOSONAR S2486
		/* intentional: origin/HEAD not set, detect base branch manually */
		for (const name of ['main', 'master']) {
			try {
				execFileSync('git', ['rev-parse', '--verify', name], { stdio: 'pipe', timeout: 3000 });
				baseBranch = name;
				break;
			} catch (_e2) { /* intentional: branch doesn't exist, try next name */ } // NOSONAR S2486
		}
	}
	return baseBranch;
}

function resolveDiffRef(execFileSync, options = {}) {
	if (options.sinceUpstream) {
		try {
			const upstreamRef = execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
				encoding: 'utf8',
				stdio: 'pipe',
				timeout: 3000,
			}).trim();
			if (upstreamRef) {
				return `${upstreamRef}...HEAD`;
			}
		} catch (_e) { // NOSONAR S2486
			/* intentional: branch may not track a remote yet, fall back to base branch */
		}
	}

	const baseBranch = resolveBaseBranch(execFileSync);
	try {
		const mergeBase = execFileSync('git', ['merge-base', 'HEAD', baseBranch], {
			encoding: 'utf8',
			timeout: 5000,
		}).trim();
		return `${mergeBase}...HEAD`;
	} catch (_e) { /* intentional: merge-base failed, fallback to diff against HEAD */ // NOSONAR S2486
		return 'HEAD';
	}
}

function getChangedFiles(execFileSync, options = {}) {
	const diffRef = resolveDiffRef(execFileSync, options);
	let output;
	try {
		output = execFileSync('git', ['diff', '--name-only', diffRef], {
			encoding: 'utf8',
			timeout: 5000,
		}).trim();
	} catch (_e) { // NOSONAR S2486
		/* intentional: git diff failed, no affected files to report */
		return [];
	}

	if (!output) return [];
	return output.split('\n').filter(Boolean);
}

/**
 * Get changed files relative to main branch, mapped to test file paths.
 *
 * Falls back to `git diff --name-only HEAD` if merge-base fails.
 *
 * @param {string} projectRoot - Project root for test file existence checks
 * @param {Function} execFileSync - Injected execFileSync
 * @param {Object} [fs] - Injected fs module
 * @param {Object} [options] - Diff selection options
 * @returns {string[]} Array of test file paths (e.g. ['test/foo.test.js'])
 */
function getAffectedTestFiles(projectRoot, execFileSync, fs = defaultFs, options = {}) {
	const changedFiles = getChangedFiles(execFileSync, options);
	const testFiles = new Set();
	for (const file of changedFiles) {
		for (const candidate of getTestCandidatesForChangedFile(file)) {
			if (fs.existsSync(path.join(projectRoot, candidate))) {
				testFiles.add(candidate);
			}
		}
	}

	return Array.from(testFiles).sort((left, right) => left.localeCompare(right));
}

function getTestCandidatesForChangedFile(file) {
	if (!file) return [];

	if (file === 'lib/lefthook-check.js' || file === 'lib/runtime-health.js') {
		return ['test/runtime-health.test.js'];
	}

	if (file === 'scripts/test.js') {
		return ['test/scripts/test-runner.test.js'];
	}

	if (file.startsWith('test/') && file.endsWith('.test.js')) {
		return [file];
	}

	if (file.startsWith('lib/') && file.endsWith('.js')) {
		const relative = file.slice('lib/'.length);
		return [`test/${relative.replace(/\.js$/, '.test.js')}`];
	}

	if (file.startsWith('scripts/') && (file.endsWith('.js') || file.endsWith('.sh'))) {
		const relative = file.slice('scripts/'.length).replace(/\.(js|sh)$/, '.test.js');
		return [
			`test/scripts/${relative}`,
			`test/${relative}`,
		];
	}

	if (file.startsWith('.github/workflows/')) {
		const workflowName = path.basename(file, path.extname(file));
		return [
			`test/workflows/${workflowName}.test.js`,
			'test/ci-workflow.test.js',
		];
	}

	if (file.startsWith('.github/agentic-workflows/') || file === '.github/behavioral-test-scores.json') {
		return [
			'test/scripts/behavioral-judge.test.js',
			'test/structural/agentic-workflow-sync.test.js',
		];
	}

	if (file.startsWith('.claude/commands/') && file.endsWith('.md')) {
		return [
			'test/command-sync-check.test.js',
			'test/structural/command-sync.test.js',
		];
	}

	if (file.startsWith('.forge/')
		|| file.startsWith('.cursor/')
		|| file.startsWith('.cline/')
		|| file.startsWith('.roo/')
		|| file.startsWith('.kilocode/')
		|| file.startsWith('.opencode/')
		|| file.startsWith('.codex/skills/')
		|| file.startsWith('.github/prompts/')) {
		return [
			'test/agent-gaps.test.js',
			'test/command-sync-check.test.js',
			'test/scripts/check-agents.test.js',
			'test/structural/command-sync.test.js',
		];
	}

	return [];
}

module.exports = {
	getChangedFiles,
	getAffectedTestFiles,
	getTestCandidatesForChangedFile,
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
		} catch (_e) { /* intentional: package.json missing or unreadable, use default timeout */ } // NOSONAR S2486

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
			const affectedTests = getAffectedTestFiles(projectRoot, execFileSync, fs, {
				sinceUpstream: flags.sinceUpstream || flags['--since-upstream'],
			});
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
