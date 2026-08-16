'use strict';

/**
 * Test Command — Smart Test Runner
 *
 * Wraps test execution with smart defaults:
 * - Auto-detects package manager from lockfiles
 * - Supports --affected flag to run only tests for changed files
 *
 * Security: Uses execFileSync for subprocess calls (OWASP A03)
 *
 * @module commands/test
 */

const { execFileSync: defaultExecFileSync, spawnSync: defaultSpawnSync } = require('node:child_process');
const defaultFs = require('node:fs');
const path = require('node:path');

const { selectDocAssertingTests } = require('../doc-assertions');

/** @type {Array<[string, string]>} Lockfile → package manager mapping (order matters) */
const LOCKFILE_MAP = [
	['bun.lockb', 'bun'],
	['pnpm-lock.yaml', 'pnpm'],
	['yarn.lock', 'yarn'],
	['package-lock.json', 'npm'],
];

const DEFAULT_TIMEOUT = 120000;
const DIRECT_TEST_CANDIDATES = Object.freeze({
	'bin/forge.js': [
		'test/cli-flags.test.js',
		'test/forge-cli-registry.test.js',
		'test/setup-runtime-flags.test.js',
	],
	// The second CLI surface (command descriptions + shepherd wiring). Without an
	// entry here it resolves to zero tests and pushes fall back to the full suite.
	'bin/forge-cmd.js': [
		'test/cli/forge-cmd.test.js',
		'test/forge-cmd-shepherd.test.js',
	],
	'bin/forge-preflight.js': ['test/bin/forge-preflight.test.js'],
	// The CI entry point is covered by the doc-assertion regression suite; without
	// this entry it resolves to zero tests and forces the full suite.
	// (lib/doc-assertions.js resolves via the lib/ -> test/ convention below.)
	'scripts/doc-asserting-tests.js': [
		'test/doc-assertions.test.js',
		'test/scripts/doc-asserting-tests.test.js',
	],
	'lib/lefthook-check.js': ['test/lefthook-check.test.js', 'test/runtime-health.test.js'],
	'lib/runtime-health.js': ['test/runtime-health.test.js'],
	// skill-eval hosts the accuracy-lint detectors (auditCommandDocumentation /
	// auditRouterPrecision), so edits there must also run their detector suite.
	'lib/skill-eval.js': ['test/skill-eval.test.js', 'test/skill-accuracy.test.js'],
	'lib/upgrade-safety.js': ['test/commands/upgrade.test.js'],
	'scripts/test.js': ['test/scripts/test-runner.test.js'],
	// `bun.lock` is deliberately absent: a dependency change can break anything,
	// so it stays on the full-suite lane.
	// lefthook.yml is the repository's hook wiring, so this must also cover the
	// suites that assert the individual pre-commit/pre-push commands exist.
	'lefthook.yml': [
		'test/lefthook-check.test.js',
		'test/lefthook-wiring.test.js',
		'test/commands/lefthook-user-config.test.js',
		'test/branch-protection.test.js',
		'test/commitlint.test.js',
		'test/cross-platform-install.test.js',
		'test/sync-d20-audit-script.test.js',
	],
	'eslint.config.js': ['test/lint-script.test.js'],
	'.coderabbit.yaml': ['test/coderabbit-config.test.js'],
	'.claude-plugin/marketplace.json': [
		'test/activation/plugin-scaffold.test.js',
		'test/plugin-catalog.test.js',
	],
});

// Directory-level mappings for source trees that own a dedicated suite. Without
// these a change under any of them resolves to zero tests and forces the full
// suite (see hasZeroResolvedTests in scripts/test.js).
const PREFIX_TEST_TARGETS = Object.freeze([
	['validation/', ['test/validation/risk-manifest.test.js', 'test/validation/risk-manifest-generator.test.js']],
	// `eval/corpus/` must come first: the corpus hash and manifest checks live in
	// immutable-corpus, and eval-sets only reads `eval/commands/`.
	['eval/corpus/', ['test/eval/immutable-corpus.test.js']],
	['eval/', ['test/eval/eval-sets.test.js']],
	['rules/', ['test/rules-sync.test.js', 'test/skill-dispatch-parity.test.js']],
	['plugin/', ['test/activation/plugin-scaffold.test.js', 'test/plugin-catalog.test.js', 'test/release-readiness.test.js']],
]);

