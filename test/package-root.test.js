'use strict';

const { test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  getPackageRoot,
  isCompiledBinary,
  extractEmbeddedAssets,
  listAssets,
  hasDiskAssets,
  ASSET_ROOTS,
  DISK_PACKAGE_ROOT,
} = require('../lib/package-root');

test('isCompiledBinary() is false under the real runtime (node / non-compiled bun)', () => {
  // No FORGE_COMPILED define and no Bun embedded files outside a compiled binary.
  expect(isCompiledBinary()).toBe(false);
});

test('isCompiledBinary() is false when Bun exists but has no embedded files', () => {
  expect(isCompiledBinary({ embeddedFiles: [] })).toBe(false);
  expect(isCompiledBinary({ embeddedFiles: null })).toBe(false);
  expect(isCompiledBinary(undefined)).toBe(false);
});

test('isCompiledBinary() is true (fallback signal) when Bun exposes embedded files', () => {
  expect(isCompiledBinary({ embeddedFiles: [{ name: 'x', size: 1 }] })).toBe(true);
});

test('hasDiskAssets() detects a real package root vs a bogus one', () => {
  expect(hasDiskAssets(DISK_PACKAGE_ROOT)).toBe(true);
  expect(hasDiskAssets(path.join(os.tmpdir(), 'definitely-not-forge'))).toBe(false);
  expect(hasDiskAssets(undefined)).toBe(false);
});

test('getPackageRoot() returns the on-disk package root in the npm channel', () => {
  const root = getPackageRoot();
  expect(root).toBe(DISK_PACKAGE_ROOT);
  expect(fs.existsSync(path.join(root, 'skills'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(true);
});

test('getPackageRoot() returns a real disk fallback that carries assets', () => {
  expect(getPackageRoot(DISK_PACKAGE_ROOT)).toBe(DISK_PACKAGE_ROOT);
});

test('getPackageRoot() throws loudly when BOTH channels fail (no assets, not compiled)', () => {
  const bogus = path.join(os.tmpdir(), 'forge-nope-xyz');
  expect(() => getPackageRoot(bogus)).toThrow(/Cannot resolve Forge runtime assets/);
  // Error lists both attempted sources.
  try {
    getPackageRoot(bogus);
  } catch (e) {
    expect(e.message).toContain('on-disk package root');
    expect(e.message).toContain('embedded assets');
  }
});

test('listAssets() is empty outside a compiled binary', () => {
  expect(listAssets()).toEqual([]);
});

test('ASSET_ROOTS covers the core setup assets', () => {
  expect(ASSET_ROOTS).toContain('skills');
  expect(ASSET_ROOTS).toContain('rules');
  expect(ASSET_ROOTS).toContain('AGENTS.md');
  expect(ASSET_ROOTS).toContain('.forge/hooks');
  expect(ASSET_ROOTS).toContain('scripts');
});

test('extractEmbeddedAssets() writes every asset preserving relative paths and returns the count', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-extract-'));
  const srcDir = path.join(workDir, 'src');
  const destDir = path.join(workDir, 'dest');
  fs.mkdirSync(srcDir, { recursive: true });

  const srcA = path.join(srcDir, 'a.md');
  const srcB = path.join(srcDir, 'b.sh');
  fs.writeFileSync(srcA, 'AAA');
  fs.writeFileSync(srcB, 'BBB');

  const manifest = {
    'skills/foo/SKILL.md': srcA,
    'scripts/forge-team/lib/claim.sh': srcB,
  };

  const count = extractEmbeddedAssets(destDir, manifest, ['scripts/forge-team/lib/claim.sh']);
  expect(count).toBe(2);

  const outA = path.join(destDir, 'skills', 'foo', 'SKILL.md');
  const outB = path.join(destDir, 'scripts', 'forge-team', 'lib', 'claim.sh');
  expect(fs.readFileSync(outA, 'utf8')).toBe('AAA');
  expect(fs.readFileSync(outB, 'utf8')).toBe('BBB');

  // Executable bit restored on the .sh (POSIX only; chmod is a no-op on Windows).
  if (process.platform !== 'win32') {
    const mode = fs.statSync(outB).mode & 0o111;
    expect(mode).not.toBe(0);
  }

  fs.rmSync(workDir, { recursive: true, force: true });
});

test('extractEmbeddedAssets() refuses unsafe manifest keys (traversal / absolute)', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-unsafe-'));
  const src = path.join(workDir, 'a.md');
  fs.writeFileSync(src, 'x');
  const destDir = path.join(workDir, 'dest');

  expect(() => extractEmbeddedAssets(destDir, { '../escape.md': src })).toThrow(/unsafe/i);
  expect(() => extractEmbeddedAssets(destDir, { 'a/../../escape.md': src })).toThrow(/unsafe/i);
  const abs = process.platform === 'win32' ? 'C:\\evil.md' : '/evil.md';
  expect(() => extractEmbeddedAssets(destDir, { [abs]: src })).toThrow(/unsafe/i);

  fs.rmSync(workDir, { recursive: true, force: true });
});
