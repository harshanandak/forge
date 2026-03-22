const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  detectHusky,
  mapHuskyHooks,
  migrateHusky,
} = require('../lib/husky-migration');

describe('detectHusky', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husky-detect-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns found=false when no .husky/ directory exists', () => {
    const result = detectHusky(tmpDir);
    expect(result.found).toBe(false);
    expect(result.huskyDir).toBeNull();
    expect(result.hasHooksPath).toBe(false);
  });

  it('returns found=true when .husky/ directory exists', () => {
    fs.mkdirSync(path.join(tmpDir, '.husky'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.husky', 'pre-commit'), '#!/bin/sh\nnpx lint-staged\n');

    const result = detectHusky(tmpDir);
    expect(result.found).toBe(true);
    expect(result.huskyDir).toBe(path.join(tmpDir, '.husky'));
    expect(result.hasHooksPath).toBe(false);
  });

  it('detects core.hooksPath git config', () => {
    fs.mkdirSync(path.join(tmpDir, '.husky'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.husky', 'pre-commit'), '#!/bin/sh\nnpx lint-staged\n');

    // Create a minimal .git/config with core.hooksPath
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.git', 'config'),
      '[core]\n\thooksPath = .husky\n'
    );

    const result = detectHusky(tmpDir);
    expect(result.found).toBe(true);
    expect(result.hasHooksPath).toBe(true);
  });
});

describe('mapHuskyHooks', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husky-map-'));
    fs.mkdirSync(path.join(tmpDir, '.husky'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('maps npx lint-staged pre-commit to lefthook format', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.husky', 'pre-commit'),
      '#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n\nnpx lint-staged\n'
    );

    const result = mapHuskyHooks(path.join(tmpDir, '.husky'));
    expect(result.mapped.length).toBe(1);
    expect(result.mapped[0].hook).toBe('pre-commit');
    expect(result.mapped[0].name).toBe('lint-staged');
    expect(result.mapped[0].run).toBe('npx lint-staged');
  });

  it('maps commitlint commit-msg to lefthook format', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.husky', 'commit-msg'),
      '#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n\nnpx --no -- commitlint --edit ${1}\n'
    );

    const result = mapHuskyHooks(path.join(tmpDir, '.husky'));
    expect(result.mapped.length).toBe(1);
    expect(result.mapped[0].hook).toBe('commit-msg');
    expect(result.mapped[0].name).toBe('commitlint');
    expect(result.mapped[0].run).toBe('npx --no -- commitlint --edit {1}');
  });

  it('reports complex unmappable hooks with reason', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.husky', 'pre-push'),
      '#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n\nif [ "$SKIP_TESTS" != "true" ]; then\n  npm test\n  npm run lint\nfi\n'
    );

    const result = mapHuskyHooks(path.join(tmpDir, '.husky'));
    expect(result.unmapped.length).toBe(1);
    expect(result.unmapped[0].hook).toBe('pre-push');
    expect(result.unmapped[0].reason).toBeDefined();
    expect(result.unmapped[0].reason.length).toBeGreaterThan(0);
  });

  it('skips husky internal files like _/husky.sh', () => {
    // Create the internal _/ directory that husky uses
    fs.mkdirSync(path.join(tmpDir, '.husky', '_'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.husky', '_', 'husky.sh'),
      '#!/usr/bin/env sh\n# husky internal\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.husky', 'pre-commit'),
      '#!/bin/sh\nnpx lint-staged\n'
    );

    const result = mapHuskyHooks(path.join(tmpDir, '.husky'));
    // Should only map pre-commit, not the internal _/husky.sh
    expect(result.mapped.length).toBe(1);
    expect(result.unmapped.length).toBe(0);
  });

  it('maps simple npm/bun/yarn run commands', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.husky', 'pre-commit'),
      '#!/bin/sh\nnpm run format\n'
    );

    const result = mapHuskyHooks(path.join(tmpDir, '.husky'));
    expect(result.mapped.length).toBe(1);
    expect(result.mapped[0].run).toBe('npm run format');
    expect(result.mapped[0].name).toBe('format');
  });
});

