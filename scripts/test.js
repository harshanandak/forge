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
  '.cursor/',
  '.codex/',
  '.forge/',
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

// Wall-clock ceiling for a single spawned test lane. Bun's per-test `--timeout`
// races a JS timer and CANNOT preempt a synchronous blocking spawn (e.g. an
// `execFileSync` of git/bash that hangs during git mid-push state). Without this
// ceiling such a hang blocks `forge push` indefinitely (observed ~50 min on
// Windows, issue 8aef79e8). This kills the lane process so the push fails fast
// instead of hanging forever.
//
// The default is a practical 5 minutes for a single TARGETED lane: those run a
// small, mapped subset that completes in seconds, so 5 min is comfortably a
// fail-fast ceiling (not the old 15-min wait that made `forge push` feel
// wedged). Raise it with FORGE_TEST_TIMEOUT_MS for slow machines.
const DEFAULT_TEST_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

// Wall-clock budget for the FULL-SUITE fallback lane (`scripts/test-full-suite.js`),
// which runs on package-level, unmapped, or zero-resolved changes. Unlike a
// targeted lane, a healthy full suite legitimately takes 5-10 min, so the 5-min
// fail-fast ceiling would kill a good-but-slow full run. Kept at 10 min to stay
// aligned with the local-validation budget (VALIDATION_COMMAND_TIMEOUT_MS = 600000
// in lib/commands/validate.js and its "long enough subprocess timeout for the
// full local suite" regression test). FORGE_TEST_TIMEOUT_MS still overrides.
const DEFAULT_FULL_SUITE_TIMEOUT_MS = 10 * 60 * 1000;

// Conventional shell exit code for a command terminated by a timeout.
const TIMEOUT_EXIT_CODE = 124;

/**
 * Reads and validates the FORGE_TEST_TIMEOUT_MS override, if any.
 *
 * @param {NodeJS.ProcessEnv} env Environment to read the override from.
 * @returns {number|null} The positive integer override, or null when unset/invalid.
 */
function readTimeoutOverride(env) {
  const parsed = Number.parseInt(env.FORGE_TEST_TIMEOUT_MS, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolves the wall-clock timeout for a targeted/e2e/edge-case lane, honoring
 * FORGE_TEST_TIMEOUT_MS.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment to read the override from.
 * @returns {number} Timeout in milliseconds (defaults to DEFAULT_TEST_COMMAND_TIMEOUT_MS).
 */
function resolveCommandTimeoutMs(env = process.env) {
  return readTimeoutOverride(env) ?? DEFAULT_TEST_COMMAND_TIMEOUT_MS;
}

/**
 * Resolves the wall-clock budget for the full-suite fallback lane. An explicit
 * FORGE_TEST_TIMEOUT_MS override wins; otherwise it uses the larger,
 * validation-aligned budget so a healthy-but-slow full run is not failed fast.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment to read the override from.
 * @returns {number} Timeout in milliseconds (defaults to DEFAULT_FULL_SUITE_TIMEOUT_MS).
 */
function resolveFullSuiteTimeoutMs(env = process.env) {
  return readTimeoutOverride(env) ?? DEFAULT_FULL_SUITE_TIMEOUT_MS;
}

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

  if (file === 'README.md'
    || file === 'bin/forge.js'
    || file === 'QUICKSTART.md'
    || file === 'CHANGELOG.md'
    || file === 'AGENTS.md'
    || file === 'DEVELOPMENT.md'
    || file === 'docs/INDEX.md'
    || file === 'docs/PROJECT_DESIGN.md'
    || file.startsWith('docs/forge/')
    || file.startsWith('docs/guides/')
    || file.startsWith('docs/plans/')
    || file.startsWith('docs/reference/')
    || file.startsWith('docs/work/')
    // Skill sources + their committed mirror map to the skill suite (see
    // SKILL_TEST_TARGETS in lib/commands/test.js); a skills-only PR stays on the
    // targeted lane instead of the full suite.
    || file.startsWith('skills/')
    || file.startsWith('.agents/skills/')) {
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
    if (result.error.code === 'ETIMEDOUT') {
      console.error('');
      console.error('Test lane exceeded its wall-clock ceiling and was terminated.');
      console.error('A single test likely hung (e.g. a spawned git/bash call that never returns).');
      console.error('Adjust the ceiling with FORGE_TEST_TIMEOUT_MS. Failing the run instead of');
      console.error('blocking the push. See issue 8aef79e8.');
      console.error('');
      return TIMEOUT_EXIT_CODE;
    }
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
  const timeout = resolveCommandTimeoutMs(env);
  const laneOptions = { env, killSignal: 'SIGKILL', timeout };
  // The full-suite fallback gets a larger, validation-aligned budget so a
  // healthy-but-slow full run is not failed fast by the targeted-lane ceiling.
  const fullSuiteOptions = { env, killSignal: 'SIGKILL', timeout: resolveFullSuiteTimeoutMs(env) };

  console.log(`Running ${label} (${pkgManager})...`);

  try {
    if (plan.runFullSuite) {
      console.log(`  Mode: full suite (${plan.reason})`);
      const status = runCommand('node', ['scripts/test-full-suite.js'], fullSuiteOptions, spawnSync);
      if (status !== 0) return status;
    } else if (plan.testTargets.length > 0) {
      console.log(`  Mode: targeted (${plan.testTargets.length} test file${plan.testTargets.length === 1 ? '' : 's'})`);
      const command = pkgManager === 'bun' ? bunCommand : pkgManager;
      const status = runCommand(command, ['run', 'test', ...plan.testTargets], laneOptions, spawnSync);
      if (status !== 0) return status;
    }

    if (plan.runE2E) {
      console.log('  Extra: running affected e2e tests');
      const status = runCommand(bunCommand, ['test', '--timeout', '15000', 'test/e2e/'], laneOptions, spawnSync);
      if (status !== 0) return status;
    }

    if (!plan.runFullSuite && plan.runTestEnv) {
      console.log('  Extra: running affected edge-case tests');
      const status = runCommand(bunCommand, ['test', '--timeout', '15000', 'test-env/'], laneOptions, spawnSync);
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
  DEFAULT_FULL_SUITE_TIMEOUT_MS,
  DEFAULT_TEST_COMMAND_TIMEOUT_MS,
  buildTestExecutionPlan,
  classifyPushTests,
  detectPackageManager,
  resolveCommandTimeoutMs,
  resolveFullSuiteTimeoutMs,
  runLocalValidationTests,
  runPrePushTests,
  runTestExecutionPlan,
  stripGitHookEnv,
};
