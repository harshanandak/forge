#!/usr/bin/env node
/**
 * Cross-platform test runner for lefthook pre-push hook.
 * Replaces bash-only: bun/pnpm/yarn/npm test detection with if/elif.
 * Works on Windows CMD, PowerShell, macOS, Linux.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

// Detect package manager from lock files (same priority as forge.js)
function detectPackageManager() {
  if (fs.existsSync('bun.lockb') || fs.existsSync('bun.lock')) return 'bun';
  if (fs.existsSync('pnpm-lock.yaml')) return 'pnpm';
  if (fs.existsSync('yarn.lock')) return 'yarn';
  return 'npm';
}

const pkgManager = detectPackageManager();
console.log(`🧪 Running test suite (${pkgManager} test)...`);

const result = spawnSync(pkgManager, ['test'], { stdio: 'inherit', shell: false });

if (result.status !== 0) {
  console.error('');
  console.error('❌ Tests failed. Fix them before pushing.');
  console.error('');
  console.error('Emergency bypass: LEFTHOOK=0 git push');
  console.error('');
  process.exit(1);
}

console.log('✅ All tests passed');
