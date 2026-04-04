const { describe, test, expect } = require('bun:test');
const path = require('node:path');

const {
  resetCommands,
  resolveCanonicalCommandsDir,
} = require('../lib/commands/commands-reset');

const repoRoot = path.join(__dirname, '..');

describe('commands-reset canonical source resolution', () => {
  test('resolves the packaged canonical command directory with legacy fallback', () => {
    const canonicalDir = resolveCanonicalCommandsDir(repoRoot);

    expect(canonicalDir).toBe(path.join(repoRoot, '.claude', 'commands'));
  });

  test('dry-run reset accepts the packaged canonical command source', () => {
    const result = resetCommands({
      repoRoot,
      commandName: 'plan',
      all: false,
      dryRun: true,
    });

    expect(result.errors).toEqual([]);
  });
});
