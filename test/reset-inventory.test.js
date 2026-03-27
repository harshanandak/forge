const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { getForgeFiles } = require('../lib/reset');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reset-inventory-test-'));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Helper: create a directory tree from a list of relative file paths.
 */
function scaffold(root, files) {
  for (const f of files) {
    const fullPath = path.join(root, f);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, `# ${f}`, 'utf-8');
  }
}

describe('getForgeFiles', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('returns categorized forge file lists', () => {
    scaffold(tmpDir, [
      '.forge/setup-state.json',
      '.forge/hooks/pre-commit',
      '.claude/commands/plan.md',
      '.claude/rules/workflow.md',
      '.claude/scripts/greptile-resolve.sh',
      '.cursor/rules/forge-workflow.mdc',
      '.github/workflows/beads-to-github.yml',
      'scripts/github-beads-sync/config.mjs',
    ]);

    const result = getForgeFiles(tmpDir);

    expect(result.config).toContain('.forge');
    expect(result.commands.length).toBeGreaterThan(0);
    expect(result.rules.length).toBeGreaterThan(0);
    expect(result.scripts.length).toBeGreaterThan(0);
    expect(result.agentDirs.length).toBeGreaterThan(0);
    expect(result.workflows.length).toBeGreaterThan(0);
    expect(result.syncScripts.length).toBeGreaterThan(0);
  });

  test('does not include user-created files in rules', () => {
    scaffold(tmpDir, [
      '.claude/rules/workflow.md',
      '.claude/rules/my-custom-rule.md',
    ]);

    const result = getForgeFiles(tmpDir);

    // workflow.md is a forge template, my-custom-rule.md is user-created
    const allPaths = [
      ...result.rules,
      ...result.commands,
      ...result.scripts,
    ];

    // Normalize to forward slashes for comparison
    const normalized = allPaths.map(p => p.replace(/\\/g, '/'));

    expect(normalized).toContain('.claude/rules/workflow.md');
    expect(normalized).not.toContain('.claude/rules/my-custom-rule.md');
  });

  test('returns empty arrays when no forge files exist', () => {
    const result = getForgeFiles(tmpDir);

    expect(result.config).toEqual([]);
    expect(result.commands).toEqual([]);
    expect(result.rules).toEqual([]);
    expect(result.scripts).toEqual([]);
    expect(result.agentDirs).toEqual([]);
    expect(result.workflows).toEqual([]);
    expect(result.syncScripts).toEqual([]);
  });

  test('detects multiple agent directories', () => {
    scaffold(tmpDir, [
      '.cursor/rules/forge-workflow.mdc',
      '.cline/rules/forge-workflow.md',
      '.roo/rules/forge-workflow.md',
    ]);

    const result = getForgeFiles(tmpDir);
    const normalized = result.agentDirs.map(p => p.replace(/\\/g, '/'));

    expect(normalized).toContain('.cursor');
    expect(normalized).toContain('.cline');
    expect(normalized).toContain('.roo');
  });
});