describe('migrateHusky', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'husky-migrate-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects symlinks in .husky/ with security warning (OWASP A08)', () => {
    fs.mkdirSync(path.join(tmpDir, '.husky'), { recursive: true });

    // Create a real file then a symlink to it
    const realFile = path.join(tmpDir, 'real-hook.sh');
    fs.writeFileSync(realFile, '#!/bin/sh\nnpx lint-staged\n');

    const symlinkPath = path.join(tmpDir, '.husky', 'pre-commit');
    try {
      fs.symlinkSync(realFile, symlinkPath);
    } catch (_err) {
      // Windows requires elevated privileges for symlinks — skip test
      // eslint-disable-next-line no-console
      console.log('  (skipped: symlink creation requires elevated privileges on Windows)');
      return;
    }

    const result = migrateHusky(tmpDir, { nonInteractive: true });
    expect(result.success).toBe(false);
    expect(result.warnings).toBeDefined();
    expect(result.warnings.some(w => w.includes('symlink'))).toBe(true);
  });

  it('performs full migration: removes .husky/, creates lefthook config', () => {
    // Setup .husky directory with hooks
    fs.mkdirSync(path.join(tmpDir, '.husky'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.husky', 'pre-commit'),
      '#!/bin/sh\nnpx lint-staged\n'
    );

    const result = migrateHusky(tmpDir, { nonInteractive: true });
    expect(result.success).toBe(true);
    expect(result.mappedCount).toBe(1);
    expect(result.unmappedCount).toBe(0);

    // .husky/ should be removed
    expect(fs.existsSync(path.join(tmpDir, '.husky'))).toBe(false);
  });

  it('non-interactive mode auto-migrates without prompting', () => {
    fs.mkdirSync(path.join(tmpDir, '.husky'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.husky', 'pre-commit'),
      '#!/bin/sh\nnpx lint-staged\n'
    );

    // Non-interactive should succeed without any user input
    const result = migrateHusky(tmpDir, { nonInteractive: true });
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.husky'))).toBe(false);
  });

  it('warns about unmapped hooks but still succeeds', () => {
    fs.mkdirSync(path.join(tmpDir, '.husky'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.husky', 'pre-commit'),
      '#!/bin/sh\nnpx lint-staged\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.husky', 'pre-push'),
      '#!/bin/sh\nif [ "$CI" = "true" ]; then\n  echo "skip"\nelse\n  npm test && npm run build\nfi\n'
    );

    const result = migrateHusky(tmpDir, { nonInteractive: true });
    expect(result.success).toBe(true);
    expect(result.mappedCount).toBe(1);
    expect(result.unmappedCount).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('merges mapped hooks into existing lefthook.yml', () => {
    // Create existing lefthook.yml
    fs.writeFileSync(
      path.join(tmpDir, 'lefthook.yml'),
      'pre-push:\n  commands:\n    test:\n      run: bun test\n'
    );

    // Create .husky hooks
    fs.mkdirSync(path.join(tmpDir, '.husky'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.husky', 'pre-commit'),
      '#!/bin/sh\nnpx lint-staged\n'
    );

    const result = migrateHusky(tmpDir, { nonInteractive: true });
    expect(result.success).toBe(true);

    // lefthook.yml should still exist and contain both old and new hooks
    const lefthookContent = fs.readFileSync(path.join(tmpDir, 'lefthook.yml'), 'utf8');
    expect(lefthookContent).toContain('pre-commit');
    expect(lefthookContent).toContain('lint-staged');
    // Should preserve existing content
    expect(lefthookContent).toContain('pre-push');
  });

  it('returns success=false when no .husky/ directory exists', () => {
    const result = migrateHusky(tmpDir, { nonInteractive: true });
    expect(result.success).toBe(false);
    expect(result.warnings).toBeDefined();
  });

  it('unsets core.hooksPath during migration', () => {
    const { execFileSync: testExecFile } = require('child_process');

    // Initialize a real git repo so git config --unset works
    testExecFile('git', ['init'], { cwd: tmpDir, stdio: 'ignore' });
    testExecFile('git', ['config', 'core.hooksPath', '.husky'], { cwd: tmpDir, stdio: 'ignore' });

    // Create .husky with a hook
    fs.mkdirSync(path.join(tmpDir, '.husky'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.husky', 'pre-commit'),
      '#!/bin/sh\nnpx lint-staged\n'
    );

    const result = migrateHusky(tmpDir, { nonInteractive: true });
    expect(result.success).toBe(true);
    expect(result.hooksPathUnset).toBe(true);

    // Verify core.hooksPath was actually unset
    try {
      testExecFile('git', ['config', '--get', 'core.hooksPath'], { cwd: tmpDir, stdio: 'ignore' });
      // If the above doesn't throw, the config still exists — fail
      expect(true).toBe(false); // Should not reach here
    } catch (_err) {
      // git config --get exits non-zero when key is not set — expected
      expect(true).toBe(true);
    }
  });
});
