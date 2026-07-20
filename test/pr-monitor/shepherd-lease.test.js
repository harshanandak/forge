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
  test('first acquire writes payload with pid/startedAt/heartbeatAt/watchers', () => {
    const res = lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 1000 }));
    expect(res.ok).toBe(true);
    const held = readHolder();
    expect(held.pid).toBe(100);
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

  test('(5) release removes only our own lock', () => {
    lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 1000 }));
    lease.release(null, opts({ pid: 200 }));
    expect(fs.existsSync(lease.lockFilePath(null, { gitCommonDir }))).toBe(true);
    lease.release(null, opts({ pid: 100 }));
    expect(fs.existsSync(lease.lockFilePath(null, { gitCommonDir }))).toBe(false);
  });

  test('(6) re-read after reclaim rejects a lost double-reclaim race', () => {
    // Wedge a dead holder so acquire takes the reclaim branch.
    lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 0 }));
    // A competitor overwrites the file with ITS pid right after our reclaim
    // write but before our confirm re-read.
    const res = lease.acquire(null, opts({
      pid: 200,
      isAlive: (p) => p !== 100,
      now: () => 1000,
      onReclaimWrite: () => {
        fs.writeFileSync(lease.lockFilePath(null, { gitCommonDir }),
          JSON.stringify({ pid: 999, startedAt: 'x', heartbeatAt: 'x', watchers: [] }));
      },
    }));
    expect(res.ok).toBe(false);
    expect(readHolder().pid).toBe(999);
  });

  test('updateWatchers rewrites the watchers array only for the owner', () => {
    lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 1000 }));
    expect(lease.updateWatchers(null, [7, 8], opts({ pid: 100 }))).toBe(true);
    expect(readHolder().watchers).toEqual([7, 8]);
    expect(lease.updateWatchers(null, [9], opts({ pid: 200 }))).toBe(false);
    expect(readHolder().watchers).toEqual([7, 8]);
  });

  test('heartbeat stamp refreshes heartbeatAt for the owner and start/stop are safe', () => {
    lease.acquire(null, opts({ pid: 100, isAlive: alive, now: () => 1000 }));
    const before = readHolder().heartbeatAt;
    expect(lease.stamp(null, opts({ pid: 100, now: () => 5000 }))).toBe(true);
    const after = readHolder().heartbeatAt;
    expect(after).not.toBe(before);
    expect(Date.parse(after)).toBe(5000);
    // A non-owner cannot stamp.
    expect(lease.stamp(null, opts({ pid: 200, now: () => 9000 }))).toBe(false);
    const timer = lease.startHeartbeat(null, opts({ pid: 100 }));
    lease.stopHeartbeat(timer);
  });
});
