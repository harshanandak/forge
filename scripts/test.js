#!/usr/bin/env node
/**
 * Cross-platform test runner shared by the pre-push hook and local validation.
 *
 * It runs only the tests affected by known changes when possible and falls back
 * to the full suite for package-level or unknown-file changes.
 */

const { execFileSync: defaultExecFileSync, spawnSync: defaultSpawnSync } = require('node:child_process');
const fs = require('node:fs');

const {
  getAffectedTestFiles,
  getChangedFiles,
} = require('../lib/commands/test');

const PACKAGE_LEVEL_PATHS = new Set([
  'package.json',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
]);

const KNOWN_TARGETABLE_PREFIXES = [
  '.claude/commands/',
  '.cursor/',
  '.cline/',
  '.roo/',
  '.kilocode/',
  '.opencode/',
  '.codex/skills/',
  '.forge/',
  '.github/prompts/',
  '.github/agentic-workflows/',
  '.github/workflows/',
  'test/',
];

const ALWAYS_RUN_RISK_TEST_TARGETS = [
  // Windows + concurrent filesystem locking has failed post-merge; keep this
  // in the fast PR lane until enough full-matrix runs prove it stable.
  'test/project-memory.test.js',
];

const isWindows = process.platform === 'win32';

/**
 * @typedef {Object} TestExecutionPlan
 * @property {string[]} changedFiles
 * @property {boolean} hasUnmappedFiles
 * @property {boolean} hasUnknownChangedFiles
 * @property {boolean} hasZeroResolvedTests
 * @property {'targeted'|'full'} mode
 * @property {string} reason
 * @property {boolean} runE2E
 * @property {boolean} runFullSuite
 * @property {boolean} runTestEnv
 * @property {boolean} runWorkflowTests
 * @property {string[]} testTargets
 */

/**
 * Detects the package manager to use for running test commands in this checkout.
 *
 * @returns {'bun'|'pnpm'|'yarn'|'npm'} The package manager inferred from lockfiles.
 */
function detectPackageManager() {
  if (fs.existsSync('bun.lockb') || fs.existsSync('bun.lock')) return 'bun';
  if (fs.existsSync('pnpm-lock.yaml')) return 'pnpm';
  if (fs.existsSync('yarn.lock')) return 'yarn';
  return 'npm';
}

/**
 * Removes Git hook-only environment variables before spawning nested Git-aware commands.
 *
 * @param {NodeJS.ProcessEnv} [sourceEnv=process.env] Environment variables to sanitize.
 * @returns {NodeJS.ProcessEnv} A copy of the environment without hook-specific Git variables.
 */
function stripGitHookEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  for (const key of Object.keys(env)) {
    if (key === 'GIT_DIR' || key === 'GIT_WORK_TREE' || key === 'GIT_INDEX_FILE'
      || key === 'GIT_OBJECT_DIRECTORY' || key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
      || key === 'GIT_QUARANTINE_PATH') {
      delete env[key];
    }
  }
  return env;
}

/**
 * Checks whether a changed path belongs to a known test-targetable area.
 *
 * @param {string} file Repository-relative changed file path.
 * @returns {boolean} True when the path can be handled by targeted test selection.
 */
