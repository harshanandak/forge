const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { safeBeadsInit } = require('../lib/beads-setup');

/**
 * Helper: create a unique temp directory for each test.
 */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'beads-init-wrapper-'));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Helper: set up a fake project root with .git/hooks/ directory.
 * @param {string} tmpDir - The temp directory to use as project root.
 * @param {Object} [hooks] - Map of hook filename to content.
 * @returns {string} Path to .git/hooks/ directory.
 */
function setupFakeGitHooks(tmpDir, hooks = {}) {
  const hooksDir = path.join(tmpDir, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const [name, content] of Object.entries(hooks)) {
    fs.writeFileSync(path.join(hooksDir, name), content, { mode: 0o755 });
  }
  return hooksDir;
}

// ---------------------------------------------------------------------------
// safeBeadsInit — idempotent (already initialized)
// ---------------------------------------------------------------------------
describe('safeBeadsInit — idempotent skip', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('returns skipped:true when already initialized', () => {
    // Set up a fully initialized .beads directory
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(
      path.join(beadsDir, 'config.yaml'),
      'issue-prefix: my-proj\ndatabase:\n  backend: dolt\n'
    );
    fs.writeFileSync(path.join(beadsDir, 'issues.jsonl'), '');
    setupFakeGitHooks(tmpDir);

    const result = safeBeadsInit(tmpDir, { execBdInit: () => {} });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('already initialized');
  });
});

