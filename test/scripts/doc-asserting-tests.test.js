'use strict';

/**
 * Unit tests for the CI entry point of the doc-asserting lane.
 *
 * `.github/workflows/required-checks-bypass.yml` runs this script INSTEAD of the
 * test matrix for a markdown-only PR, and its exit status becomes the required
 * "Test Suite" check. Untested, it is the same single point of failure the echo it
 * replaced was (kernel issue 63556816) — so its argument parsing, base resolution,
 * change detection and, above all, its failure-to-status mapping are pinned here.
 */

const { describe, expect, test } = require('bun:test');
const path = require('node:path');

const {
	changedFilesSince,
	parseArgs,
	resolveBase,
	resolveSpawnStatus,
} = require('../../scripts/doc-asserting-tests.js');

const REPO_ROOT = path.resolve(__dirname, '../..');

describe('parseArgs', () => {
	test('defaults to no explicit base and run mode', () => {
		expect(parseArgs([])).toEqual({ base: null, list: false });
	});

	test('reads the value that follows --base', () => {
		expect(parseArgs(['--base', 'origin/master'])).toEqual({ base: 'origin/master', list: false });
	});

	test('treats a trailing --base with no value as no base', () => {
		expect(parseArgs(['--base'])).toEqual({ base: null, list: false });
	});

	test('recognizes --list in any position', () => {
		expect(parseArgs(['--list'])).toEqual({ base: null, list: true });
		expect(parseArgs(['--list', '--base', 'HEAD~2'])).toEqual({ base: 'HEAD~2', list: true });
	});

	test('ignores unrelated flags rather than failing', () => {
		expect(parseArgs(['--verbose'])).toEqual({ base: null, list: false });
	});
});

describe('resolveBase', () => {
	test('an explicit base wins over any discovered ref', () => {
		expect(resolveBase('feature/some-branch')).toBe('feature/some-branch');
	});

	test('falls back to a ref this checkout can actually diff against', () => {
		const base = resolveBase(null);
		expect(['origin/master', 'origin/main', 'HEAD~1']).toContain(base);
	});
});

describe('changedFilesSince', () => {
	test('returns repository-relative paths, trimmed and without blanks', () => {
		const files = changedFilesSince('HEAD~1');
		expect(Array.isArray(files)).toBe(true);
		for (const file of files) {
			expect(file).toBe(file.trim());
			expect(file.length).toBeGreaterThan(0);
			expect(path.isAbsolute(file)).toBe(false);
		}
	});

	test('a range with no differences yields an empty list, not a blank entry', () => {
		expect(changedFilesSince('HEAD')).toEqual([]);
	});

	test('throws for an unresolvable base so the caller can fail closed', () => {
		expect(() => changedFilesSince('definitely-not-a-ref-9f2c41d7')).toThrow();
	});

	test('reads the diff of this checkout, not the process working directory', () => {
		// The script pins cwd to REPO_ROOT; a suite run from elsewhere must still work.
		expect(REPO_ROOT).toBe(path.resolve(__dirname, '../..'));
		expect(() => changedFilesSince('HEAD')).not.toThrow();
	});
});

describe('resolveSpawnStatus', () => {
	test('passes a real zero exit through as success', () => {
		expect(resolveSpawnStatus({ status: 0 })).toBe(0);
	});

	test('passes a real non-zero exit through unchanged', () => {
		expect(resolveSpawnStatus({ status: 3 })).toBe(3);
	});

	// The regression that matters: a lane that never ran the tests must NOT be green.
	test('a spawn error is a failure, never a silent zero', () => {
		expect(resolveSpawnStatus({ error: new Error('spawn bun ENOENT'), status: null })).toBe(1);
	});

	test('a signal-killed run with a null status is a failure', () => {
		expect(resolveSpawnStatus({ signal: 'SIGKILL', status: null })).toBe(1);
	});

	test('a timed-out run with an undefined status is a failure', () => {
		expect(resolveSpawnStatus({})).toBe(1);
	});

	test('a missing result is a failure', () => {
		expect(resolveSpawnStatus(undefined)).toBe(1);
	});
});
