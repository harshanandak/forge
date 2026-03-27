const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { reinstall } = require('../lib/reset');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reinstall-test-'));
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

describe('reinstall', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmrf(tmpDir);
  });

  test('calls resetHard then setupFn', async () => {
    scaffold(tmpDir, [
      '.forge/setup-state.json',
      '.claude/commands/plan.md',
      '.claude/rules/workflow.md',
    ]);

    let setupCalled = false;
    let setupRoot = null;
    const mockSetup = async (root) => {
      setupCalled = true;
      setupRoot = root;
      return { success: true };
    };

    const result = await reinstall(tmpDir, { force: true, setupFn: mockSetup });

    // Forge files should have been removed
    expect(fs.existsSync(path.join(tmpDir, '.forge'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'plan.md'))).toBe(false);

    // Setup function was called with project root
    expect(setupCalled).toBe(true);
    expect(setupRoot).toBe(tmpDir);

    // Result contains both reset and setup results
    expect(result.resetResult.removed).toContain('.forge');
    expect(result.setupResult).toEqual({ success: true });
  });

  test('throws when force is not set', async () => {
    scaffold(tmpDir, ['.forge/setup-state.json']);

    try {
      await reinstall(tmpDir);
      expect(true).toBe(false); // Should not reach here
    } catch (error) {
      expect(error.message).toContain('--force');
    }
  });

  test('works without setupFn (reset only)', async () => {
    scaffold(tmpDir, [
      '.forge/setup-state.json',
      '.claude/rules/workflow.md',
    ]);

    const result = await reinstall(tmpDir, { force: true });

    expect(fs.existsSync(path.join(tmpDir, '.forge'))).toBe(false);
    expect(result.resetResult.removed).toContain('.forge');
    expect(result.setupResult).toBeNull();
  });

  test('preserves user files during reinstall', async () => {
    scaffold(tmpDir, [
      '.forge/setup-state.json',
      '.claude/rules/workflow.md',
      '.claude/rules/my-custom.md',
    ]);

    const mockSetup = async () => ({ success: true });
    await reinstall(tmpDir, { force: true, setupFn: mockSetup });

    // User file preserved
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'my-custom.md'))).toBe(true);
    // Forge file removed
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'rules', 'workflow.md'))).toBe(false);
  });
});
