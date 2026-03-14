const { describe, test, expect } = require('bun:test');
const path = require('node:path');

const { syncCommands } = require('../../scripts/sync-commands');

const repoRoot = path.resolve(__dirname, '../..');

// ─── sync drift detection ────────────────────────────────────────────────────

describe('command sync drift detection', () => {
  test('all agent command files are in sync with canonical source', () => {
    const result = syncCommands({ dryRun: false, check: true, repoRoot });

    if (result.outOfSync.length > 0) {
      const listing = result.outOfSync
        .map((e) => `  [${e.agent}] ${path.join(e.dir, e.filename)}`)
        .join('\n');

      throw new Error(
        `${result.outOfSync.length} file(s) out of sync. Run "node scripts/sync-commands.js" and commit the results.\n${listing}`
      );
    }

    expect(result.outOfSync).toHaveLength(0);
  });
});
