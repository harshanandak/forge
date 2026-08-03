'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  MANIFEST_ENV,
  MANIFEST_VERSION,
  TOKEN_ENV,
  createProcessTree,
  reconcileProcessManifests,
  readProcessManifest,
} = require('../../scripts/process-tree');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-process-tree-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('scripts/process-tree.js', () => {
  test('writes a verified run manifest and registers a shard before cleanup', () => {
    const manifestPath = path.join(makeTempDir(), 'run.json');
    const kills = [];
    const tree = createProcessTree({
      manifestPath,
      token: 'run-token',
      platform: 'linux',
      processApi: { pid: 9000, kill: (pid, signal) => kills.push({ pid, signal }) },
      isAlive: () => true,
      getProcessIdentity: () => 'child-start',
    });

    const reservation = tree.reserveChild({ kind: 'shard', label: 'unit-0' });
    const reserved = readProcessManifest(manifestPath);
    expect(reserved.token).toBe('run-token');
    expect(reserved.children).toHaveLength(1);
    expect(reserved.children[0].pid).toBeNull();

    tree.registerChild(reservation, { pid: 9010 });
    expect(readProcessManifest(manifestPath).children[0].pid).toBe(9010);

    tree.cleanup('SIGKILL');
    tree.cleanup('SIGKILL');

    expect(kills).toEqual([{ pid: -9010, signal: 'SIGKILL' }]);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  test('refuses to kill missing or mismatched ownership entries', () => {
    const manifestPath = path.join(makeTempDir(), 'run.json');
    const kills = [];
    const tree = createProcessTree({
      manifestPath,
      token: 'run-token',
      platform: 'linux',
      processApi: { pid: 9000, kill: (pid) => kills.push(pid) },
      isAlive: () => true,
      getProcessIdentity: () => 'child-start',
    });
    const reservation = tree.reserveChild({ kind: 'shard', label: 'unit-0' });
    tree.registerChild(reservation, { pid: 9011 });

    const manifest = readProcessManifest(manifestPath);
    manifest.children[0].token = 'different-run';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    tree.cleanup('SIGTERM');

    expect(kills).toHaveLength(0);
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  test('uses taskkill tree semantics on Windows and exports child env markers', () => {
    const manifestPath = path.join(makeTempDir(), 'run.json');
    const calls = [];
    const tree = createProcessTree({
      manifestPath,
      token: 'windows-token',
      platform: 'win32',
      processApi: { pid: 9000 },
      spawnSync: (...args) => calls.push(args),
      isAlive: () => true,
      getProcessIdentity: () => 'child-start',
    });
    const reservation = tree.reserveChild({ kind: 'shard', label: 'unit-0' });
    tree.registerChild(reservation, { pid: 9012 });

    const env = tree.envFor({ PATH: 'test-path' });
    expect(env).toEqual(expect.objectContaining({
      PATH: 'test-path',
      [MANIFEST_ENV]: manifestPath,
      [TOKEN_ENV]: 'windows-token',
    }));

    tree.cleanup('SIGTERM');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('taskkill');
    expect(calls[0][1]).toEqual(['/PID', '9012', '/T', '/F']);
    expect(calls[0][2]).toEqual(expect.objectContaining({ windowsHide: true, stdio: 'ignore' }));
  });

  test('escalates a signal cleanup to timeout cleanup without double-killing', () => {
    const manifestPath = path.join(makeTempDir(), 'run.json');
    const kills = [];
    const tree = createProcessTree({
      manifestPath,
      token: 'escalation-token',
      platform: 'linux',
      processApi: { pid: 9000, kill: (pid, signal) => kills.push({ pid, signal }) },
      isAlive: () => true,
      getProcessIdentity: () => 'child-start',
    });
    const reservation = tree.reserveChild({ kind: 'shard', label: 'unit-0' });
    tree.registerChild(reservation, { pid: 9013 });

    tree.cleanup('SIGTERM');
    expect(fs.existsSync(manifestPath)).toBe(true);
    tree.cleanup('SIGKILL');
    tree.cleanup('SIGKILL');

    expect(kills).toEqual([
      { pid: -9013, signal: 'SIGTERM' },
      { pid: -9013, signal: 'SIGKILL' },
    ]);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  test('refuses a PID-reused process when its stable identity changed', () => {
    const manifestPath = path.join(makeTempDir(), 'run.json');
    const kills = [];
    let identity = 'child-start-a';
    const tree = createProcessTree({
      manifestPath,
      token: 'identity-token',
      platform: 'linux',
      processApi: { pid: 9000, kill: (pid) => kills.push(pid) },
      isAlive: () => true,
      getProcessIdentity: () => identity,
    });
    const reservation = tree.reserveChild({ kind: 'shard', label: 'unit-0' });
    tree.registerChild(reservation, { pid: 9014 });
    identity = 'foreign-process-start';

    tree.cleanup('SIGKILL');

    expect(kills).toHaveLength(0);
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  test('treats a nonzero Windows taskkill status as failure and retains a live marker', () => {
    const manifestPath = path.join(makeTempDir(), 'run.json');
    const tree = createProcessTree({
      manifestPath,
      token: 'taskkill-status-token',
      platform: 'win32',
      processApi: { pid: 9000 },
      spawnSync: () => ({ status: 1 }),
      isAlive: () => true,
      getProcessIdentity: () => 'child-start',
    });
    const reservation = tree.reserveChild({ kind: 'shard', label: 'unit-0' });
    tree.registerChild(reservation, { pid: 9015 });

    const result = tree.cleanup('SIGKILL');

    expect(result.killed).toHaveLength(0);
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  test('does not overwrite malformed or foreign existing markers', () => {
    const malformedPath = path.join(makeTempDir(), 'malformed.json');
    fs.writeFileSync(malformedPath, '{not-json');
    const malformedTree = createProcessTree({
      manifestPath: malformedPath,
      token: 'new-token',
      processApi: { pid: 9000 },
    });
    expect(malformedTree.envFor({ PATH: 'test-path' })[MANIFEST_ENV]).toBeUndefined();
    expect(fs.readFileSync(malformedPath, 'utf8')).toBe('{not-json');

    const foreignPath = path.join(makeTempDir(), 'foreign.json');
    const foreign = {
      version: MANIFEST_VERSION,
      token: 'foreign-token',
      owner: { pid: 9001, identity: 'foreign-owner', startedAt: '2026-08-03T00:00:00.000Z' },
      children: [],
    };
    fs.writeFileSync(foreignPath, JSON.stringify(foreign));
    createProcessTree({
      manifestPath: foreignPath,
      token: 'new-token',
      processApi: { pid: 9000 },
    });
    expect(JSON.parse(fs.readFileSync(foreignPath, 'utf8'))).toEqual(foreign);
  });

  test('abortChild kills a newly spawned child when identity registration fails', () => {
    const manifestPath = path.join(makeTempDir(), 'run.json');
    const killed = [];
    const tree = createProcessTree({
      manifestPath,
      token: 'abort-token',
      processApi: { pid: 9000 },
      getProcessIdentity: () => null,
    });
    const reservation = tree.reserveChild({ kind: 'shard', label: 'unit-0' });
    const child = { pid: 9016, kill: (signal) => killed.push(signal) };

    expect(tree.registerChild(reservation, child)).toBeNull();
    tree.abortChild(reservation, child);

    expect(killed).toEqual(['SIGKILL']);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  test('retains ownership when a Windows child kill fails while the child remains alive', () => {
    const manifestPath = path.join(makeTempDir(), 'run.json');
    const tree = createProcessTree({
      manifestPath,
      token: 'windows-abort-token',
      platform: 'win32',
      processApi: { pid: 9000 },
      isAlive: () => true,
      getProcessIdentity: () => null,
      spawnSync: () => ({ status: 1 }),
    });
    const reservation = tree.reserveChild({ kind: 'shard', label: 'unit-0' });
    const child = { pid: 9017, kill: () => false };

    expect(tree.registerChild(reservation, child)).toBeNull();
    tree.abortChild(reservation, child);

    const retained = readProcessManifest(manifestPath);
    expect(retained).toBeTruthy();
    expect(retained.children).toHaveLength(1);
    expect(retained.children[0].status).toBe('reserved');
    expect(retained.children[0].pid).toBe(9017);
  });

  test('startup reconciliation reaps only owned orphan manifests with a dead owner', () => {
    const manifestDir = makeTempDir();
    const orphanPath = path.join(manifestDir, 'orphan.json');
    fs.writeFileSync(orphanPath, JSON.stringify({
      version: MANIFEST_VERSION,
      token: 'orphan-token',
      owner: { pid: 7000, identity: 'owner-start', startedAt: '2026-08-03T00:00:00.000Z' },
      children: [{
        id: 'orphan-token:0',
        token: 'orphan-token',
        kind: 'shard',
        label: 'unit-0',
        pid: 7010,
        status: 'running',
        startedAt: '2026-08-03T00:00:01.000Z',
        identity: 'child-start',
      }],
    }));
    const kills = [];
    const isAlive = (pid) => pid === 7010;
    const getProcessIdentity = (pid) => (pid === 7010 ? 'child-start' : null);

    const result = reconcileProcessManifests({
      manifestDir,
      platform: 'linux',
      processApi: { pid: 9000, kill: (pid, signal) => kills.push({ pid, signal }) },
      isAlive,
      getProcessIdentity,
    });

    expect(result.reaped).toBe(1);
    expect(kills).toEqual([{ pid: -7010, signal: 'SIGKILL' }]);
    expect(fs.existsSync(orphanPath)).toBe(false);
  });
});
