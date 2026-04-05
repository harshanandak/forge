const { afterEach, describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resetCommands,
  resolveCanonicalCommandsDir,
} = require('../lib/commands/commands-reset');

const repoRoot = path.join(__dirname, '..');
const tempRoots = [];

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

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

  test('dry-run reset plans from commands/ when that is the canonical source', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reset-'));
    tempRoots.push(tempRoot);

    const commandsDir = path.join(tempRoot, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(commandsDir, 'plan.md'),
      '---\ndescription: Plan\n---\nUse the plan workflow.\n'
    );

    const result = resetCommands({
      repoRoot: tempRoot,
      commandName: 'plan',
      all: false,
      dryRun: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.reset.some((entry) => entry.file.includes('plan'))).toBe(true);
  });
});
