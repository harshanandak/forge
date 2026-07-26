'use strict';

/**
 * Regression tests for docs-only test selection (kernel issue 63556816).
 *
 * Master went red TWICE because a markdown-only PR was classified as "docs" and
 * skipped the test matrix, while several suites assert on the CONTENT of that
 * markdown:
 *
 *   Occurrence 1 — README size badge (#307/#310): `test/workflows/size-check.test.js`
 *                  reads README.md and asserts the published package-size badge.
 *   Occurrence 2 — AGENTS.md convention test after #325 (hotfix e1dddb77):
 *                  `test/agents-md-convention.test.js` reads AGENTS.md and asserts
 *                  its "Descriptive Context Convention" section.
 *
 * Both suites merged green on the docs PR and then failed on master for every
 * following code PR. A markdown change MUST select the suites that read that
 * markdown, regardless of the docs classification.
 *
 * The selection is DERIVED from the test sources (see lib/doc-assertions.js), not
 * hardcoded, so a newly added markdown-reading suite is picked up automatically
 * instead of drifting out of a stale list.
 */

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

const docAssertions = require('../lib/doc-assertions.js');
const { getAffectedTestFiles } = require('../lib/commands/test.js');

/** Builds an execFileSync stub whose `git diff --name-only` returns `files`. */
function makeGitStub(files) {
	return (_command, args) => {
		const argv = Array.isArray(args) ? args : [];
		if (argv.includes('diff') && argv.includes('--name-only')) {
			return `${files.join('\n')}\n`;
		}
		if (argv.includes('merge-base')) return 'abc1234\n';
		if (argv.includes('rev-parse')) return 'master\n';
		return '';
	};
}

describe('doc-assertion index (derived, not hardcoded)', () => {
	const index = docAssertions.buildDocAssertionIndex(REPO_ROOT, fs);

	test('maps AGENTS.md to the suite that asserts on its content', () => {
		// Occurrence 2: this is the suite that broke master after #325.
		expect(index.get('AGENTS.md')).toContain('test/agents-md-convention.test.js');
	});

	test('maps README.md to the suite that asserts on its content', () => {
		// Occurrence 1: this is the suite that broke master after #307/#310.
		expect(index.get('README.md')).toContain('test/workflows/size-check.test.js');
	});

	test('maps docs/ content to the docs-consistency suite', () => {
		expect(index.get('docs/INDEX.md')).toContain('test/docs-consistency.test.js');
	});

	test('only indexes markdown that is actually tracked in the repo', () => {
		for (const docPath of index.keys()) {
			expect(fs.existsSync(path.join(REPO_ROOT, docPath))).toBe(true);
		}
	});

	test('every indexed suite is an existing test file', () => {
		for (const suites of index.values()) {
			for (const suite of suites) {
				expect(fs.existsSync(path.join(REPO_ROOT, suite))).toBe(true);
			}
		}
	});
});

describe('selectDocAssertingTests', () => {
	test('selects the doc-asserting suites for a markdown change', () => {
		const selected = docAssertions.selectDocAssertingTests(['AGENTS.md'], REPO_ROOT, fs);
		expect(selected).toContain('test/agents-md-convention.test.js');
	});

	test('ignores non-markdown changes', () => {
		expect(docAssertions.selectDocAssertingTests(['lib/foo.js'], REPO_ROOT, fs)).toEqual([]);
	});

	test('returns a sorted, de-duplicated selection', () => {
		const selected = docAssertions.selectDocAssertingTests(['AGENTS.md', 'README.md'], REPO_ROOT, fs);
		expect(selected).toEqual([...new Set(selected)].sort());
	});
});

describe('suites that discover markdown dynamically', () => {
	// A suite that walks a directory and filters on `.md` names no markdown file, so
	// there is nothing to attribute it to. Attributing nothing means selecting nothing
	// — the exact false-green this index exists to remove.

	test('a real traversal-based suite is selected for a docs/ markdown change', () => {
		// test/cleanup/dropped-agent-docs.test.js reads every .md under docs/work via
		// readdirSync + `entry.endsWith('.md')`, with no literal per file.
		const selected = docAssertions.selectDocAssertingTests(
			['docs/work/2026-07-24-example/plan.md'],
			REPO_ROOT,
			fs,
		);
		expect(selected).toContain('test/cleanup/dropped-agent-docs.test.js');
	});

	test('a suite that globs markdown is selected without naming a single file', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doc-scan-'));
		try {
			fs.mkdirSync(path.join(root, 'test'), { recursive: true });
			fs.writeFileSync(path.join(root, 'test', 'traversal.test.js'), [
				"const { readdirSync } = require('node:fs');",
				"const docs = readdirSync(process.cwd()).filter((entry) => entry.endsWith('.md'));",
				'module.exports = docs;',
			].join('\n'));

			expect(docAssertions.selectDocAssertingTests(['README.md'], root, fs))
				.toEqual(['test/traversal.test.js']);
		} finally {
			fs.rmSync(root, { force: true, recursive: true });
		}
	});

	test('a suite that lists directories without touching markdown is not selected', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-doc-scan-'));
		try {
			fs.mkdirSync(path.join(root, 'test'), { recursive: true });
			fs.writeFileSync(path.join(root, 'test', 'sources.test.js'), [
				"const { readdirSync } = require('node:fs');",
				"const sources = readdirSync(process.cwd()).filter((entry) => entry.endsWith('.js'));",
				'module.exports = sources;',
			].join('\n'));

			expect(docAssertions.selectDocAssertingTests(['README.md'], root, fs)).toEqual([]);
		} finally {
			fs.rmSync(root, { force: true, recursive: true });
		}
	});
});

describe('markdown changes select doc-asserting suites in the push lane', () => {
	test('an AGENTS.md-only change selects the AGENTS.md convention suite', () => {
		const targets = getAffectedTestFiles(REPO_ROOT, makeGitStub(['AGENTS.md']), fs, {});
		expect(targets).toContain('test/agents-md-convention.test.js');
	});

	test('a README.md-only change selects the README size-check suite', () => {
		const targets = getAffectedTestFiles(REPO_ROOT, makeGitStub(['README.md']), fs, {});
		expect(targets).toContain('test/workflows/size-check.test.js');
	});

	test('a docs/ change still selects the docs-consistency suite', () => {
		const targets = getAffectedTestFiles(REPO_ROOT, makeGitStub(['docs/INDEX.md']), fs, {});
		expect(targets).toContain('test/docs-consistency.test.js');
	});

	test('a code-only change selects no doc-asserting suites it does not need', () => {
		const targets = getAffectedTestFiles(REPO_ROOT, makeGitStub(['lib/runtime-health.js']), fs, {});
		expect(targets).not.toContain('test/agents-md-convention.test.js');
	});
});

describe('CI: markdown-only PRs must still run doc-asserting suites', () => {
	// A markdown-only PR does not match `paths:` in .github/workflows/test.yml, so
	// the matrix never runs and Required Checks Bypass reports "Test Suite" green.
	// That bypass must run the doc-asserting selection instead of echoing success,
	// otherwise the two failures above recur.
	const bypassPath = path.join(REPO_ROOT, '.github', 'workflows', 'required-checks-bypass.yml');
	const bypass = fs.readFileSync(bypassPath, 'utf8');

	test('the Test Suite bypass job runs the doc-asserting selection', () => {
		expect(bypass).toContain('scripts/doc-asserting-tests.js');
	});

	test('the bypass workflow checks out the repo so it can run those tests', () => {
		expect(bypass).toContain('actions/checkout');
	});
});
