#!/usr/bin/env node
/**
 * Cross-platform commitlint runner for lefthook commit-msg hook.
 * Executes the installed commitlint CLI directly on Windows, macOS, and Linux.
 */

const { spawnSync } = require('node:child_process');

const commitMsgFile = process.argv[2];
if (!commitMsgFile) {
  // Write synchronously so the message is flushed before exit: on Windows the
  // stderr pipe is async and process.exit() can otherwise truncate it.
  require('node:fs').writeSync(2, '❌ No commit message file provided\n');
  process.exit(1);
}

let commitlintCli;
try {
  commitlintCli = require.resolve('@commitlint/cli/cli.js');
} catch (error) {
  console.error(`❌ Failed to resolve commitlint: ${error.message}`);
  console.error('   Install project dependencies before committing.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [commitlintCli, '--edit', commitMsgFile],
  { stdio: 'inherit', shell: false }
);

if (result.error) {
  console.error('');
  console.error(`❌ Failed to run commitlint: ${result.error.message}`);
  console.error('   Is Node.js/npm installed and on PATH?');
  console.error('');
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