function isKnownTargetablePath(file) {
  if (file === '.gitignore') {
    return true;
  }

  if (file.startsWith('docs/plans/')) {
    return true;
  }

  return KNOWN_TARGETABLE_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/**
 * Determines whether the resolved test targets require workflow-specific validation.
 *
 * @param {string[]} testTargets Repository-relative test file paths.
 * @returns {boolean} True when workflow tests are part of the target set.
 */
function includesWorkflowTarget(testTargets) {
  return testTargets.some((target) => target === 'test/ci-workflow.test.js'
    || target === 'test/structural/agentic-workflow-sync.test.js'
    || target.startsWith('test/workflows/'));
}

/**
 * Deduplicates test targets while preserving the original execution order.
 *
 * @param {string[]} testTargets Repository-relative test file paths.
 * @returns {string[]} Unique test targets in first-seen order.
 */
function uniqueTestTargets(testTargets) {
  return [...new Set(testTargets)];
}

function isExtraLaneOnlyPath(file) {
  return file.startsWith('test/e2e/') || file.startsWith('test-env/');
}

/**
 * Builds the execution plan used by PR, pre-push, and local validation test lanes.
 *
 * @param {string} projectRoot Absolute or relative repository root.
 * @param {typeof defaultExecFileSync} [execFileSync=defaultExecFileSync] Command runner used to inspect Git state.
 * @param {{sinceUpstream?: boolean}} [options={}] Test selection options.
 * @returns {TestExecutionPlan} The computed test execution plan.
 */
function buildTestExecutionPlan(projectRoot, execFileSync = defaultExecFileSync, options = {}) {
  const diffOptions = {
    sinceUpstream: options.sinceUpstream !== false,
  };
  const changedFiles = getChangedFiles(execFileSync, diffOptions);
  const affectedTestTargets = getAffectedTestFiles(projectRoot, execFileSync, fs, diffOptions);

  let runFullSuite = false;
  let runTestEnv = false;
  let runE2E = false;
  let runWorkflowTests = includesWorkflowTarget(affectedTestTargets);
  let hasUnmappedFiles = false;
  const hasUnknownChangedFiles = changedFiles.length === 0 && affectedTestTargets.length === 0;

  for (const file of changedFiles) {
    if (PACKAGE_LEVEL_PATHS.has(file) || file.startsWith('packages/')) {
      runFullSuite = true;
      runTestEnv = true;
      runE2E = true;
      runWorkflowTests = true;
      break;
    }

    if (file.startsWith('test-env/')) {
      runTestEnv = true;
      continue;
    }

    if (file.startsWith('test/e2e/')) {
      runE2E = true;
      continue;
    }

    if ((file.startsWith('lib/') || file.startsWith('scripts/')) && (file.endsWith('.js') || file.endsWith('.sh'))) {
      runTestEnv = true;
      if (file === 'scripts/behavioral-judge.sh') {
        runWorkflowTests = true;
      }
      continue;
    }

    if (file.startsWith('.github/workflows/') || file.startsWith('.github/agentic-workflows/')) {
      runWorkflowTests = true;
    }

    if (isKnownTargetablePath(file)) {
      continue;
    }

    hasUnmappedFiles = true;
  }

  const hasOnlyExtraLaneChanges = changedFiles.length > 0
    && changedFiles.every(isExtraLaneOnlyPath);
  const hasZeroResolvedTests = changedFiles.length > 0
    && affectedTestTargets.length === 0
    && !runFullSuite
    && !hasOnlyExtraLaneChanges;
  const shouldRunFullSuite = runFullSuite || hasUnmappedFiles || hasUnknownChangedFiles || hasZeroResolvedTests;

  const reason = hasUnmappedFiles
    ? 'unmapped pushed files require full unit coverage'
    : hasUnknownChangedFiles
      ? 'changed files could not be resolved safely'
      : hasZeroResolvedTests
        ? 'known changes did not resolve runnable tests'
      : runFullSuite
        ? 'package-level changes detected'
        : 'known changes mapped to targeted tests';

  return {
    changedFiles,
    hasUnmappedFiles,
    hasUnknownChangedFiles,
    hasZeroResolvedTests,
    mode: shouldRunFullSuite ? 'full' : 'targeted',
    reason,
    runE2E,
    runFullSuite: shouldRunFullSuite,
    runTestEnv,
    runWorkflowTests,
    testTargets: shouldRunFullSuite
      ? affectedTestTargets
      : uniqueTestTargets([...affectedTestTargets, ...ALWAYS_RUN_RISK_TEST_TARGETS]),
  };
}

/**
 * Classifies the pushed changes into the test plan enforced by the pre-push hook.
 *
 * @param {string} projectRoot Absolute or relative repository root.
 * @param {typeof defaultExecFileSync} [execFileSync=defaultExecFileSync] Command runner used to inspect Git state.
 * @returns {TestExecutionPlan} The pre-push test execution plan.
 */
function classifyPushTests(projectRoot, execFileSync = defaultExecFileSync) {
  return buildTestExecutionPlan(projectRoot, execFileSync, { sinceUpstream: true });
}

/**
 * Runs a command and returns its exit status, throwing only when process spawning fails.
 *
 * @param {string} command Executable name.
 * @param {string[]} args Command arguments.
 * @param {import('node:child_process').SpawnSyncOptions} [options={}] Spawn options.
 * @param {typeof defaultSpawnSync} [spawnSync=defaultSpawnSync] Process runner.
 * @returns {number} Process exit status, or 1 when no status is reported.
 */
function runCommand(command, args, options = {}, spawnSync = defaultSpawnSync) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: isWindows,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

/**
 * Executes a computed test plan and any extra targeted validation lanes.
 *
 * @param {TestExecutionPlan} plan Test plan to execute.
 * @param {Object} [deps={}] Runtime dependencies for tests.
 * @returns {number} Exit status for the executed plan.
 */
function runTestExecutionPlan(plan, deps = {}) {
  const spawnSync = deps.spawnSync || defaultSpawnSync;
  const pkgManager = deps.pkgManager || detectPackageManager();
  const env = deps.env || stripGitHookEnv(process.env);
  const bunCommand = deps.bunCommand || env.BUN_EXE || process.env.BUN_EXE || 'bun';
  const label = deps.label || 'tests';

  console.log(`Running ${label} (${pkgManager})...`);

  try {
    if (plan.runFullSuite) {
      console.log(`  Mode: full suite (${plan.reason})`);
      const status = runCommand('node', ['scripts/test-full-suite.js'], { env }, spawnSync);
      if (status !== 0) return status;
    } else if (plan.testTargets.length > 0) {
      console.log(`  Mode: targeted (${plan.testTargets.length} test file${plan.testTargets.length === 1 ? '' : 's'})`);
      const command = pkgManager === 'bun' ? bunCommand : pkgManager;
      const status = runCommand(command, ['run', 'test', ...plan.testTargets], { env }, spawnSync);
      if (status !== 0) return status;
    }

    if (!plan.runFullSuite && plan.runE2E) {
      console.log('  Extra: running affected e2e tests');
      const status = runCommand(bunCommand, ['test', 'test/e2e/'], { env }, spawnSync);
      if (status !== 0) return status;
    }

    if (!plan.runFullSuite && plan.runTestEnv) {
      console.log('  Extra: running affected edge-case tests');
      const status = runCommand(bunCommand, ['test', 'test-env/'], { env }, spawnSync);
      if (status !== 0) return status;
    }

    console.log('Relevant tests passed');
    return 0;
  } catch (error) {
    console.error('');
    console.error(`Failed to run ${label}: ${error.message}`);
    console.error('');
    return 1;
  }
}

/**
 * Runs the pre-push test plan for the current checkout.
 *
 * @param {string} [projectRoot=process.cwd()] Repository root.
 * @param {Object} [deps={}] Runtime dependencies for tests.
 * @returns {number} Exit status for pre-push tests.
 */
function runPrePushTests(projectRoot = process.cwd(), deps = {}) {
  const execFileSync = deps.execFileSync || defaultExecFileSync;
  const plan = classifyPushTests(projectRoot, execFileSync);
  return runTestExecutionPlan(plan, { ...deps, label: 'pre-push tests' });
}

/**
 * Runs the local validation test plan for the current checkout.
 *
 * @param {string} [projectRoot=process.cwd()] Repository root.
 * @param {Object} [deps={}] Runtime dependencies for tests.
 * @returns {number} Exit status for local validation tests.
 */
function runLocalValidationTests(projectRoot = process.cwd(), deps = {}) {
  const execFileSync = deps.execFileSync || defaultExecFileSync;
  const plan = buildTestExecutionPlan(projectRoot, execFileSync, { sinceUpstream: true });
  return runTestExecutionPlan(plan, { ...deps, label: 'local validation tests' });
}

if (require.main === module) {
  const exitCode = process.argv.includes('--validate')
    ? runLocalValidationTests()
    : runPrePushTests();
  process.exit(exitCode);
}

module.exports = {
  ALWAYS_RUN_RISK_TEST_TARGETS,
  buildTestExecutionPlan,
  classifyPushTests,
  detectPackageManager,
  runLocalValidationTests,
  runPrePushTests,
  runTestExecutionPlan,
  stripGitHookEnv,
};
