#!/usr/bin/env node
/**
 * Cross-platform ESLint runner for lefthook pre-push hook.
 * Replaces bash-only: bunx eslint . --max-warnings 0
 * Works on Windows CMD, PowerShell, macOS, Linux.
 */

const { spawnSync } = require('node:child_process');

console.log('🔍 Running ESLint...');

const result = spawnSync(
  'npx',
  ['--yes', 'eslint', '.', '--max-warnings', '0'],
  { stdio: 'inherit', shell: false }
);

if (result.status !== 0) {
  console.error('');
  console.error('❌ ESLint errors found. Fix them before pushing.');
  console.error('');
  console.error('To see errors:  npx eslint .');
  console.error('To auto-fix:    npx eslint . --fix');
  console.error('');
  console.error('Emergency bypass: LEFTHOOK=0 git push');
  console.error('');
  process.exit(1);
}

console.log('✅ ESLint check passed (no errors)');
