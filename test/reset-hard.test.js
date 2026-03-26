const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { resetHard } = require('../lib/reset');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reset-hard-test-'));
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

describe('resetHard', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('removes all forge files when force=true', () => {
    scaffold(tmpDir, [
      '.forge/setup-state.json',
      '.claude/commands/plan.md',
      '.claude/rules/workflow.md',
      '.claude/scripts/greptile-resolve.sh',
      '.cursor/rules/forge-workflow.mdc',
      '.github/workflows/beads-to-github.yml',
      'scripts/github-beads-sync/config.mjs',
    ]);

    resetHard(tmpDir, { force: true });

    expect(fs.existsSync(path.join(tmpDir, '.forge'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'plan.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'workflow.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cursor'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.github', 'workflows', 'beads-to-github.yml'))).toBe(false);
  });

  test('preserves user-created files not in forge template list', () => {
    scaffold(tmpDir, [
      '.claude/rules/workflow.md',
      '.claude/rules/my-custom-rule.md',
      '.claude/commands/plan.md',
      '.claude/commands/my-custom-cmd.md',
    ]);

    resetHard(tmpDir, { force: true });

    // Forge templates removed
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'workflow.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'plan.md'))).toBe(false);

    // User files preserved
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'my-custom-rule.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'my-custom-cmd.md'))).toBe(true);
  });

  test('throws when force is not set', () => {
    scaffold(tmpDir, ['.forge/setup-state.json']);

    expect(() => resetHard(tmpDir)).toThrow('--force');
  });

  test('returns removed list', () => {
    scaffold(tmpDir, [
      '.forge/setup-state.json',
      '.claude/rules/workflow.md',
    ]);

    const result = resetHard(tmpDir, { force: true });

    expect(result.removed).toContain('.forge');
    expect(result.removed).toContain('.claude/rules/workflow.md');
  });

  test('handles empty project gracefully', () => {
    const result = resetHard(tmpDir, { force: true });

    expect(result.removed).toEqual([]);
  });

  test('removes multiple agent directories', () => {
    scaffold(tmpDir, [
      '.cursor/rules/forge-workflow.mdc',
      '.cline/rules/forge-workflow.md',
      '.roo/rules/forge-workflow.md',
    ]);

    resetHard(tmpDir, { force: true });

    expect(fs.existsSync(path.join(tmpDir, '.cursor'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cline'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.roo'))).toBe(false);
  });
});
