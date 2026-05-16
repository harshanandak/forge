const { describe, expect, test, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  addLockEntry,
  readForgeLock,
  verifyForgeLock,
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
});

