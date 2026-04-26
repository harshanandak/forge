const { describe, it, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { checkLefthookStatus } = require('../lib/lefthook-check');

describe('checkLefthookStatus', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lefthook-check-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns installed=true and binaryAvailable=true when package.json has lefthook and binary exists', () => {
    // Create package.json with lefthook
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { lefthook: '^1.0.0' } })
    );

    // Create node_modules/.bin/lefthook binary
    const binDir = path.join(tmpDir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'lefthook'), '');

    // On Windows, also create .cmd variant
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, 'lefthook.cmd'), '');
    }

    const result = checkLefthookStatus(tmpDir);
    expect(result.installed).toBe(true);
    expect(result.binaryAvailable).toBe(true);
    expect(result.message).toBe('');
  });

  it('returns installed=true and binaryAvailable=false when package.json has lefthook but no binary', () => {
    // Create package.json with lefthook but no node_modules
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { lefthook: '^1.0.0' } })
    );

    const result = checkLefthookStatus(tmpDir);
    expect(result.installed).toBe(true);
    expect(result.binaryAvailable).toBe(false);
    expect(result.message).toContain('bun install');
  });

  it('detects Bun Windows lefthook.exe shim as an available binary', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { lefthook: '^2.1.4' } })
    );
    const binDir = path.join(tmpDir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'lefthook.exe'), '');

    const result = checkLefthookStatus(tmpDir);
    expect(result.installed).toBe(true);
    expect(result.binaryAvailable).toBe(true);
    expect(result.state).toBe('installed');
  });

  it('returns installed=false and binaryAvailable=false when lefthook not in package.json', () => {
    // Create package.json without lefthook
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29.0.0' } })
    );

    const result = checkLefthookStatus(tmpDir);
    expect(result.installed).toBe(false);
    expect(result.binaryAvailable).toBe(false);
    expect(result.message).toContain('bun add');
  });

  it('returns installed=false and binaryAvailable=false when no package.json exists', () => {
    const result = checkLefthookStatus(tmpDir);
    expect(result.installed).toBe(false);
    expect(result.binaryAvailable).toBe(false);
    expect(result.message).toBe('');
  });

  it('detects lefthook in dependencies (not just devDependencies)', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { lefthook: '^1.0.0' } })
    );

    // Create binary
    const binDir = path.join(tmpDir, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'lefthook'), '');
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(binDir, 'lefthook.cmd'), '');
    }

    const result = checkLefthookStatus(tmpDir);
    expect(result.installed).toBe(true);
    expect(result.binaryAvailable).toBe(true);
    expect(result.message).toBe('');
  });

  it('handles malformed package.json gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ invalid json }');

    const result = checkLefthookStatus(tmpDir);
    expect(result.installed).toBe(false);
    expect(result.binaryAvailable).toBe(false);
    expect(result.message).toBe('');
  });
});
