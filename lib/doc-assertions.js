'use strict';

/**
 * Doc-assertion index — which test suites assert on which tracked markdown.
 *
 * Several suites read repository markdown and assert on its CONTENT (the README
 * package-size badge, the AGENTS.md convention section, docs/ consistency). A
 * markdown-only PR is classified as "docs" and skips the code matrix, so without
 * this index those suites never run on the PR that breaks them — they fail later,
 * on master, for the next unrelated code PR. That happened twice (kernel issue
 * 63556816): the README size badge (#307/#310) and the AGENTS.md convention test
 * after #325.
 *
 * The mapping is DERIVED by scanning the test sources rather than hardcoded, so a
 * newly added markdown-reading suite is selected automatically instead of drifting
 * out of a stale list.
 *
 * Detection is deliberately anchored, not literal-matching: only markdown reached
 * from the REPOSITORY ROOT counts. Tests that write a throwaway `AGENTS.md` into a
 * temp fixture directory join a tmpdir, not the repo root, so they are not selected.
 *
 * Suites that DISCOVER markdown (directory traversal, a glob, a `.md` filter) name
 * no file to attribute, so they are selected on ANY markdown change instead — see
 * `scansMarkdownDynamically`.
 *
 * @module doc-assertions
 */

const defaultFs = require('node:fs');
const path = require('node:path');

/** `path.join(...)` / `path.resolve(...)` (or bare `join`/`resolve`) with a flat argument list. */
const PATH_CALL = /(?:path\s*\.\s*)?\b(?:join|resolve)\s*\(([^()]*)\)/g;

/** A `const ROOT = path.resolve(__dirname, '..')`-style anchor declaration. */
const ANCHOR_DECL = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\s*\.\s*)?(?:join|resolve)\s*\(([^()]*)\)/g;

