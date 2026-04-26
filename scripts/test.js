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

function detectPackageManager() {
  if (fs.existsSync('bun.lockb') || fs.existsSync('bun.lock')) return 'bun';
  if (fs.existsSync('pnpm-lock.yaml')) return 'pnpm';
  if (fs.existsSync('yarn.lock')) return 'yarn';
  return 'npm';
}

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

function isKnownTargetablePath(file) {
  if (file === '.gitignore') {
    return true;
  }

  if (file.startsWith('docs/plans/')) {
    return true;
  }

  return KNOWN_TARGETABLE_PREFIXES.some((prefix) => file.startsWith(prefix));
}

function includesWorkflowTarget(testTargets) {
  return testTargets.some((target) => target === 'test/ci-workflow.test.js'
    || target === 'test/structural/agentic-workflow-sync.test.js'
    || target.startsWith('test/workflows/'));
}

function buildTestExecutionPlan(projectRoot, execFileSync = defaultExecFileSync, options = {}) {
  const diffOptions = {
    sinceUpstream: options.sinceUpstream !== false,
  };
  const changedFiles = getChangedFiles(execFileSync, diffOptions);
  const testTargets = getAffectedTestFiles(projectRoot, execFileSync, fs, diffOptions);

  let runFullSuite = false;
  let runTestEnv = false;
  let runE2E = false;
  let runWorkflowTests = includesWorkflowTarget(testTargets);
  let hasUnmappedFiles = false;
  const hasUnknownChangedFiles = changedFiles.length === 0 && testTargets.length === 0;

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

  const hasZeroResolvedTests = changedFiles.length > 0
    && testTargets.length === 0
    && !runFullSuite
    && !runTestEnv
    && !runE2E
    && !runWorkflowTests;

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
    mode: runFullSuite || hasUnmappedFiles || hasUnknownChangedFiles || hasZeroResolvedTests ? 'full' : 'targeted',
    reason,
    runE2E,
    runFullSuite: runFullSuite || hasUnmappedFiles || hasUnknownChangedFiles || hasZeroResolvedTests,
    runTestEnv,
    runWorkflowTests,
    testTargets,
  };
}

function classifyPushTests(projectRoot, execFileSync = defaultExecFileSync) {
  return buildTestExecutionPlan(projectRoot, execFileSync, { sinceUpstream: true });
}

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

function runPrePushTests(projectRoot = process.cwd(), deps = {}) {
  const execFileSync = deps.execFileSync || defaultExecFileSync;
  const plan = classifyPushTests(projectRoot, execFileSync);
  return runTestExecutionPlan(plan, { ...deps, label: 'pre-push tests' });
}

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
  buildTestExecutionPlan,
  classifyPushTests,
  detectPackageManager,
  runLocalValidationTests,
  runPrePushTests,
  runTestExecutionPlan,
  stripGitHookEnv,
};
