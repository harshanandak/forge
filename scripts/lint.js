#!/usr/bin/env node
/**
 * Cross-platform ESLint runner for lefthook pre-push hook.
 * Delegates to the project's package manager: <pkg> run lint
 * Works on Windows CMD, PowerShell, macOS, Linux.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

// On Windows, package manager CLIs are .cmd files — shell: true resolves them
const isWindows = process.platform === 'win32';

// Detect package manager from lock files (same priority as forge.js and test.js)
function detectPackageManager() {
  if (fs.existsSync('bun.lockb') || fs.existsSync('bun.lock')) return 'bun';
  if (fs.existsSync('pnpm-lock.yaml')) return 'pnpm';
  if (fs.existsSync('yarn.lock')) return 'yarn';
  return 'npm';
}

const pkgManager = detectPackageManager();
console.log(`🔍 Running ESLint (${pkgManager} run lint)...`);

const result = spawnSync(pkgManager, ['run', 'lint'], { stdio: 'inherit', shell: isWindows });

if (result.error) {
  console.error('');
  console.error(`❌ Failed to run ${pkgManager} run lint: ${result.error.message}`);
  console.error(`   Is '${pkgManager}' installed and on PATH?`);
  console.error('');
  process.exit(1);
}

if (result.status !== 0) {
  console.error('');
  console.error('❌ ESLint errors found. Fix them before pushing.');
  console.error('');
  console.error(`To see errors:  ${pkgManager} run lint`);
  console.error(`To auto-fix:    ${pkgManager} run lint -- --fix`);
  console.error('');
  console.error('Fix the failing checks. Do not bypass hooks.');
  console.error('');
  process.exit(1);
}

console.log('✅ ESLint check passed (no errors)');
