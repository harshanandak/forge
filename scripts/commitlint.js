#!/usr/bin/env node
/**
 * Cross-platform commitlint runner for lefthook commit-msg hook.
 * Replaces direct npx invocation which fails on Windows without shell: true.
 * Works on Windows CMD, PowerShell, macOS, Linux.
 */

const { spawnSync } = require('node:child_process');

// On Windows, npx is npx.cmd — shell: true resolves .cmd extensions
const isWindows = process.platform === 'win32';

const commitMsgFile = process.argv[2];
if (!commitMsgFile) {
  console.error('❌ No commit message file provided');
  process.exit(1);
}

// Detect package manager: prefer bun (fast, works with bun.lock), fall back to npx
// npx fails on Windows when npm 11's arborist encounters bun.lock instead of package-lock.json
const hasBunLock = require('node:fs').existsSync(
  require('node:path').join(__dirname, '../bun.lock')
);
const runner = hasBunLock ? 'bunx' : 'npx';

const result = spawnSync(
  runner,
  ['commitlint', '--edit', commitMsgFile],
  { stdio: 'inherit', shell: isWindows }
);

if (result.error) {
  console.error('');
  console.error(`❌ Failed to run commitlint: ${result.error.message}`);
  console.error('   Is Node.js/npm installed and on PATH?');
  console.error('');
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status);
}