// ---------------------------------------------------------------------------
// safeBeadsInit — full init flow
// ---------------------------------------------------------------------------
describe('safeBeadsInit — full init flow', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    setupFakeGitHooks(tmpDir, {
      'pre-commit': '#!/bin/sh\necho "lefthook pre-commit"',
      'pre-push': '#!/bin/sh\necho "lefthook pre-push"'
    });
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('writes config.yaml and .gitignore during init', () => {
    let bdInitCalled = false;
    const fakeBdInit = () => { bdInitCalled = true; };

    const result = safeBeadsInit(tmpDir, {
      prefix: 'test-proj',
      execBdInit: fakeBdInit
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(false);
    expect(bdInitCalled).toBe(true);

    // config.yaml should exist with correct prefix
    const configPath = path.join(tmpDir, '.beads', 'config.yaml');
    expect(fs.existsSync(configPath)).toBe(true);
    const configContent = fs.readFileSync(configPath, 'utf8');
    expect(configContent).toContain('issue-prefix: test-proj');

    // .gitignore should exist with Dolt entries
    const gitignorePath = path.join(tmpDir, '.beads', '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
    expect(gitignoreContent).toContain('dolt/');

    // issues.jsonl should no longer be pre-seeded
    const jsonlPath = path.join(tmpDir, '.beads', 'issues.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(false);
  });

  test('calls execBdInit with the project root', () => {
    let capturedRoot = null;
    const fakeBdInit = (root) => { capturedRoot = root; };

    safeBeadsInit(tmpDir, {
      prefix: 'proj',
      execBdInit: fakeBdInit
    });

    expect(capturedRoot).toBe(tmpDir);
  });
});

// ---------------------------------------------------------------------------
// safeBeadsInit — hooks preservation
// ---------------------------------------------------------------------------
describe('safeBeadsInit — hooks preservation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('hooks are identical before and after safeBeadsInit', () => {
    const originalHooks = {
      'pre-commit': '#!/bin/sh\necho "lefthook pre-commit"',
      'pre-push': '#!/bin/sh\necho "lefthook pre-push"',
      'commit-msg': '#!/bin/sh\necho "commitlint"'
    };
    setupFakeGitHooks(tmpDir, originalHooks);

    // Simulate bd init overwriting hooks
    const fakeBdInit = (root) => {
      const hooksDir = path.join(root, '.git', 'hooks');
      fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nbd hook pre-commit');
      fs.writeFileSync(path.join(hooksDir, 'pre-push'), '#!/bin/sh\nbd hook pre-push');
      // bd init also removes some hooks
      fs.unlinkSync(path.join(hooksDir, 'commit-msg'));
      // bd init adds its own hook
      fs.writeFileSync(path.join(hooksDir, 'post-commit'), '#!/bin/sh\nbd hook post-commit');
    };

    safeBeadsInit(tmpDir, {
      prefix: 'proj',
      execBdInit: fakeBdInit
    });

    const hooksDir = path.join(tmpDir, '.git', 'hooks');

    // Original hooks should be restored
    expect(fs.readFileSync(path.join(hooksDir, 'pre-commit'), 'utf8'))
      .toBe('#!/bin/sh\necho "lefthook pre-commit"');
    expect(fs.readFileSync(path.join(hooksDir, 'pre-push'), 'utf8'))
      .toBe('#!/bin/sh\necho "lefthook pre-push"');
    expect(fs.readFileSync(path.join(hooksDir, 'commit-msg'), 'utf8'))
      .toBe('#!/bin/sh\necho "commitlint"');

    // bd init's extra hook should be removed
    expect(fs.existsSync(path.join(hooksDir, 'post-commit'))).toBe(false);
  });

  test('handles case where .git/hooks does not exist initially', () => {
    // Just create .git but no hooks directory
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

    const fakeBdInit = (root) => {
      // bd init creates hooks dir and writes hooks
      const hooksDir = path.join(root, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nbd hook');
    };

    const result = safeBeadsInit(tmpDir, {
      prefix: 'proj',
      execBdInit: fakeBdInit
    });

    expect(result.success).toBe(true);

    // hooks dir should exist but be empty (restored to original empty state)
    const hooksDir = path.join(tmpDir, '.git', 'hooks');
    if (fs.existsSync(hooksDir)) {
      const files = fs.readdirSync(hooksDir);
      expect(files.length).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// safeBeadsInit — bd CLI not found
// ---------------------------------------------------------------------------
describe('safeBeadsInit — bd CLI not found', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    setupFakeGitHooks(tmpDir);
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('returns graceful error when bd CLI not found', () => {
    const fakeBdInit = () => {
      const err = new Error('bd CLI not installed');
      err.code = 'ENOENT';
      throw err;
    };

    const result = safeBeadsInit(tmpDir, {
      prefix: 'proj',
      execBdInit: fakeBdInit
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('not installed');
  });

  test('hooks are preserved even when bd CLI not found', () => {
    const originalHooks = {
      'pre-commit': '#!/bin/sh\necho "keep me"'
    };

    // Re-create with hooks
    rmrf(tmpDir);
    tmpDir = makeTmpDir();
    setupFakeGitHooks(tmpDir, originalHooks);

    const fakeBdInit = () => {
      const err = new Error('spawn bd ENOENT');
      err.code = 'ENOENT';
      throw err;
    };

    safeBeadsInit(tmpDir, {
      prefix: 'proj',
      execBdInit: fakeBdInit
    });

    const hooksDir = path.join(tmpDir, '.git', 'hooks');
    expect(fs.readFileSync(path.join(hooksDir, 'pre-commit'), 'utf8'))
      .toBe('#!/bin/sh\necho "keep me"');
  });
});

// ---------------------------------------------------------------------------
// safeBeadsInit — bd init fails (non-ENOENT)
// ---------------------------------------------------------------------------
describe('safeBeadsInit — bd init fails', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    setupFakeGitHooks(tmpDir, {
      'pre-commit': '#!/bin/sh\necho "original"'
    });
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('returns graceful error when bd init fails', () => {
    const fakeBdInit = () => {
      throw new Error('bd init failed: permission denied');
    };

    const result = safeBeadsInit(tmpDir, {
      prefix: 'proj',
      execBdInit: fakeBdInit
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('bd init failed');
  });

  test('hooks are still restored after bd init failure', () => {
    const fakeBdInit = (root) => {
      // bd init partially runs and overwrites hooks before failing
      const hooksDir = path.join(root, '.git', 'hooks');
      fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nbd hook broken');
      throw new Error('bd init crashed midway');
    };

    safeBeadsInit(tmpDir, {
      prefix: 'proj',
      execBdInit: fakeBdInit
    });

    const hooksDir = path.join(tmpDir, '.git', 'hooks');
    expect(fs.readFileSync(path.join(hooksDir, 'pre-commit'), 'utf8'))
      .toBe('#!/bin/sh\necho "original"');
  });
});

// ---------------------------------------------------------------------------
// safeBeadsInit — lefthook restore
// ---------------------------------------------------------------------------
describe('safeBeadsInit — lefthook restore', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    setupFakeGitHooks(tmpDir, {
      'pre-commit': '#!/bin/sh\necho "lefthook"'
    });
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('calls restoreLefthook callback when provided', () => {
    let lefthookCalled = false;
    const fakeRestoreLefthook = () => { lefthookCalled = true; };

    safeBeadsInit(tmpDir, {
      prefix: 'proj',
      execBdInit: () => {},
      restoreLefthook: fakeRestoreLefthook
    });

    expect(lefthookCalled).toBe(true);
  });

  test('does not fail when restoreLefthook is not provided', () => {
    const result = safeBeadsInit(tmpDir, {
      prefix: 'proj',
      execBdInit: () => {}
    });

    expect(result.success).toBe(true);
  });

  test('adds warning when restoreLefthook throws', () => {
    const fakeRestoreLefthook = () => {
      throw new Error('lefthook install failed');
    };

    const result = safeBeadsInit(tmpDir, {
      prefix: 'proj',
      execBdInit: () => {},
      restoreLefthook: fakeRestoreLefthook
    });

    // Should still succeed (lefthook restore is non-fatal)
    expect(result.success).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('lefthook');
  });
});

// ---------------------------------------------------------------------------
// safeBeadsInit — return shape
// ---------------------------------------------------------------------------
describe('safeBeadsInit — return shape', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    setupFakeGitHooks(tmpDir);
  });
  afterEach(() => {
    rmrf(tmpDir);
  });

  test('successful init returns correct shape', () => {
    const result = safeBeadsInit(tmpDir, {
      prefix: 'proj',
      execBdInit: () => {}
    });

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('warnings');
    expect(result).toHaveProperty('errors');
    expect(result.success).toBe(true);
    expect(result.skipped).toBe(false);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  test('skipped init returns correct shape', () => {
    // Make it look initialized
    const beadsDir = path.join(tmpDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(
      path.join(beadsDir, 'config.yaml'),
      'issue-prefix: proj\ndatabase:\n  backend: dolt\n'
    );
    fs.writeFileSync(path.join(beadsDir, 'issues.jsonl'), '');

    const result = safeBeadsInit(tmpDir, { execBdInit: () => {} });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBeDefined();
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  test('failed init returns correct shape', () => {
    const result = safeBeadsInit(tmpDir, {
      prefix: 'proj',
      execBdInit: () => { throw new Error('fail'); }
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toBe(false);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
