'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');

const {
  MANIFEST_ENV,
  MANIFEST_VERSION,
  INSTANCE_ENV,
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
      spawnSync: (...args) => {
        calls.push(args);
        return { status: 0 };
      },
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

    const result = tree.cleanup('SIGTERM');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('taskkill');
    expect(calls[0][1]).toEqual(['/PID', '9012', '/T', '/F']);
    expect(calls[0][2]).toEqual(expect.objectContaining({ windowsHide: true, stdio: 'ignore' }));
    expect(result.killed).toEqual([9012]);
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

  test('restricts manifests to user-owned paths and creates private directories', () => {
    const manifestPath = path.join(makeTempDir(), 'foreign.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      version: MANIFEST_VERSION,
      token: 'foreign-token',
      owner: { pid: 9001, identity: 'foreign-owner', startedAt: '2026-08-03T00:00:00.000Z' },
      children: [],
    }));
    const foreignFs = Object.create(fs);
    foreignFs.lstatSync = (target) => ({ ...fs.lstatSync(target), uid: 999 });
    const processApi = { pid: 9000, getuid: () => 100 };
    const rejected = createProcessTree({
      manifestPath,
      token: 'new-token',
      fsApi: foreignFs,
      processApi,
      getProcessIdentity: () => 'owner',
    });
    expect(rejected.envFor({ [MANIFEST_ENV]: manifestPath, [TOKEN_ENV]: 'new-token' })[MANIFEST_ENV])
      .toBeUndefined();
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).token).toBe('foreign-token');

    const chmodCalls = [];
    const modeFs = Object.create(fs);
    modeFs.chmodSync = (...args) => {
      chmodCalls.push(args);
      return fs.chmodSync(...args);
    };
    createProcessTree({
      manifestPath: path.join(makeTempDir(), 'private.json'),
      token: 'private-token',
      fsApi: modeFs,
      processApi: { pid: 9000 },
      getProcessIdentity: () => 'owner',
    });
    expect(chmodCalls.some(([, mode]) => mode === 0o700)).toBe(true);
  });

  test('accepts a macOS runner temp chain with trusted system ancestors', () => {
    if (process.platform === 'win32') return;
    const uid = 501;
    const manifestDir = '/var/folders/zz/runner/T/forge-process-tree';
    const manifestPath = path.join(manifestDir, 'run.json');
    const nodes = new Map([
      ['/', { uid: 0, mode: 0o755, isDirectory: () => true, isSymbolicLink: () => false }],
      ['/var', { uid: 0, mode: 0o120777, isDirectory: () => false, isSymbolicLink: () => true }],
      ['/var/folders', { uid: 0, mode: 0o755, isDirectory: () => true, isSymbolicLink: () => false }],
      ['/var/folders/zz', { uid: 0, mode: 0o755, isDirectory: () => true, isSymbolicLink: () => false }],
      [`/var/folders/zz/runner`, { uid, mode: 0o700, isDirectory: () => true, isSymbolicLink: () => false }],
      [`/var/folders/zz/runner/T`, { uid, mode: 0o700, isDirectory: () => true, isSymbolicLink: () => false }],
      [manifestDir, { uid, mode: 0o700, isDirectory: () => true, isSymbolicLink: () => false }],
    ]);
    const writes = new Map();
    const macFs = {
      lstatSync: (target) => {
        if (nodes.has(target)) return nodes.get(target);
        if (writes.has(target)) return { uid, mode: 0o600, isDirectory: () => false, isSymbolicLink: () => false };
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
      existsSync: (target) => nodes.has(target) || writes.has(target),
      readlinkSync: (target) => {
        if (target === '/var') return 'private/var';
        throw new Error('not a symlink');
      },
      readFileSync: (target) => {
        if (writes.has(target)) return writes.get(target);
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
      mkdirSync: (target) => {
        nodes.set(target, { uid, mode: 0o700, isDirectory: () => true, isSymbolicLink: () => false });
      },
      chmodSync: () => {},
      writeFileSync: (target, value) => writes.set(target, value),
    };
    const processApi = { pid: 9000, getuid: () => uid };
    const tree = createProcessTree({
      manifestPath,
      token: 'mac-token',
      fsApi: macFs,
      processApi,
      getProcessIdentity: () => 'owner',
    });

    expect(tree.envFor({})[MANIFEST_ENV]).toBe(manifestPath);
    expect(readProcessManifest(manifestPath, macFs, processApi).token).toBe('mac-token');
  });

  test('rejects symlink ancestors and dangling leaves before chmod or write', () => {
    const targetRoot = makeTempDir();
    const targetNested = path.join(targetRoot, 'nested');
    fs.mkdirSync(targetNested);
    const linkRoot = makeTempDir();
    const linkedDir = path.join(linkRoot, 'linked');
    fs.symlinkSync(targetRoot, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    const ancestorManifestPath = path.join(linkedDir, 'nested', 'run.json');
    const targetMode = fs.statSync(targetNested).mode;
    const chmodCalls = [];
    const writes = [];
    const readdirCalls = [];
    const guardedFs = Object.create(fs);
    guardedFs.chmodSync = (target, mode) => {
      chmodCalls.push({ target, mode });
      return fs.chmodSync(target, mode);
    };
    guardedFs.writeFileSync = (...args) => {
      writes.push(args);
      return fs.writeFileSync(...args);
    };
    guardedFs.readdirSync = (...args) => {
      readdirCalls.push(args);
      return fs.readdirSync(...args);
    };

    const ancestorTree = createProcessTree({
      manifestPath: ancestorManifestPath,
      token: 'symlink-ancestor-token',
      fsApi: guardedFs,
      processApi: { pid: 9000 },
      getProcessIdentity: () => 'owner',
    });
    expect(ancestorTree.envFor({ [MANIFEST_ENV]: ancestorManifestPath })[MANIFEST_ENV]).toBeUndefined();
    expect(chmodCalls).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(fs.statSync(targetNested).mode).toBe(targetMode);
    expect(fs.existsSync(path.join(targetNested, 'run.json'))).toBe(false);
    expect(reconcileProcessManifests({
      manifestDir: path.join(linkedDir, 'nested'),
      fsApi: guardedFs,
      processApi: { pid: 9000 },
    })).toEqual({ reaped: 0 });
    expect(readdirCalls).toHaveLength(0);

    const danglingPath = path.join(makeTempDir(), 'dangling.json');
    fs.symlinkSync(
      path.join(makeTempDir(), 'missing.json'),
      danglingPath,
      process.platform === 'win32' ? 'junction' : 'file',
    );
    const danglingTree = createProcessTree({
      manifestPath: danglingPath,
      token: 'dangling-leaf-token',
      fsApi: guardedFs,
      processApi: { pid: 9000 },
      getProcessIdentity: () => 'owner',
    });
    expect(danglingTree.envFor({ [MANIFEST_ENV]: danglingPath })[MANIFEST_ENV]).toBeUndefined();
    expect(chmodCalls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  test('captures identity before abort and reaps the owned process group first', () => {
    const manifestPath = path.join(makeTempDir(), 'run.json');
    const groupKills = [];
    const directKills = [];
    let identityCalls = 0;
    const tree = createProcessTree({
      manifestPath,
      token: 'group-abort-token',
      platform: 'linux',
      processApi: { pid: 9000, kill: (pid, signal) => groupKills.push({ pid, signal }) },
      isAlive: () => true,
      getProcessIdentity: () => (identityCalls++ < 2 ? null : 'child-start'),
    });
    const reservation = tree.reserveChild({ kind: 'shard', label: 'unit-0' });
    const child = { pid: 9019, kill: (signal) => { directKills.push(signal); return true; } };

    expect(tree.registerChild(reservation, child)).toBeNull();
    expect(tree.abortChild(reservation, child)).toBe(true);
    expect(groupKills).toEqual([{ pid: -9019, signal: 'SIGKILL' }]);
    expect(directKills).toEqual([]);
    expect(fs.existsSync(manifestPath)).toBe(false);
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
    const child = { pid: 9016, kill: (signal) => { killed.push(signal); return true; } };

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
    expect(retained.children[0].status).toBe('running');
    expect(retained.children[0].identity).toBe('unverified:9017');
    expect(retained.children[0].pid).toBe(9017);
  });

  test('strips foreign manifest markers when an environment tree is unusable', () => {
    const manifestPath = path.join(makeTempDir(), 'foreign.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      version: MANIFEST_VERSION,
      token: 'foreign-token',
      owner: { pid: 9001, identity: 'owner-start', startedAt: '2026-08-03T00:00:00.000Z' },
      children: [],
    }));
    const tree = createProcessTree({
      env: { [MANIFEST_ENV]: manifestPath, [TOKEN_ENV]: 'new-token', [INSTANCE_ENV]: 'foreign-instance' },
      token: 'new-token',
      processApi: { pid: 9000 },
    });
    expect(tree.envFor({ [MANIFEST_ENV]: manifestPath, [TOKEN_ENV]: 'new-token', [INSTANCE_ENV]: 'foreign-instance' }))
      .toEqual({});
  });

  test('uses per-instance reservation ids and does not clean another instance', () => {
    const manifestPath = path.join(makeTempDir(), 'run.json');
    const first = createProcessTree({ manifestPath, token: 'shared-token', instanceId: 'first', processApi: { pid: 9000 }, getProcessIdentity: () => 'owner' });
    const second = createProcessTree({
      env: first.envFor({ PATH: 'test-path' }),
      processApi: { pid: 9001 },
      getProcessIdentity: () => 'owner',
    });
    const firstReservation = first.reserveChild();
    const secondReservation = second.reserveChild();
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(second.envFor({})[MANIFEST_ENV]).toBe(manifestPath);
    expect(firstReservation.id).not.toBe(secondReservation.id);
    expect(second.unregisterChild(firstReservation)).toBe(false);
    expect(readProcessManifest(manifestPath).children).toHaveLength(2);
  });

  test('removes dead unverifiable entries during cleanup', () => {
    const manifestPath = path.join(makeTempDir(), 'run.json');
    const tree = createProcessTree({
      manifestPath,
      token: 'unverified-token',
      processApi: { pid: 9000 },
      isAlive: () => false,
      getProcessIdentity: () => null,
    });
    const reservation = tree.reserveChild();
    const manifest = readProcessManifest(manifestPath);
    manifest.children[0] = {
      ...manifest.children[0], pid: 9018, status: 'running', identity: 'unverified:9018',
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    tree.cleanup('SIGKILL');
    expect(fs.existsSync(manifestPath)).toBe(false);
    expect(reservation).toBeTruthy();
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
