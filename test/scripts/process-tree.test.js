'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  MANIFEST_ENV,
  TOKEN_ENV,
  createProcessTree,
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
});
