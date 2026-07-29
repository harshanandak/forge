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

  test('preserves an existing @AGENTS.md import byte-for-byte', () => {
    const tmpDir = makeTmpDir();
    try {
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      const existingImport = '\uFEFF  @AGENTS.md\r\n';
      fs.writeFileSync(targetPath, '# Forge Workflow\n');
      fs.writeFileSync(linkPath, existingImport);

      const { createSymlinkOrCopy } = require('../lib/symlink-utils');
      const result = createSymlinkOrCopy(targetPath, linkPath);

      expect(result).toBe('existing-import');
      expect(fs.readFileSync(linkPath)).toEqual(Buffer.from(existingImport));
    } finally {
      cleanTmpDir(tmpDir);
    }
  });

  test('treats an existing symlink to the target as already linked', () => {
    const tmpDir = makeTmpDir();
    const originalLstatSync = fs.lstatSync;
    const originalReadlinkSync = fs.readlinkSync;
    const originalWarn = console.warn;
    const warnings = [];
    try {
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(targetPath, '# Forge Workflow\n');
      fs.lstatSync = file => file === linkPath
        ? {
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => true,
          }
        : originalLstatSync(file);
      fs.readlinkSync = file => file === linkPath
        ? path.relative(path.dirname(linkPath), targetPath)
        : originalReadlinkSync(file);
      console.warn = message => warnings.push(message);

      const { createSymlinkOrCopy } = require('../lib/symlink-utils');
      const result = createSymlinkOrCopy(targetPath, linkPath);

      expect(result).toBe('linked');
      expect(warnings).toEqual([]);
    } finally {
      fs.lstatSync = originalLstatSync;
      fs.readlinkSync = originalReadlinkSync;
      console.warn = originalWarn;
      cleanTmpDir(tmpDir);
    }
  });

  test('does not overwrite an existing non-import file', () => {
    const tmpDir = makeTmpDir();
    try {
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      const userContent = '# User instructions\nKeep this content.\n';
      fs.writeFileSync(targetPath, '# Forge Workflow\n');
      fs.writeFileSync(linkPath, userContent);

      const { createSymlinkOrCopy } = require('../lib/symlink-utils');
      const result = createSymlinkOrCopy(targetPath, linkPath);

      expect(result).toBe('');
      expect(fs.readFileSync(linkPath, 'utf8')).toBe(userContent);
    } finally {
      cleanTmpDir(tmpDir);
    }
  });

  test('preserves a file created during symlink creation', () => {
    const tmpDir = makeTmpDir();
    const originalSymlinkSync = fs.symlinkSync;
    try {
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      const userContent = '# Created concurrently\n';
      fs.writeFileSync(targetPath, '# Forge Workflow\n');
      fs.symlinkSync = function () {
        fs.writeFileSync(linkPath, userContent);
        const err = new Error('File exists');
        err.code = 'EEXIST';
        throw err;
      };

      const { createSymlinkOrCopy } = require('../lib/symlink-utils');
      const result = createSymlinkOrCopy(targetPath, linkPath);

      expect(result).toBe('');
      expect(fs.readFileSync(linkPath, 'utf8')).toBe(userContent);
    } finally {
      fs.symlinkSync = originalSymlinkSync;
      cleanTmpDir(tmpDir);
    }
  });

  test('retries symlink creation when an EEXIST destination disappears', () => {
    const tmpDir = makeTmpDir();
    const originalLstatSync = fs.lstatSync;
    const originalSymlinkSync = fs.symlinkSync;
    let symlinkAttempts = 0;
    try {
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(targetPath, '# Forge Workflow\n');
      fs.lstatSync = file => {
        if (file !== linkPath) return originalLstatSync(file);
        const err = new Error('No such file');
        err.code = 'ENOENT';
        throw err;
      };
      fs.symlinkSync = function () {
        symlinkAttempts += 1;
        if (symlinkAttempts === 1) {
          const err = new Error('File exists');
          err.code = 'EEXIST';
          throw err;
        }
      };

      const { createSymlinkOrCopy } = require('../lib/symlink-utils');
      const result = createSymlinkOrCopy(targetPath, linkPath);

      expect(result).toBe('linked');
      expect(symlinkAttempts).toBe(2);
    } finally {
      fs.lstatSync = originalLstatSync;
      fs.symlinkSync = originalSymlinkSync;
      cleanTmpDir(tmpDir);
    }
  });

  test('warns when repeated EEXIST races exhaust creation retries', () => {
    const tmpDir = makeTmpDir();
    const originalLstatSync = fs.lstatSync;
    const originalSymlinkSync = fs.symlinkSync;
    const originalWarn = console.warn;
    const warnings = [];
    let symlinkAttempts = 0;
    try {
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(targetPath, '# Forge Workflow\n');
      fs.lstatSync = file => {
        if (file !== linkPath) return originalLstatSync(file);
        const err = new Error('No such file');
        err.code = 'ENOENT';
        throw err;
      };
      fs.symlinkSync = function () {
        symlinkAttempts += 1;
        const err = new Error('File exists');
        err.code = 'EEXIST';
        throw err;
      };
      console.warn = message => warnings.push(message);

      const { createSymlinkOrCopy } = require('../lib/symlink-utils');
      const result = createSymlinkOrCopy(targetPath, linkPath);

      expect(result).toBe('');
      expect(symlinkAttempts).toBe(2);
      expect(warnings).toEqual([
        `  ⚠ Could not create ${linkPath} after repeated conflicts; please re-run setup.`,
      ]);
    } finally {
      fs.lstatSync = originalLstatSync;
      fs.symlinkSync = originalSymlinkSync;
      console.warn = originalWarn;
      cleanTmpDir(tmpDir);
    }
  });

  test('preserves a file created during copy fallback', () => {
    const tmpDir = makeTmpDir();
    const originalSymlinkSync = fs.symlinkSync;
    const originalWriteFileSync = fs.writeFileSync;
    try {
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      const userContent = '# Created concurrently\n';
      originalWriteFileSync(targetPath, '# Forge Workflow\n');
      fs.symlinkSync = function () {
        const err = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      };
      fs.writeFileSync = function (file, content, options) {
        if (file === linkPath) {
          originalWriteFileSync(linkPath, userContent);
        }
        return originalWriteFileSync(file, content, options);
      };

      const { createSymlinkOrCopy } = require('../lib/symlink-utils');
      const result = createSymlinkOrCopy(targetPath, linkPath);

      expect(result).toBe('');
      expect(fs.readFileSync(linkPath, 'utf8')).toBe(userContent);
    } finally {
      fs.symlinkSync = originalSymlinkSync;
      fs.writeFileSync = originalWriteFileSync;
      cleanTmpDir(tmpDir);
    }
  });

  test('retries copy fallback when an EEXIST destination disappears', () => {
    const tmpDir = makeTmpDir();
    const originalLstatSync = fs.lstatSync;
    const originalSymlinkSync = fs.symlinkSync;
    const originalWriteFileSync = fs.writeFileSync;
    let copyAttempts = 0;
    try {
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      originalWriteFileSync(targetPath, '# Forge Workflow\n');
      fs.lstatSync = file => {
        if (file !== linkPath) return originalLstatSync(file);
        const err = new Error('No such file');
        err.code = 'ENOENT';
        throw err;
      };
      fs.symlinkSync = function () {
        const err = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      };
      fs.writeFileSync = function (file, content, options) {
        if (file === linkPath) {
          copyAttempts += 1;
          if (copyAttempts === 1) {
            const err = new Error('File exists');
            err.code = 'EEXIST';
            throw err;
          }
        }
        return originalWriteFileSync(file, content, options);
      };

      const { createSymlinkOrCopy } = require('../lib/symlink-utils');
      const result = createSymlinkOrCopy(targetPath, linkPath);

      expect(result).toBe('copied');
      expect(copyAttempts).toBe(2);
    } finally {
      fs.lstatSync = originalLstatSync;
      fs.symlinkSync = originalSymlinkSync;
      fs.writeFileSync = originalWriteFileSync;
      cleanTmpDir(tmpDir);
    }
  });

  test('does not copy when symlink creation fails unexpectedly', () => {
    const tmpDir = makeTmpDir();
    const originalSymlinkSync = fs.symlinkSync;
    try {
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(targetPath, '# Forge Workflow\n');
      fs.symlinkSync = function () {
        const err = new Error('I/O error');
        err.code = 'EIO';
        throw err;
      };

      const { createSymlinkOrCopy } = require('../lib/symlink-utils');
      const result = createSymlinkOrCopy(targetPath, linkPath);

      expect(result).toBe('');
      expect(fs.existsSync(linkPath)).toBe(false);
    } finally {
      fs.symlinkSync = originalSymlinkSync;
      cleanTmpDir(tmpDir);
    }
  });

  test('uses lstat to detect a dangling symlink destination', () => {
    const tmpDir = makeTmpDir();
    const originalExistsSync = fs.existsSync;
    const originalLstatSync = fs.lstatSync;
    const originalReadlinkSync = fs.readlinkSync;
    const originalSymlinkSync = fs.symlinkSync;
    let symlinkAttempts = 0;
    try {
      const targetPath = path.join(tmpDir, 'AGENTS.md');
      const linkPath = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(targetPath, '# Forge Workflow\n');
      fs.existsSync = file => file === linkPath ? false : originalExistsSync(file);
      fs.lstatSync = file => file === linkPath
        ? {
            isDirectory: () => false,
            isFile: () => false,
            isSymbolicLink: () => true,
          }
        : originalLstatSync(file);
      fs.readlinkSync = file => file === linkPath ? 'missing-target' : originalReadlinkSync(file);
      fs.symlinkSync = function () {
        symlinkAttempts += 1;
        const err = new Error('File exists');
        err.code = 'EEXIST';
        throw err;
      };

      const { createSymlinkOrCopy } = require('../lib/symlink-utils');
      const result = createSymlinkOrCopy(targetPath, linkPath);

      expect(result).toBe('');
      expect(symlinkAttempts).toBe(0);
      expect(originalExistsSync(linkPath)).toBe(false);
    } finally {
      fs.existsSync = originalExistsSync;
      fs.lstatSync = originalLstatSync;
      fs.readlinkSync = originalReadlinkSync;
      fs.symlinkSync = originalSymlinkSync;
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
