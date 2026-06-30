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
      '.claude/skills/plan/SKILL.md',
      '.claude/rules/workflow.md',
      '.claude/scripts/greptile-resolve.sh',
      '.cursor/rules/forge-workflow.mdc',
      '.github/workflows/beads-to-github.yml',
      'scripts/github-beads-sync/config.mjs',
    ]);

    resetHard(tmpDir, { force: true });

    expect(fs.existsSync(path.join(tmpDir, '.forge'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'workflow.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.cursor'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.github', 'workflows', 'beads-to-github.yml'))).toBe(false);
  });

  test('preserves user-created files not in forge template list', () => {
    scaffold(tmpDir, [
      '.claude/rules/workflow.md',
      '.claude/rules/my-custom-rule.md',
      '.claude/skills/plan/SKILL.md',
    ]);

    resetHard(tmpDir, { force: true });

    // Forge templates removed
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'workflow.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills'))).toBe(false);

    // User files preserved
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'my-custom-rule.md'))).toBe(true);
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

  test('preserves user/third-party skills while removing Forge-managed skills', () => {
    // Fixture canonical source: Forge "owns" only the 'plan' skill here.
    const sourceRoot = path.join(tmpDir, '_forge-src');
    scaffold(sourceRoot, ['skills/plan/SKILL.md']);

    // Project skills dir mixes a Forge-managed skill and a user-authored one.
    scaffold(tmpDir, [
      '.claude/skills/plan/SKILL.md',
      '.claude/skills/my-custom-skill/SKILL.md',
    ]);

    resetHard(tmpDir, { force: true, sourceRoot });

    // Forge-managed skill removed
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'plan'))).toBe(false);
    // User/third-party skill preserved
    expect(
      fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'my-custom-skill', 'SKILL.md'))
    ).toBe(true);
    // Surrounding skills dir intact (not wiped) because a user skill remains
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills'))).toBe(true);
  });

  test('removes Forge skill dir entirely when no user skills remain', () => {
    const sourceRoot = path.join(tmpDir, '_forge-src');
    scaffold(sourceRoot, ['skills/plan/SKILL.md']);
    scaffold(tmpDir, ['.claude/skills/plan/SKILL.md']);

    resetHard(tmpDir, { force: true, sourceRoot });

    // Empty Forge skills dir is cleaned up
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills'))).toBe(false);
  });

  test('removes multiple agent directories', () => {
    scaffold(tmpDir, [
      '.cursor/rules/forge-workflow.mdc',
      '.codex/skills/plan/SKILL.md',
    ]);

    resetHard(tmpDir, { force: true });

    expect(fs.existsSync(path.join(tmpDir, '.cursor'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.codex'))).toBe(false);
  });
});
