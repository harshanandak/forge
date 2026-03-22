const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * TDD tests for lib/symlink-utils.js — createSymlinkOrCopy
 *
 * Tests:
 * 1. Creates symlink in a tmpdir
 * 2. Symlink target resolves to correct content
 * 3. When symlink fails (EPERM), falls back to copy with header comment
 * 4. Copy fallback has the header comment as first line
 */

/** Helper: create a unique temp directory for each test */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-symlink-test-'));
}

/** Helper: clean up temp directory */
function cleanTmpDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('lib/symlink-utils.js — createSymlinkOrCopy', () => {
  test('module exports createSymlinkOrCopy function', () => {
    const mod = require('../lib/symlink-utils');
    expect(typeof mod.createSymlinkOrCopy).toBe('function');
  });

  test('creates symlink when possible', () => {
    const tmpDir = makeTmpDir();
    try {
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(targetPath, '# Forge Workflow\nSome content here.\n');

      const { createSymlinkOrCopy } = require('../lib/symlink-utils');
      const result = createSymlinkOrCopy(targetPath, linkPath);

      // On systems that support symlinks, it should be 'linked'
      // On Windows without admin, it falls back to 'copied'
      expect(result === 'linked' || result === 'copied').toBe(true);
      expect(fs.existsSync(linkPath)).toBe(true);
    } finally {
      cleanTmpDir(tmpDir);
    }
  });

  test('symlink target resolves to correct content', () => {
    const tmpDir = makeTmpDir();
    try {
      const content = '# Forge Workflow\nLine two.\n';
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(targetPath, content);

      const { createSymlinkOrCopy } = require('../lib/symlink-utils');
      const result = createSymlinkOrCopy(targetPath, linkPath);

      const readContent = fs.readFileSync(linkPath, 'utf-8');

      if (result === 'linked') {
        // Symlink: content is identical (read through symlink)
        expect(readContent).toBe(content);
      } else {
        // Copy fallback: content starts with header comment, then original content
        expect(readContent).toContain(content);
      }
    } finally {
      cleanTmpDir(tmpDir);
    }
  });

  test('when symlink fails (EPERM), falls back to copy with header comment', () => {
    const tmpDir = makeTmpDir();
    try {
      const content = '# Forge Workflow\nContent here.\n';
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(targetPath, content);

      // Mock fs.symlinkSync to throw EPERM
      const originalSymlinkSync = fs.symlinkSync;
      fs.symlinkSync = function () {
        const err = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      };

      try {
        // Need to re-require with mocked fs — but since the module uses the
        // same fs reference, the mock takes effect
        const { createSymlinkOrCopy } = require('../lib/symlink-utils');
        const result = createSymlinkOrCopy(targetPath, linkPath);

        expect(result).toBe('copied');
        expect(fs.existsSync(linkPath)).toBe(true);

        const readContent = fs.readFileSync(linkPath, 'utf-8');
        expect(readContent).toContain(content);
      } finally {
        fs.symlinkSync = originalSymlinkSync;
      }
    } finally {
      cleanTmpDir(tmpDir);
    }
  });

  test('copy fallback has the header comment as first line', () => {
    const tmpDir = makeTmpDir();
    try {
      const content = '# Forge Workflow\nContent here.\n';
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(targetPath, content);

      // Mock fs.symlinkSync to throw EPERM
      const originalSymlinkSync = fs.symlinkSync;
      fs.symlinkSync = function () {
        const err = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      };

      try {
        const { createSymlinkOrCopy } = require('../lib/symlink-utils');
        const result = createSymlinkOrCopy(targetPath, linkPath);

        expect(result).toBe('copied');

        const readContent = fs.readFileSync(linkPath, 'utf-8');
        const firstLine = readContent.split('\n')[0];
        expect(firstLine).toBe(
          '<!-- This file is a copy of AGENTS.md. Keep in sync manually or use: bunx forge setup --symlink -->'
        );
      } finally {
        fs.symlinkSync = originalSymlinkSync;
      }
    } finally {
      cleanTmpDir(tmpDir);
    }
  });

  test('HEADER_COMMENT constant is exported', () => {
    const { HEADER_COMMENT } = require('../lib/symlink-utils');
    expect(typeof HEADER_COMMENT).toBe('string');
    expect(HEADER_COMMENT).toContain('AGENTS.md');
    expect(HEADER_COMMENT).toContain('--symlink');
  });
});

describe('--symlink flag in bin/forge.js', () => {
  test('bin/forge.js should reference symlink flag', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    expect(content.includes('--symlink')).toBe(true);
  });

  test('parseFlags should include symlink in flags object', () => {
    const forgePath = path.join(__dirname, '..', 'bin', 'forge.js');
    const content = fs.readFileSync(forgePath, 'utf-8');
    expect(content.includes('symlink')).toBe(true);
    // The flags object should have a symlink property
    expect(content.includes('flags.symlink')).toBe(true);
  });
});
