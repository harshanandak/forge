'use strict';

/**
 * Lint Command — ESLint Runner
 *
 * Wraps ESLint execution via the project's package.json lint script:
 * - Auto-detects package manager from lockfiles
 * - Supports --fix flag to auto-fix fixable issues
 * - Parses error/warning counts from eslint output
 * - Handles missing eslint gracefully (returns error, doesn't crash)
 *
 * Security: Uses spawnSync for subprocess calls (OWASP A03)
 *
 * @module commands/lint
 */

const { spawnSync: defaultSpawnSync } = require('node:child_process');
const defaultFs = require('node:fs');
const path = require('node:path');

/** @type {Array<[string, string]>} Lockfile -> package manager mapping (order matters) */
const LOCKFILE_MAP = [
	['bun.lockb', 'bun'],
	['bun.lock', 'bun'],
	['pnpm-lock.yaml', 'pnpm'],
	['yarn.lock', 'yarn'],
	['package-lock.json', 'npm'],
];

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
 * Parse eslint error/warning counts from output string.
 *
 * Matches patterns like "3 errors and 5 warnings" or
 * "3 errors" / "5 warnings" individually.
 *
 * @param {string} output - Combined stdout/stderr from eslint
 * @returns {{ errors: number, warnings: number }}
 */
function parseEslintCounts(output) {
	let errors = 0;
	let warnings = 0;

	if (!output) return { errors, warnings };

	const errorMatch = (/(\d+)\s+error/).exec(output); // NOSONAR — simple anchored regex, no backtracking risk
	if (errorMatch) {
		errors = Number.parseInt(errorMatch[1], 10);
	}

	const warningMatch = (/(\d+)\s+warning/).exec(output); // NOSONAR — simple anchored regex, no backtracking risk
	if (warningMatch) {
		warnings = Number.parseInt(warningMatch[1], 10);
	}

	return { errors, warnings };
}

module.exports = {
	name: 'lint',
	description: 'Run ESLint with project configuration',
	usage: 'forge lint [--fix]',
	flags: {
		'--fix': 'Auto-fix fixable issues',
	},

	/**
	 * Run ESLint via the project's package.json lint script.
	 *
	 * @param {string[]} _args - Positional arguments (unused)
	 * @param {Object} flags - Parsed flags ({ '--fix'?: boolean, fix?: boolean })
	 * @param {string} projectRoot - Absolute path to project root
	 * @param {Object} [deps] - Dependency injection for testability
	 * @param {Object} [deps.fs] - fs module
	 * @param {Function} [deps.spawnSync] - child_process.spawnSync
	 * @returns {Promise<{ success: boolean, errors: number, warnings: number }>}
	 */
	async handler(args, flags, projectRoot, deps = {}) {
		const fs = deps.fs || defaultFs;
		const spawnSync = deps.spawnSync || defaultSpawnSync;

		// 1. Detect package manager
		const pkgManager = detectPackageManager(projectRoot, fs);

		// 2. Build lint command args
		const lintArgs = ['run', 'lint'];

		// 3. Append --fix if requested
		const fixRequested = !!(flags && (flags['--fix'] || flags.fix)) || (Array.isArray(args) && args.includes('--fix'));
		if (fixRequested) {
			lintArgs.push('--', '--fix');
		}

		// 4. Run lint
		let result;
		try {
			result = spawnSync(pkgManager, lintArgs, {
				stdio: ['inherit', 'pipe', 'pipe'],
				shell: process.platform === 'win32',
				cwd: projectRoot,
			});
		} catch (_err) { // NOSONAR S2486
			/* intentional: eslint/package manager not found or crashed */
			return { success: false, errors: 0, warnings: 0 };
		}

		const exitCode = result.status ?? 1;

		// 5. Parse error/warning counts from output
		const output = [
			result.stdout || '',
			result.stderr || '',
		].join('\n');
		const { errors, warnings } = parseEslintCounts(output);

		return {
			success: exitCode === 0,
			errors,
			warnings,
		};
	},
};
