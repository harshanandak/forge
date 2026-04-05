#!/usr/bin/env node
/**
 * Cross-platform test runner for lefthook pre-push hook.
 * Replaces bash-only: bun/pnpm/yarn/npm test detection with if/elif.
 * Works on Windows CMD, PowerShell, macOS, Linux.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

// On Windows, package manager CLIs are .cmd files — shell: true resolves them
const isWindows = process.platform === 'win32';

// Detect package manager from lock files (same priority as forge.js)
function detectPackageManager() {
  if (fs.existsSync('bun.lockb') || fs.existsSync('bun.lock')) return 'bun';
  if (fs.existsSync('pnpm-lock.yaml')) return 'pnpm';
  if (fs.existsSync('yarn.lock')) return 'yarn';
  return 'npm';
}

const pkgManager = detectPackageManager();
console.log(`🧪 Running test suite (${pkgManager} test)...`);

// Strip git hook environment variables so child processes (especially tests
// that create temp git repos) never accidentally operate on the real worktree.
// During pre-push hooks, git sets GIT_DIR pointing to the repo — any test that
// runs `git init` / `git commit` in a temp dir inherits this and silently
// commits into the worktree instead, creating rogue "initial commit" that
// deletes the entire codebase.
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key === 'GIT_DIR' || key === 'GIT_WORK_TREE' || key === 'GIT_INDEX_FILE'
    || key === 'GIT_OBJECT_DIRECTORY' || key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
    || key === 'GIT_QUARANTINE_PATH') {
    delete env[key];
  }
}

// Use 'run test' to invoke the package.json script (which may include --timeout flags)
// 'bun test' is a built-in that ignores package.json scripts
const result = spawnSync(pkgManager, ['run', 'test'], { stdio: 'inherit', shell: isWindows, env });

if (result.error) {
  console.error('');
  console.error(`❌ Failed to run ${pkgManager} test: ${result.error.message}`);
  console.error(`   Is '${pkgManager}' installed and on PATH?`);
  console.error('');
  process.exit(1);
}

if (result.status !== 0) {
  console.error('');
  console.error('❌ Tests failed. Fix them before pushing.');
  console.error('');
  console.error('Fix the failing checks. Do not bypass hooks.');
  console.error('');
  process.exit(1);
}

console.log('✅ All tests passed');
