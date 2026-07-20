'use strict';

const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lease = require('../../lib/pr-monitor/shepherd-lease');

// A temp dir stands in for the shared gitCommonDir so no test ever touches the
// real repo lock. Passing `gitCommonDir` bypasses the git rev-parse resolver.
let gitCommonDir;
const opts = (extra = {}) => ({ gitCommonDir, ...extra });
const alive = () => true;

beforeEach(() => {
  gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shep-lease-'));
});
afterEach(() => { fs.rmSync(gitCommonDir, { recursive: true, force: true }); });

function readHolder() {
  return JSON.parse(fs.readFileSync(lease.lockFilePath(null, { gitCommonDir }), 'utf8'));
}

describe('shepherd-lease', () => {
  test('first acquire writes payload with pid/token/startedAt/heartbeatAt/watchers', () => {
    const res = lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 1000 }));
    expect(res.ok).toBe(true);
    expect(typeof res.token).toBe('string');
    const held = readHolder();
    expect(held.pid).toBe(100);
    expect(held.token).toBe(res.token);
    expect(typeof held.startedAt).toBe('string');
    expect(typeof held.heartbeatAt).toBe('string');
    expect(held.watchers).toEqual([]);
  });

  test('(1) live + fresh holder blocks a second acquire', () => {
    lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 1000 }));
    const res = lease.acquire(null, opts({ pid: 200, isAlive: alive, now: () => 1000 }));
    expect(res.ok).toBe(false);
    expect(res.held.pid).toBe(100);
  });

  test('(2) dead holder is reclaimed', () => {
    lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 1000 }));
    const res = lease.acquire(null, opts({ pid: 200, isAlive: (p) => p !== 100, now: () => 1000 }));
    expect(res.ok).toBe(true);
    expect(res.reclaimed).toBe(true);
    expect(readHolder().pid).toBe(200);
  });

  test('(3) wedged holder (heartbeat older than STALE_MS) is reclaimed', () => {
    lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 0 }));
    const res = lease.acquire(null, opts({ pid: 200, isAlive: alive, now: () => lease.STALE_MS + 1 }));
    expect(res.ok).toBe(true);
    expect(res.reclaimed).toBe(true);
    expect(readHolder().pid).toBe(200);
  });

  test('(4) a foreign live+fresh holder is NEVER stolen', () => {
    lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 1000 }));
    const res = lease.acquire(null, opts({ pid: 200, isAlive: alive, now: () => 1000 }));
    expect(res.ok).toBe(false);
    expect(res.reclaimed).toBeUndefined();
    expect(readHolder().pid).toBe(100);
  });

  test('(5) release removes only OUR lock (by token, not pid)', () => {
    const held = lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 1000 }));
    // A foreign token (even with any pid) cannot release our lease.
    lease.release(null, opts({ token: 'someone-else' }));
    expect(fs.existsSync(lease.lockFilePath(null, { gitCommonDir }))).toBe(true);
    // Our own token releases it.
    lease.release(null, opts({ token: held.token }));
    expect(fs.existsSync(lease.lockFilePath(null, { gitCommonDir }))).toBe(false);
  });

  test('(6) ATOMIC takeover: losing the O_EXCL race backs off (never double-owns)', () => {
    // Wedge a dead holder so the second acquire takes the takeover branch.
    lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 0 }));
    // A competitor wins the exclusive re-create in the window AFTER we remove the
    // stale lock and BEFORE our own O_EXCL create — so our create hits EEXIST and
    // we must back off rather than both returning ok:true.
    const res = lease.acquire(null, opts({
      pid: 200,
      isAlive: (p) => p !== 100,
      now: () => 1000,
      onBeforeTakeover: () => {
        fs.writeFileSync(lease.lockFilePath(null, { gitCommonDir }),
          JSON.stringify({ pid: 999, token: 'competitor', startedAt: 'x', heartbeatAt: 'x', watchers: [] }));
      },
    }));
    expect(res.ok).toBe(false);
    expect(readHolder().pid).toBe(999);
    expect(readHolder().token).toBe('competitor');
  });

  test('(P2) a reclaimed owner cannot resurrect its lease via a revived heartbeat', () => {
    // Owner A claims, then wedges (heartbeat ages out).
    const a = lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 0 }));
    // Owner B reclaims the stale lease with a fresh token.
    const b = lease.acquire(null, opts({ pid: 200, isAlive: alive, now: () => lease.STALE_MS + 1 }));
    expect(b.ok).toBe(true);
    expect(b.token).not.toBe(a.token);
    // A revives and its heartbeat fires — but its token no longer owns the lock,
    // so the stamp is a no-op and B's lease is NOT overwritten.
    expect(lease.stamp(null, opts({ token: a.token, now: () => 9999 }))).toBe(false);
    expect(lease.updateWatchers(null, [1, 2], opts({ token: a.token }))).toBe(false);
    expect(readHolder().token).toBe(b.token);
    expect(readHolder().watchers).toEqual([]);
  });

  test('pid reuse cannot mutate a foreign lease (token authoritative over pid)', () => {
    // A crashes; B later acquires the SAME pid (reuse) but a different token.
    lease.acquire(null, opts({ pid: 100, isAlive: (p) => p !== 100, now: () => 0 }));
    const b = lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => lease.STALE_MS + 1 }));
    // A stale actor holding pid 100 but the OLD token cannot stamp or release.
    expect(lease.stamp(null, opts({ token: 'stale-a-token', pid: 100 }))).toBe(false);
    lease.release(null, opts({ token: 'stale-a-token', pid: 100 }));
    expect(fs.existsSync(lease.lockFilePath(null, { gitCommonDir }))).toBe(true);
    expect(readHolder().token).toBe(b.token);
  });

  test('updateWatchers rewrites the watchers array only for the token owner', () => {
    const held = lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 1000 }));
    expect(lease.updateWatchers(null, [7, 8], opts({ token: held.token }))).toBe(true);
    expect(readHolder().watchers).toEqual([7, 8]);
    expect(lease.updateWatchers(null, [9], opts({ token: 'other' }))).toBe(false);
    expect(readHolder().watchers).toEqual([7, 8]);
  });

  test('heartbeat stamp refreshes heartbeatAt for the token owner and start/stop are safe', () => {
    const held = lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 1000 }));
    const before = readHolder().heartbeatAt;
    expect(lease.stamp(null, opts({ token: held.token, now: () => 5000 }))).toBe(true);
    const after = readHolder().heartbeatAt;
    expect(after).not.toBe(before);
    expect(Date.parse(after)).toBe(5000);
    // A non-owner token cannot stamp.
    expect(lease.stamp(null, opts({ token: 'other', now: () => 9000 }))).toBe(false);
    const timer = lease.startHeartbeat(null, opts({ token: held.token }));
    lease.stopHeartbeat(timer);
  });
});
