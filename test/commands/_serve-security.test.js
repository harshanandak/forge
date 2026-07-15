'use strict';

// Tests for the three ALWAYS shared-machine controls that harden `forge serve`
// on a multi-user box (see docs/work/2026-07-13-forge-serve/security-model.md):
//   1. serve.lock single-instance guard (stale-PID reclaim + clean release)
//   2. securePath() owner-only perms-at-creation + a startup world-readable audit
//   3. a hash-chained, tamper-evident mutation journal + verify()
//
// POSIX asserts the real 0o600/0o700 mode bits; on Windows chmod only flips the
// read-only bit and st.mode does not reflect ACLs, so those assertions are
// gated behind `POSIX` and the Windows path only asserts "does not throw / is
// flagged best-effort". The hash-chain + lock logic is platform-independent and
// asserted everywhere.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const sec = require('../../lib/commands/_serve-security');

const POSIX = process.platform !== 'win32';
const tempRoots = [];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-serve-sec-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  return root;
}

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// 2. securePath / writeSecret / auditPaths
// ---------------------------------------------------------------------------

describe('securePath — owner-only perms at creation', () => {
  test('writeSecret creates a file that is not group/other readable (POSIX)', () => {
    const root = makeProject();
    const target = path.join(root, '.forge', 'secret.txt');
    sec.writeSecret(target, 'top secret');
    expect(fs.readFileSync(target, 'utf8')).toBe('top secret');
    if (POSIX) {
      const mode = fs.statSync(target).mode & 0o777;
      expect(mode & 0o077).toBe(0); // no group/other bits
      expect(mode & 0o600).toBe(0o600); // owner rw
    }
  });

  test('ensureSecureDir creates an owner-only directory (POSIX)', () => {
    const root = makeProject();
    const dir = path.join(root, '.forge', 'serve');
    sec.ensureSecureDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    if (POSIX) {
      const mode = fs.statSync(dir).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    }
  });

  test('securePath on Windows is a documented best-effort no-op (never throws)', () => {
    const root = makeProject();
    const target = path.join(root, '.forge', 'wintest.txt');
    fs.writeFileSync(target, 'x');
    const res = sec.securePath(target);
    expect(res.ok).toBe(true);
    if (!POSIX) expect(res.applied).toBe(false); // ACLs unaffected by chmod
  });
});

describe('auditPaths — startup world-readable check', () => {
  test('flags a group/other-readable sensitive file (POSIX)', () => {
    const root = makeProject();
    const target = path.join(root, '.forge', 'leaky.txt');
    fs.writeFileSync(target, 'x', { mode: 0o644 });
    if (POSIX) fs.chmodSync(target, 0o644);
    const audit = sec.auditPaths([target]);
    if (POSIX) {
      expect(audit.ok).toBe(false);
      expect(audit.offenders.map((o) => o.path)).toContain(target);
    } else {
      // Windows: mode bits do not reflect ACLs, so we do not raise false alarms.
      expect(audit.results[0].platformCaveat).toBe(true);
    }
  });

  test('a securely-created file is not flagged (POSIX)', () => {
    const root = makeProject();
    const target = path.join(root, '.forge', 'tight.txt');
    sec.writeSecret(target, 'x');
    const audit = sec.auditPaths([target]);
    if (POSIX) expect(audit.ok).toBe(true);
  });

  test('a missing path is simply not an offender', () => {
    const root = makeProject();
    const audit = sec.auditPaths([path.join(root, '.forge', 'nope.txt')]);
    expect(audit.ok).toBe(true);
    expect(audit.results[0].exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1. serve.lock single-instance guard
// ---------------------------------------------------------------------------

describe('serve.lock single-instance guard', () => {
  test('first acquire succeeds and writes a lock file', () => {
    const root = makeProject();
    const res = sec.acquireLock(root, { pid: 1111, port: 8730, isAlive: () => true });
    expect(res.ok).toBe(true);
    expect(fs.existsSync(sec.lockPath(root))).toBe(true);
    if (POSIX) expect(fs.statSync(sec.lockPath(root)).mode & 0o077).toBe(0);
  });

  test('a second live instance is BLOCKED (no silent port-squat)', () => {
    const root = makeProject();
    const first = sec.acquireLock(root, { pid: 1111, port: 8730, isAlive: () => true });
    expect(first.ok).toBe(true);
    const second = sec.acquireLock(root, { pid: 2222, port: 8731, isAlive: () => true });
    expect(second.ok).toBe(false);
    expect(second.held.pid).toBe(1111);
    expect(second.held.port).toBe(8730);
  });

  test('a stale lock (dead PID) is reclaimed', () => {
    const root = makeProject();
    const first = sec.acquireLock(root, { pid: 1111, port: 8730, isAlive: () => false });
    expect(first.ok).toBe(true);
    // pid 1111 is "dead" -> a new instance reclaims it.
    const second = sec.acquireLock(root, { pid: 2222, port: 8731, isAlive: () => false });
    expect(second.ok).toBe(true);
    expect(second.reclaimed).toBe(true);
    expect(sec.readLock(sec.lockPath(root)).pid).toBe(2222);
  });

  test('releaseLock removes only our own lock', () => {
    const root = makeProject();
    sec.acquireLock(root, { pid: 1111, isAlive: () => true });
    // A different pid must not delete our lock.
    sec.releaseLock(root, { pid: 9999 });
    expect(fs.existsSync(sec.lockPath(root))).toBe(true);
    sec.releaseLock(root, { pid: 1111 });
    expect(fs.existsSync(sec.lockPath(root))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Hash-chained tamper-evident journal
// ---------------------------------------------------------------------------

describe('hash-chained mutation journal', () => {
  test('append links each record to the previous hash; verify passes', () => {
    const root = makeProject();
    const a = sec.appendJournal(root, { verb: 'gate', ok: true });
    const b = sec.appendJournal(root, { verb: 'issue.create', ok: true });
    const c = sec.appendJournal(root, { verb: 'issue.close', ok: false });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(c.seq).toBe(2);
    const v = sec.verifyJournal(root);
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(3);
    if (POSIX) expect(fs.statSync(sec.journalPath(root)).mode & 0o077).toBe(0);
  });

  test('an empty / absent journal verifies as ok', () => {
    const root = makeProject();
    const v = sec.verifyJournal(root);
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(0);
  });

  test('editing a past record BREAKS the chain (tamper detected)', () => {
    const root = makeProject();
    sec.appendJournal(root, { verb: 'gate', ok: true });
    sec.appendJournal(root, { verb: 'issue.create', ok: true });
    sec.appendJournal(root, { verb: 'issue.close', ok: true });

    const file = sec.journalPath(root);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.verb = 'role'; // silently rewrite the middle record's payload
    lines[1] = JSON.stringify(tampered);
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const v = sec.verifyJournal(root);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(1);
  });

  test('deleting a past record BREAKS the chain (prevHash mismatch)', () => {
    const root = makeProject();
    sec.appendJournal(root, { verb: 'gate', ok: true });
    sec.appendJournal(root, { verb: 'issue.create', ok: true });
    sec.appendJournal(root, { verb: 'issue.close', ok: true });

    const file = sec.journalPath(root);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    lines.splice(1, 1); // drop the middle record
    fs.writeFileSync(file, lines.join('\n') + '\n');

    const v = sec.verifyJournal(root);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(1);
  });
});
