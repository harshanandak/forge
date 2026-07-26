#!/usr/bin/env node
'use strict';

/**
 * Runs (or lists) the test suites that assert on changed markdown.
 *
 * A markdown-only PR does not match the `paths:` filter in
 * `.github/workflows/test.yml`, so the full matrix never runs and
 * `required-checks-bypass.yml` reports the required "Test Suite" check green.
 * Several suites nevertheless assert on markdown CONTENT, so such a PR merged
 * green and then broke master for the next unrelated code PR — twice (kernel
 * issue 63556816: the README size badge in #307/#310, and the AGENTS.md
 * convention test after #325).
 *
 * This script closes that gap by running exactly the doc-asserting suites for the
 * changed markdown. It shares `lib/doc-assertions.js` with the local push lane
 * (`lib/commands/test.js`), so CI and local selection cannot drift apart.
 *
 * Usage:
 *   node scripts/doc-asserting-tests.js [--base <ref>] [--list]
 *
 *   --base <ref>  Compare against <ref> (default: origin/<default-branch> or HEAD~1).
 *   --list        Print the selected suites instead of running them.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { selectDocAssertingTests } = require('../lib/doc-assertions');

const REPO_ROOT = path.resolve(__dirname, '..');

/** Wall-clock ceiling for the doc-asserting lane; it is a small, fast subset. */
const LANE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Parses the supported command-line flags.
 *
 * @param {string[]} argv Raw arguments (without node/script).
 * @returns {{base: string|null, list: boolean}} Parsed options.
 */
function parseArgs(argv) {
	const baseIndex = argv.indexOf('--base');
	return {
		base: baseIndex !== -1 ? argv[baseIndex + 1] || null : null,
		list: argv.includes('--list'),
	};
}

/**
 * Resolves the ref the PR should be compared against.
 *
 * @param {string|null} explicitBase Base supplied with `--base`.
 * @returns {string} A git ref usable in `git diff <ref>...HEAD`.
 */
function resolveBase(explicitBase) {
	if (explicitBase) return explicitBase;
	for (const ref of ['origin/master', 'origin/main']) {
		try {
			execFileSync('git', ['rev-parse', '--verify', ref], { cwd: REPO_ROOT, stdio: 'pipe', timeout: 5000 });
			return ref;
		} catch (_e) { /* intentional: ref not present in this checkout, try next */ } // NOSONAR S2486
	}
	return 'HEAD~1';
}

/**
 * Parses `git diff --name-only` output into repository-relative paths.
 *
 * Split out so the parsing contract (trimmed, no blanks) is testable without a live
 * repository: CI checks out shallow, so a test that reaches for `HEAD~1` passes locally
 * and fails on the runner.
 *
 * @param {string} output Raw `git diff --name-only` stdout.
 * @returns {string[]} Changed file paths.
 */
function parseChangedFiles(output) {
	return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Lists repository-relative paths changed against the base ref.
 *
 * @param {string} base Base git ref.
 * @returns {string[]} Changed file paths.
 */
function changedFilesSince(base) {
	const output = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		timeout: 15000,
	});
	return parseChangedFiles(output);
}

/**
 * Turns a `spawnSync` result into a process exit status.
 *
 * A spawn that never produced a status (`error`, or killed by a signal so `status`
 * is null) MUST report FAILURE. Reporting 0 there would re-create the bug this lane
 * exists to remove: a required check reporting green without running the tests.
 *
 * @param {{status: number|null, error?: Error}} result Result of `spawnSync`.
 * @returns {number} Exit status; non-zero whenever the run did not demonstrably pass.
 */
function resolveSpawnStatus(result) {
	if (!result || result.error) return 1;
	return result.status ?? 1;
}

function main() {
	const { base: explicitBase, list } = parseArgs(process.argv.slice(2));
	const base = resolveBase(explicitBase);

	let changedFiles;
	try {
		changedFiles = changedFilesSince(base);
	} catch (error) {
		// Fail closed: if the change set cannot be determined we cannot prove the
		// doc-asserting suites are unaffected.
		console.error(`Could not compute changed files against ${base}: ${error.message}`);
		return 1;
	}

	const suites = selectDocAssertingTests(changedFiles, REPO_ROOT, fs);

	if (suites.length === 0) {
		console.log('No changed markdown asserts on by any test suite — nothing to run.');
		return 0;
	}

	if (list) {
		console.log(suites.join('\n'));
		return 0;
	}

	console.log(`Running ${suites.length} doc-asserting suite${suites.length === 1 ? '' : 's'} for changed markdown:`);
	for (const suite of suites) console.log(`  ${suite}`);

	const result = spawnSync('bun', ['test', ...suites], {
		cwd: REPO_ROOT,
		stdio: 'inherit',
		timeout: LANE_TIMEOUT_MS,
		shell: process.platform === 'win32',
	});

	if (result.error) {
		console.error(`Failed to run doc-asserting suites: ${result.error.message}`);
	}
	return resolveSpawnStatus(result);
}

if (require.main === module) {
	process.exit(main());
}

module.exports = { changedFilesSince, parseArgs, parseChangedFiles, resolveBase, resolveSpawnStatus };
