#!/usr/bin/env node
/**
 * Cross-platform test runner shared by the pre-push hook and local validation.
 *
 * It runs only the tests affected by known changes when possible and falls back
 * to the full suite for package-level or unknown-file changes.
 *
 * Quick lane: `forge push --quick` sets FORGE_PUSH_LANE=quick on the `git push`
 * it spawns, declaring the lint-only review-cycle lane. The pre-push entry point
 * honors that declaration and skips the test run with a loud notice, so --quick
 * is quick end to end instead of only in the step push.js controls. This is not
 * a hook bypass: branch protection and lint still run, local validation
 * (`--validate`) ignores the variable entirely, and CI runs the full matrix.
 */

const { EventEmitter } = require('node:events');
const {
  execFileSync: defaultExecFileSync,
  spawn: defaultSpawn,
} = require('node:child_process');
const fs = require('node:fs');

const {
  getAffectedTestFiles,
  getChangedFiles,
} = require('../lib/commands/test');
const { createProcessTree, signalExitCode } = require('./process-tree');

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

// Lane declaration set by `forge push --quick` on the spawned `git push`.
// Only this exact value opts into the lint-only lane.
const QUICK_LANE_ENV_VAR = 'FORGE_PUSH_LANE';
const QUICK_LANE_VALUE = 'quick';

/**
 * Reports whether the environment declares the lint-only quick push lane.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] Environment to inspect.
 * @returns {boolean} True when the quick lane is explicitly declared.
 */
function isQuickPushLane(env = process.env) {
  return env[QUICK_LANE_ENV_VAR] === QUICK_LANE_VALUE;
}

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
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === 'GIT_DIR' || normalizedKey === 'GIT_WORK_TREE'
      || normalizedKey === 'GIT_INDEX_FILE' || normalizedKey === 'GIT_OBJECT_DIRECTORY'
      || normalizedKey === 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
      || normalizedKey === 'GIT_QUARANTINE_PATH') {
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
    || file === 'bin/forge-cmd.js'
    || file === 'bin/forge-preflight.js'
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
    || file.startsWith('.agents/skills/')
    // Maintainer-only contributor skills (tracked, never published). They map to
    // the AGENTS.md docs-bleed gate in lib/commands/test.js, so a contributor-docs
    // PR stays on the targeted lane instead of the full suite.
    || file.startsWith('.forge/contributor-skills/')) {
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
 * @param {import('node:child_process').SpawnOptions} [options={}] Spawn options.
 * @param {typeof defaultSpawn} [spawn=defaultSpawn] Process runner.
 * @returns {Promise<number>} Process exit status, or 1 when no status is reported.
 */
function runCommand(command, args, options = {}, spawn = defaultSpawn) {
  const { processTree, timeout, killSignal: _killSignal, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer = null;
    const reservation = processTree?.reserveChild?.({ kind: 'test-lane', label: command }) || null;
    let registered = false;
    const release = () => {
      if (registered) {
        processTree?.unregisterChild?.(reservation);
        registered = false;
      }
    };
    const finish = (status) => {
      if (settled) return;
      settled = true;
      release();
      resolve(status ?? 1);
    };
    const fail = (error) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      if (error?.code === 'ETIMEDOUT') {
        processTree?.cleanup?.('SIGKILL');
        console.error('');
        console.error('Test lane exceeded its wall-clock ceiling and was terminated.');
        console.error('A single test likely hung (e.g. a spawned git/bash call that never returns).');
        console.error('Adjust the ceiling with FORGE_TEST_TIMEOUT_MS. Failing the run instead of');
        console.error('blocking the push. See issue 8aef79e8.');
        console.error('');
        finish(TIMEOUT_EXIT_CODE);
        return;
      }
      settled = true;
      release();
      reject(error);
    };
    try {
      child = spawn(command, args, { stdio: 'inherit', shell: isWindows, ...spawnOptions });
    } catch (error) {
      fail(error);
      return;
    }
    child.once?.('error', fail);
    child.once?.('close', (status, signal) => {
      if (timer) clearTimeout(timer);
      finish(status ?? signalExitCode(signal));
    });
    if (reservation && typeof processTree?.registerChild === 'function') {
      registered = true;
      if (!processTree.registerChild(reservation, child)) {
        processTree.abortChild?.(reservation, child);
        release();
        fail(new Error('test lane process could not be registered'));
        return;
      }
    }
    timer = timeout > 0 ? setTimeout(() => {
      processTree?.cleanup?.('SIGKILL');
      try { child.kill?.('SIGKILL'); } catch { /* best effort */ }
      finish(TIMEOUT_EXIT_CODE);
    }, timeout) : null;
    if (!child.once) {
      if (timer) clearTimeout(timer);
      finish(child.status ?? 1);
    }
  });
}

/**
 * Executes a computed test plan and any extra targeted validation lanes.
 *
 * @param {TestExecutionPlan} plan Test plan to execute.
 * @param {Object} [deps={}] Runtime dependencies for tests.
 * @returns {number} Exit status for the executed plan.
 */
