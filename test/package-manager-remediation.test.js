const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  detectPackageManagerForRemediation,
  getInstallCommand,
  getAddDevCommand
} = require('../lib/package-manager-remediation');

describe('package-manager-remediation', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-remediation-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects bun from bun.lockb', () => {
    fs.writeFileSync(path.join(tmpDir, 'bun.lockb'), '');
    expect(detectPackageManagerForRemediation(tmpDir).name).toBe('bun');
    expect(getInstallCommand(tmpDir)).toBe('bun install');
    expect(getAddDevCommand(tmpDir, 'lefthook')).toBe('bun add -D lefthook && bun install');
  });

  it('detects bun from bun.lock (text lockfile)', () => {
    fs.writeFileSync(path.join(tmpDir, 'bun.lock'), '');
    expect(detectPackageManagerForRemediation(tmpDir).name).toBe('bun');
    expect(getInstallCommand(tmpDir)).toBe('bun install');
  });

  it('detects pnpm from pnpm-lock.yaml', () => {
    fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), '');
    expect(detectPackageManagerForRemediation(tmpDir).name).toBe('pnpm');
    expect(getInstallCommand(tmpDir)).toBe('pnpm install');
    expect(getAddDevCommand(tmpDir, 'lefthook')).toBe('pnpm add -D lefthook');
  });

  it('detects yarn from yarn.lock', () => {
    fs.writeFileSync(path.join(tmpDir, 'yarn.lock'), '');
    expect(detectPackageManagerForRemediation(tmpDir).name).toBe('yarn');
    expect(getInstallCommand(tmpDir)).toBe('yarn install');
    expect(getAddDevCommand(tmpDir, 'lefthook')).toBe('yarn add -D lefthook');
  });

  it('detects npm from package-lock.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '');
    expect(detectPackageManagerForRemediation(tmpDir).name).toBe('npm');
    expect(getInstallCommand(tmpDir)).toBe('npm install');
    expect(getAddDevCommand(tmpDir, 'lefthook')).toBe('npm install -D lefthook');
  });

  it('falls back to npm install when no lockfile is present', () => {
    expect(detectPackageManagerForRemediation(tmpDir).name).toBe('npm');
    expect(getInstallCommand(tmpDir)).toBe('npm install');
    expect(getAddDevCommand(tmpDir, 'lefthook')).toBe('npm install -D lefthook');
  });

  it('prefers the first matching lockfile when multiple are present', () => {
    fs.writeFileSync(path.join(tmpDir, 'bun.lockb'), '');
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '');
    expect(detectPackageManagerForRemediation(tmpDir).name).toBe('bun');
  });

  it('defaults to process.cwd() when projectRoot is not a string', () => {
    expect(() => detectPackageManagerForRemediation(undefined)).not.toThrow();
    expect(() => detectPackageManagerForRemediation(null)).not.toThrow();
  });
});
