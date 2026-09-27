'use strict';

const { expect, test } = require('bun:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../../scripts/vendor-internal-packages.js');

test('prepare cleans partial vendor output and releases the lock when a copy fails', () => {
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vendor-lock-'));
  const vendorRemovals = [];
  const fakeFs = {
    ...fs,
    cpSync() {
      throw new Error('injected copy failure');
    },
    rmSync(target, options) {
      if (path.dirname(target) === lockDir) return fs.rmSync(target, options);
      vendorRemovals.push(target);
      return undefined;
    },
  };
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const sandbox = {
    __dirname: path.dirname(SCRIPT),
    module: { exports: {} },
    process: { argv: ['node', SCRIPT, 'prepare'], pid: 1 },
    require(specifier) {
      if (specifier === 'node:crypto') return crypto;
      if (specifier === 'node:fs') return fakeFs;
      if (specifier === 'node:os') return { ...os, tmpdir: () => lockDir };
      if (specifier === 'node:path') return path;
      throw new Error(`unexpected require: ${specifier}`);
    },
  };

  try {
    expect(() => vm.runInNewContext(source, sandbox, { filename: SCRIPT }))
      .toThrow('injected copy failure');
    expect(vendorRemovals).toHaveLength(2);
    expect(fs.readdirSync(lockDir)).toEqual([]);
  } finally {
    fs.rmSync(lockDir, { force: true, recursive: true });
  }
});

function stageCheckout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vendor-concurrency-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'vendor-internal-packages.js'));
  for (const name of ['contracts', 'memory', 'flow']) {
    fs.cpSync(path.resolve(__dirname, '../../packages', name), path.join(root, 'packages', name), {
      recursive: true,
      filter: (source) => path.basename(source) !== 'node_modules',
    });
  }
  return root;
}

function runVendor(root, action) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'vendor-internal-packages.js'), action], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('a second prepare waits for the first pack window instead of wiping its vendor tree', async () => {
  const root = stageCheckout();
  const vendorRoot = path.join(root, 'lib', '_internal', 'vendor');
  const sentinel = path.join(vendorRoot, 'contracts', 'index.js');
  let second;
  try {
    expect(runVendor(root, 'prepare').status).toBe(0);
    // Pack A is now archiving its vendor tree; tag a file so a wipe is observable.
    fs.appendFileSync(sentinel, '\n// pack-a-marker\n');

    second = spawn(process.execPath, [path.join(root, 'scripts', 'vendor-internal-packages.js'), 'prepare'], {
      cwd: root,
      stdio: 'ignore',
    });
    const secondExit = new Promise((resolve) => second.once('exit', (code) => resolve(code)));
    const earlyExit = await Promise.race([secondExit, new Promise((resolve) => setTimeout(() => resolve('waiting'), 3000))]);

    expect(earlyExit).toBe('waiting');
    expect(fs.readFileSync(sentinel, 'utf8')).toContain('pack-a-marker');

    expect(runVendor(root, 'cleanup').status).toBe(0);
    expect(await secondExit).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).not.toContain('pack-a-marker');
    expect(runVendor(root, 'cleanup').status).toBe(0);
    expect(fs.existsSync(vendorRoot)).toBe(false);
  } finally {
    if (second && second.exitCode === null) second.kill();
    runVendor(root, 'cleanup');
    fs.rmSync(root, { force: true, recursive: true });
  }
}, 60_000);