/** A quoted string literal ending in `.md`. */
const MARKDOWN_LITERAL = /['"`]([^'"`\n]*\.md)['"`]/g;

/** A call that enumerates a directory or expands a glob instead of naming files. */
// `.sync` member forms matter: `glob.sync('**/*.md')` has a `.` where this pattern would
// otherwise expect `(`, so without the optional `.sync` the scanner is invisible and the
// suite is under-selected — the exact failure this module exists to prevent.
const DIRECTORY_SCAN_CALL = /\b(?:readdir|readdirSync|opendir|opendirSync|glob(?:Sync|\.sync)?|globby(?:\.sync)?|fastGlob(?:\.sync)?|walk|walkSync)\s*\(/;

/** `.md` used as an EXTENSION test rather than a filename: glob, regex, or bare extension. */
const MARKDOWN_EXTENSION_FILTER = /\*\.md\b|\\\.md\b|['"`]\.md['"`]/;

/**
 * Reports whether a repository-relative path is a markdown file.
 *
 * @param {string} file Repository-relative path.
 * @returns {boolean} True for markdown paths.
 */
function isMarkdownPath(file) {
	return typeof file === 'string' && file.toLowerCase().endsWith('.md');
}

/** Converts an absolute path to a forward-slash repository-relative path. */
function toRepoRelative(repoRoot, absolutePath) {
	return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

/** Returns the value of a single-quoted/double-quoted/backtick string literal, or null. */
function readStringLiteral(token) {
	const match = /^'([^']*)'$|^"([^"]*)"$|^`([^`$]*)`$/.exec(token.trim());
	if (!match) return null;
	return match[1] ?? match[2] ?? match[3];
}

/** Splits a flat call-argument list into trimmed, non-empty tokens. */
function splitArguments(rawArgs) {
	return rawArgs.split(',').map((token) => token.trim()).filter(Boolean);
}

/**
 * Collects every path anchor a test file can resolve against, keyed by identifier.
 *
 * Starts from `__dirname` and follows literal-only `path.join`/`path.resolve`
 * declarations (e.g. `const ROOT = path.resolve(__dirname, '..')`).
 *
 * @param {string} source Test file source.
 * @param {string} testDir Absolute directory containing the test file.
 * @returns {Map<string, string>} Identifier → absolute directory.
 */
function collectAnchors(source, testDir) {
	const anchors = new Map([['__dirname', testDir]]);
	let match;
	ANCHOR_DECL.lastIndex = 0;
	while ((match = ANCHOR_DECL.exec(source)) !== null) {
		const args = splitArguments(match[2]);
		if (args.length === 0) continue;
		const base = anchors.get(args[0]);
		if (!base) continue;
		const segments = args.slice(1).map(readStringLiteral);
		if (segments.some((segment) => segment === null)) continue;
		anchors.set(match[1], path.resolve(base, ...segments));
	}
	return anchors;
}

/**
 * Finds markdown a single test file reads from the repository root.
 *
 * Two shapes are recognized:
 *  1. A fully literal anchored path, e.g. `path.resolve(__dirname, '..', 'AGENTS.md')`.
 *  2. A root-relative read helper, e.g. `const ROOT = join(__dirname, '..')` plus
 *     `readFileSync(join(ROOT, relPath))`. Because the path is assembled at run
 *     time, every markdown literal in the file that resolves to a real repository
 *     file is attributed to that test (this is how `test/docs-consistency.test.js`
 *     reads its documents).
 *
 * @param {string} repoRoot Absolute repository root.
 * @param {string} testFile Absolute path to the test file.
 * @param {string} source Test file source.
 * @param {Object} fs Injected fs module.
 * @returns {Set<string>} Repository-relative markdown paths the test asserts on.
 */
function findAssertedMarkdown(repoRoot, testFile, source, fs) {
	const anchors = collectAnchors(source, path.dirname(testFile));
	const found = new Set();

	const addIfTracked = (relativePath) => {
		if (!isMarkdownPath(relativePath)) return;
		if (relativePath.startsWith('..')) return;
		if (!fs.existsSync(path.join(repoRoot, relativePath))) return;
		found.add(relativePath);
	};

	let match;
	PATH_CALL.lastIndex = 0;
	while ((match = PATH_CALL.exec(source)) !== null) {
		const args = splitArguments(match[1]);
		if (args.length === 0) continue;
		const base = anchors.get(args[0]);
		if (!base) continue;
		const segments = args.slice(1).map(readStringLiteral);
		if (segments.some((segment) => segment === null)) continue;
		addIfTracked(toRepoRelative(repoRoot, path.resolve(base, ...segments)));
	}

	const rootAnchors = [...anchors]
		.filter(([, directory]) => path.resolve(directory) === path.resolve(repoRoot))
		.map(([identifier]) => identifier);
	const readsRootRelativePaths = rootAnchors.some((identifier) => new RegExp(
		`\\b(?:join|resolve)\\s*\\(\\s*${identifier}\\s*,\\s*[A-Za-z_$]`,
	).test(source));

	if (readsRootRelativePaths) {
		MARKDOWN_LITERAL.lastIndex = 0;
		while ((match = MARKDOWN_LITERAL.exec(source)) !== null) {
			addIfTracked(match[1].replace(/^\.\//, ''));
		}
	}

	return found;
}

/**
 * Reports whether a test DISCOVERS markdown instead of naming it.
 *
 * `findAssertedMarkdown` can only attribute markdown that appears as a literal, so
 * a suite that walks a directory (or expands a glob) and filters on `.md` maps to
 * nothing and would never be selected — the false green this module exists to
 * remove (`test/cleanup/dropped-agent-docs.test.js` is exactly that shape).
 *
 * Deliberately biased to OVER-selection: the two signals need not be on the same
 * expression, because a few extra suites cost CI seconds while under-selection is
 * what broke master twice. No attempt is made to resolve traversal roots into a
 * file set — that would silently under-select again.
 *
 * @param {string} source Test file source.
 * @returns {boolean} True when the test reaches markdown it does not name.
 */
function scansMarkdownDynamically(source) {
	return DIRECTORY_SCAN_CALL.test(source) && MARKDOWN_EXTENSION_FILTER.test(source);
}

/** Recursively lists `*.test.js` files under a directory. */
function listTestFiles(directory, fs, collected = []) {
	let entries;
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch (_e) { // NOSONAR S2486
		/* intentional: missing test directory yields no suites */
		return collected;
	}
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			listTestFiles(entryPath, fs, collected);
		} else if (entry.name.endsWith('.test.js')) {
			collected.push(entryPath);
		}
	}
	return collected;
}

/** Sorts test paths deterministically. */
function sortPaths(paths) {
	return [...paths].sort((a, b) => a.localeCompare(b));
}

/**
 * Scans the test tree once, splitting suites into the two ways they reach markdown.
 *
 * @param {string} repoRoot Absolute repository root.
 * @param {Object} fs Injected fs module.
 * @returns {{index: Map<string, string[]>, scanners: string[]}} Named-markdown index
 *   plus the suites that discover markdown dynamically.
 */
function scanTestSuites(repoRoot, fs) {
	const index = new Map();
	const scanners = new Set();

	for (const testFile of listTestFiles(path.join(repoRoot, 'test'), fs)) {
		let source;
		try {
			source = fs.readFileSync(testFile, 'utf8');
		} catch (_e) { // NOSONAR S2486
			/* intentional: unreadable test file contributes nothing */
			continue;
		}
		const testPath = toRepoRelative(repoRoot, testFile);
		for (const docPath of findAssertedMarkdown(repoRoot, testFile, source, fs)) {
			if (!index.has(docPath)) index.set(docPath, new Set());
			index.get(docPath).add(testPath);
		}
		if (scansMarkdownDynamically(source)) scanners.add(testPath);
	}

	return {
		index: new Map([...index].map(([docPath, suites]) => [docPath, sortPaths(suites)])),
		scanners: sortPaths(scanners),
	};
}

/**
 * Builds the markdown → test-suite index for a checkout.
 *
 * Only covers suites that NAME their markdown; suites that discover it are returned
 * by {@link findDynamicMarkdownScanners} because they map to no specific file.
 *
 * @param {string} repoRoot Absolute repository root.
 * @param {Object} [fs=defaultFs] Injected fs module.
 * @returns {Map<string, string[]>} Repository-relative markdown path → sorted test files.
 */
function buildDocAssertionIndex(repoRoot, fs = defaultFs) {
	return scanTestSuites(repoRoot, fs).index;
}

/**
 * Lists the suites that read markdown they never name (traversal, glob, `.md` filter).
 *
 * @param {string} repoRoot Absolute repository root.
 * @param {Object} [fs=defaultFs] Injected fs module.
 * @returns {string[]} Sorted test file paths.
 */
function findDynamicMarkdownScanners(repoRoot, fs = defaultFs) {
	return scanTestSuites(repoRoot, fs).scanners;
}

/**
 * Selects the suites that assert on the changed markdown.
 *
 * Returns an empty selection when no markdown changed, so the index is only built
 * for changes that can actually break a doc-asserting suite.
 *
 * @param {string[]} changedFiles Repository-relative changed paths.
 * @param {string} repoRoot Absolute repository root.
 * @param {Object} [fs=defaultFs] Injected fs module.
 * @returns {string[]} Sorted, de-duplicated test file paths.
 */
function selectDocAssertingTests(changedFiles, repoRoot, fs = defaultFs) {
	const changedMarkdown = (changedFiles || []).filter(isMarkdownPath);
	if (changedMarkdown.length === 0) return [];

	const { index, scanners } = scanTestSuites(repoRoot, fs);
	// Scanners discover markdown by traversal, so no changed path maps to them —
	// any markdown change selects all of them.
	const selected = new Set(scanners);
	for (const docPath of changedMarkdown) {
		for (const suite of index.get(docPath) || []) {
			selected.add(suite);
		}
	}
	return sortPaths(selected);
}

module.exports = {
	buildDocAssertionIndex,
	findDynamicMarkdownScanners,
	isMarkdownPath,
	scansMarkdownDynamically,
	selectDocAssertingTests,
};
