/**
 * Tests for lib/commands/commands-reset.js — forge commands reset.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { resetCommands } = require('../lib/commands/commands-reset');
const { syncCommands } = require('../scripts/sync-commands');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reset-'));
  // Create minimal commands/ dir with one canonical file
  const commandsDir = path.join(tmpDir, 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.writeFileSync(
    path.join(commandsDir, 'plan.md'),
    '---\ndescription: Plan a feature\n---\n\nPlan body content.\n'
  );
  // Create scripts dir for sync-commands to find (it resolves .. from __dirname)
  // We use the real repo root instead
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resetCommands', () => {
  test('rejects invalid command names (OWASP A03)', () => {
    const result = resetCommands({
      repoRoot: tmpDir,
      commandName: '../etc/passwd',
      dryRun: true,
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Invalid command name');
  });

  test('reports error when canonical source missing', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reset-empty-'));
    try {
      const result = resetCommands({ repoRoot: emptyDir, dryRun: true });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Canonical source directory not found');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test('reports error when specified command does not exist', () => {
    const result = resetCommands({
      repoRoot: tmpDir,
      commandName: 'nonexistent',
      dryRun: true,
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Command not found');
  });

  // Integration test using real repo root
  test('dry-run with real repo returns planned entries', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const result = resetCommands({ repoRoot, dryRun: true });
    expect(result.errors).toHaveLength(0);
    // Should have entries for all agents x commands
    expect(result.reset.length + result.skipped.length).toBeGreaterThan(0);
  });

  test('dry-run filters by command name', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const result = resetCommands({ repoRoot, commandName: 'plan', dryRun: true });
    expect(result.errors).toHaveLength(0);
    // All entries should be for 'plan' command
    for (const entry of [...result.reset, ...result.skipped]) {
      expect(entry.file).toMatch(/plan/);
    }
  });

  test('targeted reset does not rewrite unrelated command files', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'commands', 'dev.md'),
      '---\ndescription: Dev a feature\n---\n\nDev body content.\n'
    );

    const { planned } = syncCommands({ repoRoot: tmpDir, dryRun: true, check: false });
    const planEntry = planned.find((entry) => entry.agent === 'cursor' && entry.filename === 'plan.md');
    const devEntry = planned.find((entry) => entry.agent === 'cursor' && entry.filename === 'dev.md');

    expect(planEntry).toBeDefined();
    expect(devEntry).toBeDefined();

    fs.mkdirSync(path.dirname(planEntry.filePath), { recursive: true });
    fs.writeFileSync(planEntry.filePath, 'customized plan command\n');
    fs.writeFileSync(devEntry.filePath, 'customized dev command\n');

    const result = resetCommands({ repoRoot: tmpDir, commandName: 'plan', dryRun: false });

    expect(result.errors).toEqual([]);
    expect(fs.readFileSync(planEntry.filePath, 'utf8')).toBe(planEntry.content);
    expect(fs.readFileSync(devEntry.filePath, 'utf8')).toBe('customized dev command\n');

    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, '.forge', 'sync-manifest.json'), 'utf8'));
    expect(manifest.files).toContain('.cursor/commands/plan.md');
    expect(manifest.files).toContain('.cursor/commands/dev.md');
  });
});
