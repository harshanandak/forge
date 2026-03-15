const { describe, test, expect } = require('bun:test');
const path = require('node:path');

const { syncCommands } = require('../../scripts/sync-commands');

const repoRoot = path.resolve(__dirname, '../..');

// ─── sync drift detection ────────────────────────────────────────────────────

describe('command sync drift detection', () => {
  test('all agent command files are in sync with canonical source', () => {
    const result = syncCommands({ dryRun: false, check: true, repoRoot });

    if (result.empty) {
      throw new Error('No command files found in .claude/commands/ — cannot verify sync.');
    }

    if (result.manifestMissing) {
      throw new Error(
        'Sync manifest (.forge/sync-manifest.json) not found — stale file detection skipped.\n' +
        'Run "node scripts/sync-commands.js" to generate the manifest and commit it.'
      );
    }

    const issues = [];

    if (result.outOfSync.length > 0) {
      const listing = result.outOfSync
        .map((e) => `  [${e.agent}] ${path.join(e.dir, e.filename)}`)
        .join('\n');
      issues.push(`${result.outOfSync.length} file(s) out of sync:\n${listing}`);
    }

    if (result.staleFiles && result.staleFiles.length > 0) {
      const listing = result.staleFiles
        .map((f) => `  ${path.relative(repoRoot, f)}`)
        .join('\n');
      issues.push(`${result.staleFiles.length} stale file(s) should be removed:\n${listing}`);
    }

    if (issues.length > 0) {
      throw new Error(
        `Sync drift detected. Run "node scripts/sync-commands.js" and commit the results.\n${issues.join('\n')}`
      );
    }

    expect(result.outOfSync).toHaveLength(0);
    expect(result.staleFiles).toHaveLength(0);
  });
});