async function runTestExecutionPlan(plan, deps = {}) {
  const usesSpawnSyncAdapter = !deps.spawn && typeof deps.spawnSync === 'function';
  const spawn = deps.spawn || (usesSpawnSyncAdapter ? (...args) => {
    const child = new EventEmitter();
    let result;
    try {
      result = deps.spawnSync(...args);
    } catch (error) {
      process.nextTick(() => child.emit('error', error));
      return child;
    }
    child.pid = result?.pid || process.pid;
    process.nextTick(() => {
      if (result?.error) child.emit('error', result.error);
      else child.emit('close', result?.status ?? 1, result?.signal);
    });
    return child;
  } : defaultSpawn);
  const pkgManager = deps.pkgManager || detectPackageManager();
  const env = deps.env || stripGitHookEnv(process.env);
  // The injected synchronous runner has already exited when its adapter returns,
  // so there is no live child to register or reap through host process probes.
  const processTree = deps.processTree || (usesSpawnSyncAdapter ? {} : createProcessTree({
    env,
    platform: deps.platform,
  }));
  let signal = null;
  const removeSignalHandlers = typeof processTree.installSignalHandlers === 'function'
    ? processTree.installSignalHandlers((received) => {
      signal = received;
    })
    : () => {};
  const childEnv = typeof processTree.envFor === 'function' ? processTree.envFor(env) : env;
  const bunCommand = deps.bunCommand || env.BUN_EXE || process.env.BUN_EXE || 'bun';
  const label = deps.label || 'tests';
  const timeout = resolveCommandTimeoutMs(env);
  const laneOptions = { env: childEnv, killSignal: 'SIGKILL', timeout, processTree };
  // The full-suite fallback gets a larger, validation-aligned budget so a
  // healthy-but-slow full run is not failed fast by the targeted-lane ceiling.
  const fullSuiteOptions = {
    env: childEnv,
    killSignal: 'SIGKILL',
    timeout: resolveFullSuiteTimeoutMs(env),
    processTree,
  };

  console.log(`Running ${label} (${pkgManager})...`);

  try {
    if (plan.runFullSuite) {
      console.log(`  Mode: full suite (${plan.reason})`);
       const status = await runCommand('node', ['scripts/test-full-suite.js'], fullSuiteOptions, spawn);
      if (signal) return signalExitCode(signal);
      if (status !== 0) return status;
    } else if (plan.testTargets.length > 0) {
      console.log(`  Mode: targeted (${plan.testTargets.length} test file${plan.testTargets.length === 1 ? '' : 's'})`);
      const command = pkgManager === 'bun' ? bunCommand : pkgManager;
       const status = await runCommand(command, ['run', 'test', ...plan.testTargets], laneOptions, spawn);
      if (signal) return signalExitCode(signal);
      if (status !== 0) return status;
    }

    if (plan.runE2E) {
      console.log('  Extra: running affected e2e tests');
       const status = await runCommand(bunCommand, ['test', '--timeout', '15000', 'test/e2e/'], laneOptions, spawn);
      if (signal) return signalExitCode(signal);
      if (status !== 0) return status;
    }

    if (!plan.runFullSuite && plan.runTestEnv) {
      console.log('  Extra: running affected edge-case tests');
       const status = await runCommand(bunCommand, ['test', '--timeout', '15000', 'test-env/'], laneOptions, spawn);
      if (signal) return signalExitCode(signal);
      if (status !== 0) return status;
    }

    console.log('Relevant tests passed');
    return signal ? signalExitCode(signal) : 0;
  } catch (error) {
    console.error('');
    console.error(`Failed to run ${label}: ${error.message}`);
    console.error('');
    return signal ? signalExitCode(signal) : 1;
  } finally {
    removeSignalHandlers();
    processTree.cleanup?.(signal ? 'SIGKILL' : 'SIGTERM');
  }
}

/**
 * Runs the pre-push test plan for the current checkout.
 *
 * @param {string} [projectRoot=process.cwd()] Repository root.
 * @param {Object} [deps={}] Runtime dependencies for tests.
 * @returns {number} Exit status for pre-push tests.
 */
async function runPrePushTests(projectRoot = process.cwd(), deps = {}) {
  if (isQuickPushLane(deps.env || process.env)) {
    console.log('');
    console.log('  quick lane: tests skipped locally — CI runs the full matrix');
    console.log('  Run `forge push` (no --quick) to test before merge.');
    console.log('');
    return 0;
  }

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
async function runLocalValidationTests(projectRoot = process.cwd(), deps = {}) {
  const execFileSync = deps.execFileSync || defaultExecFileSync;
  const plan = buildTestExecutionPlan(projectRoot, execFileSync, { sinceUpstream: true });
  return runTestExecutionPlan(plan, { ...deps, label: 'local validation tests' });
}

if (require.main === module) {
  (async () => {
    const exitCode = process.argv.includes('--validate')
      ? await runLocalValidationTests()
      : await runPrePushTests();
    process.exit(exitCode);
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  ALWAYS_RUN_RISK_TEST_TARGETS,
  DEFAULT_FULL_SUITE_TIMEOUT_MS,
  DEFAULT_TEST_COMMAND_TIMEOUT_MS,
  QUICK_LANE_ENV_VAR,
  QUICK_LANE_VALUE,
  buildTestExecutionPlan,
  classifyPushTests,
  detectPackageManager,
  isQuickPushLane,
  resolveCommandTimeoutMs,
  resolveFullSuiteTimeoutMs,
  runLocalValidationTests,
  runPrePushTests,
  runTestExecutionPlan,
  stripGitHookEnv,
};
