const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { copyEssentialDocs } = require('../lib/docs-copy');

/**
 * Helper: create a unique temp directory for each test and clean up after.
 */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'setup-docs-copy-test-'));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('copyEssentialDocs', () => {
  let tmpDir;
  let sourceDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sourceDir = makeTmpDir();

    // Create mock source docs
    fs.mkdirSync(path.join(sourceDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'docs', 'TOOLCHAIN.md'), '# Toolchain\nSetup instructions here.');
    fs.writeFileSync(path.join(sourceDir, 'docs', 'VALIDATION.md'), '# Validation\nValidation guide here.');
  });

  afterEach(() => {
    rmrf(tmpDir);
    rmrf(sourceDir);
  });

  test('copies TOOLCHAIN.md and VALIDATION.md to docs/forge/', () => {
    copyEssentialDocs(tmpDir, sourceDir);

    const toolchainPath = path.join(tmpDir, 'docs', 'forge', 'TOOLCHAIN.md');
    const validationPath = path.join(tmpDir, 'docs', 'forge', 'VALIDATION.md');

    expect(fs.existsSync(toolchainPath)).toBe(true);
    expect(fs.existsSync(validationPath)).toBe(true);

    expect(fs.readFileSync(toolchainPath, 'utf-8')).toBe('# Toolchain\nSetup instructions here.');
    expect(fs.readFileSync(validationPath, 'utf-8')).toBe('# Validation\nValidation guide here.');
  });

  test('creates docs/forge/ directory if missing', () => {
    const forgeDirPath = path.join(tmpDir, 'docs', 'forge');
    expect(fs.existsSync(forgeDirPath)).toBe(false);

    copyEssentialDocs(tmpDir, sourceDir);

    expect(fs.existsSync(forgeDirPath)).toBe(true);
  });

  test('is idempotent - calling again does not error', () => {
    copyEssentialDocs(tmpDir, sourceDir);
    // Second call should not throw
    expect(() => copyEssentialDocs(tmpDir, sourceDir)).not.toThrow();

    // Files should still exist with same content
    const toolchainPath = path.join(tmpDir, 'docs', 'forge', 'TOOLCHAIN.md');
    expect(fs.readFileSync(toolchainPath, 'utf-8')).toBe('# Toolchain\nSetup instructions here.');
  });

  test('skips files that already exist (does not overwrite)', () => {
    // Pre-create with custom content
    fs.mkdirSync(path.join(tmpDir, 'docs', 'forge'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'docs', 'forge', 'TOOLCHAIN.md'), '# Custom content');

    copyEssentialDocs(tmpDir, sourceDir);

    // Should preserve the existing file
    const content = fs.readFileSync(path.join(tmpDir, 'docs', 'forge', 'TOOLCHAIN.md'), 'utf-8');
    expect(content).toBe('# Custom content');
  });

  test('returns created and skipped lists', () => {
    const result = copyEssentialDocs(tmpDir, sourceDir);

    expect(result.created).toContain('docs/forge/TOOLCHAIN.md');
    expect(result.created).toContain('docs/forge/VALIDATION.md');
    expect(result.skipped).toEqual([]);
  });

  test('returns skipped list when files already exist', () => {
    // First call creates
    copyEssentialDocs(tmpDir, sourceDir);
    // Second call skips
    const result = copyEssentialDocs(tmpDir, sourceDir);

    expect(result.created).toEqual([]);
    expect(result.skipped).toContain('docs/forge/TOOLCHAIN.md');
    expect(result.skipped).toContain('docs/forge/VALIDATION.md');
  });

  test('handles missing source files gracefully', () => {
    const emptySourceDir = makeTmpDir();
    fs.mkdirSync(path.join(emptySourceDir, 'docs'), { recursive: true });
    // No TOOLCHAIN.md or VALIDATION.md in source

    const result = copyEssentialDocs(tmpDir, emptySourceDir);

    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual([]);
    rmrf(emptySourceDir);
  });
});
