const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { resetSoft } = require('../lib/reset');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reset-soft-test-'));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function scaffold(root, files) {
  for (const f of files) {
    const fullPath = path.join(root, f);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, `# ${f}`, 'utf-8');
  }
}

describe('resetSoft', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('removes .forge/ directory when force=true', () => {
    scaffold(tmpDir, [
      '.forge/setup-state.json',
      '.forge/hooks/pre-commit',
    ]);

    expect(fs.existsSync(path.join(tmpDir, '.forge'))).toBe(true);

    resetSoft(tmpDir, { force: true });

    expect(fs.existsSync(path.join(tmpDir, '.forge'))).toBe(false);
  });

  test('preserves .claude/ directory', () => {
    scaffold(tmpDir, [
      '.forge/setup-state.json',
      '.claude/commands/plan.md',
      '.claude/rules/workflow.md',
    ]);

    resetSoft(tmpDir, { force: true });

    expect(fs.existsSync(path.join(tmpDir, '.forge'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'plan.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'workflow.md'))).toBe(true);
  });

  test('preserves agent directories', () => {
    scaffold(tmpDir, [
      '.forge/setup-state.json',
      '.cursor/rules/forge-workflow.mdc',
    ]);

    resetSoft(tmpDir, { force: true });

    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'rules', 'forge-workflow.mdc'))).toBe(true);
  });

  test('throws when force is not set', () => {
    scaffold(tmpDir, ['.forge/setup-state.json']);

    expect(() => resetSoft(tmpDir)).toThrow('--force');
  });

  test('returns removed and preserved lists', () => {
    scaffold(tmpDir, [
      '.forge/setup-state.json',
      '.claude/commands/plan.md',
    ]);

    const result = resetSoft(tmpDir, { force: true });

    expect(result.removed).toContain('.forge');
    expect(result.preserved.length).toBeGreaterThan(0);
  });

  test('handles case when .forge/ does not exist', () => {
    const result = resetSoft(tmpDir, { force: true });

    expect(result.removed).toEqual([]);
  });
});