// Skill sources (canonical `skills/**` and the committed `.agents/skills/**` mirror)
// map to the fast skill suite. This is what keeps a skills-only PR on the targeted
// lane instead of the full ~1500-test suite. `skills-sync-drift` guards the mirror.
const SKILL_TEST_TARGETS = Object.freeze([
	'test/skills-structure.test.js',
	'test/skill-coverage.test.js',
	'test/skill-eval.test.js',
	'test/skill-accuracy.test.js',
	'test/skill-dispatch-parity.test.js',
	'test/using-forge.test.js',
	'test/structural/skills-sync-drift.test.js',
	'test/skills/chain-integrity.test.js',
	'test/skills/skills-sync.test.js',
	'test/skills/stage-skills.test.js',
	'test/skills/using-forge-skill.test.js',
	'test/skills/context-cost.test.js',
]);

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
	} catch (err) { // NOSONAR S2486
		// A git-diff FAILURE is NOT the same as "no files changed": we could not
		// determine the change set at all. Callers that must fail closed (preflight)
		// pass { strict: true } so the error surfaces instead of masquerading as an
		// empty list. The default path keeps the historical empty-list fallback that
		// `forge test --affected` and the pre-push mapping rely on to run the full
		// suite, so their semantics are unchanged.
		if (options.strict) {
			const reason = err && err.message ? err.message : String(err);
			throw new Error(`git diff failed while computing changed files: ${reason}`);
		}
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

	// Markdown changes must also run the suites that assert on that markdown's
	// CONTENT (README size badge, AGENTS.md convention, docs consistency). The
	// static mapping above only knows the docs-consistency suite, so a docs PR
	// used to merge green and break master for the next code PR (issue 63556816).
	// The set is derived from the test sources, so new markdown-reading suites are
	// picked up without editing a list here.
	for (const candidate of selectDocAssertingTests(changedFiles, projectRoot, fs)) {
		testFiles.add(candidate);
	}

	return Array.from(testFiles).sort((left, right) => left.localeCompare(right));
}

function getTestCandidatesForChangedFile(file) {
	if (!file) return [];

	const directCandidates = DIRECT_TEST_CANDIDATES[file];
	if (directCandidates) {
		return directCandidates;
	}

	if (file.startsWith('test/') && file.endsWith('.test.js')) {
		return [file];
	}

	if (file.startsWith('skills/') || file.startsWith('.agents/skills/')) {
		return [...SKILL_TEST_TARGETS];
	}

	// Maintainer-only contributor skills. They document the AGENTS.md product /
	// maintainer split, so the docs-bleed gate is the suite that can catch a
	// contradiction between them.
	if (file.startsWith('.forge/contributor-skills/')) {
		return ['test/structural/agents-docs-bleed.test.js'];
	}

	for (const [prefix, targets] of PREFIX_TEST_TARGETS) {
		if (file.startsWith(prefix)) {
			return [...targets];
		}
	}

	if (file === 'README.md'
		|| file === 'QUICKSTART.md'
		|| file === 'CHANGELOG.md'
		|| file === 'AGENTS.md'
		|| file === 'DEVELOPMENT.md'
		|| file === 'docs/INDEX.md'
		|| file === 'docs/PROJECT_DESIGN.md'
		|| file.startsWith('docs/forge/')
		|| file.startsWith('docs/guides/')
		|| file.startsWith('docs/reference/')
		|| file.startsWith('docs/work/')) {
		return file === 'AGENTS.md'
			? ['test/docs-consistency.test.js', 'test/structural/agents-docs-bleed.test.js']
			: ['test/docs-consistency.test.js'];
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

	if (file.startsWith('.forge/')
		|| file.startsWith('.cursor/')
		|| file.startsWith('.codex/')) {
		return [
			'test/agent-gaps.test.js',
			'test/scripts/check-agents.test.js',
			'test/structural/skills-sync-drift.test.js',
		];
	}

	return [];
}

module.exports = {
	getChangedFiles,
	getAffectedTestFiles,
	getTestCandidatesForChangedFile,
	name: 'test',
	description: 'Run tests with smart defaults (timeout, affected-only)',
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
	 * @returns {Promise<{ success: boolean, exitCode: number }>}
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

		// 3. Build test command args
		let testArgs = ['run', 'test'];

		// 4. --affected flag: find changed test files
		if (flags['--affected'] || flags.affected) {
			const affectedTests = getAffectedTestFiles(projectRoot, execFileSync, fs, {
				sinceUpstream: flags.sinceUpstream || flags['--since-upstream'],
			});
			if (affectedTests.length > 0) {
				testArgs = ['run', 'test', ...affectedTests];
			}
			// If no affected tests found, fall back to running all tests
		}

		// 5. Run tests
		const result = spawnSync(pkgManager, testArgs, {
			env: { ...process.env },
			timeout,
			stdio: 'inherit',
			shell: process.platform === 'win32',
		});

		const exitCode = result.status ?? 1;

		return {
			success: exitCode === 0,
			exitCode,
		};
	},
};
