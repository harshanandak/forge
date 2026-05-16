const { describe, expect, test, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  addLockEntry,
  readForgeLock,
  verifyForgeLock,
  writeForgeLock,
} = require('../lib/forge-lock');

const tempRoots = [];

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lock-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extensions', 'local.plugin.json'), '{"name":"local"}\n', 'utf8');
  return root;
}

beforeEach(() => {
  tempRoots.length = 0;
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('forge lock trust policy', () => {
  test('writes a reviewable lock entry and audit event for trusted local sources', () => {
    const root = makeRepo();

    const result = addLockEntry(root, {
      name: 'local',
      source: './extensions/local.plugin.json',
    });

    expect(result.entry.name).toBe('local');
    expect(result.entry.trust.trusted).toBe(true);
    expect(result.entry.integrity).toMatch(/^sha512-/);

    const lock = readForgeLock(root);
    expect(lock.version).toBe(1);
    expect(lock.extensions).toHaveLength(1);
    expect(lock.extensions[0].source).toBe('./extensions/local.plugin.json');

    const auditLog = fs.readFileSync(path.join(root, '.forge', 'log.jsonl'), 'utf8').trim();
    const event = JSON.parse(auditLog);
    expect(event.kind).toBe('forge.lock');
    expect(event.action).toBe('add');
    expect(event.name).toBe('local');
  });

  test('refuses untrusted locator strings unless explicitly allowed', () => {
    const root = makeRepo();

    expect(() => addLockEntry(root, {
      name: 'remote',
      source: 'gh:owner/repo/plugin',
    })).toThrow(/Untrusted source/);

    const result = addLockEntry(root, {
      name: 'remote',
      source: 'gh:owner/repo/plugin',
      allowUntrusted: true,
    });

    expect(result.entry.trust.trusted).toBe(false);
    expect(result.entry.trust.allowUntrusted).toBe(true);
    expect(result.entry.integrity).toBe(null);
    expect(result.entry.verification).toBe('unsupported-remote');
  });

  test('reports tampered local source integrity mismatches', () => {
    const root = makeRepo();
    addLockEntry(root, {
      name: 'local',
      source: './extensions/local.plugin.json',
    });

    fs.writeFileSync(path.join(root, 'extensions', 'local.plugin.json'), '{"name":"tampered"}\n', 'utf8');

    const report = verifyForgeLock(root);
    expect(report.ok).toBe(false);
    expect(report.results[0].status).toBe('fail');
    expect(report.results[0].reason).toContain('integrity mismatch');
  });

  test('refuses symlinked local sources that resolve outside the project root', () => {
    const root = makeRepo();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lock-outside-'));
    tempRoots.push(outsideRoot);
    const outsideFile = path.join(outsideRoot, 'external.plugin.json');
    const linkPath = path.join(root, 'extensions', 'external.plugin.json');
    fs.writeFileSync(outsideFile, '{"name":"external"}\n', 'utf8');
    try {
      fs.symlinkSync(outsideFile, linkPath);
    } catch (error) {
      expect(['EACCES', 'EPERM']).toContain(error.code);
      return;
    }

    expect(() => addLockEntry(root, {
      name: 'external',
      source: './extensions/external.plugin.json',
    })).toThrow(/project root/);
  });

  test('fails verification when a crafted lock entry escapes the project root', () => {
    const root = makeRepo();
    writeForgeLock(root, {
      version: 1,
      generatedBy: 'forge',
      extensions: [{
        name: 'escape',
        source: '../outside.plugin.json',
        resolvedPath: '../outside.plugin.json',
        integrity: 'sha512-invalid',
        verification: 'sri',
        trust: {
          trusted: true,
          allowUntrusted: false,
          reason: 'crafted test entry',
        },
        lockedAt: new Date().toISOString(),
      }],
    });

    const report = verifyForgeLock(root);

    expect(report.ok).toBe(false);
    expect(report.results[0].status).toBe('fail');
    expect(report.results[0].reason).toContain('project root');
  });

  test('fails verification when local paths spoof unsupported remote entries', () => {
    const root = makeRepo();
    writeForgeLock(root, {
      version: 1,
      generatedBy: 'forge',
      extensions: [{
        name: 'spoofed',
        source: './extensions/local.plugin.json',
        resolvedPath: null,
        integrity: null,
        verification: 'unsupported-remote',
        trust: {
          trusted: false,
          allowUntrusted: true,
          reason: 'crafted test entry',
        },
        lockedAt: new Date().toISOString(),
      }],
    });

    const report = verifyForgeLock(root);

    expect(report.ok).toBe(false);
    expect(report.results[0].status).toBe('fail');
    expect(report.results[0].reason).toContain('remote source locator');
  });
});
