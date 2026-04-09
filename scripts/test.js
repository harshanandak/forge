#!/usr/bin/env node
/**
 * Cross-platform test runner for the lefthook pre-push hook.
 *
 * Runs only the tests affected by the changes being pushed when possible.
 * Falls back to the full suite only for package-level changes.
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

const isWindows = process.platform === 'win32';

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

function classifyPushTests(projectRoot, execFileSync = defaultExecFileSync) {
  const changedFiles = getChangedFiles(execFileSync, { sinceUpstream: true });
  const testTargets = getAffectedTestFiles(projectRoot, execFileSync, fs, { sinceUpstream: true });

  let runFullSuite = false;
  let runTestEnv = false;
  let runE2E = false;
  let hasUnmappedFiles = false;
  const hasUnknownChangedFiles = changedFiles.length === 0 && testTargets.length === 0;

  for (const file of changedFiles) {
    if (PACKAGE_LEVEL_PATHS.has(file) || file.startsWith('packages/')) {
      runFullSuite = true;
      runTestEnv = true;
      runE2E = true;
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

    if ((file.startsWith('lib/') || file.startsWith('scripts/')) && file.endsWith('.js')) {
      runTestEnv = true;
      continue;
    }

    if (file.startsWith('test/') || file.startsWith('.github/workflows/') || file.startsWith('.claude/commands/')) {
      continue;
    }

    hasUnmappedFiles = true;
  }

  return {
    changedFiles,
    hasUnmappedFiles,
    hasUnknownChangedFiles,
    runE2E,
    runFullSuite: runFullSuite || hasUnmappedFiles || hasUnknownChangedFiles,
    runTestEnv,
    testTargets,
  };
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

function runPrePushTests(projectRoot = process.cwd(), deps = {}) {
  const spawnSync = deps.spawnSync || defaultSpawnSync;
  const execFileSync = deps.execFileSync || defaultExecFileSync;
  const pkgManager = deps.pkgManager || detectPackageManager();
  const env = deps.env || stripGitHookEnv(process.env);
  const plan = classifyPushTests(projectRoot, execFileSync);

  console.log(`Running pre-push tests (${pkgManager})...`);

  try {
    if (plan.runFullSuite) {
      const reason = plan.hasUnmappedFiles
        ? 'unmapped pushed files require full unit coverage'
        : plan.hasUnknownChangedFiles
          ? 'changed files could not be resolved safely'
          : 'package-level changes detected';
      console.log(`  Mode: full suite (${reason})`);
      const status = runCommand(pkgManager, ['run', 'test'], { env }, spawnSync);
      if (status !== 0) return status;
    } else if (plan.testTargets.length > 0) {
      console.log(`  Mode: targeted (${plan.testTargets.length} test file${plan.testTargets.length === 1 ? '' : 's'})`);
      const status = runCommand(pkgManager, ['run', 'test', ...plan.testTargets], { env }, spawnSync);
      if (status !== 0) return status;
    }

    if (plan.runE2E) {
      console.log('  Extra: running affected e2e tests');
      const status = runCommand('bun', ['test', 'test/e2e/'], { env }, spawnSync);
      if (status !== 0) return status;
    }

    if (plan.runTestEnv) {
      console.log('  Extra: running affected edge-case tests');
      const status = runCommand('bun', ['test', 'test-env/'], { env }, spawnSync);
      if (status !== 0) return status;
    }

    console.log('Relevant tests passed');
    return 0;
  } catch (error) {
    console.error('');
    console.error(`Failed to run tests: ${error.message}`);
    console.error('');
    return 1;
  }
}

if (require.main === module) {
  process.exit(runPrePushTests());
}

module.exports = {
  classifyPushTests,
  detectPackageManager,
  runPrePushTests,
  stripGitHookEnv,
};
